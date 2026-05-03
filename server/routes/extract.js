const router = require("express").Router();
const multer = require("multer");
const Anthropic = require("@anthropic-ai/sdk");
const Tesseract = require("tesseract.js");
const sharp = require("sharp");
const { PDFDocument } = require("pdf-lib");
const { pool } = require("../models/db");
const { requireAuth, requireQuota, SAVED_FILE_LIMITS } = require("../middleware/auth");
const { buildStyledXLSX } = require("../utils/excelFormatter");

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    ["application/pdf","image/png","image/jpeg","image/webp"].includes(file.mimetype)
      ? cb(null, true) : cb(null, false);
  },
});

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── OCR helpers ───────────────────────────────────────────────────────────────
async function isScannedPDF(buffer) {
  try {
    const doc = await PDFDocument.load(buffer);
    const pages = doc.getPageCount();
    const sizePerPage = buffer.length / pages;
    return sizePerPage > 200 * 1024;
  } catch { return false; }
}

async function runOCR(imageBuffer) {
  try {
    const pngBuffer = await sharp(imageBuffer)
      .resize({ width: 2000, withoutEnlargement: true })
      .sharpen()
      .png()
      .toBuffer();
    const { data: { text } } = await Tesseract.recognize(pngBuffer, "eng", { logger: () => {} });
    return text.trim();
  } catch (err) {
    console.error("OCR error:", err.message);
    return null;
  }
}

async function pdfPageToImage(buffer) {
  try {
    return await sharp(buffer, { density: 200 }).png().toBuffer();
  } catch { return null; }
}

// ── Main extraction ───────────────────────────────────────────────────────────
async function extract(file) {
  const base64 = file.buffer.toString("base64");
  const isImage = file.mimetype.startsWith("image/");
  const isPDF = file.mimetype === "application/pdf";

  let ocrText = null;
  let useOCR = false;

  if (isImage) {
    ocrText = await runOCR(file.buffer);
    useOCR = !!(ocrText && ocrText.length > 50);
  }

  if (isPDF) {
    const scanned = await isScannedPDF(file.buffer);
    if (scanned) {
      const imgBuf = await pdfPageToImage(file.buffer);
      if (imgBuf) {
        ocrText = await runOCR(imgBuf);
        useOCR = !!(ocrText && ocrText.length > 50);
      }
    }
  }

  const ocrHint = useOCR
    ? `\n\nOCR TEXT (extracted from scanned document):\n${ocrText.slice(0, 8000)}\n\nUse this as primary source and verify against the document image.`
    : "";

  const prompt = `Extract ALL tabular data from this financial document (file: ${file.originalname}).${ocrHint}

Return ONLY valid JSON — no markdown, no backticks.
{
  "document_type": "Bank Statement | Invoice | Receipt | Other",
  "title": "descriptive title",
  "detected_currency": "NGN|USD|EUR|GBP|GHS|KES|ZAR|unknown",
  "ocr_used": ${useOCR},
  "metadata": { "key": "value" },
  "summary": {
    "total_transactions": 0,
    "total_credits": "string or null",
    "total_debits": "string or null",
    "closing_balance": "string or null",
    "period": "string or null"
  },
  "sheets": [{ "name": "sheet name", "headers": ["Col1","Col2"], "rows": [["v1","v2"]] }]
}`;

  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: [
        isImage
          ? { type: "image", source: { type: "base64", media_type: file.mimetype, data: base64 } }
          : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: prompt },
      ],
    }],
  });

  const raw = msg.content.find(b => b.type === "text")?.text || "";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ── Save to dashboard ─────────────────────────────────────────────────────────
