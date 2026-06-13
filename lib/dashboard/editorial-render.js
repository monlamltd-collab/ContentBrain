'use strict';

// lib/dashboard/editorial-render.js — HTML fragments for the Editorial tab
// (blog coverage / draft queue with amend / add-content / brief queue).
// Read views render server-side; actions go through the untouched
// /api/content/* JSON endpoints via the api() helper in editorial.html.

const { escHtml, escAttr, fmtDate, chip } = require('./html');
const { VALID_BRANDS } = require('./editorial-queries');

// ── Coverage ──────────────────────────────────────────────────────────────

function renderCoverageFilter(brand = '') {
  const opts = [
    { v: '', label: 'Both brands' },
    ...VALID_BRANDS.map(b => ({ v: b, label: b === 'bridgematch' ? 'BridgeMatch' : 'AuctionBrain' })),
  ];
  const buttons = opts.map(({ v, label }) => `
    <button class="filter-pill${v === brand ? ' active' : ''}"
      hx-get="/dashboard/editorial/coverage?brand=${escAttr(v)}"
      hx-target="#editorial-coverage" hx-swap="outerHTML">${escHtml(label)}</button>`).join('');
  return `<div class="filter-pills">${buttons}</div>`;
}

function renderCoverage({ posts, coverage }, brand = '') {
  const chips = coverage.map(({ tag, count, status }) =>
    `<span class="tag-chip ${escAttr(status)}" title="${count} post${count !== 1 ? 's' : ''}">${escHtml(tag)} <span class="count">${count}</span></span>`).join('\n');

  const body = coverage.length
    ? `<p class="hint">${posts} published post${posts !== 1 ? 's' : ''} · <span class="tag-chip covered">covered (1–2)</span> <span class="tag-chip saturated">saturated (3+)</span></p>
<div class="coverage-grid">${chips}</div>`
    : '<p class="hint">No published posts yet.</p>';

  return `<div id="editorial-coverage">
${renderCoverageFilter(brand)}
${body}
</div>`;
}

// ── Draft queue ───────────────────────────────────────────────────────────

function renderDraftCard(d) {
  const id = escAttr(d.id);
  const brand = VALID_BRANDS.includes(d.brand) ? d.brand : 'auctionbrain';
  const rawSummary = d.summary || String(d.content || '').replace(/[#*`]/g, '').slice(0, 200);
  const summary = rawSummary ? rawSummary.slice(0, 200) + (rawSummary.length > 200 ? '…' : '') : '';
  const score = d.evaluation_score != null
    ? `<span class="draft-score${d.evaluation_score >= 8 ? ' pass' : ''}">${Number(d.evaluation_score)}/10</span>`
    : '';

  return `<div class="card draft-card" id="draft-${id}">
  <div class="card-meta">
    ${chip(brand === 'bridgematch' ? 'BridgeMatch' : 'AuctionBrain', brand)}
    ${d.post_type ? chip(d.post_type, 'template') : ''}
    <span class="card-date">${escHtml(fmtDate(d.created_at))}</span>
    ${score}
  </div>
  <div class="draft-title">${escHtml(d.title || '(untitled)')}</div>
  ${summary ? `<div class="draft-summary">${escHtml(summary)}</div>` : ''}
  <div class="btn-row">
    <button class="btn btn-approve" onclick="edApprove('${escAttr(brand)}','${id}',this)">✓ Approve</button>
    <button class="btn btn-save" onclick="edToggleAmend('${escAttr(brand)}','${id}',this)">✎ Amend</button>
    <button class="btn btn-reject" onclick="edToggleReject('${id}')">✗ Reject&hellip;</button>
  </div>
  <div class="reject-box" id="ed-reject-${id}">
    <textarea rows="2" placeholder="Feedback for the engine (optional)&hellip;"></textarea>
    <div class="btn-row">
      <button class="btn btn-reject" onclick="edReject('${escAttr(brand)}','${id}',this)">Send rejection</button>
      <button class="btn btn-save" onclick="edToggleReject('${id}')">Cancel</button>
    </div>
  </div>
  <div class="amend-form" id="ed-amend-${id}"></div>
  <div class="status-bar" id="ed-status-${id}"></div>
</div>`;
}

function renderDraftQueue(drafts) {
  const inner = drafts.length
    ? drafts.map(d => renderDraftCard(d)).join('\n')
    : '<p class="hint">No drafts waiting for review.</p>';
  return `<div id="editorial-queue" class="draft-list">${inner}</div>`;
}

// ── Brief queue ───────────────────────────────────────────────────────────

function renderBriefCard(b) {
  const id = escAttr(b.id);
  return `<div class="brief-card" id="brief-${id}">
  <div class="brief-card-body">
    ${b.topic ? `<div class="brief-topic">${escHtml(b.topic)}</div>` : ''}
    <div>${escHtml(b.message || '')}</div>
    <div class="hint">${escHtml(fmtDate(b.created_at))}${b.brand ? ` · ${escHtml(b.brand)}` : ''}</div>
  </div>
  <button class="btn btn-clear btn-tiny" title="Dismiss" onclick="edDismissBrief('${id}',this)">✕</button>
</div>`;
}

function renderBriefQueue(briefs) {
  const inner = briefs.length
    ? briefs.map(b => renderBriefCard(b)).join('\n')
    : '<p class="hint">No briefs queued — add some in the Notes tab.</p>';
  return `<div id="editorial-briefs" class="brief-list">${inner}</div>`;
}

module.exports = {
  renderCoverage,
  renderCoverageFilter,
  renderDraftQueue,
  renderDraftCard,
  renderBriefQueue,
  renderBriefCard,
};
