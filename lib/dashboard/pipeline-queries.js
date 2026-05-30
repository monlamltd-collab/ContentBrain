'use strict';

// ── Pipeline tab query helpers (Phase F-1) ────────────────────────────────
//
// Backs the three /api/dashboard/pipeline/* section endpoints + the
// per-row action handlers in routes/dashboard/pipeline.js. Read-only
// queries — every mutation goes through lib/sequence.js or lib/suppression.js
// (Pipeline doesn't refactor either; it consumes them).
//
// Design source of truth: .ruflo/phase-f-pipeline-tab-design.md §1.5
// (query budget) + §2 (per-row actions).
//
// Query budget: 6 queries per main-page render (3 sections × ~2 queries
// each). Sub-millisecond at current row counts (<500 rows total). No
// caching layer — if volumes ever climb (10k+ replies), add a 60s
// in-memory cache keyed on (windowDays, now-rounded-to-minute), matching
// the pattern lib/dashboard/performance-queries.js comments out.
//
// Window-string parsing is shared with the action endpoints (a window
// param appears on multiple endpoints) — `parseWindow` is exported.
//
// House style: lazy require the supabase client through the wrapper so
// tests can inject. British English in any user-facing strings (the
// queries themselves don't return UI text — that lives in the renderers).

const { supabase } = require('../supabase');

// Window strings the dashboard accepts. Matches the Pipeline tab's
// window selector (24h / 7d / 30d / all) and the design doc §1.4 default.
const VALID_WINDOWS = Object.freeze(['24h', '7d', '30d', 'all']);

// Tracks the Pipeline tab filters by. 'all' is the dashboard-only no-op.
const VALID_TRACK_FILTERS = Object.freeze(['all', 'lender', 'broker', 'auction_house']);

// Section A defaults — see design doc §1.1. These are the intents whose
// replies set requires_human=true via the classifier action lookup.
const DEFAULT_ATTENTION_INTENTS = Object.freeze([
  'interested',
  'questions',
  'hostile',
  'complaint',
]);

// Section B pagination defaults.
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

// Section C defaults.
const DEFAULT_RECENT_LIMIT = 40;
const MAX_RECENT_LIMIT = 100;

/**
 * Parse a window string ('24h' | '7d' | '30d' | 'all') into ISO bounds.
 *
 * @param {string} window
 * @returns {{from: string, to: string, label: string}} ISO timestamps
 *          (from = 1970-01-01 for 'all'), and the original label.
 */
function parseWindow(_window) {
  throw new Error('NOT_IMPLEMENTED: parseWindow');
}

/**
 * Section A query — replies that need a human + sequences paused
 * awaiting human input.
 *
 * Combines two Supabase reads (Supabase JS doesn't UNION cheaply, so we
 * read both and merge in JS by created_at DESC):
 *   1. replies WHERE requires_human=true AND processed_at IS NOT NULL
 *      AND classified_intent IN (intents)
 *      AND created_at >= window.from
 *      ORDER BY created_at DESC
 *      Joined with contacts + prospects (id, name, email, company_name,
 *      type, website, metadata) and the parent sequence (id, track,
 *      current_step, status) when reply.sequence_id IS NOT NULL.
 *   2. sequences WHERE status='paused' AND ended_reason IN
 *      ('awaiting_human','hostile_pause') AND created_at >= window.from
 *      ORDER BY created_at DESC (using created_at — no updated_at column;
 *      see design doc §5.5 default (a) = last_sent_at as proxy when sort
 *      key matters; for "newest stuck" we use COALESCE(last_sent_at,
 *      created_at) DESC).
 *      Joined with contacts + prospects + the most recent reply (for
 *      the inline "Latest reply" details).
 *
 * Returns merged array, newest first, capped at 50 total rows.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowDays=7]      window length in days, or 'all'
 * @param {string[]} [opts.intents]         classified_intent filter set
 *                                          (default DEFAULT_ATTENTION_INTENTS)
 * @returns {Promise<Array<{kind:'reply'|'paused-sequence', ts:string, data:object}>>}
 */
async function getNeedsAttention(_opts) {
  throw new Error('NOT_IMPLEMENTED: getNeedsAttention');
}

/**
 * Section B query — active sequences, paginated.
 *
 * SQL shape (Supabase JS chain):
 *   sequences WHERE status='active'
 *     [AND track=$track]   -- omitted when track='all'
 *     ORDER BY track ASC, next_scheduled_at ASC
 *     LIMIT pageSize OFFSET (page * pageSize)
 *   Joined with contacts (id, name, email) + prospects (id, type,
 *   company_name, website, metadata).
 *
 * Returns the rows plus a `hasMore` flag (true if rows.length === pageSize
 * — caller renders the "Load more" button conditionally). The flag is a
 * heuristic, not a count: an exact count would require a second query
 * (`COUNT(*)`) which isn't worth it at our volumes.
 *
 * @param {object} [opts]
 * @param {string} [opts.track='all']      'all' | 'lender' | 'broker' | 'auction_house'
 * @param {number} [opts.page=0]           offset page number (0-indexed)
 * @param {number} [opts.pageSize=25]      clamped to [1, MAX_PAGE_SIZE]
 * @returns {Promise<{rows: object[], page: number, pageSize: number, hasMore: boolean}>}
 */
