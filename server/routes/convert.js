const router = require("express").Router();
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const { requireAuth, requireQuota } = require("../middleware/auth");
const { pool } = require("../models/db");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const allowed = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.ms-excel",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ];
    cb(null, allowed.includes(file.mimetype) ? true : new Error("Unsupported file type."));
  },
});

const CC_KEY = process.env.CLOUDCONVERT_API_KEY;
const CC_BASE = "https://api.cloudconvert.com/v2";

// Supported conversions
const CONVERSIONS = {
  "pdf-to-docx":  { from: "pdf",  to: "docx", label: "PDF to Word",       outputMime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  "docx-to-pdf":  { from: "docx", to: "pdf",  label: "Word to PDF",       outputMime: "application/pdf" },
  "xlsx-to-pdf":  { from: "xlsx", to: "pdf",  label: "Excel to PDF",      outputMime: "application/pdf" },
  "pptx-to-pdf":  { from: "pptx", to: "pdf",  label: "PowerPoint to PDF", outputMime: "application/pdf" },
};

// Helper: poll job until done
async function pollJob(jobId, timeout = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const res = await axios.get(`${CC_BASE}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${CC_KEY}` },
    });
    const job = res.data.data;
    if (job.status === "finished") return job;
    if (job.status === "error") throw new Error(job.tasks?.find(t => t.status === "error")?.message || "Conversion failed.");
    await new Promise(r => setTimeout(r, 2000)); // poll every 2s
  }
  throw new Error("Conversion timed out.");
}

// POST /api/convert/:type — e.g. /api/convert/pdf-to-docx
router.post("/:type", requireAuth, requireQuota, upload.single("file"), async (req, res) => {
  const conv = CONVERSIONS[req.params.type];
  if (!conv) return res.status(400).json({ error: "Unsupported conversion type." });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  if (!CC_KEY) return res.status(503).json({ error: "Conversion service not configured. Please add CLOUDCONVERT_API_KEY." });

  try {
    // Step 1: Create a CloudConvert job
    const jobRes = await axios.post(`${CC_BASE}/jobs`, {
      tasks: {
        "upload-file": {
          operation: "import/upload",
        },
        "convert-file": {
          operation: "convert",
          input: "upload-file",
          input_format: conv.from,
          output_format: conv.to,
          engine: "office",   // best quality for office docs
        },
        "export-file": {
          operation: "export/url",
          input: "convert-file",
        },
      },
    }, {
      headers: {
        Authorization: `Bearer ${CC_KEY}`,
        "Content-Type": "application/json",
      },
    });

    const job = jobRes.data.data;
    const uploadTask = job.tasks.find(t => t.name === "upload-file");

    // Step 2: Upload the file
    const form = new FormData();
    Object.entries(uploadTask.result.form.parameters).forEach(([k, v]) => form.append(k, v));
    form.append("file", req.file.buffer, {
      filename: req.file.originalname,
      contentType: req.file.mimetype,
    });

    await axios.post(uploadTask.result.form.url, form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    // Step 3: Poll until done
    const finishedJob = await pollJob(job.id);

    // Step 4: Download result
    const exportTask = finishedJob.tasks.find(t => t.name === "export-file");
    const downloadUrl = exportTask?.result?.files?.[0]?.url;
    if (!downloadUrl) throw new Error("Could not get download URL.");

    const fileRes = await axios.get(downloadUrl, { responseType: "arraybuffer" });
    const outputBuffer = Buffer.from(fileRes.data);

    // Deduct usage
    if (req.useCredit) {
      await pool.query("UPDATE users SET credits=credits-1 WHERE id=$1", [req.user.id]);
    } else {
      await pool.query("UPDATE users SET conversations_used=conversations_used+1 WHERE id=$1", [req.user.id]);
    }

    await pool.query(
      "INSERT INTO conversions (user_id,file_name,document_type,title,export_type) VALUES ($1,$2,$3,$4,$5)",
      [req.user.id, req.file.originalname, "Document", `${conv.label} conversion`, req.params.type]
    );

    // Generate output filename
    const baseName = req.file.originalname.replace(/\.[^.]+$/, "");
    const outputName = `${baseName}.${conv.to}`;

    res.set({
      "Content-Type": conv.outputMime,
      "Content-Disposition": `attachment; filename="${outputName}"`,
      "Content-Length": outputBuffer.length,
    });
    res.send(outputBuffer);

  } catch (err) {
    console.error("Conversion error:", err.response?.data || err.message);
    const msg = err.response?.data?.message || err.message || "Conversion failed.";
    res.status(500).json({ error: msg });
  }
});

// GET /api/convert/status — check if CloudConvert is configured
router.get("/status", requireAuth, async (req, res) => {
  if (!CC_KEY) return res.json({ configured: false });
  try {
    const r = await axios.get(`${CC_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${CC_KEY}` },
    });
    res.json({ configured: true, credits: r.data.data.credits, plan: r.data.data.plan });
  } catch {
    res.json({ configured: false });
  }
});

router.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File too large. Maximum 50MB." });
  if (err.message) return res.status(400).json({ error: err.message });
  next(err);
});

module.exports = router;
