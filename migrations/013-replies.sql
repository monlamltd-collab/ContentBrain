-- Migration 013: replies table for outbound (Phase C)
--
-- Inbound emails arrive via the Resend webhook (`routes/api/resend-webhook.js`,
-- Phase C). Each parsed inbound is stored here, classified by lib/classify.js
-- (cheap Haiku call returning one of 8 intents — interested, decline,
-- unsubscribe, ooo, hostile, complaint, info_request, other), then routed:
--   - interested / hostile / complaint  → Telegram alert, requires_human=true
--   - unsubscribe                       → suppression.addSuppression, pause sequence
--   - decline / ooo / info_request      → pause or auto-resume sequence
--   - other                             → leave for human review
--
-- FK to contacts cascades (delete a contact, drop the replies). FK to sequences
-- is SET NULL because a reply may arrive AFTER the sequence ended (e.g. someone
-- replies to a +14d message a month later) and we still want the reply on file.
--
-- `raw_body` is the full inbound text — kept so Simon can audit a classifier
-- mistake and so the persona module can learn from a sample of real replies.
--
-- `processed_at` is NULL until classify+route runs. Partial index serves the
-- cron-style "what came in that I haven't dealt with yet?" query.
--
-- `requires_human` is set true by the classifier for intents that must hit
-- Simon's Telegram before any automated response. The dashboard Pipeline tab
-- (Phase C) surfaces these in a queue.

CREATE TABLE IF NOT EXISTS replies (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id        uuid        NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  sequence_id       uuid        REFERENCES sequences(id) ON DELETE SET NULL,
  raw_body          text        NOT NULL,
  classified_intent text,
  requires_human    boolean     NOT NULL DEFAULT false,
  processed_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- "Show me every reply from this contact" — Pipeline tab thread view.
CREATE INDEX IF NOT EXISTS idx_replies_contact
  ON replies (contact_id);

-- Classifier worker queue: "what came in that hasn't been processed yet?"
-- Partial keeps the index small once most replies are classified.
CREATE INDEX IF NOT EXISTS idx_replies_unprocessed
  ON replies (created_at)
  WHERE processed_at IS NULL;
