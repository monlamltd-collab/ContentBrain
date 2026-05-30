-- Migration 018: persist classifier confidence + reasoning on replies (Phase F-1)
--
-- The Phase C closed loop had a missed write: lib/classify.js#classifyReply
-- returns {intent, confidence, reasoning}, lib/inbound.js feeds `confidence`
-- through `lookupAction` to drive the requires_human floor (<0.6 forces
-- human review), and includes it in the Telegram alert text — but then
-- THROWS IT AWAY before the replies UPDATE runs. `reasoning` was never
-- persisted either. See .ruflo/phase-f-pipeline-tab-design.md §5.1 for the
-- bug write-up.
--
-- Two consequences:
--   1. The Pipeline tab can't render a confidence badge without re-running
--      the classifier on every page render (wasteful + racy).
--   2. We have no audit trail for "why did the classifier think this was
--      hostile?" — useful when triaging false positives.
--
-- Both columns are nullable: rows written before this migration won't have
-- values, and a classifier failure path in lib/inbound.js falls back to
-- {questions, 0.5, '(classifier failed)'} — keeping the columns nullable
-- avoids a backfill and matches the same pattern migration 015 uses for
-- resend_email_id.
--
-- The intent+created_at composite index speeds the Pipeline "needs
-- attention" filter (`WHERE classified_intent IN (...) ORDER BY created_at
-- DESC`). Migration 013's idx_replies_unprocessed is wrong polarity for
-- this query (partial on `processed_at IS NULL`), and idx_replies_contact_created
-- (mig 015) is contact-scoped. The new index is the one the Pipeline tab
-- queries off.
--
-- House style (matches 013/015/017):
--   - IF NOT EXISTS on every DDL
--   - numeric(3,2) for confidence so 0.00..1.00 fits exactly (not floating)
--   - No CHECK constraint — application clamps to [0,1] in lib/classify.js
--   - Idempotent — safe to re-run.

-- Classifier confidence (0.00..1.00). NULL = pre-migration row or
-- classifier-fallback path. lookupAction's <0.6 floor is computed at
-- inbound time; persistence is for read-side (Pipeline badge) + audit.
ALTER TABLE replies
  ADD COLUMN IF NOT EXISTS confidence numeric(3,2);

-- Classifier's free-text reason. Quoted verbatim in the Pipeline reply
-- card's expand-details ("why did Claude tag this as hostile?"). Kept
-- nullable for the same reasons confidence is.
ALTER TABLE replies
  ADD COLUMN IF NOT EXISTS classifier_reasoning text;

-- Pipeline tab's "Needs attention" feed: ORDER BY created_at DESC,
-- filtered by classified_intent IN (...). The composite serves both the
-- WHERE and ORDER BY in a single index scan; partial WHERE on
-- classified_intent IS NOT NULL keeps the index tight (unclassified rows
-- are surfaced via idx_replies_unprocessed instead).
CREATE INDEX IF NOT EXISTS idx_replies_intent_created
  ON replies (classified_intent, created_at DESC)
  WHERE classified_intent IS NOT NULL;
