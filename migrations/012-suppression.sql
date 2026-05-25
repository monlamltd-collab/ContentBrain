-- Migration 012: suppression list for outbound (Phase B)
--
-- Hard block list of email addresses AND domains we MUST NOT email. Checked
-- by lib/suppression.isSuppressed(email) before any Resend send. Populated by:
--   - manual additions from Telegram (hostile reply, complaint)
--   - automatic additions from Resend webhook events (hard bounce, spam report)
--   - one-time imports of historical suppression lists (Mortgage-Style etc.)
--
-- A row matches if `email_or_domain` equals the recipient address OR equals
-- the recipient's domain (the @-suffix). Application code does both checks —
-- the table stores either form so a single bad sender ("noisy@x.co") and a
-- whole domain block ("x.co") share the same primary key namespace.
--
-- PK is the address/domain itself: idempotent inserts (`ON CONFLICT DO NOTHING`)
-- and fast existence lookups for every send. No surrogate id needed —
-- suppression is a set, not an event log. `reason` documents WHY for audit;
-- `added_at` is when. Both required because forgetting why a domain is on
-- the block list is how you accidentally remove it later.

CREATE TABLE IF NOT EXISTS suppression (
  email_or_domain text        PRIMARY KEY,
  reason          text        NOT NULL,
  added_at        timestamptz NOT NULL DEFAULT now()
);
