// ── Sales Brain constants (Phase B) ──────────────────────────────────────
//
// Single source of truth for the enums NOT enforced by SQL CHECK constraints.
// Architect's call (see .ruflo/phase-b-context.md): application code is the
// gatekeeper so adding a new track/source/status doesn't need a migration.
//
// Every insert path that writes a `track`, `source`, `status`, reply intent,
// or suppression reason MUST validate against the matching list here before
// the row hits Supabase. Validation helpers at the bottom of the file keep
// call sites short.
//
// British English in messages — these surface in Telegram logs.

// posts.track + sequences.track — which channel-family does this row belong to.
// 'social' is the existing content path (default for migration 008 backfill);
// the rest are outbound tracks added in Phase B/D.
const VALID_TRACKS = Object.freeze([
  'social',
  'lender',
  'broker',
  'auction_house',
]);

// prospects.source + contacts.source — where the row was imported from.
// 'bridging-brain' = the lenders.db snapshot importer (Phase B).
// 'auction-brain' / 'fca-register' arrive in Phase D.
// 'hunter' = Hunter.io enrichment (Phase B follow-up).
// 'manual' = added by Simon through the dashboard.
const VALID_SOURCES = Object.freeze([
  'bridging-brain',
  'auction-brain',
  'fca-register',
  'hunter',
  'manual',
]);

// sequences.status + posts.status (outbound subset). Posts use a wider set
// for social ('draft','approved','published','rejected'); outbound posts
// additionally use 'suppressed' when publishToResend short-circuits on a
// suppression hit. Keep both sides in lockstep here.
const VALID_STATUSES = Object.freeze([
  'draft',
  'approved',
  'published',
  'rejected',
  'suppressed',
  // sequence-only:
  'active',
  'paused',
  'completed',
  'opted_out',
  'bounced',
]);

// replies.classified_intent — Phase C will populate via lib/classify.js.
// Listed here so the webhook receiver in Phase B can stash an unclassified
// reply without inventing an intent value we'd later regret.
const VALID_REPLY_INTENTS = Object.freeze([
  'interested',
  'questions',
  'not_interested',
  'out_of_office',
  'wrong_person',
  'unsubscribe',
  'hostile',
  'complaint',
]);

// suppression.reason — every block has an audit trail. Forgetting WHY a
// domain was blocked is how it gets accidentally re-enabled later.
const VALID_SUPPRESSION_REASONS = Object.freeze([
  'bounce',          // Resend email.bounced
  'complaint',       // Resend email.complained / spam report
  'hostile_reply',   // Phase C classifier (hostile OR complaint intent)
  'unsubscribe',     // Phase C classifier / list-unsubscribe header
  'wrong_person',    // Phase C classifier — reply said "not me, try Sarah"
  'manual',          // Simon added via dashboard / Telegram
  'import',          // One-time historical list seed
]);

// sequences.ended_reason — application-enforced enum. No SQL CHECK so adding
// a new reason doesn't need a migration. Matches the state-machine diagram in
// .ruflo/phase-c-design.md §1.
const VALID_ENDED_REASONS = Object.freeze([
  'completed',         // step 4 sent OK
  'replied_decline',   // reply intent = not_interested
  'wrong_person',      // reply intent = wrong_person
  'unsubscribe',       // reply intent = unsubscribe (also triggers email suppression)
  'awaiting_human',    // reply intents needing human (interested, questions, etc.)
  'bounced',           // email.bounced webhook on a resend_id owned by this seq
  'suppressed',        // publishToResend hit suppression at step 2/3/4
  'manual_pause',      // Simon paused via Pipeline tab / Telegram
  'hostile_pause',     // reply intent = hostile or complaint (multi-contact pause)
]);

// ── Validators ─────────────────────────────────────────────────────────
// Throw an Error (not return false) so a bad insert fails loudly at the
// call site rather than silently writing a junk value.

function assertTrack(track) {
  if (!VALID_TRACKS.includes(track)) {
    throw new Error(`Invalid track '${track}'. Must be one of: ${VALID_TRACKS.join(', ')}`);
  }
  return track;
}

function assertSource(source) {
  if (!VALID_SOURCES.includes(source)) {
    throw new Error(`Invalid source '${source}'. Must be one of: ${VALID_SOURCES.join(', ')}`);
  }
  return source;
}

function assertStatus(status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
  }
  return status;
}

function assertReplyIntent(intent) {
  if (!VALID_REPLY_INTENTS.includes(intent)) {
    throw new Error(`Invalid reply intent '${intent}'. Must be one of: ${VALID_REPLY_INTENTS.join(', ')}`);
  }
  return intent;
}

function assertSuppressionReason(reason) {
  if (!VALID_SUPPRESSION_REASONS.includes(reason)) {
    throw new Error(`Invalid suppression reason '${reason}'. Must be one of: ${VALID_SUPPRESSION_REASONS.join(', ')}`);
  }
  return reason;
}

function assertEndedReason(reason) {
  if (!VALID_ENDED_REASONS.includes(reason)) {
    throw new Error(`Invalid ended_reason '${reason}'. Must be one of: ${VALID_ENDED_REASONS.join(', ')}`);
  }
  return reason;
}

module.exports = {
  VALID_TRACKS,
  VALID_SOURCES,
  VALID_STATUSES,
  VALID_REPLY_INTENTS,
  VALID_SUPPRESSION_REASONS,
  VALID_ENDED_REASONS,
  assertTrack,
  assertSource,
  assertStatus,
  assertReplyIntent,
  assertSuppressionReason,
  assertEndedReason,
};
