require('dotenv').config();

// ── Sequence engine (Phase C) ─────────────────────────────────────────────
//
// Owns the lifecycle of a `sequences` row (migration 011) — creation on the
// first successful publish, follow-up generation on each cron tick, and the
// terminal transitions driven by reply intents / bounces / suppression hits.
//
// State machine (see .ruflo/phase-c-design.md §1 for the full diagram):
//
//   (publishToResend OK on step 1)
//          │
//          ▼
//      ┌────────┐   cron tick + caps OK    ┌────────┐
//      │ active │──────────────────────────▶│ active │  (current_step+1)
//      └────┬───┘                           └────┬───┘
//           │                                    │
//           │ step 4 sent OK                     │ step 4 sent OK
//           ▼                                    ▼
//        completed                            completed
//
//   active → paused   (suppression, OOO, hand-raise)
//   active → bounced  (email.bounced webhook on this resend_id)
//   active → completed (reply=not_interested or wrong_person)
//   active → opted_out (reply=unsubscribe)
//
// Design decisions enforced here:
//   - Sequence row is created on publish-success of step 1, NOT on approval
//     (avoids zombie active rows when a send is suppressed/deferred at the
//     last moment — Phase B's publishToResend has three terminal outcomes).
//   - `current_step` advances ONLY on publish-success. Telegram approval +
//     filter passes do not advance the row. The publish handler calls
//     `advanceSequence` after sendOutbound returns ok.
//   - `next_scheduled_at` is set forward by the interval matching the step
//     we just sent: step 1 → +3d, step 2 → +7d, step 3 → +14d, step 4 → null
//     (terminal completed). Intervals come from FOLLOWUP_INTERVALS.
//   - All terminal transitions clear `next_scheduled_at` so the cron's
//     `WHERE status='active' AND next_scheduled_at <= now()` skips them.
//   - `ended_reason` is application-enforced (see constants.js — no SQL CHECK).
//
// Re-entry safety: every UPDATE is keyed on (id, current_step) — optimistic
// concurrency. Two cron ticks racing on the same row cannot double-send.
//
// House style: lazy-load supabase + sibling libs to keep the module tree
// requireable from test isolates; never log a contact email at info level;
// British English in user-facing log strings.

const { supabase } = require('./supabase');
const { assertTrack, assertStatus } = require('./sales-brain/constants');

// Follow-up offsets in DAYS, indexed by the step we JUST sent.
//   - step 1 sent → wait 3 days  → send step 2
//   - step 2 sent → wait 7 days  → send step 3 (= +10d from step 1)
//   - step 3 sent → wait 14 days → send step 4 (= +24d from step 1)
//   - step 4 sent → no next     → status='completed', next_scheduled_at=NULL
//
// The brief (GROWTH_BRAIN_BUILD.md §5.C) says "+3d / +7d / +14d after no
// reply". Researcher's design (§1) reads those as cumulative days from
// step 1; the per-step deltas resolve to [3, 7, 14]. Coder may opt to read
// these from app_config (`outbound.followup_intervals.<track>`) to honour
// the runtime override — researcher recommended it; not blocking.
const FOLLOWUP_INTERVALS = Object.freeze([3, 7, 14]);

// Final cold-open step. After this, the sequence is `completed`.
const MAX_STEP = 4;

/**
 * Create a fresh `sequences` row when step 1 publishes successfully.
 * Called from publishToResend's success branch — see lib/publish.js. NEVER
 * called on approval (Phase B has three terminal publish outcomes; an
 * approved-but-suppressed send must not leave a zombie active sequence).
 *
 * Sets initial state:
 *   - status            = 'active'
 *   - track             = track (validated against assertTrack)
 *   - current_step      = 1
 *   - last_sent_at      = now
 *   - next_scheduled_at = now + FOLLOWUP_INTERVALS[0] days
 *
 * Idempotency: migration 011's partial UNIQUE INDEX on
 *   (contact_id, track) WHERE status IN ('active','paused')
 * means a duplicate insert raises 23505. Caller wraps in try/catch and
 * treats a unique-violation as a no-op (the row exists from a prior send).
 *
 * @param {object} post     the posts row that just published (has meta.track)
 * @param {object} contact  the contacts row the post was sent to
 * @param {object} prospect the prospects row owning the contact
 * @returns {Promise<{id: string, current_step: 1, status: 'active'} | null>}
 *   inserted sequence row, or null if an existing active/paused sequence
 *   for this (contact, track) blocked the insert (race condition: another
 *   send completed first).
 * @throws on validation errors or unexpected Supabase errors.
 */
async function createSequenceOnPublish(post, contact, prospect) {
  throw new Error('createSequenceOnPublish: not yet implemented — coder');
}

/**
 * Advance a sequence by one step. Called from two places:
 *   1) The cron handler (`getDueSequences` → loop → advanceSequence) when
 *      `next_scheduled_at <= now()` — generates step N+1 via
 *      `generateOutbound`, persists a posts row with
 *      meta.sequence_id + meta.sequence_step, and dispatches it to Telegram
 *      for human approval (re-uses Phase B's outbound-approve path).
 *   2) The publish-success branch in publishToResend for steps 2-4 (after
 *      Simon approves the generated follow-up) — bumps current_step,
 *      last_sent_at = now, next_scheduled_at = now + next interval, or
 *      transitions to 'completed' if we just sent step 4.
 *
 * Optimistic-concurrency UPDATE: `WHERE id = ? AND current_step = ?` so two
 * cron ticks racing on the same row cannot double-send.
 *
 * @param {string} sequenceId  the row to advance
 * @returns {Promise<{
 *   ok: boolean,
 *   nextStep: number,
 *   queuedPostId: string|null,   // posts row inserted for the human-approval gate
 *   completed: boolean,           // true when we just sent step MAX_STEP
 * }>}
 * @throws on validation errors, generation filter failures (with .blocks),
 *   or unexpected Supabase errors.
 */
