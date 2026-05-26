'use strict';
// routes/dashboard/approve.js
//
// GET  /dashboard/approve                       — Queue tab (existing): approved posts waiting to publish.
// POST /dashboard/approve/outbound/:id/approve  — Phase E: approve+send a single outbound draft.
// POST /dashboard/approve/outbound/:id/reject   — Phase E: reject an outbound draft (optional reason).
// POST /dashboard/approve/outbound/:id/revise   — Phase E: stash a revision request, drop back to draft.
// POST /dashboard/approve/outbound/bulk         — Phase E: bulk-approve up to bulk_approve_cap outbound drafts.
//
// HTMX fragments — each POST returns a card-shaped HTML snippet (or, for
// bulk, a tab re-render with a banner). All require no auth in this
// router because the parent /dashboard mount is auth-gated upstream
// (see routes/dashboard/index.js + the global requireAuth wrapper in
// server.js).

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

// ── Phase E: outbound action endpoints ────────────────────────────────────
//
// Stubs for the Phase E coder. The handler bodies below describe the
// expected behaviour as code-shaped TODO comments — the coder wires in
// publish()/updatePostStatus()/getPostById() and writes the card-shaped
// response fragments. Each route is mounted so HTMX in today.js renders
// the correct hx-post URL; calling them today will surface 501s loudly.

/**
 * Approve + send a single outbound draft. Mirrors the Telegram
 * cb:outbound-approve flow at server.js:1786 — coder should extract the
 * shared logic into a helper (e.g. lib/closed-loop/outbound-approval.js
 * or inline alongside this route) so both surfaces stay in sync.
 *
 * Behaviour to implement:
 *  1. updatePostStatus(req.params.id, 'approved')
 *  2. const post = await getPostById(req.params.id)
 *  3. const result = await publish(post)  // routes to publishToResend
 *  4. publishToResend now sends a Telegram receipt on success (see
 *     lib/publish.js — Phase E commit 5).
 *  5. Return card-shaped HTML fragment with the result inline:
 *       SUCCESS  → '<div class="card outbound sent">Sent to {email}</div>'
 *       SUPPRESSED → '<div class="card outbound suppressed">…</div>'
 *       DEFERRED → '<div class="card outbound deferred">…</div>'
 *     Status code 200 in all of these (HTMX swaps on 2xx).
 *  6. On error → 500 + '<div class="error">…</div>' fragment.
 */
router.post('/outbound/:id/approve', async (req, res) => {
  // BODY DELIBERATELY OMITTED — Phase E coder stub.
  res.status(501).send('<div class="error">outbound approve not implemented (Phase E coder stub)</div>');
});

/**
 * Reject an outbound draft. Optional `reason` form field captured via
 * HTMX hx-prompt — coder stores it in posts.rejection_feedback so the
 * social-side learning loop can pull it via getRecentRejectedPosts().
 *
 * Behaviour to implement:
 *  1. const reason = (req.body.prompt || req.body.reason || '').trim() || null;
 *     // HTMX hx-prompt submits the captured value under the form-field
 *     // name 'HX-Prompt' as a header AND as a body field depending on
 *     // version — read both. Phase B's existing reject endpoints in
 *     // server.js use req.headers['hx-prompt']; mirror that.
 *  2. await supabase.from('posts').update({
 *       status: 'rejected',
 *       rejection_feedback: reason,
 *     }).eq('id', req.params.id);
 *  3. Return '' (empty fragment) so the card disappears on swap.
 */
router.post('/outbound/:id/reject', async (req, res) => {
  // BODY DELIBERATELY OMITTED — Phase E coder stub.
  res.status(501).send('<div class="error">outbound reject not implemented (Phase E coder stub)</div>');
});

/**
 * Revise an outbound draft — stash-only per Simon's Phase E call. Auto-
 * regen is deferred to Phase F.
 *
 * Behaviour to implement:
 *  1. const feedback = req.headers['hx-prompt'] || req.body.feedback || '';
 *  2. Read post.meta; merge { revision_request: feedback.trim() } into it.
 *  3. supabase.from('posts').update({ status: 'draft', meta: { ...meta, revision_request } }).eq('id', id)
 *     // Setting status='draft' has no effect on the publish cron — the
 *     // post is already 'draft' when revise is clicked. The explicit set
 *     // is belt-and-braces for future auto-regen-from-meta flows.
 *  4. Return a card-shaped fragment that re-renders the same draft with
 *     a small "Pending revision: {feedback}" badge, so Simon can edit
 *     the body in place or queue a re-generation manually.
 */
router.post('/outbound/:id/revise', async (req, res) => {
  // BODY DELIBERATELY OMITTED — Phase E coder stub.
  res.status(501).send('<div class="error">outbound revise not implemented (Phase E coder stub)</div>');
});

/**
 * Bulk-approve a batch of outbound drafts.
 *
 * HTMX form-encodes the checkbox values as repeated `postId` fields
 * (since the checkboxes in today.js use name="postId" via the
 * hx-include=".bulk-select:checked" attribute — coder may need to
 * add the name attribute to the checkbox markup, currently it relies
 * on data-post-id; switch to name="postId" value="{id}" for the form
 * encode to work).
 *
 * Behaviour to implement:
 *  1. const cap = await getAppConfigNumber('dashboard.bulk_approve_cap', 10);
 *  2. const ids = [].concat(req.body.postId || []).slice(0, cap);
 *  3. For each id: call the same approve+send helper as
 *     /outbound/:id/approve. Collect { id, ok, reason } results.
 *  4. Re-render the Approve tab fragment (call into today.js render
 *     OR inline the same fetch-and-render logic) with a banner at the
 *     top summarising results: "Sent N; suppressed K; deferred M;
 *     errored E."
 *  5. If req.body.postId.length > cap, banner notes the truncation:
 *     "Capped at {cap} — selected {N}, processed {cap}, rest unchanged."
 */
router.post('/outbound/bulk', async (req, res) => {
  // BODY DELIBERATELY OMITTED — Phase E coder stub.
  res.status(501).send('<div class="error">outbound bulk-approve not implemented (Phase E coder stub)</div>');
});

function escHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = router;
