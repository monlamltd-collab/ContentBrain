'use strict';

// ── Settings tab HTML renderers (Phase F-2) ───────────────────────────────
//
// Pure render helpers — no I/O, no DB. Consumed by routes/dashboard/
// settings.js for the section GETs and the per-control POST swap responses.
// Mirrors lib/dashboard/pipeline-render.js shape: each helper takes a plain
// object and returns a string of HTML.
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
// All user-facing strings are British English.

const { escHtml, escAttr } = require('./html');

/**
 * Compact relative-time formatter — mirror of pipeline-render.relativeTime.
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
 * Render the full collapsible block for one outbound track.
 */
function renderOutboundCard(track, status) {
  const s = status || {};
  const trackLabel = escHtml(track);
  const pausedBadge = s.isPaused
    ? '<span class="badge status-paused">PAUSED</span>'
    : '<span class="badge status-active">SENDING</span>';
  const summaryLine = `Day <strong>${escHtml(String(s.day ?? 0))}</strong> &middot; cap <strong>${escHtml(String(s.cap ?? 0))}</strong> &middot; sent today <strong>${escHtml(String(s.sentToday ?? 0))}</strong>`;

  const steadyValue = s.steady_cap_override != null ? String(s.steady_cap_override) : '';
  const steadyPlaceholder = `default ${s.steady_cap_default ?? 300}`;

  const fromValue = s.from_address_override || '';
  const fromResolved = s.from_address_resolved || '';

  const toneValue = s.tone_override || '';
  const toneLen = toneValue.length;

  // Pause/resume toggle — single button form, action depends on current state.
  const pauseAction = s.isPaused ? 'resume' : 'pause';
  const pauseLabel = s.isPaused ? 'Resume sending' : 'Pause sending';

  return `<div class="track-card" id="track-card-${escAttr(track)}">
  <details${s.isPaused ? '' : ' open'}>
    <summary>
      <span class="badge track-badge">${trackLabel}</span>
      ${summaryLine}
      ${pausedBadge}
    </summary>
    <div class="track-body">
      <div class="warming-status">
        Start date <strong>${escHtml(s.startDate || '—')}</strong>
        &middot; today's cap <strong>${escHtml(String(s.cap ?? 0))}</strong>
        &middot; remaining <strong>${escHtml(String(Math.max(0, (s.cap ?? 0) - (s.sentToday ?? 0))))}</strong>
      </div>

      <form class="settings-control"
            hx-post="/dashboard/settings/outbound/${escAttr(track)}/${pauseAction}"
            hx-target="#track-card-${escAttr(track)}"
            hx-swap="outerHTML">
        <button type="submit">${pauseLabel}</button>
        <span class="muted">Pausing is reversible &mdash; flip it back any time.</span>
      </form>

      <form class="settings-control"
            hx-post="/dashboard/settings/outbound/${escAttr(track)}/steady-cap"
            hx-target="#track-card-${escAttr(track)}"
            hx-swap="outerHTML">
        <label>
          Steady-state cap (applied from day 30 onwards)
          <input type="number" name="steady_cap" min="0" max="2000"
                 value="${escAttr(steadyValue)}"
                 placeholder="${escAttr(steadyPlaceholder)}">
        </label>
        <button type="submit">Save</button>
        <button type="submit" name="reset" value="1" class="link-btn">Reset to default</button>
        <span class="saved-flash" aria-hidden="true">Saved &check;</span>
      </form>

      <form class="settings-control"
            hx-post="/dashboard/settings/outbound/${escAttr(track)}/from-address"
            hx-target="#track-card-${escAttr(track)}"
            hx-swap="outerHTML">
        <label>
          From address override
          <input type="text" name="from_address"
                 value="${escAttr(fromValue)}"
                 placeholder="e.g. Simon Deeming &lt;simon@auctionbrain.co.uk&gt;">
          <small class="muted">Currently resolving to: <code>${escHtml(fromResolved)}</code></small>
        </label>
        <button type="submit">Save override</button>
        <button type="submit" name="clear" value="1" class="link-btn">Clear override (use env)</button>
        <span class="saved-flash" aria-hidden="true">Saved &check;</span>
      </form>

      <form class="settings-control"
            hx-post="/dashboard/settings/outbound/${escAttr(track)}/tone"
            hx-target="#track-card-${escAttr(track)}"
            hx-swap="outerHTML">
        <label>
          Tone override (max 500 chars)
          <textarea name="tone" maxlength="500" rows="3"
                    placeholder="default (track persona &mdash; see lib/generate-outbound.js)">${escHtml(toneValue)}</textarea>
          <span class="char-counter"><span class="char-count">${toneLen}</span>/500</span>
        </label>
        <button type="submit">Save</button>
        <button type="submit" name="clear" value="1" class="link-btn">Reset to default</button>
        <span class="saved-flash" aria-hidden="true">Saved &check;</span>
      </form>
    </div>
  </details>
</div>`;
}

