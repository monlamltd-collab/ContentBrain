'use strict';

// routes/dashboard/pipeline.js
//
// Phase F-1 — the Pipeline tab. Visual surface for the Phase C reply
// pipeline + sequence state machine. Replaces "scroll Telegram for 10
// minutes to find one thing" with a focused triage view.
//
// Three sections in one full-page render:
//   A. Needs attention — replies with requires_human=true + paused
//      sequences with awaiting_human/hostile_pause. Newest first.
//   B. Active sequences — paginated 25/page, track-chip filtered.
//      Sorted by track ASC, next_scheduled_at ASC.
//   C. Recent activity — interleaved last 20 outbound sends + last 20
//      replies, time-ordered. Read-only.
//
// Per-row quick actions map 1:1 to existing helpers in lib/sequence.js +
// lib/suppression.js — Pipeline is a read-side consumer, never a refactor
// surface. Endpoint list (all POSTs return HTML fragments for HTMX
// outerHTML swap of the originating card):
//
//   POST /reply/:id/resolve          — flip requires_human=false
//   POST /reply/:id/meeting-booked   — set contacts.metadata.meeting_booked_at + resolve
//   POST /reply/:id/wrong-contact    — suppress + complete sequence + resolve (3 side-effects)
//   POST /sequence/:id/pause         — pauseSequence(id, 'manual_pause')
//   POST /sequence/:id/force-next    — advanceSequence(id), bypassing next_scheduled_at
//
// HTMX fragment endpoints for the three sections (sub-loaded via
// hx-trigger="load" inside the main GET / fragment so the page renders
// the shell instantly and each section fills as its query returns):
//
//   GET /api/dashboard/pipeline/needs-attention?window=7d&intent=interested,questions
//   GET /api/dashboard/pipeline/active-sequences?track=lender&page=0
//   GET /api/dashboard/pipeline/recent-activity?window=24h
//
// Body-parser scoped to THIS router only (HTMX POSTs come as
// application/x-www-form-urlencoded). Same pattern as
// routes/dashboard/approve.js — keeps other routes' parsers untouched.
//
// Auth: inherited from the parent /dashboard mount (requireAuth in
// server.js). No new auth code.
//
// Design source of truth: .ruflo/phase-f-pipeline-tab-design.md.

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Body-parser scoped — mirrors routes/dashboard/approve.js:26.
router.use(express.urlencoded({ extended: false }));

// Cache the static template at module load (same pattern as
// routes/dashboard/performance.js). The shell HTML is small + never
// changes at runtime.
const TEMPLATE_PATH = path.join(__dirname, 'pipeline.html');
let TEMPLATE_CACHE = null;
function getTemplate() {
  if (TEMPLATE_CACHE == null) {
    TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return TEMPLATE_CACHE;
}

// ── Main tab render ───────────────────────────────────────────────────────

/**
 * GET /dashboard/pipeline
 *
 * Server-rendered HTML page (full-page render mounted by
 * routes/dashboard/index.js). Returns the Pipeline tab's HTML fragment:
 *   - window selector (24h / 7d / 30d / all radios), default 7d
 *   - intent chip filter (interested, questions, hostile, complaint,
 *     and "all" — drives Section A's filter param)
 *   - three empty <div> targets (#needs-attention, #active-sequences,
 *     #recent-activity), each with hx-trigger="load" firing immediately
 *     against the matching /api fragment endpoint
 *
 * No DB queries here — the three section endpoints own those. This route
 * is pure markup. Keep it that way; queries belong in
 * lib/dashboard/pipeline-queries.js so they're testable in isolation.
 */
router.get('/', (_req, res) => {
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(getTemplate());
  } catch (err) {
    console.error('[dashboard/pipeline] template read error:', err.message);
    res.status(500).send(`<p class="error">Failed to load Pipeline tab: ${escHtml(err.message)}</p>`);
  }
});

// ── Section A: needs attention ────────────────────────────────────────────

/**
 * GET /api/dashboard/pipeline/needs-attention
 *
 * Query params:
 *   - window: '24h' | '7d' | '30d' | 'all'   default '7d'
 *   - intent: comma-separated subset of VALID_REPLY_INTENTS, or 'all'
 *             default 'interested,questions,hostile,complaint'
 *
 * Returns an HTMX fragment: a list of <div class="card pipeline reply-card">
 * + <div class="card pipeline sequence-card paused"> cards interleaved by
 * created_at DESC. Cap 50 rows total (combined). Empty state copy: "No
 * replies need your attention right now."
 *
 * Backed by:
 *   - pipelineQueries.getNeedsAttention({windowDays, intents})
 *
 * Card render helpers live in this file (renderReplyCard,
 * renderPausedSequenceCard) — exported for the action endpoints to reuse
 * post-action swaps.
 */
