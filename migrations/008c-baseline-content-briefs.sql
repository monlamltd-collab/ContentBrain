-- Migration 008c: defensive baseline CREATE TABLE for content_briefs
--
-- The content_briefs table is heavily used by the generation pipeline
-- (lib/supabase.js: saveBrief, getPendingBriefs, getPendingBriefsAll,
-- dismissBrief, markBriefsUsed) but no CREATE TABLE migration exists in
-- this folder — only ALTER TABLE statements in 003.
--
-- This migration creates the table with all observed columns if it does
-- not already exist, so a fresh database can be provisioned from
-- migrations alone without relying on out-of-band Supabase Studio clicks.
--
-- Safe to run on existing databases: IF NOT EXISTS means it is a no-op
-- when the table already exists.

CREATE TABLE IF NOT EXISTS content_briefs (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  message     text        NOT NULL DEFAULT '',
  topic       text,
  brand       text,
  angle       text,
  data_points text,
  used        boolean     NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_content_briefs_used
  ON content_briefs (used)
  WHERE used = false;
