require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const rateLimit = require("express-rate-limit");
const { initDB } = require("./models/db");

const app = express();
const PORT = process.env.PORT || 3001;

// Trust Render's proxy so req.ip and rate limiting work correctly
app.set("trust proxy", 1);

// ── Paystack webhook needs raw body — MUST be before express.json() ──────────
app.use("/api/payments/webhook", express.raw({ type: "application/json" }));

// ── General middleware ────────────────────────────────────────────────────────
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth",      require("./routes/auth"));
app.use("/api/payments",  require("./routes/payments"));
app.use("/api/pdf",       require("./routes/pdf"));
app.use("/api/convert",   require("./routes/convert"));
app.use("/api/invoices",  require("./routes/invoices"));
app.use("/api/whatsapp",  require("./routes/whatsapp"));
app.use("/api",           require("./routes/extract"));

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ── Serve React frontend in production ────────────────────────────────────────
const distPath = path.join(__dirname, "../client/dist");
app.use(express.static(distPath));
app.get("*", (_, res) => res.sendFile(path.join(distPath, "index.html")));

// ── Start server ──────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`✅ StatementIQ running on port ${PORT}`);

    // Self-ping every 14 minutes to prevent Render free tier sleep
    if (process.env.NODE_ENV === "production" && process.env.CLIENT_URL) {
      const https = require("https");
      const http = require("http");
      setInterval(() => {
        const url = process.env.CLIENT_URL;
        const lib = url.startsWith("https") ? https : http;
        lib.get(`${url}/api/health`, (res) => {
          console.log(`🏓 Self-ping OK: ${res.statusCode}`);
        }).on("error", (e) => {
          console.log(`🏓 Ping error: ${e.message}`);
        });
      }, 14 * 60 * 1000);
    }
  });
}).catch(err => {
  console.error("❌ Failed to start:", err);
  process.exit(1);
});