router.get('/needs-attention', async (_req, res) => {
  void res; // coder: implement
  throw new Error('NOT_IMPLEMENTED: GET /needs-attention');
});

// ── Section B: active sequences ───────────────────────────────────────────

/**
 * GET /api/dashboard/pipeline/active-sequences
 *
 * Query params:
 *   - track: 'all' | 'lender' | 'broker' | 'auction_house'   default 'all'
 *   - page:  integer >= 0                                    default 0
 *   - pageSize: integer 1..50                                default 25
 *
 * Returns an HTMX fragment: a list of <div class="card pipeline
 * sequence-card active"> cards. Footer carries a "Load more" button
 * (hx-get same endpoint with page=page+1, hx-target=#active-sequences-list,
 * hx-swap=beforeend) when more rows remain.
 *
 * Backed by:
 *   - pipelineQueries.getActiveSequences({track, page, pageSize})
 */
router.get('/active-sequences', async (_req, res) => {
  void res; // coder: implement
  throw new Error('NOT_IMPLEMENTED: GET /active-sequences');
});

// ── Section C: recent activity ────────────────────────────────────────────

/**
 * GET /api/dashboard/pipeline/recent-activity
 *
 * Query params:
 *   - window: '24h' | '7d' | '30d' | 'all'   default '24h'
 *   - limit:  integer 10..100                default 40
 *
 * Returns an HTMX fragment: a flat list of one-line <div class="activity-row">
 * entries — outbound sends prefixed `→`, replies prefixed `←`, both
 * time-ordered DESC. No card chrome; no per-row actions.
 *
 * Backed by:
 *   - pipelineQueries.getRecentActivity({windowHours, limit})
 */
router.get('/recent-activity', async (_req, res) => {
  void res; // coder: implement
  throw new Error('NOT_IMPLEMENTED: GET /recent-activity');
});

// ── Reply quick actions ───────────────────────────────────────────────────

/**
 * POST /api/dashboard/pipeline/reply/:id/resolve
 *
 * Flip `replies.requires_human=false`. Preserves the original
 * `processed_at` (use COALESCE — don't bump it; the activity feed in
 * Section C reads off that timestamp). Guard: only updates rows where
 * requires_human=true so a double-click is a no-op.
 *
 * Returns the same reply card re-rendered with a `resolved` class
 * (greyed-out + "resolved at HH:MM" footer). HTMX outerHTML swaps the
 * card in place — Simon sees what just happened without a tab refresh.
 *
 * No body.
 */
router.post('/reply/:id/resolve', async (_req, res) => {
  void res; // coder: implement
  throw new Error('NOT_IMPLEMENTED: POST /reply/:id/resolve');
});

/**
 * POST /api/dashboard/pipeline/reply/:id/meeting-booked
 *
 * Set `contacts.metadata.meeting_booked_at = now()` for the reply's
 * contact (merge into existing metadata jsonb — don't overwrite). Also
 * flip `replies.requires_human=false`. Does NOT complete the sequence
 * (per design doc §5.3 default: meetings are contact-level, not
 * sequence-terminal — the Performance tab attributes meetings via
 * contacts.metadata.meeting_booked_at separately).
 *
 * Button is gated by intent in the card renderer — only shown when
 * intent IN ('interested', 'questions'). Server-side: no intent check;
 * Simon clicked the button, his call.
 *
 * Returns the reply card re-rendered with a `meeting-booked` class
 * (green tint + "meeting booked" footer).
 *
 * No body.
 */
router.post('/reply/:id/meeting-booked', async (_req, res) => {
  void res; // coder: implement
  throw new Error('NOT_IMPLEMENTED: POST /reply/:id/meeting-booked');
});

/**
 * POST /api/dashboard/pipeline/reply/:id/wrong-contact
 *
 * Three atomic side-effects, executed in this order:
 *   1. addSuppression(contact.email, 'wrong_person')        — lib/suppression.js
 *   2. if reply.sequence_id: completeSequence(seqId,
 *                                            'wrong_person') — lib/sequence.js
 *   3. UPDATE replies SET requires_human=false              — same row
 *
 * Order rationale: suppression first so a parallel publish-attempt sees
 * the block before the sequence-complete clears next_scheduled_at;
 * sequence-complete next so the cron stops drafting follow-ups; reply
 * resolve last so Simon's view of "what's resolved" reflects the
 * upstream changes.
 *
 * Each step is wrapped in try/catch so a single failure (e.g. addSuppression
 * conflict because Simon already suppressed manually) doesn't poison the
 * other two — same defensive shape as lib/inbound.js's action dispatcher.
 *
 * Button gated to intents OTHER than 'wrong_person' in the card renderer
 * (when the classifier already tagged it, the action ran in inbound.js;
 * this override is for the misses).
 *
 * Returns the reply card with a `wrong-contact` class.
 *
 * No body.
 */
