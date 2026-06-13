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
// bulk, a summary banner). All require no auth in this router because the
// parent /dashboard mount is auth-gated upstream (see
// routes/dashboard/index.js + the global requireAuth wrapper in
// server.js).
//
// Body-parser scoped to THIS router only — HTMX submits the bulk-approve
// form as application/x-www-form-urlencoded with repeated `postId` fields.
// We scope to the router rather than globally so we don't accidentally
// double-parse other routes whose body-parser layer is different.

const express = require('express');
const router = express.Router();
const { getApprovedPosts, getPostById, supabase } = require('../../lib/supabase');
const { publish } = require('../../lib/publish');

router.use(express.urlencoded({ extended: false }));

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

/**
 * Approve + send one outbound draft.
 *
 * publish() routes outbound posts (track='outbound' OR channel='resend')
 * through publishToResend, which itself handles suppression / warming-cap
 * deferrals / sequence-row side effects and sends the quiet Telegram
 * receipt on success. The publishToResend status update flips the post to
 * 'published' (or 'suppressed') — we don't need to flip it ourselves here.
 */
router.post('/outbound/:id/approve', async (req, res) => {
  const id = req.params.id;
  try {
    const post = await getPostById(id);
    if (!post) {
      return res.status(404).send(`<div class="error">Post ${escHtml(id)} not found.</div>`);
    }
    const result = await approveAndSendOne(post);
    res.set('HX-Trigger', 'outbound-card-changed');
    res.send(renderApproveResult(post, result));
  } catch (err) {
    console.error(`[dashboard/approve] approve ${id}: ${err.message}`);
    res.status(500).send(`<div class="error">Approve failed: ${escHtml(err.message)}</div>`);
  }
});

/**
 * Reject an outbound draft. The optional reason is sent by HTMX as the
 * HX-Prompt request header (NOT a form field — Phase B's reject endpoints
 * in server.js follow this same convention). We persist it to
 * posts.rejection_feedback so the social-side learning loop's
 * getRecentRejectedPosts() can read it back.
 */
router.post('/outbound/:id/reject', async (req, res) => {
  const id = req.params.id;
  try {
    const rawReason = req.headers['hx-prompt'];
    const reason = (typeof rawReason === 'string' ? rawReason : '').trim() || null;

    const { error } = await supabase
      .from('posts')
      .update({ status: 'rejected', rejection_feedback: reason })
      .eq('id', id);
    if (error) throw new Error(error.message);

    console.log(`[dashboard/approve] rejected outbound post ${id}${reason ? ` (reason: ${reason})` : ''}`);
    res.set('HX-Trigger', 'outbound-card-changed');
    // Empty fragment — HTMX outerHTML-swap erases the card.
    res.send('');
  } catch (err) {
    console.error(`[dashboard/approve] reject ${id}: ${err.message}`);
    res.status(500).send(`<div class="error">Reject failed: ${escHtml(err.message)}</div>`);
  }
});

/**
 * Stash a revision request and drop back to draft. Re-renders the same
 * card with a "Pending revision: <feedback>" badge so Simon can see what
 * he asked for. Auto-regen is deferred to Phase F per the design doc.
 */
router.post('/outbound/:id/revise', async (req, res) => {
  const id = req.params.id;
  try {
    const rawFeedback = req.headers['hx-prompt'];
    const feedback = (typeof rawFeedback === 'string' ? rawFeedback : '').trim();

    const post = await getPostById(id);
    if (!post) {
      return res.status(404).send(`<div class="error">Post ${escHtml(id)} not found.</div>`);
    }

    const newMeta = { ...(post.meta || {}), revision_request: feedback || null };
    const { error } = await supabase
      .from('posts')
      .update({ status: 'draft', meta: newMeta })
      .eq('id', id);
    if (error) throw new Error(error.message);

    console.log(`[dashboard/approve] revise stashed for post ${id}${feedback ? ` (feedback: ${feedback})` : ''}`);
    res.set('HX-Trigger', 'outbound-card-changed');
    res.send(renderRevisionCard({ ...post, meta: newMeta }, feedback));
  } catch (err) {
    console.error(`[dashboard/approve] revise ${id}: ${err.message}`);
    res.status(500).send(`<div class="error">Revise failed: ${escHtml(err.message)}</div>`);
  }
});

/**
 * Bulk-approve. Loops SEQUENTIALLY (Resend rate-limit + warming cap make
 * parallel sends unsafe — one suppressed/deferred result must be visible
 * before the next send starts). Capped at app_config.dashboard.bulk_approve_cap.
 */
