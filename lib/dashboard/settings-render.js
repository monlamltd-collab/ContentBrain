'use strict';

// ── Settings tab HTML renderers (Phase F-2) ───────────────────────────────
//
// Pure render helpers — no I/O, no DB. Consumed by routes/dashboard/
// settings.js for the section GETs and the per-control POST swap responses.
// Mirrors lib/dashboard/pipeline-render.js shape: each helper takes a plain
// object and returns a string of HTML.
//
// All bodies are STUBS — coder fills these per the design doc §1 + §3.
//
// Class taxonomy (matches new styles in public/dashboard/styles.css):
//   .settings-control                — the per-control form wrapper
//   .settings-control.danger-control — red-bordered (suppression-check toggle)
//   .settings-section.section-outbound|suppression|content|system
//   .saved-flash, .saved-flash.show  — fade-out "Saved ✓" badge
//   .error-flash                     — inline error message
//   .warming-status                  — read-only per-track status panel
//   .suppression-table, .suppression-add
//   .settings-anchors                — sticky top-of-tab jump nav
//
// All user-facing strings are British English (button labels, modal copy,
// tooltips, placeholders).

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escAttr(s) {
  return escHtml(s);
}

/**
 * Compact relative-time formatter — mirror of pipeline-render.relativeTime.
 * Duplicated rather than re-imported so settings-render is self-contained.
 */
function relativeTime(iso) {
  if (!iso) return '—';
  let then;
  try { then = new Date(iso).getTime(); } catch { return '—'; }
  if (!Number.isFinite(then)) return '—';
  const deltaSec = Math.round((Date.now() - then) / 1000);
  if (deltaSec < 60) return `${Math.max(0, deltaSec)}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  if (deltaSec < 86400 * 14) return `${Math.floor(deltaSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}

// ── Section 1 — Outbound ──────────────────────────────────────────────────

/**
 * Render the full collapsible block for one outbound track. Includes:
 *   - <summary> with track name + cap one-liner + paused badge
 *   - warming status panel (read-only)
 *   - pause/resume toggle
 *   - steady-state cap input + Reset button
 *   - from-address input + Clear button + "currently from env" hint
 *   - tone textarea + char counter + Reset button
 *
 * @param {string} track  one of VALID_TRACKS
 * @param {object} status shape from getOutboundTrackStatus()
 * @returns {string} HTML for one <details> block
 */
function renderOutboundCard(track, status) {
  throw new Error('NOT_IMPLEMENTED: renderOutboundCard — coder owns the body');
}

// ── Section 2 — Suppression ───────────────────────────────────────────────

/**
 * Render one <tr> for the suppression table. id is `supp-row-${escapedKey}`
 * so the per-row hx-target works.
 *
 * @param {object} row { email_or_domain, reason, added_at }
 * @returns {string} `<tr>...</tr>`
 */
function renderSuppressionRow(row) {
  throw new Error('NOT_IMPLEMENTED: renderSuppressionRow — coder owns the body');
}

/**
 * Render the suppression table fragment for a page-load or load-more swap.
 * Includes the table shell only on page 0 (subsequent pages return raw <tr>
 * fragments for `beforeend` swap into #suppression-tbody).
 *
 * @param {Array} rows    output of getSuppressionPage().rows
 * @param {string} q      the current search filter (echoed back in pagination URL)
 * @param {boolean} hasMore  whether to render the Load more button
 * @param {number} page   current page (0-based) — controls shell vs fragment
 * @returns {string} HTML fragment
 */
function renderSuppressionTable(rows, q, hasMore, page) {
  throw new Error('NOT_IMPLEMENTED: renderSuppressionTable — coder owns the body');
}

// ── Section 3 — Content ───────────────────────────────────────────────────

/**
 * Render one card per brand (auctionbrain, bridgematch) with the active
 * toggle on top and the editorial directive textarea below. Stacked
 * vertically per design doc §6.7.
 *
 * @param {string} brand          'auctionbrain' | 'bridgematch'
 * @param {boolean} isActive      whether this brand is in active_brands
 * @param {string|null} directive current editorial directive (null = empty)
 * @returns {string} HTML for one brand card
 */
function renderContentCard(brand, isActive, directive) {
  throw new Error('NOT_IMPLEMENTED: renderContentCard — coder owns the body');
}

/**
 * Render the template-weights form (4 range inputs + Save + Reset).
 *
 * @param {object} weights { stat, hook, list, reel }
 * @returns {string} HTML for the weights form
 */
function renderTemplateWeights(weights) {
  throw new Error('NOT_IMPLEMENTED: renderTemplateWeights — coder owns the body');
}

// ── Section 4 — System ────────────────────────────────────────────────────

/**
 * Render the three system controls in one block:
 *   1. Bulk approve cap (number input + Reset)
 *   2. Telegram receipt toggle
 *   3. Suppression-check toggle (DANGER — red-bordered, hx-confirm)
 *
 * @param {object} systemLevers shape from getSystemLevers()
 * @returns {string} HTML for the System section body
 */
function renderSystemSection(systemLevers) {
  throw new Error('NOT_IMPLEMENTED: renderSystemSection — coder owns the body');
}

// ── Shared helpers ────────────────────────────────────────────────────────

/**
 * Render a `.saved-flash` element. After POST, the server returns the same
 * control re-rendered with `show=true` so the CSS animation fires.
 *
 * @param {boolean} show  whether to apply the .show class (animation trigger)
 * @returns {string}
 */
function renderSavedFlash(show) {
  throw new Error('NOT_IMPLEMENTED: renderSavedFlash — coder owns the body');
}

/**
 * Render an inline `.error-flash` element with a user-friendly message.
 * Used by POST handlers on 400/500 to surface validation/internal failures
 * without leaving the user on a broken page.
 *
 * @param {string} message
 * @returns {string}
 */
function renderErrorFlash(message) {
  throw new Error('NOT_IMPLEMENTED: renderErrorFlash — coder owns the body');
}

module.exports = {
  // Utilities
  escHtml,
  escAttr,
  relativeTime,

  // Section 1 — Outbound
  renderOutboundCard,

  // Section 2 — Suppression
  renderSuppressionRow,
  renderSuppressionTable,

  // Section 3 — Content
  renderContentCard,
  renderTemplateWeights,

  // Section 4 — System
  renderSystemSection,

  // Shared
  renderSavedFlash,
  renderErrorFlash,
};
