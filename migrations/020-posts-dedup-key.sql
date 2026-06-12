-- Migration 020: posts.dedup_key for the growth-brain-ads slot-fill pipeline
--
-- growth-brain-ads (deterministic slot-fill ad assembler, see
-- growth-brain-ads/README.md) fingerprints every generated creative as
--   sha256("platform|hook_id|proof_point_ids(sorted,comma-joined)|cta_id")
-- and refuses to emit a combination already used in the last 30 days.
-- This column is where that fingerprint lives; lib/publishLog.js loads the
-- 30-day window into a Set before each generation run.
--
-- Rows that predate the pipeline stay NULL — expected and correct. No
-- backfill: legacy posts were not component-assembled, so they have no
-- meaningful fingerprint.
--
-- Partial index serves the window lookup (brand + recency scan) and stays
-- tiny because only pipeline-written rows carry a key.
--
-- Idempotent: IF NOT EXISTS on both statements.
--
-- DRAFT — not applied. Simon signs off before this touches Auction.Bridgematch.

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS dedup_key text;

COMMENT ON COLUMN posts.dedup_key IS
  'growth-brain-ads creative fingerprint: sha256(platform|hook_id|proofs sorted|cta_id). NULL for posts that predate the deterministic pipeline.';

CREATE INDEX IF NOT EXISTS posts_dedup_key_window_idx
  ON posts (published_at DESC, dedup_key)
  WHERE dedup_key IS NOT NULL;
