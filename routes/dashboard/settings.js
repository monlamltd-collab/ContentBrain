'use strict';

// routes/dashboard/settings.js
//
// Phase F-2 — the Settings tab. Fifth and final dashboard tab; replaces
// the Telegram /tone, /messages, /hooks, /active, /templates, /directive
// command-hopping with one web UI. Every control writes the same
// app_config rows the existing Telegram commands do — no new persistence
// model.
//
// HTMX patterns mirror routes/dashboard/pipeline.js: body-parser scoped to
// THIS router only, every POST returns an HTML fragment for outerHTML swap.
// No JSON; no redirects; the swap surface is the control itself with a
// .saved-flash badge on success.
//
// All bodies are STUBS — coder fills these per the design doc §1 + §3.
// Architect deliverable is the route shape, validation contracts and the
// JSDoc on every handler.
//
// Source of truth: .ruflo/phase-f-settings-tab-design.md.

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Body-parser scoped — mirrors routes/dashboard/approve.js + pipeline.js.
// HTMX POST form bodies arrive as application/x-www-form-urlencoded; we
// scope the parser to this router so the dashboard shell doesn't have to
// global-mount one.
router.use(express.urlencoded({ extended: false }));

const settingsQueries = require('../../lib/dashboard/settings-queries');
const renderers = require('../../lib/dashboard/settings-render');

// Cache the static template at module load — same pattern as pipeline.js.
const TEMPLATE_PATH = path.join(__dirname, 'settings.html');
let TEMPLATE_CACHE = null;
function getTemplate() {
  if (TEMPLATE_CACHE == null) {
    TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return TEMPLATE_CACHE;
}

// ── Main tab render ───────────────────────────────────────────────────────

/**
 * GET /dashboard/settings — Settings tab shell. Each of the four sections
 * (Outbound, Suppression, Content, System) sub-loads its own initial state
 * via hx-trigger="load" on its wrapper div (see settings.html).
 *
 * No section data is server-rendered into the shell — keeps this handler
 * I/O free so the user sees the anchor nav + section skeletons instantly.
 */
router.get('/', (_req, res) => {
  throw new Error('NOT_IMPLEMENTED: GET /dashboard/settings — coder owns the body');
});

// ── Section 1 — Outbound ──────────────────────────────────────────────────

/**
 * GET /outbound/:track/status — HTMX fragment for one track's collapsible
 * block (warming status + pause toggle + steady-cap + from-address + tone).
 *
 * Used by both the initial load (settings.html has one of these per track)
 * and by per-control POSTs that need to re-render the whole block (e.g.
 * pause toggle, which affects the read-only status panel above it).
 *
 * Validation: :track must be in settingsQueries.VALID_TRACKS or return 400.
 *
 * @returns {string} HTML for one renderOutboundCard(track, status) block
 */
router.get('/outbound/:track/status', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: GET /outbound/:track/status — coder owns the body');
});

/**
 * POST /outbound/:track/pause — pause sending on this track immediately.
 *
 * Calls warming.pauseTrack(track). No hx-confirm: pausing is the safe
 * action and Simon may need to flip it fast during a deliverability
 * incident. Returns the re-rendered card with the paused badge on.
 *
 * Validation: :track must be in settingsQueries.VALID_TRACKS or return 400.
 */
router.post('/outbound/:track/pause', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /outbound/:track/pause — coder owns the body');
});

/**
 * POST /outbound/:track/resume — resume sending on this track immediately.
 *
 * Calls warming.resumeTrack(track). Returns the re-rendered card with the
 * paused badge off.
 *
 * Validation: :track must be in settingsQueries.VALID_TRACKS or return 400.
 */
router.post('/outbound/:track/resume', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /outbound/:track/resume — coder owns the body');
});

/**
 * POST /outbound/:track/steady-cap — write or clear the steady-state cap
 * override for a track.
 *
 * Form body:
 *   steady_cap (string) — empty/missing means "no value submitted"
 *   reset      (string) — present means "Reset to default" button hit
 *
 * Behaviour:
 *   - If `reset` is present OR `steady_cap` is empty → DELETE the
 *     `app_config WHERE brand='global' AND key='outbound.warming.<track>.steady_cap'`
 *     row (so warming.getCurrentCap falls back to DEFAULT_STEADY_CAP=300).
 *   - Otherwise: parseInt + range-check (0..2000); upsert the row.
 *
 * Validation: track ∈ VALID_TRACKS; steady_cap numeric in range.
 * Returns the re-rendered control with .saved-flash on success.
 *
 * NOTE: warming bypasses runtime-config's cache (see design doc §4.3),
 * so the write is immediately effective on the next cron tick.
 */
router.post('/outbound/:track/steady-cap', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /outbound/:track/steady-cap — coder owns the body');
});

