-- ============================================================
-- ClaimWatch — Full Database Schema
-- Run this in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── SETTLEMENTS ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS settlements (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- Core identity
  company         TEXT NOT NULL,
  domain          TEXT,                          -- e.g. "tiktok.com" for logo lookup
  lawsuit         TEXT NOT NULL,
  case_number     TEXT,
  administrator   TEXT,
  
  -- Financials
  total_amount    TEXT NOT NULL,                 -- "$92 million"
  payout_range    TEXT NOT NULL,                 -- "$27 – $167"
  estimated_payout TEXT NOT NULL,               -- "$27" (low end for display)
  
  -- Deadline — stored as timestamptz for full precision
  deadline        TIMESTAMPTZ NOT NULL,
  
  -- Classification
  category        TEXT NOT NULL CHECK (category IN (
    'data_breach','privacy','false_advertising',
    'product_defect','financial','subscription','other'
  )),
  proof_req       TEXT NOT NULL DEFAULT 'none' CHECK (proof_req IN ('none','optional','required')),
  difficulty      TEXT NOT NULL DEFAULT 'easy' CHECK (difficulty IN ('easy','medium','hard')),
  
  -- Scoring (0–100)
  ease_score      INTEGER NOT NULL DEFAULT 80 CHECK (ease_score BETWEEN 0 AND 100),
  worth_score     INTEGER NOT NULL DEFAULT 70 CHECK (worth_score BETWEEN 0 AND 100),
  
  -- Filing info
  time_to_file    TEXT NOT NULL DEFAULT '5 min',
  fields_count    INTEGER DEFAULT 5,
  needs_docs      BOOLEAN DEFAULT FALSE,
  needs_account   BOOLEAN DEFAULT FALSE,
  claim_url       TEXT NOT NULL,
  
  -- Rich content
  eligibility     TEXT NOT NULL,
  explanation     TEXT NOT NULL,
  qualify_when    TEXT NOT NULL,
  proof_explain   TEXT NOT NULL,
  steps           JSONB NOT NULL DEFAULT '[]',     -- array of strings
  required_info   JSONB NOT NULL DEFAULT '[]',     -- array of strings
  payment_methods JSONB NOT NULL DEFAULT '[]',     -- array of strings
  timeline        JSONB NOT NULL DEFAULT '[]',     -- array of strings
  
  -- Metadata
  date_added      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_verified   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  source_url      TEXT,                            -- where we scraped this from
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,   -- false = hide from feed
  is_auto_payout  BOOLEAN NOT NULL DEFAULT FALSE,  -- no claim needed
  
  -- Dedup key — prevents same lawsuit appearing twice
  dedup_key       TEXT UNIQUE,                     -- hash of company+case_number
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── FILED CLAIMS ─────────────────────────────────────────────
-- Tracks which settlements a user has filed for
-- Uses browser fingerprint OR Supabase auth user_id
CREATE TABLE IF NOT EXISTS filed_claims (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  
  -- User identification (anonymous-first)
  user_id         UUID,                            -- NULL if not logged in
  browser_id      TEXT,                            -- localStorage UUID for anon users
  
  -- Which settlement
  settlement_id   UUID NOT NULL REFERENCES settlements(id) ON DELETE CASCADE,
  
  -- Filing details
  filed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status          TEXT NOT NULL DEFAULT 'filed' CHECK (status IN ('filed','pending','paid','rejected')),
  paid_amount     DECIMAL(10,2),                   -- actual amount received (user-entered)
  notes           TEXT,                            -- user's own notes
  
  -- Prevent duplicate filing per user
  UNIQUE(settlement_id, user_id),
  UNIQUE(settlement_id, browser_id),
  
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── SCRAPE LOG ───────────────────────────────────────────────
-- Audit trail of every scrape run
CREATE TABLE IF NOT EXISTS scrape_log (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  source          TEXT NOT NULL,                   -- "topclassactions", "classaction_org", etc.
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  settlements_found INTEGER DEFAULT 0,
  settlements_added INTEGER DEFAULT 0,
  settlements_updated INTEGER DEFAULT 0,
  error_message   TEXT,
  status          TEXT DEFAULT 'running' CHECK (status IN ('running','success','error'))
);

-- ── INDEXES ──────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_settlements_deadline    ON settlements(deadline);
CREATE INDEX IF NOT EXISTS idx_settlements_category    ON settlements(category);
CREATE INDEX IF NOT EXISTS idx_settlements_proof_req   ON settlements(proof_req);
CREATE INDEX IF NOT EXISTS idx_settlements_ease_score  ON settlements(ease_score DESC);
CREATE INDEX IF NOT EXISTS idx_settlements_is_active   ON settlements(is_active);
CREATE INDEX IF NOT EXISTS idx_settlements_date_added  ON settlements(date_added DESC);
CREATE INDEX IF NOT EXISTS idx_filed_user              ON filed_claims(user_id);
CREATE INDEX IF NOT EXISTS idx_filed_browser           ON filed_claims(browser_id);
CREATE INDEX IF NOT EXISTS idx_filed_settlement        ON filed_claims(settlement_id);

-- ── ROW LEVEL SECURITY ───────────────────────────────────────
-- Settlements: public read, service-role write (scraper only)
ALTER TABLE settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "settlements_public_read"
  ON settlements FOR SELECT USING (is_active = TRUE);

-- Filed claims: users can only see/edit their own rows
ALTER TABLE filed_claims ENABLE ROW LEVEL SECURITY;
CREATE POLICY "filed_claims_anon_read"
  ON filed_claims FOR SELECT
  USING (browser_id = current_setting('app.browser_id', TRUE));
CREATE POLICY "filed_claims_anon_insert"
  ON filed_claims FOR INSERT
  WITH CHECK (browser_id = current_setting('app.browser_id', TRUE));
CREATE POLICY "filed_claims_anon_update"
  ON filed_claims FOR UPDATE
  USING (browser_id = current_setting('app.browser_id', TRUE));

-- ── UPDATED_AT TRIGGER ───────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER settlements_updated_at
  BEFORE UPDATE ON settlements
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER filed_claims_updated_at
  BEFORE UPDATE ON filed_claims
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── HELPER VIEW ──────────────────────────────────────────────
-- Active settlements with days-remaining computed
CREATE OR REPLACE VIEW active_settlements AS
SELECT
  *,
  EXTRACT(DAY FROM (deadline - NOW())) AS days_remaining,
  CASE
    WHEN deadline < NOW() THEN 'expired'
    WHEN deadline < NOW() + INTERVAL '7 days' THEN 'critical'
    WHEN deadline < NOW() + INTERVAL '30 days' THEN 'urgent'
    WHEN deadline < NOW() + INTERVAL '60 days' THEN 'soon'
    ELSE 'open'
  END AS urgency
FROM settlements
WHERE is_active = TRUE AND deadline > NOW()
ORDER BY ease_score DESC;