async function saveFile(userId, plan, data) {
  try {
    const limit = SAVED_FILE_LIMITS[plan] ?? 5;
    if (limit !== Infinity) {
      const { rows } = await pool.query(
        "SELECT COUNT(*) FROM saved_files WHERE user_id=$1 AND expires_at > NOW()", [userId]
      );
      if (parseInt(rows[0].count) >= limit) {
        await pool.query(
          "DELETE FROM saved_files WHERE id=(SELECT id FROM saved_files WHERE user_id=$1 ORDER BY created_at ASC LIMIT 1)",
          [userId]
        );
      }
    }
    const { rows } = await pool.query(
      `INSERT INTO saved_files (user_id,title,document_type,original_filename,export_type,file_data,file_size,mime_type,metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [userId, data.title, data.documentType, data.originalFilename, data.exportType,
       data.fileData, data.fileSize, data.mimeType, JSON.stringify(data.metadata || {})]
    );
    return rows[0].id;
  } catch (err) { console.error("Save file error:", err.message); return null; }
}

// ── Demo extraction ───────────────────────────────────────────────────────────
const demoSessions = new Map();
router.post("/demo/extract", upload.single("file"), async (req, res) => {
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
  const count = demoSessions.get(ip) || 0;
  if (count >= 3) return res.status(403).json({ error: "demo_limit" });
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const parsed = await extract(req.file);
    parsed._demo = true;
    demoSessions.set(ip, count + 1);
    setTimeout(() => demoSessions.delete(ip), 3600000);
    res.json({ success: true, data: parsed, remaining: 2 - count });
  } catch (err) {
    res.status(500).json({ error: "Extraction failed. Please try again." });
  }
});

// ── Authenticated extraction ──────────────────────────────────────────────────
router.post("/extract", requireAuth, requireQuota, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const parsed = await extract(req.file);
    if (req.useCredit) {
      await pool.query("UPDATE users SET credits=credits-1 WHERE id=$1", [req.user.id]);
    } else {
      await pool.query("UPDATE users SET conversations_used=conversations_used+1 WHERE id=$1", [req.user.id]);
    }
    await pool.query(
      "INSERT INTO conversions (user_id,file_name,document_type,title,export_type) VALUES ($1,$2,$3,$4,'extract')",
      [req.user.id, req.file.originalname, parsed.document_type, parsed.title]
    );
    const { rows } = await pool.query("SELECT credits,conversations_used,plan FROM users WHERE id=$1", [req.user.id]);
    res.json({ success:true, data:parsed, usage:rows[0], ocr_used:parsed.ocr_used||false });
  } catch (err) {
    console.error("Extract error:", err.message);
    res.status(500).json({ error: "Extraction failed. Please try a different file." });
  }
});

// ── Styled Excel download ─────────────────────────────────────────────────────
// POST /api/download-xlsx
// Takes the parsed extraction result + column maps + options
// Returns a professionally styled .xlsx matching JOPAR BROTHERS format
router.post("/download-xlsx", requireAuth, async (req, res) => {
  const { parsed, columnMaps, currencySymbol, companyName, firmName } = req.body;
  if (!parsed || !parsed.sheets) return res.status(400).json({ error: "No data provided." });

  try {
    // Get firm branding if user has a firm
    let resolvedFirmName = firmName;
    if (!resolvedFirmName && req.user.firm_id) {
      const { rows } = await pool.query("SELECT name FROM firms WHERE id=$1", [req.user.firm_id]);
      if (rows.length) resolvedFirmName = rows[0].name;
    }

    // Build account info line from metadata
    const meta = parsed.metadata || {};
    const accountParts = [
      meta["Account Number"] && `Account: ${meta["Account Number"]}`,
      meta["Account Name"] && meta["Account Name"],
      meta["Currency"]     && `Currency: ${meta["Currency"]}`,
      meta["Bank"]         && meta["Bank"],
      meta["Period"]       || parsed.summary?.period,
    ].filter(Boolean);
    const accountInfo = accountParts.join("  |  ") || parsed.title || "Bank Statement";

    // Use the first sheet for now; multi-sheet if multiple
    const sheet = parsed.sheets[0];
    if (!sheet) return res.status(400).json({ error: "No sheet data found." });

    // Apply column mapping if provided
    const maps = columnMaps?.[0] || sheet.headers.map((h, i) => ({ label: h, index: i, enabled: true }));
    const enabledCols = maps.filter(c => c.enabled);
    const headers = enabledCols.map(c => c.label);

    // Build rows applying column map and currency formatting
    const isMoneyHeader = (h) => /pay in|pay out|balance|debit|credit|amount|total|charge|fee/i.test(h);
    const fmtVal = (val, header) => {
      if (!isMoneyHeader(header)) return val ?? "";
      if (val === null || val === undefined || val === "") return null;
      const clean = String(val).replace(/[₦$€£₵,\s]/g, "").replace(/[()]/g, "-");
      const num = parseFloat(clean);
      return isNaN(num) ? val : num;
    };

    const rows = sheet.rows.map(row =>
      enabledCols.map(c => fmtVal(row[c.index], c.label))
    );

    // Calculate totals for money columns
    const totals = {};
    enabledCols.forEach((col, ci) => {
      if (isMoneyHeader(col.label)) {
        const sum = rows.reduce((s, r) => {
          const v = parseFloat(r[ci]);
          return s + (isNaN(v) ? 0 : v);
        }, 0);
        totals[col.label] = sum;
      }
    });

    // Override closing balance total with last row value if present
    const balanceCol = enabledCols.findIndex(c => /balance/i.test(c.label));
    if (balanceCol >= 0 && rows.length > 0) {
      const lastVal = parseFloat(rows[rows.length - 1][balanceCol]);
      if (!isNaN(lastVal)) totals[enabledCols[balanceCol].label] = lastVal;
    }

    // Year/period for sheet name
    const period = parsed.summary?.period || meta["Period"] || "Statement";
    const yearMatch = period.match(/\b(20\d{2})\b/);
    const sheetName = yearMatch ? yearMatch[1] : period.slice(0, 31);

    // Build the styled Excel
    const buffer = await buildStyledXLSX({
      companyName: companyName || meta["Account Name"] || parsed.title || "Bank Statement",
      accountInfo,
      sheetName,
      headers,
      rows,
      totals,
      firmName: resolvedFirmName,
    });

    // Save to dashboard
    try {
      const b64 = buffer.toString("base64");
      const fname = `${(parsed.title || "statement").replace(/[^a-z0-9]/gi, "_")}.xlsx`;
      await pool.query(
        `INSERT INTO saved_files (user_id,title,document_type,original_filename,export_type,file_data,file_size,mime_type)
         VALUES ($1,$2,$3,$4,'xlsx',$5,$6,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')`,
        [req.user.id, parsed.title || "Bank Statement", parsed.document_type, fname, b64, buffer.length]
      );
    } catch (_) {} // don't fail download if save fails

    const safeName = (parsed.title || "statement").replace(/[^a-z0-9]/gi, "_");
    res.set({
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${safeName}.xlsx"`,
      "Content-Length": buffer.length,
    });
    res.send(buffer);

  } catch (err) {
    console.error("Download XLSX error:", err.message);
    res.status(500).json({ error: "Failed to generate Excel file." });
  }
});