/**
 * POST /outbound/:track/from-address — write or clear the from-address
 * override for a track.
 *
 * Form body:
 *   from_address (string) — RFC 5322 form ("Name <addr@domain>" or "addr@domain")
 *   clear        (string) — present means "Clear override (use env)" button hit
 *
 * Behaviour:
 *   - If `clear` is present OR `from_address` is empty → clearLever('global',
 *     `outbound.from.<track>`).
 *   - Otherwise: setLever('global', `outbound.from.<track>`, trimmed).
 *
 * Validation: track ∈ VALID_TRACKS; from_address must contain '@' and must
 * not contain '<script' or HTML angle brackets except as part of a RFC 5322
 * display-name (`Name <addr@domain>`).
 *
 * NOTE: this lever is honoured by lib/resend-from.js#getResendFrom (Phase
 * F-2 precedence change). setLever busts the runtime-config cache for free.
 */
router.post('/outbound/:track/from-address', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /outbound/:track/from-address — coder owns the body');
});

/**
 * POST /outbound/:track/tone — write or clear the tone override for a track.
 *
 * Form body:
 *   tone  (string) — free text, capped at 500 chars
 *   clear (string) — present means "Reset to default" button hit
 *
 * Behaviour:
 *   - If `clear` is present OR `tone` is empty → clearLever('global',
 *     `outbound_tone_<track>`). (Note: underscored key, not dotted — matches
 *     the existing convention in lib/generate-outbound.js.)
 *   - Otherwise: trim; reject if > 500 chars; setLever('global',
 *     `outbound_tone_<track>`, trimmed).
 *
 * Validation: track ∈ VALID_TRACKS; tone.length ≤ 500 after trim.
 */
router.post('/outbound/:track/tone', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /outbound/:track/tone — coder owns the body');
});

// ── Section 2 — Suppression ───────────────────────────────────────────────

/**
 * GET /suppression?page=N&q=foo — paginated suppression table fragment.
 *
 * Page 0 returns the table shell + first 25 rows + Load more button.
 * Page > 0 returns just the next 25 <tr> rows (for beforeend swap into
 * #suppression-tbody).
 *
 * Query:
 *   page (string)  — zero-based; default 0
 *   q    (string)  — case-insensitive substring filter on email_or_domain
 *
 * Validation: page parses to a non-negative integer; q is trimmed.
 */
router.get('/suppression', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: GET /suppression — coder owns the body');
});

/**
 * POST /suppression/add — INSERT a row via suppression.addSuppression.
 *
 * Form body:
 *   email_or_domain (string, required)
 *   reason          (string, required) — must be in VALID_SUPPRESSION_REASONS
 *
 * Behaviour: addSuppression(email_or_domain, reason). On success returns
 * the new <tr> fragment (renderSuppressionRow) + an OOB swap to clear the
 * add form. On idempotent no-op (row already existed) still returns the
 * <tr> so the table updates if the user was paginated past it.
 *
 * Validation: email_or_domain non-empty after trim; reason in
 * VALID_SUPPRESSION_REASONS (use assertSuppressionReason from
 * lib/sales-brain/constants.js).
 */
router.post('/suppression/add', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /suppression/add — coder owns the body');
});

/**
 * POST /suppression/remove — DELETE a row via suppression.removeSuppression
 * (Phase F-2's new helper).
 *
 * Form body:
 *   email_or_domain (string, required) — the key to remove
 *
 * Behaviour:
 *   1. removeSuppression(email_or_domain)
 *   2. sendNotification(`Settings: removed <code>${escapeHtml(key)}</code>
 *      from suppression list.`) — Telegram paper trail per design §6.6.
 *   3. Return empty 200 (the row-level hx-target removes the <tr>).
 *
 * NOTE: uses POST not DELETE because the table's per-row button is a
 * regular <form> with a hidden email_or_domain input — keeps the HTML
 * simpler than the DELETE-with-encoded-key pattern in the design doc §3.3
 * (architect call: POST + form body is more robust to special chars in
 * email addresses like '+', '%', etc., which need careful URL-encoding).
 *
 * Validation: email_or_domain non-empty after trim.
 */
router.post('/suppression/remove', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /suppression/remove — coder owns the body');
});

// ── Section 3 — Content ───────────────────────────────────────────────────

/**
 * GET /content/brands — render the brand cards section (active toggles +
 * editorial directive textareas per brand).
 *
 * Reads via getContentLevers + iterates VALID_CONTENT_BRANDS.
 */
router.get('/content/brands', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: GET /content/brands — coder owns the body');
});

/**
 * POST /content/brand/:brand/active — toggle whether a brand is in
 * active_brands.
 *
 * Form body:
 *   active (string) — 'on' if the checkbox is checked, absent otherwise
 *     (HTML form behaviour for unchecked checkboxes)
 *
 * Behaviour:
 *   - Read current active_brands via getActiveBrands().
 *   - If `active` present and brand not in array → add and setLever.
 *   - If `active` absent and brand in array → remove and setLever.
 *   - Empty array IS a valid value (semantically "content paused").
 *
 * Validation: brand ∈ VALID_CONTENT_BRANDS.
 */