router.post('/reply/:id/wrong-contact', async (_req, res) => {
  void res; // coder: implement
  throw new Error('NOT_IMPLEMENTED: POST /reply/:id/wrong-contact');
});

// ── Sequence quick actions ────────────────────────────────────────────────

/**
 * POST /api/dashboard/pipeline/sequence/:id/pause
 *
 * Calls `pauseSequence(id, 'manual_pause')` from lib/sequence.js. No-op
 * when already paused (the helper handles idempotency). Returns the
 * sequence card re-rendered as paused — visually, on the next page
 * refresh it'll move from Section B to Section A. No mid-swap re-fetch;
 * Simon's HTMX swap is enough.
 *
 * No body.
 */
router.post('/sequence/:id/pause', async (_req, res) => {
  void res; // coder: implement
  throw new Error('NOT_IMPLEMENTED: POST /sequence/:id/pause');
});

/**
 * POST /api/dashboard/pipeline/sequence/:id/force-next
 *
 * Bypass the cron's `WHERE next_scheduled_at <= now()` guard by clearing
 * `next_scheduled_at` first, then calling `advanceSequence(id)` from
 * lib/sequence.js directly. advanceSequence already:
 *   - guards on status='active' (no-op if paused/completed)
 *   - loads contact + prospect
 *   - generates step N+1 via the outbound prompt
 *   - inserts a posts row as status='draft'
 *   - dispatches the Telegram approval message
 * It does NOT bump current_step — that happens on publish-success via
 * bumpSequenceOnSendSuccess. Two clicks in quick succession produce two
 * draft posts (undesirable). Mitigation: button uses `hx-disabled-elt="this"`
 * — disables on first click until the swap returns.
 *
 * Returns the sequence card with a one-line status update: "Step N+1
 * drafted — awaiting approval on the Approve tab."
 *
 * No body.
 */
router.post('/sequence/:id/force-next', async (_req, res) => {
  void res; // coder: implement
  throw new Error('NOT_IMPLEMENTED: POST /sequence/:id/force-next');
});

// ── Render helpers ────────────────────────────────────────────────────────
//
// Coder: these stubs are the public render surface used by both the section
// GETs and the per-row POSTs (post-action swap-in-place). Keep them in this
// file — they're tightly coupled to the route handlers and the CSS classes
// in public/dashboard/styles.css.

/**
 * Render a reply card (Section A reply variant + post-action swaps).
 *
 * @param {object} reply        joined { reply, contact, prospect, sequence }
 * @param {object} [opts]
 * @param {'default'|'resolved'|'meeting-booked'|'wrong-contact'} [opts.state]
 * @returns {string} HTML fragment
 */
function renderReplyCard(_reply, _opts) {
  throw new Error('NOT_IMPLEMENTED: renderReplyCard');
}

/**
 * Render a paused-sequence card (Section A paused variant).
 *
 * @param {object} sequence  joined { sequence, contact, prospect, latestReply? }
 * @returns {string} HTML fragment
 */
function renderPausedSequenceCard(_sequence) {
  throw new Error('NOT_IMPLEMENTED: renderPausedSequenceCard');
}

/**
 * Render an active-sequence card (Section B + post-action swaps).
 *
 * @param {object} sequence  joined { sequence, contact, prospect }
 * @param {object} [opts]
 * @param {'default'|'paused'|'force-next-drafted'} [opts.state]
 * @returns {string} HTML fragment
 */
function renderActiveSequenceCard(_sequence, _opts) {
  throw new Error('NOT_IMPLEMENTED: renderActiveSequenceCard');
}

/**
 * Render a one-line activity row (Section C).
 *
 * @param {object} row  { kind: 'outbound'|'reply', ts, ... }
 * @returns {string} HTML fragment
 */
function renderActivityRow(_row) {
  throw new Error('NOT_IMPLEMENTED: renderActivityRow');
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
module.exports._renderers = {
  renderReplyCard,
  renderPausedSequenceCard,
  renderActiveSequenceCard,
  renderActivityRow,
};
