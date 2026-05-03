const router = require("express").Router();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const { pool } = require("../models/db");
const { requireAuth, PLAN_LIMITS } = require("../middleware/auth");

const signToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "30d" });
const safeUser = (u) => { const { password_hash, ...s } = u; return { ...s, limit: PLAN_LIMITS[u.plan] ?? 5 }; };

// Register
router.post("/register", async (req, res) => {
  const { email, password, name, ref } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });
  try {
    const hash = await bcrypt.hash(password, 10);
    const referralCode = uuidv4().slice(0, 8).toUpperCase();
    let referredBy = null;
    if (ref) {
      const { rows } = await pool.query("SELECT id FROM users WHERE referral_code=$1", [ref]);
      if (rows.length) referredBy = rows[0].id;
    }
    const { rows } = await pool.query(
      "INSERT INTO users (email, password_hash, name, referral_code, referred_by, credits) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *",
      [email.toLowerCase().trim(), hash, name || "", referralCode, referredBy, 3]
    );
    // Pay 20% commission to referrer
    if (referredBy) {
      await pool.query(
        "INSERT INTO affiliate_earnings (affiliate_id, referred_user_id, source, amount_ngn) VALUES ($1,$2,$3,$4)",
        [referredBy, rows[0].id, "signup", 0]
      );
    }
    res.json({ token: signToken(rows[0].id), user: safeUser(rows[0]) });
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "Email already registered." });
    res.status(500).json({ error: "Registration failed." });
  }
});

// Login
router.post("/login", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: "Email and password required." });
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE email=$1", [email.toLowerCase().trim()]);
    if (!rows.length) return res.status(401).json({ error: "Invalid email or password." });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: "Invalid email or password." });
    res.json({ token: signToken(rows[0].id), user: safeUser(rows[0]) });
  } catch { res.status(500).json({ error: "Login failed." }); }
});

// Get current user
router.get("/me", requireAuth, async (req, res) => {
  const p = new Date(req.user.period_start), now = new Date();
  if (now.getMonth() !== p.getMonth() || now.getFullYear() !== p.getFullYear()) {
    await pool.query("UPDATE users SET conversations_used=0, period_start=NOW() WHERE id=$1", [req.user.id]);
    req.user.conversations_used = 0;
  }
  let firm = null;
  if (req.user.firm_id) {
    const { rows } = await pool.query("SELECT * FROM firms WHERE id=$1", [req.user.firm_id]);
    if (rows.length) firm = rows[0];
  }
  res.json({ user: safeUser(req.user), firm });
});

// Conversion history
router.get("/history", requireAuth, async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM conversions WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100", [req.user.id]);
  res.json({ history: rows });
});

// Affiliate dashboard
router.get("/affiliate", requireAuth, async (req, res) => {
  const { rows: earnings } = await pool.query("SELECT * FROM affiliate_earnings WHERE affiliate_id=$1 ORDER BY created_at DESC", [req.user.id]);
  const { rows: payouts } = await pool.query("SELECT * FROM affiliate_payouts WHERE affiliate_id=$1 ORDER BY created_at DESC", [req.user.id]);
  const { rows: referred } = await pool.query("SELECT id, name, email, plan, created_at FROM users WHERE referred_by=$1", [req.user.id]);
  const totalEarned = earnings.reduce((s, e) => s + e.amount_ngn, 0);
  const totalPaid = payouts.filter(p => p.status === "paid").reduce((s, p) => s + p.amount_ngn, 0);
  res.json({ earnings, payouts, referred, totalEarned, totalPaid, pendingBalance: totalEarned - totalPaid, referralCode: req.user.referral_code });
});

// Request payout
router.post("/affiliate/payout", requireAuth, async (req, res) => {
  const { bank_name, account_number, account_name } = req.body;
  if (!bank_name || !account_number || !account_name) return res.status(400).json({ error: "Bank details required." });
  const { rows: e } = await pool.query("SELECT COALESCE(SUM(amount_ngn),0) total FROM affiliate_earnings WHERE affiliate_id=$1", [req.user.id]);
  const { rows: p } = await pool.query("SELECT COALESCE(SUM(amount_ngn),0) total FROM affiliate_payouts WHERE affiliate_id=$1 AND status='paid'", [req.user.id]);
  const balance = parseInt(e[0].total) - parseInt(p[0].total);
  if (balance < 500000) return res.status(400).json({ error: "Minimum payout is ₦5,000." });
  await pool.query("INSERT INTO affiliate_payouts (affiliate_id, amount_ngn, bank_name, account_number, account_name) VALUES ($1,$2,$3,$4,$5)", [req.user.id, balance, bank_name, account_number, account_name]);
  res.json({ success: true, amount: balance });
});

module.exports = router;
