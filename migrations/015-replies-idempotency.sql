-- Migration 015: replies idempotency + pipeline-tab index (Phase C)
--
-- Two small, additive changes to support the inbound webhook + dashboard:
--
-- 1) `resend_email_id` — Resend retries webhook delivery on any non-2xx, and
--    may also re-fire the same event after long delays (their stated SLA is
--    "exactly once is a best effort"). The body fetch + classify pipeline
--    in lib/inbound.js is therefore not safe to run twice for the same
--    inbound message. We use Resend's `email_id` as a natural idempotency
--    key on the INSERT — `ON CONFLICT (resend_email_id) DO NOTHING` makes a
--    redelivered webhook a no-op. Nullable because (a) older rows pre-date
--    the column and (b) we still want a reply row even if Resend ever sends
--    an event without an email_id (defensive — shouldn't happen).
--
-- 2) `(contact_id, created_at)` composite index — the Pipeline tab in the
--    dashboard renders a per-contact, time-ordered thread view. Migration
--    013's `idx_replies_contact` is contact-only and works for "fetch all
--    replies for this contact" but Postgres has to re-sort by created_at
--    for the thread render. As contact volume grows the sort cost on the
--    hot tab matters; a composite index lets the query plan use the index
--    for ORDER BY directly.
--
-- House style (matches 008/008c/014):
--   - IF NOT EXISTS / IF EXISTS on every DDL
--   - timestamptz throughout (already in 013)
--   - No CHECK constraints — application enforces enums via
--     lib/sales-brain/constants.js
--   - Idempotent — safe to re-run.

-- Idempotency key for the Resend webhook (email.received). Nullable: rows
-- written before this migration won't have a value, and we don't want the
-- backfill noise; the application-side ON CONFLICT path only fires for new
-- INSERTs where resend_email_id is always set.
ALTER TABLE replies
  ADD COLUMN IF NOT EXISTS resend_email_id text;

-- UNIQUE so `INSERT ... ON CONFLICT (resend_email_id) DO NOTHING` is valid.
-- Partial WHERE clause means historic NULL rows don't collide with each
-- other (a plain UNIQUE on a nullable column would technically allow
-- multiple NULLs in Postgres, but being explicit about intent is cheaper
-- than debugging it later).
CREATE UNIQUE INDEX IF NOT EXISTS uq_replies_resend_email_id
  ON replies (resend_email_id)
  WHERE resend_email_id IS NOT NULL;

-- Pipeline tab: per-contact thread view, time-ordered. Migration 013 has
-- idx_replies_contact (contact-only); this composite adds the created_at
-- column so the planner can serve "ORDER BY created_at DESC LIMIT N" off
-- the index without a sort step. Keeping the contact-only index too — it's
-- still cheaper for "does this contact have any replies?" existence checks.
CREATE INDEX IF NOT EXISTS idx_replies_contact_created
  ON replies (contact_id, created_at DESC);
