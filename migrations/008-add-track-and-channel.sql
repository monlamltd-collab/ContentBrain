-- Migration 008: add track, channel, and meta columns to posts
--
-- track  — content motion that produced the post. 'social' for existing rows
--          (organic content from ContentBrain). 'outbound' arrives in Phase B+.
-- channel — distribution channel. 'facebook' for existing rows (publish.js
--          routes exclusively to Facebook today). 'resend' / 'unipile' in Phase B+.
-- meta   — flexible jsonb store for extra fields used by generation and publish
--          pipelines (e.g. lot_id, author, hook_pattern). Missing from the original
--          schema but already referenced by lib/supabase.js — add defensively.
--
-- track and channel are text with no hard-coded check constraint so new values
-- can be added without another migration. Application code enforces the allowed set.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS track   text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS meta    jsonb;

-- Backfill existing rows. All pre-migration posts were social Facebook posts
-- (publish.js only routes to Facebook). Idempotent: only updates NULLs.
UPDATE posts SET track   = 'social'   WHERE track   IS NULL;
UPDATE posts SET channel = 'facebook' WHERE channel IS NULL;

-- Index to support filtering by track (e.g. "show all social posts")
CREATE INDEX IF NOT EXISTS idx_posts_track ON posts (track) WHERE track IS NOT NULL;
