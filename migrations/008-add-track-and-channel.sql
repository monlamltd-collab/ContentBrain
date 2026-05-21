-- Migration 008: add track, channel, and meta columns to posts
--
-- track  — content pillar/theme (e.g. 'deal-of-week', 'market-insight', 'bridge-tip').
--          Nullable; NULL means no explicit track assigned.
-- channel — distribution channel beyond the existing platform field
--           (e.g. 'email', 'sms', 'organic-social'). Nullable for backwards compatibility.
-- meta   — flexible jsonb store for extra fields used by generation and publish
--          pipelines (e.g. lot_id, author, hook_pattern). Missing from the original
--          schema but already referenced by lib/supabase.js — add defensively.
--
-- track and channel are text with no hard-coded check constraint so new values
-- can be added without another migration. Application code enforces the allowed set.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS track   text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS channel text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS meta    jsonb;

-- Index to support filtering by track (e.g. "show all deal-of-week posts")
CREATE INDEX IF NOT EXISTS idx_posts_track ON posts (track) WHERE track IS NOT NULL;
