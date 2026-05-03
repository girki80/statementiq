const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT DEFAULT '',
      role TEXT DEFAULT 'user',
      plan TEXT DEFAULT 'free',
      credits INTEGER DEFAULT 3,
      conversations_used INTEGER DEFAULT 0,
      period_start TIMESTAMPTZ DEFAULT NOW(),
      referral_code TEXT UNIQUE,
      referred_by INTEGER,
      paystack_customer_code TEXT,
      subscription_id TEXT,
      subscription_status TEXT DEFAULT 'active',
      firm_id INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS firms (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      slug TEXT UNIQUE NOT NULL,
      logo_url TEXT,
      primary_color TEXT DEFAULT '#00C9A7',
      owner_id INTEGER,
      seat_limit INTEGER DEFAULT 5,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS credit_purchases (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      bundle TEXT NOT NULL,
      credits INTEGER NOT NULL,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'NGN',
      provider TEXT DEFAULT 'paystack',
      reference TEXT UNIQUE,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS conversions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      file_name TEXT,
      document_type TEXT,
      title TEXT,
      export_type TEXT,
      demo BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      provider TEXT DEFAULT 'paystack',
      reference TEXT UNIQUE,
      plan TEXT,
      amount INTEGER,
      currency TEXT DEFAULT 'NGN',
      status TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS affiliate_earnings (
      id SERIAL PRIMARY KEY,
      affiliate_id INTEGER,
      referred_user_id INTEGER,
      source TEXT,
      amount_ngn INTEGER NOT NULL,
      status TEXT DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS affiliate_payouts (
      id SERIAL PRIMARY KEY,
      affiliate_id INTEGER,
      amount_ngn INTEGER NOT NULL,
      bank_name TEXT,
      account_number TEXT,
      account_name TEXT,
      status TEXT DEFAULT 'requested',
      admin_note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Saved files dashboard (30-day retention)
    CREATE TABLE IF NOT EXISTS saved_files (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT,
      document_type TEXT,
      original_filename TEXT,
      export_type TEXT,
      file_data TEXT,
      file_size INTEGER,
      mime_type TEXT DEFAULT 'application/octet-stream',
      metadata JSONB DEFAULT '{}',
      expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '30 days'),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Invoices
    CREATE TABLE IF NOT EXISTS invoices (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      invoice_number TEXT NOT NULL,
      status TEXT DEFAULT 'draft',
      from_name TEXT,
      from_email TEXT,
      from_address TEXT,
      from_phone TEXT,
      to_name TEXT,
      to_email TEXT,
      to_address TEXT,
      items JSONB DEFAULT '[]',
      subtotal NUMERIC(12,2) DEFAULT 0,
      tax_rate NUMERIC(5,2) DEFAULT 0,
      tax_amount NUMERIC(12,2) DEFAULT 0,
      discount NUMERIC(12,2) DEFAULT 0,
      total NUMERIC(12,2) DEFAULT 0,
      currency TEXT DEFAULT 'NGN',
      notes TEXT,
      due_date DATE,
      logo_url TEXT,
      primary_color TEXT DEFAULT '#00C9A7',
      template TEXT DEFAULT 'modern',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- WhatsApp bot sessions
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id),
      state TEXT DEFAULT 'idle',
      pending_file_url TEXT,
      pending_file_type TEXT,
      extractions_today INTEGER DEFAULT 0,
      last_extraction_date DATE DEFAULT CURRENT_DATE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_phone ON whatsapp_sessions(phone);
    CREATE INDEX IF NOT EXISTS idx_invoices_user ON invoices(user_id);
    CREATE INDEX IF NOT EXISTS idx_saved_files_user ON saved_files(user_id);
    CREATE INDEX IF NOT EXISTS idx_saved_files_expires ON saved_files(expires_at);
  `);
  console.log("✅ Database ready");
}

module.exports = { pool, initDB };