// ── Section 2 — Suppression ───────────────────────────────────────────────

/**
 * Render one <tr> for the suppression table.
 */
function renderSuppressionRow(row) {
  const r = row || {};
  const key = r.email_or_domain || '';
  // Row id is the raw key with anything-not-id-safe replaced. Keeps the
  // selector usable; the canonical key still travels via the hidden input.
  const safeId = `supp-row-${key.replace(/[^a-zA-Z0-9_.-]/g, '_')}`;
  const reason = r.reason || 'unknown';
  return `<tr id="${escAttr(safeId)}">
  <td><code>${escHtml(key)}</code></td>
  <td><span class="badge reason-${escAttr(reason)}">${escHtml(reason)}</span></td>
  <td class="muted">${escHtml(relativeTime(r.added_at))}</td>
  <td>
    <form hx-post="/dashboard/settings/suppression/remove"
          hx-target="#${escAttr(safeId)}"
          hx-swap="outerHTML"
          hx-confirm="Remove ${escAttr(key)} from suppression? Future sends to this address will go through (subject to all other gates).">
      <input type="hidden" name="email_or_domain" value="${escAttr(key)}">
      <button type="submit">Remove</button>
    </form>
  </td>
</tr>`;
}

/**
 * Render the suppression table fragment.
 * Page 0 returns the table shell + rows + (optional) Load more button.
 * Page > 0 returns just the rows + (optional) Load more (for beforeend swap).
 */
function renderSuppressionTable(rows, q, hasMore, page) {
  const safeRows = Array.isArray(rows) ? rows : [];
  const safeQ = typeof q === 'string' ? q : '';
  const safePage = Number.isInteger(page) && page >= 0 ? page : 0;

  const rowsHtml = safeRows.map(renderSuppressionRow).join('\n');

  const loadMore = hasMore
    ? `<button class="pipeline-load-more"
        hx-get="/dashboard/settings/suppression?page=${safePage + 1}&amp;q=${encodeURIComponent(safeQ)}"
        hx-target="#suppression-tbody"
        hx-swap="beforeend"
        hx-on:htmx:after-on-load="this.remove()">Load more</button>`
    : '';

  if (safePage > 0) {
    return `${rowsHtml}\n${loadMore}`;
  }

  if (!safeRows.length) {
    return `<p class="empty">No suppression entries${safeQ ? ` matching &ldquo;${escHtml(safeQ)}&rdquo;` : ''}.</p>`;
  }

  return `<table class="suppression-table">
  <thead>
    <tr><th>Email or domain</th><th>Reason</th><th>Added</th><th></th></tr>
  </thead>
  <tbody id="suppression-tbody">
${rowsHtml}
  </tbody>
</table>
${loadMore}`;
}

// ── Section 3 — Content ───────────────────────────────────────────────────

/**
 * Render one card per brand with the active toggle + directive textarea.
 */
function renderContentCard(brand, isActive, directive) {
  const safeBrand = String(brand);
  const safeDirective = directive || '';
  const directiveLen = safeDirective.length;
  const brandLabel = safeBrand === 'auctionbrain' ? 'AuctionBrain'
                  : safeBrand === 'bridgematch' ? 'BridgeMatch'
                  : safeBrand;

  return `<div class="content-brand-card">
  <h4>${escHtml(brandLabel)}</h4>

  <form class="settings-control"
        hx-post="/dashboard/settings/content/brand/${escAttr(safeBrand)}/active"
        hx-target="closest .content-brand-card"
        hx-swap="outerHTML">
    <label class="switch">
      <input type="checkbox" name="active" value="on"${isActive ? ' checked' : ''}>
      <span>Brand active (content generated for this brand)</span>
    </label>
    <button type="submit">Save</button>
    <span class="saved-flash" aria-hidden="true">Saved &check;</span>
  </form>

  <form class="settings-control"
        hx-post="/dashboard/settings/content/brand/${escAttr(safeBrand)}/directive"
        hx-target="closest .content-brand-card"
        hx-swap="outerHTML">
    <label>
      Editorial directive (max 1000 chars)
      <textarea name="directive" maxlength="1000" rows="4"
                placeholder="e.g. &lsquo;Lean harder into data-point hooks this week &mdash; fewer how-tos.&rsquo;">${escHtml(safeDirective)}</textarea>
      <span class="char-counter"><span class="char-count">${directiveLen}</span>/1000</span>
    </label>
    <button type="submit">Save</button>
    <button type="submit" name="clear" value="1" class="link-btn">Clear directive</button>
    <span class="saved-flash" aria-hidden="true">Saved &check;</span>
  </form>
</div>`;
}