router.post('/outbound/bulk', async (req, res) => {
  try {
    const cap = await loadBulkApproveCap();
    const rawIds = req.body && req.body.postId;
    const allIds = Array.isArray(rawIds) ? rawIds : (rawIds ? [rawIds] : []);
    const ids = allIds.slice(0, cap);
    const truncated = allIds.length > cap;

    if (!ids.length) {
      return res.send('<div class="bulk-summary empty">No outbound drafts were selected.</div>');
    }

    let approved = 0;
    let suppressed = 0;
    let deferred = 0;
    let errored = 0;
    const details = [];

    for (const id of ids) {
      try {
        const post = await getPostById(id);
        if (!post) {
          errored += 1;
          details.push(`${id}: not found`);
          continue;
        }
        const result = await approveAndSendOne(post);
        if (result.suppressed)      { suppressed += 1; details.push(`${shortTo(post)}: suppressed (${result.reason})`); }
        else if (result.deferred)   { deferred   += 1; details.push(`${shortTo(post)}: deferred (${result.reason})`); }
        else                        { approved   += 1; details.push(`${shortTo(post)}: sent`); }
      } catch (err) {
        errored += 1;
        details.push(`${id}: ${err.message}`);
      }
    }

    res.set('HX-Trigger', 'outbound-card-changed');
    res.send(renderBulkSummary({
      approved, suppressed, deferred, errored,
      total: ids.length, selected: allIds.length, cap, truncated, details,
    }));
  } catch (err) {
    console.error(`[dashboard/approve] bulk: ${err.message}`);
    res.status(500).send(`<div class="error">Bulk approve failed: ${escHtml(err.message)}</div>`);
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Approve + send one post. updatePostStatus to 'approved' isn't strictly
 * necessary because publishToResend will flip status to 'published' /
 * 'suppressed' / leave it 'approved' on defer — but doing it up-front
 * means a mid-send crash leaves the post in 'approved' (cron-pickable)
 * rather than 'draft' (Simon has to re-approve from scratch).
 */
async function approveAndSendOne(post) {
  // Mark approved first so the cron can pick it up if the immediate publish
  // call crashes (defensive belt-and-braces — Simon-shaped UX is no
  // forgotten drafts).
  const { error: aErr } = await supabase
    .from('posts')
    .update({ status: 'approved', approved_at: new Date().toISOString() })
    .eq('id', post.id);
  if (aErr) throw new Error(`status update failed: ${aErr.message}`);

  const result = await publish({ ...post, status: 'approved' });
  return result || { ok: true };
}

async function loadBulkApproveCap() {
  const DEFAULT_CAP = 10;
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('brand', 'global')
      .eq('key', 'dashboard.bulk_approve_cap')
      .maybeSingle();
    if (error) {
      console.warn(`[dashboard/approve] bulk_approve_cap read failed: ${error.message}`);
      return DEFAULT_CAP;
    }
    if (!data) return DEFAULT_CAP;
    const v = data.value;
    const n = typeof v === 'number' ? v : (typeof v === 'string' ? parseInt(v, 10) : NaN);
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP;
  } catch (err) {
    console.warn(`[dashboard/approve] bulk_approve_cap threw: ${err.message}`);
    return DEFAULT_CAP;
  }
}

function shortTo(post) {
  const meta = post.meta || {};
  return meta.contact_email || meta.to || post.id;
}

function renderApproveResult(post, result) {
  const id = post.id;
  const to = escHtml(shortTo(post));
  if (result && result.suppressed) {
    return `<div class="card outbound suppressed" id="card-${id}"><strong>Suppressed</strong> — ${to} (${escHtml(result.reason || 'unknown')})</div>`;
  }
  if (result && result.deferred) {
    return `<div class="card outbound deferred" id="card-${id}"><strong>Deferred</strong> — ${to} (${escHtml(result.reason || 'unknown')})</div>`;
  }
  return `<div class="card outbound sent" id="card-${id}"><strong>Sent</strong> to ${to}</div>`;
}

function renderRevisionCard(post, feedback) {
  const meta = post.meta || {};
  const brand = post.brand || 'bridgematch';
  const track = post.track || meta.track || 'outbound';
  const step = meta.sequence_step ? `step ${escHtml(String(meta.sequence_step))}` : '';
  const company = escHtml(meta.company_name || (meta.prospect && meta.prospect.company_name) || '(unknown company)');
  const contactEmail = escHtml(meta.contact_email || meta.to || '(no email)');
  const subject = escHtml(post.copy_headline || '(no subject)');
  const body = escHtml(post.copy_body || '');
  const badge = feedback
    ? `<span class="badge revision-badge">Pending revision: ${escHtml(feedback)}</span>`
    : `<span class="badge revision-badge">Pending revision</span>`;

  return `<div class="card outbound revising" id="card-${post.id}">
  <div class="card-header">
    <input type="checkbox" class="bulk-select" name="postId" value="${post.id}" data-post-id="${post.id}" onchange="updateBulkBar()" />
    <span class="badge brand-${escHtml(brand)}">${escHtml(brand)}</span>
    <span class="badge track-badge">${escHtml(track)}</span>
    ${step ? `<span class="badge step-badge">${step}</span>` : ''}
    ${badge}
    <span class="muted"> to &lt;${contactEmail}&gt; at ${company}</span>
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
      hx-prompt="Update revision note">Revise</button>
    <button class="btn reject"
      hx-post="/dashboard/approve/outbound/${post.id}/reject"
      hx-target="#card-${post.id}"
      hx-swap="outerHTML"
      hx-prompt="Why? (optional — helps future generation)">Reject</button>
  </div>
</div>`;
}

function renderBulkSummary({ approved, suppressed, deferred, errored, total, selected, cap, truncated, details }) {
  const lines = [];
  lines.push(`<strong>Bulk approve:</strong> ${approved} sent, ${suppressed} suppressed, ${deferred} deferred, ${errored} errored (of ${total}).`);
  if (truncated) {
    lines.push(`<br/><span class="muted">Capped at ${cap} — selected ${selected}, processed ${total}; the rest are unchanged.</span>`);
  }
  const detailRows = details.map(d => `<li>${escHtml(d)}</li>`).join('');
  return `<div class="bulk-summary">${lines.join('')}<ul class="bulk-details">${detailRows}</ul></div>`;
}

const { escHtml } = require('../../lib/dashboard/html');

module.exports = router;
