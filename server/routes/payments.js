const router = require("express").Router();
const https = require("https");
const { pool } = require("../models/db");
const { requireAuth } = require("../middleware/auth");

// Credit bundles — amounts in kobo (Paystack uses kobo)
const BUNDLES = {
  starter:    { credits: 10,  amount: 150000,  display: 1500,  label: "Starter – 10 Credits" },
  pro_bundle: { credits: 50,  amount: 600000,  display: 6000,  label: "Pro Bundle – 50 Credits" },
  agency:     { credits: 200, amount: 2000000, display: 20000, label: "Agency – 200 Credits" },
};

// Subscription plans — amounts in kobo
const PLANS = {
  basic: { amount: 500000,  display: 5000,   planCode: process.env.PAYSTACK_BASIC_PLAN_CODE },
  pro:   { amount: 2500000, display: 25000,  planCode: process.env.PAYSTACK_PRO_PLAN_CODE },
  firm:  { amount: 10000000,display: 100000, planCode: process.env.PAYSTACK_FIRM_PLAN_CODE },
};

// Paystack API helper
function paystack(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: "api.paystack.co", port: 443, path, method,
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => resolve(JSON.parse(raw)));
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

// GET /plans — returns all pricing info
router.get("/plans", (req, res) => {
  res.json({
    bundles: {
      starter:    { credits: 10,  ngn: 1500,   per: 150,   label: "Starter" },
      pro_bundle: { credits: 50,  ngn: 6000,   per: 120,   label: "Pro Bundle" },
      agency:     { credits: 200, ngn: 20000,  per: 100,   label: "Agency" },
    },
    subscriptions: {
      free:  { name: "Free",  ngn: 0,      conversations: 5,           features: ["3 free credits on signup", "5 conversions/month", "Excel export", "PDF receipt"] },
      basic: { name: "Basic", ngn: 5000,   conversations: 50,          features: ["50 conversions/month", "Everything in Free", "Column mapping", "Currency formatting", "History log"] },
      pro:   { name: "Pro",   ngn: 25000,  conversations: "Unlimited", features: ["Unlimited conversions", "Everything in Basic", "Priority processing"] },
      firm:  { name: "Firm",  ngn: 100000, conversations: "Unlimited", seats: 5, features: ["5 team seats", "Unlimited conversions", "White-label receipts", "Custom branding", "Dedicated support"] },
    },
  });
});

