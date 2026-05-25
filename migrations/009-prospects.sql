-- Migration 009: prospects table for outbound (Phase B)
--
-- A `prospect` is a company we may pitch — a lender (Phase B), a bridging
-- broker (Phase D), or an auction house (Phase D). One row per company.
-- People at the company live in `contacts` (migration 010) with a FK back here.
--
-- `source` records where the row came from ('bridging-brain' for the snapshot
-- import in lib/sales-brain/import-lenders.js). Together with company_name it
-- forms the natural key — see the case-insensitive unique index below.
--
-- `website` is intentionally NULL on import: the bridging-brain snapshot has
-- no website column. Hunter.io enrichment (lib/enrich.js) backfills later.
--
-- `metadata` is the freeform stash for source-specific raw fields we don't
-- want to normalise on import (e.g. funding_model, last_updated,
-- enquiries_phone_raw, criteria_update_contact). Application code reads them.
--
-- type/source enums are NOT enforced in SQL — application code is the source
-- of truth so new tracks can be added without another migration (matches the
-- 008 track/channel pattern).

CREATE TABLE IF NOT EXISTS prospects (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type         text,
  company_name text        NOT NULL,
  website      text,
  source       text,
  metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Case-insensitive natural key — the importer upserts on (source, lower(company_name))
-- so re-running with a refreshed snapshot updates metadata instead of duplicating.
-- Functional unique index is the standard Postgres pattern for this.
CREATE UNIQUE INDEX IF NOT EXISTS uq_prospects_source_company
  ON prospects (source, lower(company_name));

-- Track filter — outbound code routinely scans by type ('lender', 'broker',
-- 'auction_house'). Partial NOT NULL keeps the index lean on legacy rows.
CREATE INDEX IF NOT EXISTS idx_prospects_type
  ON prospects (type)
  WHERE type IS NOT NULL;
