const router = require("express").Router();
const { PDFDocument, rgb, StandardFonts, degrees } = require("pdf-lib");
const { pool } = require("../models/db");
const { requireAuth } = require("../middleware/auth");

// ── Helpers ───────────────────────────────────────────────────────────────────
function hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return rgb(r, g, b);
}

function formatMoney(amount, currency = "NGN") {
  const sym = { NGN: "₦", USD: "$", EUR: "€", GBP: "£", GHS: "₵" }[currency] || "";
  return `${sym}${Number(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function nextInvoiceNumber(userId) {
  const now = new Date();
  const y = now.getFullYear().toString().slice(2);
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const rand = Math.floor(Math.random() * 900 + 100);
  return `INV-${y}${m}-${rand}`;
}

// ── Generate PDF from invoice data ────────────────────────────────────────────
async function generateInvoicePDF(inv) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([595, 842]); // A4
  const { width, height } = page.getSize();

  const boldFont   = await pdf.embedFont(StandardFonts.HelveticaBold);
  const regularFont = await pdf.embedFont(StandardFonts.Helvetica);

  const brandColor = hexToRgb(inv.primary_color || "#00C9A7");
  const darkColor  = rgb(0.08, 0.08, 0.08);
  const grayColor  = rgb(0.45, 0.45, 0.45);
  const lightGray  = rgb(0.93, 0.93, 0.93);
  const white      = rgb(1, 1, 1);

  // ── Header band ──
  page.drawRectangle({ x: 0, y: height - 100, width, height: 100, color: brandColor });

  // Company name in header
  page.drawText(inv.from_name || "Your Company", {
    x: 36, y: height - 52,
    size: 22, font: boldFont, color: white,
  });

  // "INVOICE" label top right
  page.drawText("INVOICE", {
    x: width - 140, y: height - 44,
    size: 28, font: boldFont, color: rgb(1, 1, 1, 0.25),
  });

  // Invoice number & date
  page.drawText(inv.invoice_number || "INV-001", {
    x: width - 160, y: height - 64,
    size: 11, font: boldFont, color: white,
  });

  page.drawText(`Date: ${new Date(inv.created_at || Date.now()).toLocaleDateString("en-NG")}`, {
    x: width - 160, y: height - 80,
    size: 9, font: regularFont, color: rgb(1, 1, 1, 0.8),
  });

  if (inv.due_date) {
    page.drawText(`Due: ${new Date(inv.due_date).toLocaleDateString("en-NG")}`, {
      x: width - 160, y: height - 93,
      size: 9, font: regularFont, color: rgb(1, 1, 1, 0.8),
    });
  }

  // ── From / To section ──
  let y = height - 130;

  const drawLabel = (text, x, yPos) => page.drawText(text, { x, y: yPos, size: 8, font: boldFont, color: brandColor });
  const drawLine  = (text, x, yPos, size = 10) => page.drawText(text || "", { x, y: yPos, size, font: regularFont, color: darkColor });

  drawLabel("FROM", 36, y);
  drawLine(inv.from_name || "", 36, y - 14, 11);
  drawLine(inv.from_email || "", 36, y - 27);
  drawLine(inv.from_phone || "", 36, y - 39);
  if (inv.from_address) {
    const lines = inv.from_address.split("\n");
    lines.forEach((l, i) => drawLine(l, 36, y - 51 - i * 12));
  }

  drawLabel("BILL TO", 280, y);
  drawLine(inv.to_name || "", 280, y - 14, 11);
  drawLine(inv.to_email || "", 280, y - 27);
  if (inv.to_address) {
    const lines = inv.to_address.split("\n");
    lines.forEach((l, i) => drawLine(l, 280, y - 39 - i * 12));
  }

  // ── Items table ──
  y -= 100;

  // Table header
  page.drawRectangle({ x: 36, y: y - 2, width: width - 72, height: 22, color: brandColor });
  const headers = [["Description", 40], ["Qty", 320], ["Unit Price", 360], ["Amount", 460]];
  headers.forEach(([h, x]) =>
    page.drawText(h, { x, y: y + 5, size: 9, font: boldFont, color: white })
  );
  y -= 24;

  const items = Array.isArray(inv.items) ? inv.items : [];
  items.forEach((item, i) => {
    const rowBg = i % 2 === 0 ? lightGray : white;
    page.drawRectangle({ x: 36, y: y - 2, width: width - 72, height: 20, color: rowBg });

    const amount = (parseFloat(item.qty) || 0) * (parseFloat(item.price) || 0);
    page.drawText(String(item.description || "").slice(0, 55), { x: 40, y: y + 4, size: 9, font: regularFont, color: darkColor });
    page.drawText(String(item.qty || 1),                        { x: 320, y: y + 4, size: 9, font: regularFont, color: darkColor });
    page.drawText(formatMoney(item.price, inv.currency),        { x: 360, y: y + 4, size: 9, font: regularFont, color: darkColor });
    page.drawText(formatMoney(amount, inv.currency),            { x: 460, y: y + 4, size: 9, font: boldFont, color: darkColor });
    y -= 22;
  });

  // ── Totals box ──
  y -= 10;
  const totalsX = 360;

  const drawTotalRow = (label, value, bold = false, highlight = false) => {
    if (highlight) {
      page.drawRectangle({ x: totalsX - 4, y: y - 2, width: width - totalsX - 32, height: 20, color: brandColor });
    }
    const color = highlight ? white : (bold ? darkColor : grayColor);
    page.drawText(label, { x: totalsX, y: y + 4, size: 9, font: bold ? boldFont : regularFont, color });
    page.drawText(value, { x: 460, y: y + 4, size: 9, font: boldFont, color });
    y -= 22;
  };

  drawTotalRow("Subtotal", formatMoney(inv.subtotal, inv.currency));
  if (inv.tax_rate > 0) drawTotalRow(`VAT (${inv.tax_rate}%)`, formatMoney(inv.tax_amount, inv.currency));
  if (inv.discount > 0) drawTotalRow("Discount", `-${formatMoney(inv.discount, inv.currency)}`);
  drawTotalRow("TOTAL DUE", formatMoney(inv.total, inv.currency), true, true);

  // ── Notes ──
  if (inv.notes) {
    y -= 20;
    page.drawText("Notes:", { x: 36, y, size: 9, font: boldFont, color: brandColor });
    y -= 14;
    const noteLines = inv.notes.split("\n").slice(0, 4);
    noteLines.forEach(l => {
      page.drawText(l.slice(0, 90), { x: 36, y, size: 8, font: regularFont, color: grayColor });
      y -= 12;
    });
  }

  // ── Footer ──
  page.drawLine({ start: { x: 36, y: 50 }, end: { x: width - 36, y: 50 }, thickness: 0.5, color: lightGray });
  page.drawText("Generated by StatementIQ · statementiq.com", {
    x: 36, y: 36, size: 8, font: regularFont, color: lightGray,
  });
  page.drawText("Thank you for your business!", {
    x: width - 200, y: 36, size: 8, font: boldFont, color: brandColor,
  });

  return await pdf.save();
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/invoices — list user's invoices
router.get("/", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id,invoice_number,status,to_name,total,currency,due_date,created_at FROM invoices WHERE user_id=$1 ORDER BY created_at DESC",
    [req.user.id]
  );
  res.json({ invoices: rows });
});

// POST /api/invoices — create invoice
router.post("/", requireAuth, async (req, res) => {
  const d = req.body;
  const invoiceNumber = d.invoice_number || nextInvoiceNumber(req.user.id);

  // Calculate totals
  const items = Array.isArray(d.items) ? d.items : [];
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.price)||0), 0);
  const taxAmount = subtotal * (parseFloat(d.tax_rate)||0) / 100;
  const discount  = parseFloat(d.discount) || 0;
  const total     = subtotal + taxAmount - discount;

  const { rows } = await pool.query(
    `INSERT INTO invoices
     (user_id,invoice_number,status,from_name,from_email,from_address,from_phone,
      to_name,to_email,to_address,items,subtotal,tax_rate,tax_amount,discount,total,
      currency,notes,due_date,logo_url,primary_color,template)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
     RETURNING *`,
    [req.user.id, invoiceNumber, d.status||"draft",
     d.from_name, d.from_email, d.from_address, d.from_phone,
     d.to_name, d.to_email, d.to_address,
     JSON.stringify(items), subtotal, d.tax_rate||0, taxAmount, discount, total,
     d.currency||"NGN", d.notes, d.due_date||null,
     d.logo_url, d.primary_color||"#00C9A7", d.template||"modern"]
  );
  res.json({ invoice: rows[0] });
});

// PUT /api/invoices/:id — update invoice
router.put("/:id", requireAuth, async (req, res) => {
  const d = req.body;
  const items = Array.isArray(d.items) ? d.items : [];
  const subtotal = items.reduce((s, i) => s + (parseFloat(i.qty)||0) * (parseFloat(i.price)||0), 0);
  const taxAmount = subtotal * (parseFloat(d.tax_rate)||0) / 100;
  const discount  = parseFloat(d.discount) || 0;
  const total     = subtotal + taxAmount - discount;

  const { rows } = await pool.query(
    `UPDATE invoices SET
     status=$1,from_name=$2,from_email=$3,from_address=$4,from_phone=$5,
     to_name=$6,to_email=$7,to_address=$8,items=$9,subtotal=$10,
     tax_rate=$11,tax_amount=$12,discount=$13,total=$14,currency=$15,
     notes=$16,due_date=$17,logo_url=$18,primary_color=$19,template=$20,
     updated_at=NOW()
     WHERE id=$21 AND user_id=$22 RETURNING *`,
    [d.status||"draft", d.from_name, d.from_email, d.from_address, d.from_phone,
     d.to_name, d.to_email, d.to_address, JSON.stringify(items),
     subtotal, d.tax_rate||0, taxAmount, discount, total,
     d.currency||"NGN", d.notes, d.due_date||null,
     d.logo_url, d.primary_color||"#00C9A7", d.template||"modern",
     req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Invoice not found." });
  res.json({ invoice: rows[0] });
});

// GET /api/invoices/:id — get single invoice
router.get("/:id", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found." });
  res.json({ invoice: rows[0] });
});

// DELETE /api/invoices/:id
router.delete("/:id", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]);
  res.json({ success: true });
});

// GET /api/invoices/:id/pdf — generate and download PDF
router.get("/:id/pdf", requireAuth, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT * FROM invoices WHERE id=$1 AND user_id=$2", [req.params.id, req.user.id]
  );
  if (!rows.length) return res.status(404).json({ error: "Not found." });

  try {
    const inv = rows[0];
    inv.items = typeof inv.items === "string" ? JSON.parse(inv.items) : inv.items;
    const pdfBytes = await generateInvoicePDF(inv);

    // Save to dashboard
    try {
      const b64 = Buffer.from(pdfBytes).toString("base64");
      await pool.query(
        `INSERT INTO saved_files (user_id,title,document_type,original_filename,export_type,file_data,file_size,mime_type)
         VALUES ($1,$2,'Invoice',$3,'invoice',$4,$5,'application/pdf')`,
        [req.user.id, `Invoice ${inv.invoice_number}`, `${inv.invoice_number}.pdf`, b64, pdfBytes.length]
      );
    } catch (_) {}

    res.set({
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${inv.invoice_number}.pdf"`,
      "Content-Length": pdfBytes.length,
    });
    res.send(Buffer.from(pdfBytes));
  } catch (err) {
    console.error("Invoice PDF error:", err.message);
    res.status(500).json({ error: "Failed to generate PDF." });
  }
});

module.exports = router;
