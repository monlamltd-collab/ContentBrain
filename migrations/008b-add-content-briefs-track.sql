-- Migration 008b: add track + channel columns to content_briefs
--
-- Mirrors the posts columns added in 008 so briefs and the posts
-- they produce share the same vocabulary for routing and filtering.

ALTER TABLE content_briefs ADD COLUMN IF NOT EXISTS track   text;
ALTER TABLE content_briefs ADD COLUMN IF NOT EXISTS channel text;

CREATE INDEX IF NOT EXISTS idx_content_briefs_track
  ON content_briefs (track) WHERE track IS NOT NULL;
