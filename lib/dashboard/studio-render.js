'use strict';

// lib/dashboard/studio-render.js — HTML fragments for the Studio tab.
// Card actions (save copy / approve / reject / re-render) call the existing
// /api/social/* JSON endpoints through the small api() helper that ships in
// routes/dashboard/studio.html — those endpoints are shared with Telegram
// and stay the single source of truth. Everything new (filters, settings,
// Higgsfield in PR3) is HTMX fragments.

const { escHtml, escAttr, fmtDate, chip } = require('./html');
const { VALID_BRANDS, VALID_TYPES } = require('./studio-queries');

const COPY_FIELDS = [
  { key: 'copy_headline', label: 'Headline', max: 100, cls: 'headline', rows: 2 },
  { key: 'copy_body', label: 'Body', max: 300, cls: '', rows: 3 },
  { key: 'copy_cta', label: 'CTA', max: 80, cls: '', rows: 2 },
];

function renderFilterBar({ brand = '', type = '', q = '' } = {}) {
  const brandOpts = ['', ...VALID_BRANDS].map(b =>
    `<option value="${escAttr(b)}"${b === brand ? ' selected' : ''}>${b ? escHtml(b) : 'All brands'}</option>`).join('');
  const typeOpts = ['', ...VALID_TYPES].map(t =>
    `<option value="${escAttr(t)}"${t === type ? ' selected' : ''}>${t ? escHtml(t) : 'All types'}</option>`).join('');
  return `<form class="studio-filters" id="studio-filters"
    hx-get="/dashboard/studio/grid" hx-target="#studio-grid" hx-swap="outerHTML"
    hx-trigger="change, keyup changed delay:400ms from:find input[name='q'], submit">
  <select name="brand">${brandOpts}</select>
  <select name="type">${typeOpts}</select>
  <input type="search" name="q" value="${escAttr(q)}" placeholder="Search copy&hellip;" autocomplete="off">
  <button type="submit" class="btn btn-save">Refresh</button>
</form>`;
}

function renderMediaBlock(post) {
  const bust = `?t=${Date.now()}`;
  if (post.video_url) {
    return `<div class="studio-media">
  <video src="/output/${escAttr(post.video_url)}${bust}" controls muted preload="metadata"></video>
  <span class="video-badge">MP4</span>
</div>`;
  }
  if (post.image_url) {
    return `<div class="studio-media"><img src="/output/${escAttr(post.image_url)}${bust}" alt=""></div>`;
  }
  return '<div class="studio-media"><div class="media-placeholder">no preview</div></div>';
}

function renderCopyFields(post) {
  return COPY_FIELDS.map(({ key, label, max, cls, rows }) => {
    const val = post[key] || '';
    return `<div class="copy-field">
  <label>${escHtml(label)}</label>
  <textarea data-key="${escAttr(key)}" data-max="${max}" rows="${rows}"${cls ? ` class="${escAttr(cls)}"` : ''}>${escHtml(val)}</textarea>
  <div class="charcount">${val.length} / ${max}</div>
</div>`;
  }).join('\n');
}

function renderCard(post) {
  const id = escAttr(post.id);
  return `<div class="card studio-card" id="card-${id}" data-post-id="${id}">
${renderMediaBlock(post)}
<div class="card-body">
  <div class="card-meta">
    ${chip(post.brand || 'auctionbrain', post.brand || 'auctionbrain')}
    ${chip(post.template_type || '—', 'template')}
    ${chip(post.platform || '—', 'platform')}
    <span class="card-date">${escHtml(fmtDate(post.created_at))}</span>
  </div>
  <div class="copy-fields">
${renderCopyFields(post)}
  </div>
  <div class="status-bar" id="status-${id}"></div>
</div>
<div class="card-actions">
  <div class="btn-row">
    <button class="btn btn-save" onclick="studioSaveCopy('${id}', this)">Save copy</button>
    <button class="btn btn-rerender" onclick="studioRerender('${id}', this)">Re-render</button>
  </div>
  <div class="btn-row">
    <button class="btn btn-approve" onclick="studioApprove('${id}')">Approve</button>
    <button class="btn btn-reject" onclick="studioToggleReject('${id}')">Reject&hellip;</button>
  </div>
  <div class="reject-box" id="reject-${id}">
    <textarea rows="2" placeholder="Optional feedback for next generation run&hellip;"></textarea>
    <div class="btn-row">
      <button class="btn btn-reject" onclick="studioReject('${id}')">Confirm reject</button>
      <button class="btn btn-save" onclick="studioToggleReject('${id}')">Cancel</button>
    </div>
  </div>
</div>
</div>`;
}

function renderEmpty(filtered) {
  const sub = filtered
    ? 'Try changing the filters above.'
    : 'Generation runs automatically — check back later.';
  return `<div class="empty"><strong>No drafts waiting</strong><p>${escHtml(sub)}</p></div>`;
}

function renderGrid(posts, filters = {}) {
  const filtered = Boolean(filters.brand || filters.type || (filters.q && filters.q.trim()));
  const inner = posts.length
    ? posts.map(p => renderCard(p)).join('\n')
    : renderEmpty(filtered);
  return `<div class="card-grid studio-grid" id="studio-grid">
${inner}
</div>`;
}

module.exports = { renderGrid, renderCard, renderMediaBlock, renderFilterBar, renderEmpty };
