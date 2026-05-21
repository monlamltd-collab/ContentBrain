-- Migration 008: add track + channel columns to posts
--
-- track  — content pillar/theme (e.g. 'deal-of-week', 'market-insight', 'bridge-tip').
--          Nullable; NULL means no explicit track assigned.
-- channel — distribution channel beyond the existing platform field
--           (e.g. 'email', 'sms', 'organic-social'). Nullable for backwards compatibility.
--
-- Both columns are text with no hard-coded check constraint so new values
-- can be added without another migration. Application code enforces the
-- allowed set where needed.

ALTER TABLE posts ADD COLUMN IF NOT EXISTS track   text;
ALTER TABLE posts ADD COLUMN IF NOT EXISTS channel text;

-- Index to support filtering by track (e.g. "show all deal-of-week posts")
CREATE INDEX IF NOT EXISTS idx_posts_track ON posts (track) WHERE track IS NOT NULL;
