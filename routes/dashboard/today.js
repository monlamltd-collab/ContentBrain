'use strict';
// routes/dashboard/today.js
//
// GET /dashboard/today — HTMX partial: posts generated today, pending review.
// Returns an HTML fragment (no full <html> wrapper). The dashboard shell loads
// this into #tab-content via hx-get on tab click.

const express = require('express');
const router = express.Router();
const { getDraftPosts, getDraftBlogPosts } = require('../../lib/supabase');

router.get('/', async (req, res) => {
  try {
    const [socialPosts, blogPosts] = await Promise.all([
      getDraftPosts(),
      getDraftBlogPosts(),
    ]);

    const allPosts = [
      ...socialPosts.map(p => ({ ...p, _kind: 'social' })),
      ...blogPosts.map(p => ({ ...p, _kind: 'blog' })),
    ];

    if (!allPosts.length) {
      return res.send('<p class="empty">No drafts to review today. All clear.</p>');
    }

    const cards = allPosts.map(post => buildCard(post)).join('\n');
    res.send(`<div class="card-grid">${cards}</div>`);
  } catch (err) {
    console.error('[dashboard/today] error:', err.message);
    res.status(500).send(`<p class="error">Failed to load posts: ${escHtml(err.message)}</p>`);
  }
});

function buildCard(post) {
  const kind = post._kind;
  const brand = post.brand || 'auctionbrain';
  const approveEndpoint = kind === 'blog' ? `/api/blog-posts/${post.id}/approve` : `/api/posts/${post.id}/approve`;
  const rejectEndpoint  = kind === 'blog' ? `/api/blog-posts/${post.id}/reject`  : `/api/posts/${post.id}/reject`;

  const title = kind === 'blog'
    ? escHtml(post.title || '(untitled)')
    : escHtml(post.copy_headline || '(no headline)');

  const body = kind === 'blog'
    ? escHtml((post.summary || post.meta_description || '').slice(0, 200))
    : escHtml(post.copy_body || '');

  const badgeType = kind === 'blog' ? (post.post_type || 'blog') : (post.template_type || 'social');

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
      hx-post="${approveEndpoint}"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML">Approve</button>
    <button class="btn reject"
      hx-post="${rejectEndpoint}"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML">Reject</button>
  </div>
</div>`;
}

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