async function getActiveSequences(_opts) {
  throw new Error('NOT_IMPLEMENTED: getActiveSequences');
}

/**
 * Section C query — recent activity feed (outbound sends + replies,
 * interleaved chronologically).
 *
 * Two reads, merged in JS:
 *   1. posts WHERE track='outbound' (OR channel='resend')
 *      AND status='published' AND published_at IS NOT NULL
 *      AND published_at >= window.from
 *      ORDER BY published_at DESC LIMIT 20
 *      Selecting id, copy_headline, meta, published_at.
 *   2. replies WHERE created_at >= window.from
 *      ORDER BY created_at DESC LIMIT 20
 *      Selecting id, classified_intent, created_at + joined contact email
 *      and prospect company_name.
 *
 * Merge in JS, keep newest `limit` total (default 40), return flat
 * timeline with discriminator field `kind`.
 *
 * @param {object} [opts]
 * @param {number} [opts.windowHours=24]   window length in hours
 *                                          (24h default — Section C is
 *                                          tighter than A/B by design)
 * @param {number} [opts.limit=40]         total rows after merge, [10, 100]
 * @returns {Promise<Array<{kind:'outbound'|'reply', ts:string, data:object}>>}
 */
async function getRecentActivity(_opts) {
  throw new Error('NOT_IMPLEMENTED: getRecentActivity');
}

/**
 * Helper: fetch one reply row with all the context the action handlers
 * need (contact, prospect, sequence). Single SELECT with nested joins —
 * no N+1.
 *
 * Used by:
 *   - POST /reply/:id/resolve         (just needs the id, but reuses this)
 *   - POST /reply/:id/meeting-booked  (needs contact_id + metadata)
 *   - POST /reply/:id/wrong-contact   (needs contact.email + sequence_id)
 *
 * @param {string} replyId
 * @returns {Promise<object|null>}  null when not found
 */
async function getReplyByIdWithContext(_replyId) {
  throw new Error('NOT_IMPLEMENTED: getReplyByIdWithContext');
}

/**
 * Helper: fetch one sequence row with the context the action handlers
 * need (contact, prospect). Used by the pause/force-next handlers when
 * they need to re-render the card after the action.
 *
 * @param {string} sequenceId
 * @returns {Promise<object|null>}
 */
async function getSequenceByIdWithContext(_sequenceId) {
  throw new Error('NOT_IMPLEMENTED: getSequenceByIdWithContext');
}

/**
 * Compute the "Jump to BridgeMatch" link for a prospect/contact pair.
 *
 * Fallback chain (per design doc §2.1 — Bridgematch admin URL surface
 * doesn't deeplink by FRN; see §5.2 for the investigation):
 *
 *   prospect.type === 'lender'      → ${BASE}/admin/edit?lender=<encoded company_name>
 *                                     (hint param Bridgematch's frontend
 *                                      ignores today; harmless if so, and
 *                                      a trivial follow-up to honour)
 *   prospect.type === 'broker'
 *     AND prospect.metadata.frn     → https://register.fca.org.uk/s/firm?id=<frn>
 *                                     (FCA register is FRN-keyed)
 *   prospect.type === 'auction_house'
 *     OR broker-no-FRN              → prospect.website (when set)
 *   fallback                         → ${BASE}
 *
 * BASE defaults to `https://bridgematch.co.uk`; override via
 * `process.env.BRIDGEMATCH_BASE_URL` for staging.
 *
 * @param {object} prospect  { id, type, company_name, website, metadata }
 * @param {object} [_contact] reserved for future per-contact deeplinks (FCA
 *                            individuals etc.); unused today.
 * @returns {string} absolute URL, never null
 */
function buildBridgematchJumpUrl(_prospect, _contact) {
  throw new Error('NOT_IMPLEMENTED: buildBridgematchJumpUrl');
}

module.exports = {
  // Constants (exported for the route handlers + the renderers)
  VALID_WINDOWS,
  VALID_TRACK_FILTERS,
  DEFAULT_ATTENTION_INTENTS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_RECENT_LIMIT,
  MAX_RECENT_LIMIT,
  // Queries
  parseWindow,
  getNeedsAttention,
  getActiveSequences,
  getRecentActivity,
  getReplyByIdWithContext,
  getSequenceByIdWithContext,
  // Helpers
  buildBridgematchJumpUrl,
  // Implicit test seam — coder may stub the supabase reference via require cache.
  _internals: { supabase },
};
