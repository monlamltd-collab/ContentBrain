-- Migration 014: drop posts CHECK constraints + relax platform NOT NULL
--
-- F1 from .ruflo/phase-b-acceptance.md: outbound posts need
--   template_type = 'outbound'  (not in the original check list)
--   status        = 'suppressed' (added when publishToResend skips a send)
--   platform      NULL or absent (outbound emails have no social platform;
--                  channel='resend' takes its semantic place)
--
-- Rather than widening each CHECK every phase, drop them in favour of
-- application-level enums in lib/sales-brain/constants.js — the same
-- pattern migration 008 set for posts.track / posts.channel:
--   "track and channel are text with no hard-coded check constraint so
--    new values can be added without another migration. Application code
--    enforces the allowed set."
--
-- posts_brand_check is kept (only two brands exist; both are exhaustive).
--
-- Idempotent: IF EXISTS on every drop; the column-nullable change is
-- naturally idempotent.

ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_platform_check;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_template_type_check;
ALTER TABLE posts DROP CONSTRAINT IF EXISTS posts_status_check;

ALTER TABLE posts ALTER COLUMN platform DROP NOT NULL;
