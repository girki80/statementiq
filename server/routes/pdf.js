const router = require("express").Router();
const multer = require("multer");
const { PDFDocument, degrees, rgb, StandardFonts } = require("pdf-lib");
const sharp = require("sharp");
const { requireAuth, requireQuota } = require("../middleware/auth");
const { pool } = require("../models/db");

// Multer — memory storage, accept PDF and images, 50MB max per file
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    const ok = [
      "application/pdf",
      "image/jpeg", "image/jpg", "image/png",
      "image/webp", "image/gif", "image/tiff",
    ].includes(file.mimetype);
    cb(null, ok ? true : new Error("Unsupported file type."));
  },
});

const uploadMulti = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, file.mimetype === "application/pdf"),
});

// Helper: send PDF response
function sendPDF(res, pdfBytes, filename) {
  res.set({
    "Content-Type": "application/pdf",
    "Content-Disposition": `attachment; filename="${filename}"`,
    "Content-Length": pdfBytes.length,
  });
  res.send(Buffer.from(pdfBytes));
}

// Helper: log tool usage
async function logTool(userId, tool) {
  try {
    await pool.query(
      "INSERT INTO conversions (user_id, file_name, document_type, title, export_type) VALUES ($1,$2,$3,$4,$5)",
      [userId, tool, "PDF Tool", tool, tool]
    );
  } catch (_) {}
}

// ── MERGE PDF ────────────────────────────────────────────────────────────────
// POST /api/pdf/merge — accepts multiple PDF files, returns merged PDF
router.post("/merge", requireAuth, requireQuota, uploadMulti.array("files", 20), async (req, res) => {
  if (!req.files || req.files.length < 2) {
    return res.status(400).json({ error: "Please upload at least 2 PDF files to merge." });
  }
  try {
    const merged = await PDFDocument.create();
    for (const file of req.files) {
      const doc = await PDFDocument.load(file.buffer);
      const pages = await merged.copyPages(doc, doc.getPageIndices());
      pages.forEach(p => merged.addPage(p));
    }
    const pdfBytes = await merged.save();

    // Deduct usage
    if (req.useCredit) {
      await pool.query("UPDATE users SET credits = credits - 1 WHERE id=$1", [req.user.id]);
    } else {
      await pool.query("UPDATE users SET conversations_used = conversations_used + 1 WHERE id=$1", [req.user.id]);
    }
    await logTool(req.user.id, "merge");
    sendPDF(res, pdfBytes, "merged.pdf");
  } catch (err) {
    console.error("Merge error:", err.message);
    res.status(500).json({ error: "Failed to merge PDFs. Make sure all files are valid PDFs." });
  }
});

// ── SPLIT PDF ────────────────────────────────────────────────────────────────
// POST /api/pdf/split — returns JSON with base64 pages
// Client downloads each page individually
router.post("/split", requireAuth, requireQuota, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please upload a PDF file." });
  const { pages } = req.body; // optional: "1,3,5-7" range string
  try {
    const doc = await PDFDocument.load(req.file.buffer);
    const total = doc.getPageCount();

    // Parse page ranges or split all
    let pageIndices = [];
    if (pages && pages.trim()) {
      const parts = pages.split(",");
      for (const part of parts) {
        if (part.includes("-")) {
          const [start, end] = part.split("-").map(n => parseInt(n.trim()) - 1);
          for (let i = start; i <= Math.min(end, total - 1); i++) pageIndices.push(i);
        } else {
          const n = parseInt(part.trim()) - 1;
          if (n >= 0 && n < total) pageIndices.push(n);
        }
      }
    } else {
      pageIndices = Array.from({ length: total }, (_, i) => i);
    }

    // Create individual PDFs per page
    const results = [];
    for (const idx of pageIndices) {
      const single = await PDFDocument.create();
      const [copied] = await single.copyPages(doc, [idx]);
      single.addPage(copied);
      const bytes = await single.save();
      results.push({
        page: idx + 1,
        filename: `page_${idx + 1}.pdf`,
        data: Buffer.from(bytes).toString("base64"),
      });
    }

    if (req.useCredit) {
      await pool.query("UPDATE users SET credits = credits - 1 WHERE id=$1", [req.user.id]);
    } else {
      await pool.query("UPDATE users SET conversations_used = conversations_used + 1 WHERE id=$1", [req.user.id]);
    }
    await logTool(req.user.id, "split");
    res.json({ success: true, total, pages: results });
  } catch (err) {
    console.error("Split error:", err.message);
    res.status(500).json({ error: "Failed to split PDF." });
  }
});

