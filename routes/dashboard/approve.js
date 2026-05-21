'use strict';
// routes/dashboard/approve.js
//
// GET /dashboard/approve — HTMX partial: posts approved but not yet published.
// Returns an HTML fragment. Gives Simon a view of what's queued for publish.

const express = require('express');
const router = express.Router();
const { getApprovedPosts } = require('../../lib/supabase');

router.get('/', async (req, res) => {
  try {
    const posts = await getApprovedPosts();

    if (!posts.length) {
      return res.send('<p class="empty">Nothing approved and waiting to publish.</p>');
    }

    const rows = posts.map(post => {
      const brand = post.brand || 'auctionbrain';
      const headline = escHtml(post.copy_headline || post.title || '(untitled)');
      const platform = escHtml(post.platform || '—');
      const approvedAt = post.approved_at
        ? new Date(post.approved_at).toLocaleString('en-GB', { dateStyle: 'short', timeStyle: 'short' })
        : '—';

      return `<tr>
  <td><span class="badge brand-${brand}">${brand}</span></td>
  <td>${headline}</td>
  <td>${platform}</td>
  <td>${approvedAt}</td>
</tr>`;
    }).join('\n');

    res.send(`<table class="approve-table">
  <thead><tr><th>Brand</th><th>Post</th><th>Platform</th><th>Approved</th></tr></thead>
  <tbody>${rows}</tbody>
</table>`);
  } catch (err) {
    console.error('[dashboard/approve] error:', err.message);
    res.status(500).send(`<p class="error">Failed to load approved posts: ${escHtml(err.message)}</p>`);
  }
});

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
