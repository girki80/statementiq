const jwt = require("jsonwebtoken");
const { pool } = require("../models/db");

const PLAN_LIMITS = { free: 5, basic: 50, pro: Infinity, firm: Infinity };
const SAVED_FILE_LIMITS = { free: 5, basic: 50, pro: Infinity, firm: Infinity };

async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "Not authenticated." });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [decoded.id]);
    if (!rows.length) return res.status(401).json({ error: "User not found." });
    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token." });
  }
}

async function requireQuota(req, res, next) {
  const user = req.user;
  // Reset monthly counter if new month
  const p = new Date(user.period_start), now = new Date();
  if (now.getMonth() !== p.getMonth() || now.getFullYear() !== p.getFullYear()) {
    await pool.query("UPDATE users SET conversations_used=0, period_start=NOW() WHERE id=$1", [user.id]);
    user.conversations_used = 0;
  }
  // Use credit if available
  if (user.credits > 0) { req.useCredit = true; return next(); }
  // Otherwise check plan quota
  const limit = PLAN_LIMITS[user.plan] ?? 5;
  if (user.conversations_used >= limit) {
    return res.status(403).json({ error: "quota_exceeded", plan: user.plan, limit, used: user.conversations_used, credits: user.credits });
  }
  req.useCredit = false;
  next();
}

module.exports = { requireAuth, requireQuota, PLAN_LIMITS, SAVED_FILE_LIMITS };
