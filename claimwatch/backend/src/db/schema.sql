-- ClaimWatch Database Schema
-- Run this in your Supabase SQL editor or PostgreSQL instance

-- ─── SETTLEMENTS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlements (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company         TEXT NOT NULL,
  domain          TEXT,                          -- for logo lookup
  category        TEXT NOT NULL,                 -- data_breach | privacy | false_advertising | product_defect | financial
  lawsuit         TEXT NOT NULL,
  case_number     TEXT,
  administrator   TEXT,
  total_amount    TEXT,
  payout_range    TEXT,
  estimated_payout TEXT,
  deadline        TIMESTAMPTZ NOT NULL,
  proof_req       TEXT DEFAULT 'none',           -- none | optional | required
  ease_score      INTEGER DEFAULT 50,            -- 0–100
  difficulty      TEXT DEFAULT 'medium',         -- easy | medium | hard
  time_to_file    TEXT,
  worth_score     INTEGER DEFAULT 50,
  claim_url       TEXT,
  eligibility     TEXT,
  payment_methods TEXT[],
  explanation     TEXT,
  qualify_when    TEXT,
  proof_explain   TEXT,
  steps           TEXT[],
  required_info   TEXT[],
  timeline        TEXT[],

  -- Metadata
  source_url      TEXT,                          -- where we scraped this from
  source_name     TEXT,                          -- e.g. 'TopClassActions', 'ClassAction.org'
  is_verified     BOOLEAN DEFAULT false,         -- manually verified
  is_active       BOOLEAN DEFAULT true,          -- false = deadline passed or dismissed
  date_added      TIMESTAMPTZ DEFAULT NOW(),
  date_updated    TIMESTAMPTZ DEFAULT NOW(),
  scrape_hash     TEXT UNIQUE                    -- dedup key: hash of company+lawsuit+deadline
);

-- Index for fast filtering
CREATE INDEX IF NOT EXISTS idx_settlements_deadline ON settlements(deadline);
CREATE INDEX IF NOT EXISTS idx_settlements_category ON settlements(category);
CREATE INDEX IF NOT EXISTS idx_settlements_proof_req ON settlements(proof_req);
CREATE INDEX IF NOT EXISTS idx_settlements_is_active ON settlements(is_active);
CREATE INDEX IF NOT EXISTS idx_settlements_ease_score ON settlements(ease_score DESC);

-- ─── USERS ────────────────────────────────────────────────────
-- Supabase handles auth — this extends the auth.users table
CREATE TABLE IF NOT EXISTS user_profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name TEXT,
  email       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ─── FILED CLAIMS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS filed_claims (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  settlement_id  UUID NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  filed_at       TIMESTAMPTZ DEFAULT NOW(),
  status         TEXT DEFAULT 'filed',           -- filed | pending | paid | rejected
  payout_amount  DECIMAL(10,2),                  -- actual amount received (user enters when paid)
  notes          TEXT,
  UNIQUE(user_id, settlement_id)                 -- prevents duplicate filing
);

CREATE INDEX IF NOT EXISTS idx_filed_claims_user ON filed_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_filed_claims_status ON filed_claims(status);

-- ─── SCRAPE LOG ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS scrape_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source      TEXT NOT NULL,
  started_at  TIMESTAMPTZ DEFAULT NOW(),
  finished_at TIMESTAMPTZ,
  new_found   INTEGER DEFAULT 0,
  updated     INTEGER DEFAULT 0,
  errors      INTEGER DEFAULT 0,
  status      TEXT DEFAULT 'running'             -- running | success | failed
);

-- ─── ROW LEVEL SECURITY (Supabase) ───────────────────────────
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE filed_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;

-- Anyone can read settlements
CREATE POLICY "Settlements are publicly readable"
  ON settlements FOR SELECT USING (true);

-- Users can only read/write their own filed claims
CREATE POLICY "Users can read own filed claims"
  ON filed_claims FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own filed claims"
  ON filed_claims FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own filed claims"
  ON filed_claims FOR UPDATE USING (auth.uid() = user_id);

-- Users can read/update their own profile
CREATE POLICY "Users can manage own profile"
  ON user_profiles FOR ALL USING (auth.uid() = id);

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email)
  VALUES (new.id, new.email);
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE PROCEDURE public.handle_new_user();

-- Auto-deactivate expired settlements (run daily via cron)
CREATE OR REPLACE FUNCTION deactivate_expired_settlements()
RETURNS void AS $$
BEGIN
  UPDATE settlements
  SET is_active = false, date_updated = NOW()
  WHERE deadline < NOW() AND is_active = true;
END;
$$ LANGUAGE plpgsql;
