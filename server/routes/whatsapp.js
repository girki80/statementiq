const router = require("express").Router();
const axios = require("axios");
const Anthropic = require("@anthropic-ai/sdk");
const { pool } = require("../models/db");

const WA_TOKEN    = process.env.WHATSAPP_TOKEN;
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID;
const WA_VERIFY   = process.env.WHATSAPP_VERIFY_TOKEN;
const client      = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Send WhatsApp message ─────────────────────────────────────────────────────
async function sendMessage(to, text) {
  if (!WA_TOKEN || !WA_PHONE_ID) return;
  await axios.post(
    `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`,
    { messaging_product: "whatsapp", to, type: "text", text: { body: text } },
    { headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" } }
  ).catch(e => console.error("WA send error:", e.response?.data || e.message));
}

// ── Send WhatsApp document ────────────────────────────────────────────────────
async function sendDocument(to, buffer, filename, caption) {
  if (!WA_TOKEN || !WA_PHONE_ID) return;
  try {
    // Upload media first
    const FormData = require("form-data");
    const fd = new FormData();
    fd.append("file", buffer, { filename, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    fd.append("messaging_product", "whatsapp");

    const uploadRes = await axios.post(
      `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/media`,
      fd,
      { headers: { ...fd.getHeaders(), Authorization: `Bearer ${WA_TOKEN}` } }
    );
    const mediaId = uploadRes.data.id;

    // Send as document
    await axios.post(
      `https://graph.facebook.com/v19.0/${WA_PHONE_ID}/messages`,
      { messaging_product: "whatsapp", to, type: "document",
        document: { id: mediaId, filename, caption } },
      { headers: { Authorization: `Bearer ${WA_TOKEN}`, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("WA doc send error:", e.response?.data || e.message);
    await sendMessage(to, `✅ Extraction complete! Unfortunately I couldn't send the file directly. Please visit statementiq.com to download your Excel file.`);
  }
}

// ── Download media from WhatsApp ──────────────────────────────────────────────
async function downloadMedia(mediaId) {
  const urlRes = await axios.get(`https://graph.facebook.com/v19.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${WA_TOKEN}` } }
  );
  const fileRes = await axios.get(urlRes.data.url, {
    headers: { Authorization: `Bearer ${WA_TOKEN}` },
    responseType: "arraybuffer",
  });
  return Buffer.from(fileRes.data);
}

// ── Get or create WhatsApp session ───────────────────────────────────────────
async function getSession(phone) {
  const { rows } = await pool.query(
    "SELECT * FROM whatsapp_sessions WHERE phone=$1", [phone]
  );
  if (rows.length) {
    // Reset daily count if new day
    const today = new Date().toISOString().split("T")[0];
    if (rows[0].last_extraction_date?.toISOString().split("T")[0] !== today) {
      await pool.query(
        "UPDATE whatsapp_sessions SET extractions_today=0, last_extraction_date=CURRENT_DATE WHERE phone=$1",
        [phone]
      );
      rows[0].extractions_today = 0;
    }
    return rows[0];
  }
  const { rows: newRows } = await pool.query(
    "INSERT INTO whatsapp_sessions (phone) VALUES ($1) RETURNING *", [phone]
  );
  return newRows[0];
}

// ── AI extraction for WhatsApp ────────────────────────────────────────────────
async function extractForWhatsApp(buffer, mimetype) {
  const base64 = buffer.toString("base64");
  const isImage = mimetype.startsWith("image/");

  const msg = await client.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 3000,
    messages: [{
      role: "user",
      content: [
        isImage
          ? { type: "image", source: { type: "base64", media_type: mimetype, data: base64 } }
          : { type: "document", source: { type: "base64", media_type: "application/pdf", data: base64 } },
        { type: "text", text: `Extract tabular data from this financial document.
Return ONLY valid JSON:
{
  "document_type": "Bank Statement | Invoice | Receipt | Other",
  "title": "short title",
  "summary": { "total_transactions": 0, "total_credits": null, "total_debits": null, "closing_balance": null, "period": null },
  "headers": ["Col1","Col2"],
  "rows": [["val1","val2"]]
}` }
      ],
    }],
  });

  const raw = msg.content.find(b => b.type === "text")?.text || "";
  return JSON.parse(raw.replace(/```json|```/g, "").trim());
}

// ── Build Excel from extracted data ──────────────────────────────────────────
function buildSimpleExcel(parsed) {
  // We use a minimal XLSX writer (no external dep needed for simple cases)
  // Returns a base64 string that we decode to buffer
  const rows = [parsed.headers, ...parsed.rows];
  // Build CSV as fallback — proper XLSX needs the xlsx library
  const csv = rows.map(r => r.map(c => `"${String(c||"").replace(/"/g,'""')}"`).join(",")).join("\n");
  return Buffer.from(csv, "utf-8");
}

// ── Format summary message ────────────────────────────────────────────────────
function formatSummary(parsed) {
  const s = parsed.summary || {};
  const lines = [
    `📊 *${parsed.title || parsed.document_type}*`,
    ``,
    `📁 Type: ${parsed.document_type}`,
  ];
  if (s.period)             lines.push(`📅 Period: ${s.period}`);
  if (s.total_transactions) lines.push(`🔢 Transactions: ${s.total_transactions}`);
  if (s.total_credits)      lines.push(`⬆️ Credits: ${s.total_credits}`);
  if (s.total_debits)       lines.push(`⬇️ Debits: ${s.total_debits}`);
  if (s.closing_balance)    lines.push(`💰 Balance: ${s.closing_balance}`);
  lines.push(``, `✅ Sending your Excel file now...`);
  return lines.join("\n");
}

// ── WELCOME message ───────────────────────────────────────────────────────────
const WELCOME = `👋 Welcome to *StatementIQ Bot*!

I convert bank statements and invoices into Excel files automatically.

*How to use:*
📎 Send me any PDF or image of a bank statement, invoice, or receipt
📊 I'll extract the data and send back an Excel file

*Free tier:* 3 conversions per day
💳 Upgrade at statementiq.com for unlimited

Just send your document to get started!`;

const HELP = `*StatementIQ Bot Commands:*

📎 Send a PDF/image → Get Excel file
*help* → Show this message
*status* → Check your usage today
*website* → Visit StatementIQ

Supported: GTB, Access, Zenith, UBA, First Bank and all Nigerian banks 🇳🇬`;

// ── WEBHOOK VERIFY (GET) ──────────────────────────────────────────────────────
router.get("/", (req, res) => {
  const mode      = req.query["hub.mode"];
  const token     = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WA_VERIFY) {
    console.log("✅ WhatsApp webhook verified");
    return res.status(200).send(challenge);
  }
  res.status(403).send("Forbidden");
});

// ── WEBHOOK HANDLER (POST) ────────────────────────────────────────────────────
router.post("/", async (req, res) => {
  res.status(200).send("OK"); // Acknowledge immediately

  try {
    const body = req.body;
    if (body.object !== "whatsapp_business_account") return;

    const entry   = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value   = changes?.value;
    const message = value?.messages?.[0];

    if (!message) return;

    const phone = message.from;
    const session = await getSession(phone);
    const FREE_LIMIT = 3;

    // ── Text commands ──
    if (message.type === "text") {
      const text = message.text.body.trim().toLowerCase();

      if (text === "start" || text === "hi" || text === "hello" || session.extractions_today === 0 && text.length < 20) {
        await sendMessage(phone, WELCOME);
        return;
      }
      if (text === "help") {
        await sendMessage(phone, HELP);
        return;
      }
      if (text === "status") {
        const remaining = Math.max(0, FREE_LIMIT - (session.extractions_today || 0));
        await sendMessage(phone, `📊 *Your Usage Today*\n\nConversions used: ${session.extractions_today || 0}/${FREE_LIMIT}\nRemaining: ${remaining}\n\nUpgrade for unlimited: statementiq.com/pricing`);
        return;
      }
      if (text === "website") {
        await sendMessage(phone, "🌐 Visit us at: https://statementiq.com");
        return;
      }
      // Default response for unrecognised text
      await sendMessage(phone, `📎 Please send me a PDF or image of your bank statement or invoice and I'll convert it to Excel for you!\n\nType *help* for commands.`);
      return;
    }

    // ── Document or image ──
    if (message.type === "document" || message.type === "image") {
      // Check daily limit
      if ((session.extractions_today || 0) >= FREE_LIMIT) {
        await sendMessage(phone, `⚠️ You've used all ${FREE_LIMIT} free conversions today.\n\n💳 Upgrade for unlimited conversions at:\nstatementiq.com/pricing\n\nYour limit resets tomorrow at midnight.`);
        return;
      }

      await sendMessage(phone, "⏳ Got it! Extracting data from your document...\nThis usually takes 10–20 seconds.");

      let mediaId, mimetype;
      if (message.type === "document") {
        mediaId  = message.document.id;
        mimetype = message.document.mime_type;
      } else {
        mediaId  = message.image.id;
        mimetype = message.image.mime_type || "image/jpeg";
      }

      // Only process PDFs and images
      const supported = ["application/pdf","image/jpeg","image/png","image/webp"];
      if (!supported.includes(mimetype)) {
        await sendMessage(phone, "❌ Sorry, I can only process PDF files and images (JPG, PNG, WebP).\n\nPlease send your bank statement as a PDF or photo.");
        return;
      }

      // Download the file
      const fileBuffer = await downloadMedia(mediaId);

      // Extract data with AI
      const parsed = await extractForWhatsApp(fileBuffer, mimetype);

      // Send summary
      await sendMessage(phone, formatSummary(parsed));

      // Build and send Excel
      // Note: For a proper xlsx we'd use the xlsx library
      // This sends CSV which Excel opens natively
      const csvBuffer = buildSimpleExcel(parsed);
      const filename  = `${(parsed.title || "statement").replace(/[^a-z0-9]/gi,"_")}.csv`;
      await sendDocument(phone, csvBuffer, filename, `📊 ${parsed.title || "Extracted Data"} — ${parsed.rows?.length || 0} rows extracted`);

      // Update session counter
      await pool.query(
        "UPDATE whatsapp_sessions SET extractions_today=extractions_today+1, updated_at=NOW() WHERE phone=$1",
        [phone]
      );

      const remaining = FREE_LIMIT - ((session.extractions_today || 0) + 1);
      if (remaining > 0) {
        await sendMessage(phone, `✅ Done! You have *${remaining} free conversion${remaining!==1?"s":""} remaining* today.\n\nNeed unlimited? Upgrade at statementiq.com`);
      } else {
        await sendMessage(phone, `✅ Done! That was your last free conversion for today.\n\n💳 Upgrade for unlimited:\nstatementiq.com/pricing`);
      }
    }

  } catch (err) {
    console.error("WhatsApp webhook error:", err.message);
  }
});

module.exports = router;