// ── COMPRESS PDF ─────────────────────────────────────────────────────────────
// POST /api/pdf/compress — reduces PDF size by re-saving with compression
router.post("/compress", requireAuth, requireQuota, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please upload a PDF file." });
  try {
    const doc = await PDFDocument.load(req.file.buffer, { updateMetadata: false });

    // Remove metadata to reduce size
    doc.setTitle("");
    doc.setAuthor("");
    doc.setSubject("");
    doc.setKeywords([]);
    doc.setProducer("");
    doc.setCreator("");

    const pdfBytes = await doc.save({
      useObjectStreams: true,   // best compression available in pdf-lib
      addDefaultPage: false,
      objectsPerTick: 50,
    });

    const originalSize = req.file.buffer.length;
    const newSize = pdfBytes.length;
    const reduction = Math.round((1 - newSize / originalSize) * 100);

    if (req.useCredit) {
      await pool.query("UPDATE users SET credits = credits - 1 WHERE id=$1", [req.user.id]);
    } else {
      await pool.query("UPDATE users SET conversations_used = conversations_used + 1 WHERE id=$1", [req.user.id]);
    }
    await logTool(req.user.id, "compress");

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="compressed.pdf"`,
      "Content-Length": pdfBytes.length,
      "X-Original-Size": originalSize,
      "X-Compressed-Size": newSize,
      "X-Reduction-Percent": reduction,
    });
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Compress error:", err.message);
    res.status(500).json({ error: "Failed to compress PDF." });
  }
});

// ── IMAGE TO PDF ─────────────────────────────────────────────────────────────
// POST /api/pdf/image-to-pdf — converts 1 or more images to a PDF
router.post("/image-to-pdf", requireAuth, requireQuota, upload.array("files", 20), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Please upload at least one image." });
  }
  try {
    const pdf = await PDFDocument.create();
    for (const file of req.files) {
      // Convert any image format to JPEG via sharp for consistent embedding
      const jpegBuf = await sharp(file.buffer)
        .rotate() // auto-rotate based on EXIF
        .jpeg({ quality: 90 })
        .toBuffer();

      const img = await pdf.embedJpg(jpegBuf);
      // A4 size in points: 595 x 842
      const A4_W = 595, A4_H = 842;
      const scale = Math.min(A4_W / img.width, A4_H / img.height);
      const w = img.width * scale;
      const h = img.height * scale;
      const x = (A4_W - w) / 2;
      const y = (A4_H - h) / 2;

      const page = pdf.addPage([A4_W, A4_H]);
      page.drawImage(img, { x, y, width: w, height: h });
    }

    const pdfBytes = await pdf.save();

    if (req.useCredit) {
      await pool.query("UPDATE users SET credits = credits - 1 WHERE id=$1", [req.user.id]);
    } else {
      await pool.query("UPDATE users SET conversations_used = conversations_used + 1 WHERE id=$1", [req.user.id]);
    }
    await logTool(req.user.id, "image-to-pdf");
    sendPDF(res, pdfBytes, "images.pdf");
  } catch (err) {
    console.error("Image to PDF error:", err.message);
    res.status(500).json({ error: "Failed to convert images to PDF." });
  }
});

// ── ROTATE PDF ───────────────────────────────────────────────────────────────
// POST /api/pdf/rotate — rotate all pages or specific pages
router.post("/rotate", requireAuth, requireQuota, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please upload a PDF file." });
  const angle = parseInt(req.body.angle) || 90; // 90, 180, 270
  try {
    const doc = await PDFDocument.load(req.file.buffer);
    const pages = doc.getPages();
    pages.forEach(page => {
      const current = page.getRotation().angle;
      page.setRotation(degrees((current + angle) % 360));
    });
    const pdfBytes = await doc.save();

    if (req.useCredit) {
      await pool.query("UPDATE users SET credits = credits - 1 WHERE id=$1", [req.user.id]);
    } else {
      await pool.query("UPDATE users SET conversations_used = conversations_used + 1 WHERE id=$1", [req.user.id]);
    }
    await logTool(req.user.id, "rotate");
    sendPDF(res, pdfBytes, "rotated.pdf");
  } catch (err) {
    res.status(500).json({ error: "Failed to rotate PDF." });
  }
});

// ── ADD WATERMARK ────────────────────────────────────────────────────────────
// POST /api/pdf/watermark — adds diagonal text watermark to all pages
router.post("/watermark", requireAuth, requireQuota, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Please upload a PDF file." });
  const text = req.body.text || "CONFIDENTIAL";
  const opacity = parseFloat(req.body.opacity) || 0.25;
  try {
    const doc = await PDFDocument.load(req.file.buffer);
    const font = await doc.embedFont(StandardFonts.HelveticaBold);
    const pages = doc.getPages();

    pages.forEach(page => {
      const { width, height } = page.getSize();
      const fontSize = Math.min(width, height) * 0.08;
      const textWidth = font.widthOfTextAtSize(text, fontSize);
      page.drawText(text, {
        x: (width - textWidth) / 2,
        y: height / 2,
        size: fontSize,
        font,
        color: rgb(0.5, 0.5, 0.5),
        opacity,
        rotate: degrees(45),
      });
    });

    const pdfBytes = await doc.save();
    if (req.useCredit) {
      await pool.query("UPDATE users SET credits = credits - 1 WHERE id=$1", [req.user.id]);
    } else {
      await pool.query("UPDATE users SET conversations_used = conversations_used + 1 WHERE id=$1", [req.user.id]);
    }
    await logTool(req.user.id, "watermark");
    sendPDF(res, pdfBytes, "watermarked.pdf");
  } catch (err) {
    res.status(500).json({ error: "Failed to add watermark." });
  }
});

// ── PDF INFO ─────────────────────────────────────────────────────────────────
// POST /api/pdf/info — returns page count, size, metadata (no credit used)
router.post("/info", requireAuth, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  try {
    const doc = await PDFDocument.load(req.file.buffer);
    const pages = doc.getPages();
    res.json({
      pageCount: doc.getPageCount(),
      title: doc.getTitle() || "",
      author: doc.getAuthor() || "",
      fileSizeKB: Math.round(req.file.buffer.length / 1024),
      pages: pages.map((p, i) => ({
        index: i + 1,
        width: Math.round(p.getWidth()),
        height: Math.round(p.getHeight()),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: "Could not read PDF." });
  }
});

// Error handler for this router
router.use((err, req, res, next) => {
  if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File too large. Maximum size is 50MB." });
  if (err.code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: "Too many files. Maximum is 20." });
  if (err.message) return res.status(400).json({ error: err.message });
  next(err);
});

module.exports = router;
