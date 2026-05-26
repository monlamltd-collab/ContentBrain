'use strict';
// routes/dashboard/today.js
//
// GET /dashboard/today — HTMX partial: the Approve tab (label rename per
// Phase E — path stays /dashboard/today for backward compat with bookmarks
// and the index.html shell mount). Renders draft outbound emails ABOVE
// the existing draft social posts, since outbound drafts time out fastest
// (warming caps + sequence cadence).
//
// Bulk-approve UI: outbound cards carry a checkbox; a sticky bulk-bar at
// the top batches them via POST /dashboard/approve/outbound/bulk. Cap is
// `app_config.dashboard.bulk_approve_cap` (default 10 — matches warming
// day-1 send cap so a 25-cap doesn't trigger silent deferrals).

const express = require('express');
const router = express.Router();
const { getDraftPosts, getDraftBlogPosts } = require('../../lib/supabase');

router.get('/', async (req, res) => {
  try {
    const [allDrafts, blogPosts] = await Promise.all([
      getDraftPosts(),
      getDraftBlogPosts(),
    ]);

    // Split: outbound posts render with the outbound card variant (subject,
    // contact, sequence step, approve-and-send confirm). Everything else
    // goes through the social/blog card.
    const outboundDrafts = allDrafts.filter(p => p.track === 'outbound' || p.channel === 'resend');
    const socialDrafts   = allDrafts.filter(p => !(p.track === 'outbound' || p.channel === 'resend'));

    const items = [
      ...outboundDrafts.map(p => ({ ...p, _kind: 'outbound' })),
      ...socialDrafts  .map(p => ({ ...p, _kind: 'social'   })),
      ...blogPosts     .map(p => ({ ...p, _kind: 'blog'     })),
    ];

    if (!items.length) {
      return res.send('<p class="empty">No drafts to review. All clear.</p>');
    }

    const bulkBar = outboundDrafts.length ? buildBulkBar() : '';
    const cards   = items.map(buildCard).join('\n');
    res.send(`${bulkBar}<div class="card-grid">${cards}</div>${outboundDrafts.length ? bulkScript() : ''}`);
  } catch (err) {
    console.error('[dashboard/today] error:', err.message);
    res.status(500).send(`<p class="error">Failed to load posts: ${escHtml(err.message)}</p>`);
  }
});

// ── Card variants ────────────────────────────────────────────────────────

function buildCard(post) {
  if (post._kind === 'outbound') return buildOutboundCard(post);
  if (post._kind === 'blog')     return buildBlogCard(post);
  return buildSocialCard(post);
}

function buildOutboundCard(post) {
  const meta = post.meta || {};
  const brand = post.brand || 'bridgematch';
  const track = post.track || meta.track || 'outbound';
  const step = meta.sequence_step ? `step ${escHtml(String(meta.sequence_step))}` : '';
  const company = escHtml(meta.company_name || meta.prospect?.company_name || '(unknown company)');
  const contactEmail = escHtml(meta.contact_email || meta.to || '(no email)');
  const contactName = meta.contact_name || meta.contact?.name || null;
  const subject = escHtml(post.copy_headline || '(no subject)');
  const body = escHtml(post.copy_body || '');

  // hx-confirm renders a native confirm() dialog — good enough for v1.
  // hx-prompt captures Simon's reason/feedback for reject + revise.
  return `<div class="card outbound" id="card-${post.id}">
  <div class="card-header">
    <input type="checkbox" class="bulk-select" data-post-id="${post.id}" onchange="updateBulkBar()" />
    <span class="badge brand-${escHtml(brand)}">${escHtml(brand)}</span>
    <span class="badge track-badge">${escHtml(track)}</span>
    ${step ? `<span class="badge step-badge">${step}</span>` : ''}
    <span class="muted"> to ${contactName ? escHtml(contactName) + ' ' : ''}&lt;${contactEmail}&gt; at ${company}</span>
  </div>
  <div class="copy">
    <strong>Subject:</strong> ${subject}
    <details><summary>Expand body</summary><pre class="outbound-body">${body}</pre></details>
  </div>
  <div class="actions">
    <button class="btn approve"
      hx-post="/dashboard/approve/outbound/${post.id}/approve"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML"
      hx-confirm="Approve and send to ${contactEmail}?">Approve &amp; send</button>
    <button class="btn revise"
      hx-post="/dashboard/approve/outbound/${post.id}/revise"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML"
      hx-prompt="What needs changing?">Revise</button>
    <button class="btn reject"
      hx-post="/dashboard/approve/outbound/${post.id}/reject"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML"
      hx-prompt="Why? (optional — helps future generation)">Reject</button>
  </div>
</div>`;
}

function buildSocialCard(post) {
  const brand = post.brand || 'auctionbrain';
  const title = escHtml(post.copy_headline || '(no headline)');
  const body = escHtml(post.copy_body || '');
  const badgeType = post.template_type || 'social';

  return `<div class="card" id="card-${post.id}">
  <div class="card-header">
    <span class="badge brand-${brand}">${brand}</span>
    <span class="badge type-badge">${escHtml(badgeType)}</span>
    ${post.track ? `<span class="badge track-badge">${escHtml(post.track)}</span>` : ''}
  </div>
  <div class="copy">
    <strong>${title}</strong>
    <p>${body}</p>
  </div>
  <div class="actions">
    <button class="btn approve"
      hx-post="/api/posts/${post.id}/approve"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML">Approve</button>
    <button class="btn reject"
      hx-post="/api/posts/${post.id}/reject"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML">Reject</button>
  </div>
</div>`;
}

function buildBlogCard(post) {
  const brand = post.brand || 'auctionbrain';
  const title = escHtml(post.title || '(untitled)');
  const body = escHtml((post.summary || post.meta_description || '').slice(0, 200));
  const badgeType = post.post_type || 'blog';

  return `<div class="card" id="card-${post.id}">
  <div class="card-header">
    <span class="badge brand-${brand}">${brand}</span>
    <span class="badge type-badge">${escHtml(badgeType)}</span>
  </div>
  <div class="copy">
    <strong>${title}</strong>
    <p>${body}</p>
  </div>
  <div class="actions">
    <button class="btn approve"
      hx-post="/api/blog-posts/${post.id}/approve"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML">Approve</button>
    <button class="btn reject"
      hx-post="/api/blog-posts/${post.id}/reject"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML">Reject</button>
  </div>
</div>`;
}

// ── Bulk-approve bar (outbound only) ─────────────────────────────────────

function buildBulkBar() {
  return `<div class="bulk-bar" id="bulk-bar" hidden>
  <span class="bulk-count" id="bulk-count">0 selected</span>
  <button class="btn primary"
    hx-post="/dashboard/approve/outbound/bulk"
    hx-include=".bulk-select:checked"
    hx-target="#tab-content"
    hx-swap="innerHTML"
    hx-confirm="Approve and send all selected outbound emails? They go out immediately.">Approve &amp; send selected</button>
  <button class="btn ghost" type="button" onclick="clearBulkSelect()">Clear</button>
</div>`;
}

function bulkScript() {
  return `<script>
function updateBulkBar() {
  const sel = document.querySelectorAll('.bulk-select:checked').length;
  const bar = document.getElementById('bulk-bar');
  const cnt = document.getElementById('bulk-count');
  if (cnt) cnt.textContent = sel + ' selected';
  if (bar) bar.hidden = sel === 0;
}
function clearBulkSelect() {
  document.querySelectorAll('.bulk-select').forEach(el => { el.checked = false; });
  updateBulkBar();
}
</script>`;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