/**
 * Render the template-weights form — 4 range sliders + Save + Reset.
 */
function renderTemplateWeights(weights) {
  const w = weights || {};
  const types = ['stat', 'hook', 'list', 'reel'];
  const sliders = types.map(t => {
    const val = Number.isFinite(w[t]) ? w[t] : 1;
    return `  <label>
    ${escHtml(t)}
    <input type="range" name="weight_${escAttr(t)}" min="0" max="5" step="1" value="${escAttr(String(val))}">
    <span class="range-value">${escHtml(String(val))}</span>
  </label>`;
  }).join('\n');

  return `<form class="settings-control template-weights"
        hx-post="/dashboard/settings/content/template-weights"
        hx-target="this"
        hx-swap="outerHTML">
  <p class="muted">Template mix &mdash; 0 disables, 5 is 5&times; the base weight.</p>
${sliders}
  <button type="submit">Save</button>
  <button type="submit" name="reset" value="1" class="link-btn">Reset to equal (1,1,1,1)</button>
  <span class="saved-flash" aria-hidden="true">Saved &check;</span>
</form>`;
}

// ── Section 4 — System ────────────────────────────────────────────────────

/**
 * Render the three system controls in one block.
 */
function renderSystemSection(systemLevers) {
  const s = systemLevers || {};
  const bulkCap = s.bulk_approve_cap != null ? String(s.bulk_approve_cap) : '';
  const telegramOn = s.send_telegram_receipt !== false;
  const suppressionOn = s.suppression_check_enabled !== false;

  return `<div id="system-section">
  <form class="settings-control"
        hx-post="/dashboard/settings/system/bulk-approve-cap"
        hx-target="#system-section"
        hx-swap="outerHTML">
    <label>
      Bulk approve cap (max outbound drafts approved at once)
      <input type="number" name="cap" min="1" max="50"
             value="${escAttr(bulkCap)}"
             placeholder="default 10">
    </label>
    <button type="submit">Save</button>
    <button type="submit" name="reset" value="1" class="link-btn">Reset to default (10)</button>
    <span class="saved-flash" aria-hidden="true">Saved &check;</span>
  </form>

  <form class="settings-control"
        hx-post="/dashboard/settings/system/telegram-receipt"
        hx-target="#system-section"
        hx-swap="outerHTML">
    <label class="switch">
      <input type="checkbox" name="enabled" value="on"${telegramOn ? ' checked' : ''}>
      <span>Send Telegram receipt on every outbound send</span>
    </label>
    <button type="submit">Save</button>
    <span class="saved-flash" aria-hidden="true">Saved &check;</span>
  </form>

  <form class="settings-control danger-control"
        hx-post="/dashboard/settings/system/suppression-check"
        hx-target="#system-section"
        hx-swap="outerHTML"
        hx-confirm="DANGER: Disabling the suppression check means future outbound sends will NOT skip suppressed addresses. This breaks PECR compliance (commercial e-marketing rules) and risks Resend deactivation. Are you absolutely sure?">
    <label class="switch danger">
      <input type="checkbox" name="enabled" value="on"${suppressionOn ? ' checked' : ''}>
      <span>Suppression check enabled (PECR &mdash; always leave ON)</span>
    </label>
    <button type="submit">Save</button>
    <span class="saved-flash" aria-hidden="true">Saved &check;</span>
  </form>
</div>`;
}

// ── Shared helpers ────────────────────────────────────────────────────────

/**
 * Render a `.saved-flash` element. The `.show` class triggers the CSS fade.
 */
function renderSavedFlash(show) {
  const cls = show ? 'saved-flash show' : 'saved-flash';
  return `<span class="${cls}" aria-hidden="true">Saved &check;</span>`;
}

/**
 * Render an inline `.error-flash` element with a user-friendly message.
 */
function renderErrorFlash(message) {
  return `<span class="error-flash" role="alert">${escHtml(message || 'Save failed.')}</span>`;
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