async function advanceSequence(sequenceId) {
  throw new Error('advanceSequence: not yet implemented — coder');
}

/**
 * Fetch every active sequence whose next_scheduled_at has arrived.
 *
 * Cron query — runs at 09:00 London Mon-Fri (see server.js). Returns rows
 * joined with `contacts` and `prospects` so the advance loop has everything
 * `generateOutbound` needs in one round-trip. Ordered ASC on
 * next_scheduled_at so older-due rows go first (matches the cap-per-tick
 * behaviour described in the design doc §2).
 *
 * Filters in the SQL, not in JS:
 *   - status = 'active'
 *   - current_step < MAX_STEP   (step 4 is terminal — no follow-up exists)
 *   - next_scheduled_at <= now()
 *
 * @returns {Promise<Array<{
 *   id: string,
 *   contact_id: string,
 *   track: string,
 *   current_step: number,
 *   next_scheduled_at: string,
 *   contact: { id, name, email, role, prospect_id },
 *   prospect: { id, type, company_name, website, metadata },
 * }>>}
 */
async function getDueSequences() {
  throw new Error('getDueSequences: not yet implemented — coder');
}

/**
 * Pause a sequence. Used for OOO auto-defer, suppression hits at step 2-4,
 * and any reply intent whose intent → action lookup returns
 * `sequence_action: 'pause'` (interested, questions, hostile, complaint).
 *
 * Clears `next_scheduled_at` so the cron stops picking the row up. Status
 * goes to 'paused'; `ended_reason` records why so the Pipeline tab can
 * surface a queue of awaiting-human rows distinctly from suppression-paused
 * ones. Multiple paused → active resumes are allowed (manual Telegram
 * action) — only `completeSequence` / `optOutSequence` are truly terminal.
 *
 * @param {string} id       sequence id
 * @param {string} reason   one of: 'awaiting_human', 'hostile_pause',
 *   'suppressed', 'manual_pause', 'ooo' (application-enforced; see
 *   constants.js).
 * @returns {Promise<{ok: boolean, previousStatus: string}>}
 */
async function pauseSequence(id, reason) {
  throw new Error('pauseSequence: not yet implemented — coder');
}

/**
 * Complete a sequence (terminal — no resume). Used when step 4 sends OK,
 * when a reply intent says `not_interested` (`ended_reason='replied_decline'`)
 * or `wrong_person` (`ended_reason='wrong_person'`), or when Simon manually
 * ends a paused sequence.
 *
 * @param {string} id     sequence id
 * @param {string} reason ended_reason — one of: 'completed', 'replied_decline',
 *   'wrong_person'.
 * @returns {Promise<{ok: boolean}>}
 */
async function completeSequence(id, reason) {
  throw new Error('completeSequence: not yet implemented — coder');
}

/**
 * Opt-out terminal: status → 'opted_out'. Used ONLY for reply intent
 * `unsubscribe` (and List-Unsubscribe one-click hits — see lib/unsubscribe.js).
 * The caller is responsible for calling `addSuppression(email, 'unsubscribe')`
 * — this function only handles the sequence-row transition.
 *
 * `ended_reason` is always 'unsubscribe' (no other path leads here).
 *
 * @param {string} id  sequence id
 * @returns {Promise<{ok: boolean}>}
 */
async function optOutSequence(id) {
  throw new Error('optOutSequence: not yet implemented — coder');
}

/**
 * Bounce terminal: status → 'bounced'. Triggered by Resend's `email.bounced`
 * webhook (see lib/resend.js#handleWebhook) when the bounce is hard-mapped
 * to a `resend_id` we own. Soft bounces stay 'active' — only hard bounces
 * (permanent failure) hit this path.
 *
 * Caller is responsible for `addSuppression(email, 'bounce')` — this is the
 * sequence-row half of the transition.
 *
 * @param {string} id  sequence id
 * @returns {Promise<{ok: boolean}>}
 */
async function bounceSequence(id) {
  throw new Error('bounceSequence: not yet implemented — coder');
}

/**
 * Multi-contact company pause for hostile/complaint replies.
 *
 * Brief §5.115: "hostile/complaint reply → pause all sequences to that
 * company, require human review." When Alice@acme.com sends a hostile reply,
 * we don't just pause her sequence — we pause every other active sequence
 * to a contact whose prospect_id is acme.com's prospect_id. Suppression at
 * the domain level (added separately by the caller via addSuppression(domain,
 * 'hostile_reply')) would catch future sends, but this is belt-and-braces:
 * stop the running follow-ups immediately so a +7d goes nowhere.
 *
 * The caller's own sequence is included in the scan — caller may pass
 * `excludeSequenceId` to avoid double-pausing the one that triggered this.
 *
 * @param {string} prospectId        the company to pause across
 * @param {string} reason            ended_reason (typically 'hostile_pause')
 * @param {string} [excludeSequenceId] optional — skip this one
 * @returns {Promise<{paused: number, ids: string[]}>}
 */
async function pauseSiblingsForCompany(prospectId, reason, excludeSequenceId) {
  throw new Error('pauseSiblingsForCompany: not yet implemented — coder');
}

module.exports = {
  createSequenceOnPublish,
  advanceSequence,
  getDueSequences,
  pauseSequence,
  completeSequence,
  optOutSequence,
  bounceSequence,
  pauseSiblingsForCompany,
  FOLLOWUP_INTERVALS,
  MAX_STEP,
};