router.post('/content/brand/:brand/active', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /content/brand/:brand/active — coder owns the body');
});

/**
 * POST /content/template-weights — bulk save the four template weights.
 *
 * Form body:
 *   weight_stat, weight_hook, weight_list, weight_reel (strings, 0..5)
 *   reset (string) — if present, DELETE the row (back to 1/1/1/1)
 *
 * Behaviour:
 *   - If `reset` present → clearLever('global', 'template_weights').
 *   - Otherwise: parse all four as non-negative integers, range-check
 *     (0..5), setLever('global', 'template_weights', {stat, hook, list, reel}).
 *
 * Validation: each weight integer in [0, 5].
 */
router.post('/content/template-weights', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /content/template-weights — coder owns the body');
});

/**
 * POST /content/brand/:brand/directive — write or clear the editorial
 * directive for a brand.
 *
 * Form body:
 *   directive (string) — free text, capped at 1000 chars
 *   clear     (string) — if present, DELETE the row
 *
 * Behaviour:
 *   - If `clear` present OR directive empty → clearLever(brand, 'directive').
 *   - Otherwise: trim; reject if > 1000 chars; setLever(brand, 'directive',
 *     trimmed). NOTE: brand-scoped, not 'global'.
 *
 * Validation: brand ∈ VALID_CONTENT_BRANDS; directive.length ≤ 1000.
 */
router.post('/content/brand/:brand/directive', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /content/brand/:brand/directive — coder owns the body');
});

// ── Section 4 — System ────────────────────────────────────────────────────

/**
 * GET /system — render the three system controls (bulk-approve cap,
 * Telegram receipt toggle, suppression-check danger toggle) in one swap.
 *
 * Reads via settingsQueries.getSystemLevers + renderers.renderSystemSection.
 * Mirror of GET /content/brands; both sections are small enough that one
 * read + one render is cheaper than per-control sub-loads.
 */
router.get('/system', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: GET /system — coder owns the body');
});

/**
 * POST /system/bulk-approve-cap — write or clear dashboard.bulk_approve_cap.
 *
 * Form body:
 *   cap   (string)  — number 1..50
 *   reset (string)  — if present, DELETE the row (back to default 10)
 *
 * Behaviour:
 *   - If `reset` present OR cap empty → clearLever('global',
 *     'dashboard.bulk_approve_cap').
 *   - Otherwise: parseInt + range-check (1..50); setLever.
 *
 * Validation: cap integer in [1, 50]. Hard upper limit 50 keeps the bulk
 * approve loop from hitting Resend rate-limits in one click.
 */
router.post('/system/bulk-approve-cap', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /system/bulk-approve-cap — coder owns the body');
});

/**
 * POST /system/telegram-receipt — toggle dashboard.send_telegram_receipt.
 *
 * Form body:
 *   enabled (string) — 'on' if checked, absent otherwise
 *
 * Behaviour (matches lib/outbound-receipt.js's "missing row = default ON"
 * semantics):
 *   - If `enabled` present → clearLever (so the default ON re-applies cleanly).
 *   - If `enabled` absent → setLever('global', 'dashboard.send_telegram_receipt', false).
 */
router.post('/system/telegram-receipt', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /system/telegram-receipt — coder owns the body');
});

/**
 * POST /system/suppression-check — toggle outbound.suppression_check_enabled.
 *
 * DANGER — disabling this breaks PECR compliance + risks Resend deactivation.
 * The HTML form uses hx-confirm with the full warning text (see design doc
 * §3.4) AND the control has a 2px red border via .danger-control class.
 *
 * Form body:
 *   enabled (string) — 'on' if checked, absent otherwise
 *
 * Behaviour:
 *   - setLever('global', 'outbound.suppression_check_enabled', enabled).
 *   - On EVERY flip (regardless of direction), fire sendNotification
 *     to the Telegram channel:
 *       `Settings: suppression_check_enabled toggled <on/off> by dashboard user`
 *
 * This is the only setting that logs to Telegram on every change (paper
 * trail for compliance-sensitive action). See design doc §6.3.
 *
 * IMPORTANT: the READ-SIDE gate for this lever is NOT wired in Phase F-2.
 * lib/publish.js#publishToResend still calls isSuppressed unconditionally
 * — the toggle is currently write-only. That's the SAFE failure mode and
 * is acceptable for F-2; the read-side wiring is a separate change with
 * its own compliance risk (the safe-state default must be ON-when-absent).
 */
router.post('/system/suppression-check', async (_req, _res) => {
  throw new Error('NOT_IMPLEMENTED: POST /system/suppression-check — coder owns the body');
});

module.exports = router;
