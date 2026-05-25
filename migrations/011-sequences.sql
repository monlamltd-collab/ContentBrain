-- Migration 011: sequences table for outbound (Phase B/C)
--
-- A `sequence` is the state machine for one outbound conversation with one
-- contact on one track ('lender' / 'broker' / 'auction_house'). It tracks
-- where we are in the +0 / +3d / +7d / +14d cadence and why the sequence
-- ended (replied, bounced, suppressed, manually paused, completed).
--
-- One contact can have multiple sequences over time (e.g. a re-engagement
-- six months after the first one ended), but only ONE active or paused
-- sequence per (contact, track) at a time — enforced by the partial unique
-- index below. This prevents a contact getting two parallel +3d follow-ups.
--
-- `current_step` is 0 before the first message goes out; 1 after the +0
-- (cold), 2 after +3d, 3 after +7d, 4 after +14d. Final step transitions
-- status to 'completed'.
--
-- `next_scheduled_at` is the wall-clock time the cron should send the next
-- step. NULL when status is anything but 'active'. The cron query is
--   WHERE status='active' AND next_scheduled_at <= now()
-- which the partial idx_sequences_due index serves.
--
-- `ended_reason` records why a sequence terminated: 'replied', 'bounced',
-- 'suppressed', 'manual_pause', 'completed', 'hostile_pause'. Application
-- code enforces the enum so new reasons don't need a migration.

CREATE TABLE IF NOT EXISTS sequences (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  track             text        NOT NULL,
  current_step      int         NOT NULL DEFAULT 0,
  status            text        NOT NULL DEFAULT 'active',
  last_sent_at      timestamptz,
  next_scheduled_at timestamptz,
  ended_reason      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- The cron query is "active sequences due now or earlier". Partial index
-- on status='active' keeps it small (completed/ended sequences accumulate).
CREATE INDEX IF NOT EXISTS idx_sequences_due
  ON sequences (next_scheduled_at)
  WHERE status = 'active';

-- One active/paused sequence per (contact, track). Completed/ended rows are
-- excluded so a re-engagement six months later can start a fresh sequence
-- on the same track without a unique-violation. Application code enforces
-- the 6-month re-engagement cool-down separately.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sequences_active
  ON sequences (contact_id, track)
  WHERE status IN ('active', 'paused');