// POST /credits — start credit purchase
router.post("/credits", requireAuth, async (req, res) => {
  const { bundle } = req.body;
  if (!BUNDLES[bundle]) return res.status(400).json({ error: "Invalid bundle." });
  const b = BUNDLES[bundle];
  const callbackUrl = `${process.env.CLIENT_URL}/payment/verify?type=credits&bundle=${bundle}`;
  try {
    const result = await paystack("POST", "/transaction/initialize", {
      email: req.user.email,
      amount: b.amount,
      callback_url: callbackUrl,
      metadata: { user_id: req.user.id, type: "credits", bundle },
    });
    if (!result.status) throw new Error(result.message);
    await pool.query(
      "INSERT INTO credit_purchases (user_id, bundle, credits, amount, reference, status) VALUES ($1,$2,$3,$4,$5,'pending')",
      [req.user.id, bundle, b.credits, b.amount, result.data.reference]
    );
    res.json({ url: result.data.authorization_url, reference: result.data.reference });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /subscribe — start subscription
router.post("/subscribe", requireAuth, async (req, res) => {
  const { plan } = req.body;
  if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan." });
  const p = PLANS[plan];
  const callbackUrl = `${process.env.CLIENT_URL}/payment/verify?type=subscription&plan=${plan}`;
  try {
    const result = await paystack("POST", "/transaction/initialize", {
      email: req.user.email,
      amount: p.amount,
      plan: p.planCode,
      callback_url: callbackUrl,
      metadata: { user_id: req.user.id, type: "subscription", plan },
    });
    if (!result.status) throw new Error(result.message);
    await pool.query(
      "INSERT INTO payments (user_id, reference, plan, amount, status) VALUES ($1,$2,$3,$4,'pending')",
      [req.user.id, result.data.reference, plan, p.amount]
    );
    res.json({ url: result.data.authorization_url });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /verify/:reference — verify after Paystack redirect
router.get("/verify/:reference", requireAuth, async (req, res) => {
  try {
    // Check if already processed to prevent double top-up
    const existing = await pool.query(
      "SELECT status FROM credit_purchases WHERE reference=$1 UNION SELECT status FROM payments WHERE reference=$1",
      [req.params.reference]
    );
    if (existing.rows[0]?.status === "success") {
      const { rows: updated } = await pool.query("SELECT * FROM users WHERE id=$1", [req.user.id]);
      const { password_hash, ...safe } = updated[0];
      return res.json({ success: true, user: safe, already_processed: true });
    }

    const result = await paystack("GET", `/transaction/verify/${req.params.reference}`);
    if (!result.status || result.data.status !== "success") {
      return res.status(400).json({ error: "Payment not successful." });
    }
    const meta = result.data.metadata;
    const userId = meta.user_id || req.user.id;

    if (meta.type === "credits") {
      const b = BUNDLES[meta.bundle];
      if (!b) return res.status(400).json({ error: "Invalid bundle in payment metadata." });
      await pool.query("UPDATE credit_purchases SET status='success' WHERE reference=$1", [req.params.reference]);
      await pool.query("UPDATE users SET credits = credits + $1 WHERE id=$2", [b.credits, userId]);
      // Pay affiliate 20% commission
      const { rows } = await pool.query("SELECT referred_by FROM users WHERE id=$1", [userId]);
      if (rows[0]?.referred_by) {
        const commission = Math.floor(b.display * 0.20 * 100);
        await pool.query(
          "INSERT INTO affiliate_earnings (affiliate_id, referred_user_id, source, amount_ngn) VALUES ($1,$2,'credit_purchase',$3)",
          [rows[0].referred_by, userId, commission]
        );
      }
    } else {
      const plan = meta.plan;
      if (!PLANS[plan]) return res.status(400).json({ error: "Invalid plan in payment metadata." });
      await pool.query("UPDATE payments SET status='success' WHERE reference=$1", [req.params.reference]);
      await pool.query(
        "UPDATE users SET plan=$1, subscription_status='active', conversations_used=0, period_start=NOW() WHERE id=$2",
        [plan, userId]
      );
      // Pay affiliate
      const { rows } = await pool.query("SELECT referred_by FROM users WHERE id=$1", [userId]);
      if (rows[0]?.referred_by) {
        const commission = Math.floor(PLANS[plan].display * 0.20 * 100);
        await pool.query(
          "INSERT INTO affiliate_earnings (affiliate_id, referred_user_id, source, amount_ngn) VALUES ($1,$2,'subscription',$3)",
          [rows[0].referred_by, userId, commission]
        );
      }
    }

    const { rows: updated } = await pool.query("SELECT * FROM users WHERE id=$1", [userId]);
    const { password_hash, ...safe } = updated[0];
    res.json({ success: true, user: safe });
  } catch (err) {
    console.error("Verify error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Paystack webhook — raw body already applied in index.js
router.post("/webhook", async (req, res) => {
  try {
    const crypto = require("crypto");
    const hash = crypto.createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(req.body).digest("hex");
    if (hash !== req.headers["x-paystack-signature"]) {
      return res.status(400).send("Invalid signature");
    }
    const event = JSON.parse(req.body.toString());
    console.log("Paystack webhook event:", event.event);

    if (event.event === "subscription.disable" || event.event === "subscription.not_renew") {
      const email = event.data?.customer?.email;
      if (email) {
        await pool.query(
          "UPDATE users SET plan='free', subscription_status='cancelled' WHERE email=$1",
          [email]
        );
        console.log(`Plan downgraded for ${email}`);
      }
    }

    if (event.event === "charge.success") {
      const ref = event.data?.reference;
      const meta = event.data?.metadata;
      if (ref && meta?.type === "credits" && meta?.user_id) {
        // Handle webhook-initiated credit top-up (safety net)
        const existing = await pool.query("SELECT status FROM credit_purchases WHERE reference=$1", [ref]);
        if (existing.rows[0]?.status === "pending") {
          const b = BUNDLES[meta.bundle];
          if (b) {
            await pool.query("UPDATE credit_purchases SET status='success' WHERE reference=$1", [ref]);
            await pool.query("UPDATE users SET credits = credits + $1 WHERE id=$2", [b.credits, meta.user_id]);
            console.log(`Webhook: added ${b.credits} credits to user ${meta.user_id}`);
          }
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    console.error("Webhook error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