// ── Saved files: save ─────────────────────────────────────────────────────────
router.post("/files/save", requireAuth, async (req, res) => {
  const id = await saveFile(req.user.id, req.user.plan, req.body);
  if (!id) return res.status(500).json({ error: "Failed to save file." });
  res.json({ success: true, id });
});

// ── Saved files: list ─────────────────────────────────────────────────────────
router.get("/files", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id,title,document_type,original_filename,export_type,file_size,mime_type,metadata,expires_at,created_at
     FROM saved_files WHERE user_id=$1 AND expires_at>NOW() ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json({ files:rows, limit:SAVED_FILE_LIMITS[req.user.plan]??5, count:rows.length });
});

// ── Saved files: download ─────────────────────────────────────────────────────
router.get("/files/:id/download", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM saved_files WHERE id=$1 AND user_id=$2 AND expires_at>NOW()",
    [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "File not found or expired." });
  const file = rows[0];
  const buf = Buffer.from(file.file_data, "base64");
  res.set({ "Content-Type":file.mime_type, "Content-Disposition":`attachment; filename="${file.original_filename}"`, "Content-Length":buf.length });
  res.send(buf);
});

// ── Saved files: delete ───────────────────────────────────────────────────────
router.delete("/files/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM saved_files WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ success: true });
});

router.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File too large. Max 20MB." });
  next(err);
});

module.exports = router;
