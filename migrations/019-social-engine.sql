-- Migration 019: Phase G — Social Engine schema
--
-- Adds the two tables Phase G needs that don't yet exist. Reuses everything
-- else (posts, posts.track/channel, posts.meta, post_metrics) from earlier
-- migrations.
--
-- 1. `social_audience_daily` — page-level follower/fan trajectory snapshot.
--    One row per (brand, page_id, recorded_at). The Phase G dashboard charts
--    `followers_count` over time and computes cost-per-follower against the
--    same day's `boost_runs.spend_pence`.
--
-- 2. `boost_runs` — per-post paid-boost ledger driven by the Make
--    `ub-social-boost` scenario (see .ruflo/social-engine-architecture.md
--    Part M). ContentBrain inserts the row pending → Make fills in
--    boost_campaign_id / boost_ad_id via the callback route → daily
--    Make reconcile fills spend + ad metrics → orchestrator marks complete.
--
-- Posts.track is NOT added here — it already exists from migration 008.
-- The Phase G orchestrator inserts new posts with track='social'.
--
-- All operations idempotent (IF NOT EXISTS / DEFAULT). Re-running this
-- migration on an already-applied database is a no-op.

-- ── social_audience_daily ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS social_audience_daily (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand             text NOT NULL,                       -- 'auctionbrain' (currently the only Page)
  page_id           text NOT NULL,                       -- Facebook Page ID
  recorded_at       date NOT NULL,                       -- one snapshot per day
  followers_count   integer NOT NULL,                    -- /<page>?fields=followers_count
  fans_count        integer,                             -- legacy "page likes" (fans)
  follows_delta     integer,                             -- vs previous day; computed at insert
  source            text NOT NULL DEFAULT 'graph_api',   -- room to ingest from other sources later
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (brand, page_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS idx_social_audience_brand_date
  ON social_audience_daily (brand, recorded_at DESC);

-- ── boost_runs ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS boost_runs (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id             uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,

  -- Set by Make `ub-social-boost` scenario via the callback route. NULL while
  -- the request is in flight. Indexed because the reconcile scenario looks
  -- up active runs by campaign_id.
  boost_campaign_id   text,
  boost_ad_id         text,

  -- Requested spec (immutable post-insert).
  daily_budget_pence  integer NOT NULL,
  duration_hours      integer NOT NULL DEFAULT 24,
  audience_spec       jsonb,

  -- Lifecycle status; no CHECK constraint — application-level enum in
  -- lib/social-engine/constants.js, same pattern as posts.track / posts.status
  -- (see migration 014 rationale).
  --   pending  : ContentBrain inserted, webhook not yet acknowledged
  --   active   : Make returned boost_campaign_id, ad is live
  --   complete : ad duration finished, final metrics pulled
  --   failed   : Make returned an error in the callback (see meta.error)
  status              text NOT NULL DEFAULT 'pending',

  -- Filled by Make callback / reconcile.
  started_at          timestamptz,
  ended_at            timestamptz,
  spend_pence         integer NOT NULL DEFAULT 0,
  ad_impressions      integer NOT NULL DEFAULT 0,
  ad_engagements      integer NOT NULL DEFAULT 0,
  ad_new_follows      integer NOT NULL DEFAULT 0,
  ad_link_clicks      integer NOT NULL DEFAULT 0,

  -- Computed at reconcile time; NULL when ad_new_follows = 0 to avoid
  -- div-by-zero (or a misleading 0).
  cost_per_follow_pence numeric,

  -- Full FB insights blob + error messages + correlation IDs. Free-form
  -- because the Marketing API response shape can shift.
  raw_metrics         jsonb,
  meta                jsonb,

  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_boost_runs_post     ON boost_runs (post_id);
CREATE INDEX IF NOT EXISTS idx_boost_runs_status   ON boost_runs (status);
CREATE INDEX IF NOT EXISTS idx_boost_runs_campaign ON boost_runs (boost_campaign_id)
  WHERE boost_campaign_id IS NOT NULL;

-- updated_at auto-bump on UPDATE. Pattern reused from earlier migrations.
CREATE OR REPLACE FUNCTION boost_runs_touch_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_boost_runs_touch ON boost_runs;
CREATE TRIGGER trg_boost_runs_touch
  BEFORE UPDATE ON boost_runs
  FOR EACH ROW EXECUTE FUNCTION boost_runs_touch_updated_at();
