require('dotenv').config();
const { createLLM } = require('./lib/llm');
const express = require('express');
const path = require('path');
const { timingSafeEqual, scryptSync, createHmac } = require('crypto');
const { getDraftPosts, getApprovedPosts, updatePostStatus, getPostById, saveBrief, saveSeed, getDraftBlogPosts, updateBlogPostStatus, getBlogPostById, getPublishedBlogPostsBothBrands, getPendingBriefsAll, dismissBrief } = require('./lib/supabase');
const { publish } = require('./lib/publish');
const { sendNotification, API, BOT_TOKEN } = require('./lib/telegram');
const reviewRouter = require('./lib/review-api');
const runtimeConfig = require('./lib/runtime-config');
const { brands: defaultBrands, templateTypes } = require('./lib/config');
const { registerCronJobs, runGenerate } = require('./lib/cron-jobs');
const telegramHandlers = require('./lib/telegram-handlers');

// HTML-escape user-supplied strings before echoing them in Telegram
// notifications (sendNotification uses parse_mode HTML).
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── AUTH CONFIG ──
// Preferred: scrypt-hashed password via DASHBOARD_PASSWORD_HASH + DASHBOARD_PASSWORD_SALT.
// Generate these once locally with:  node scripts/gen-dashboard-hash.js
// Then set both values in Railway environment variables.
//
// Legacy fallback: if neither hash var is set, REVIEW_UI_PASSWORD is used as
// a plain-text comparison (backwards-compatible for local dev). Emit a warning
// so it is not silently relied upon in production.
const HASH = process.env.DASHBOARD_PASSWORD_HASH;
const SALT = process.env.DASHBOARD_PASSWORD_SALT;
const LEGACY_PASSWORD = process.env.REVIEW_UI_PASSWORD;

if (!HASH && LEGACY_PASSWORD) {
  console.warn('[auth] WARNING: using plaintext REVIEW_UI_PASSWORD. Run scripts/gen-dashboard-hash.js and set DASHBOARD_PASSWORD_HASH + DASHBOARD_PASSWORD_SALT to upgrade.');
}
if (!HASH && !LEGACY_PASSWORD) {
  console.warn('[auth] WARNING: no password configured. All routes are unprotected. Set DASHBOARD_PASSWORD_HASH + DASHBOARD_PASSWORD_SALT.');
}

// Derive a stable session-cookie token from the hash so the cookie never
// carries the plaintext password. HMAC with key=HASH means old cookies are
// automatically invalidated when the hash changes.
const SESSION_TOKEN = HASH
  ? createHmac('sha256', HASH).update('session').digest('hex')
  : (LEGACY_PASSWORD || '');

// Constant-time Buffer compare. Length mismatch returns false without comparing bytes.
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// Verify a submitted plaintext password against the configured credentials.
// Returns true if the password is correct, false otherwise.
function verifyPassword(submitted) {
  if (typeof submitted !== 'string' || !submitted) return false;

  if (HASH && SALT) {
    try {
      const candidate = scryptSync(submitted, SALT, 64).toString('hex');
      // Both sides are fixed-length hex strings, so length will always match.
      // Use timingSafeEqual directly on Buffers for constant-time comparison.
      return timingSafeEqual(Buffer.from(candidate, 'hex'), Buffer.from(HASH, 'hex'));
    } catch {
      return false;
    }
  }

  // Legacy plaintext fallback
  if (LEGACY_PASSWORD) {
    return safeEqual(submitted, LEGACY_PASSWORD);
  }

  return false;
}

// Resend webhook — Phase B.
// MUST be registered BEFORE express.json() because HMAC verification needs
// the raw request body byte-for-byte; if express.json consumes the body
// first, the signature check always fails. The route uses express.raw
// scoped to this path only so the rest of the app still gets parsed JSON.
app.post('/api/resend-webhook', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try {
    const { handleWebhook } = require('./lib/resend');
    // Express lowercases header keys; pass them through verbatim.
    const result = await handleWebhook(req.body, req.headers);
    return res.status(200).json(result);
  } catch (err) {
    // Verification failures are 401; anything else is 500. The Resend dashboard
    // surfaces both — 401 in particular tells Simon to check RESEND_WEBHOOK_SECRET.
    const msg = err && err.message ? err.message : String(err);
    if (/signature|verification/i.test(msg)) {
      console.warn(`[POST /api/resend-webhook] 401: ${msg}`);
      return res.status(401).json({ error: msg });
    }
    console.error(`[POST /api/resend-webhook] 500: ${msg}`);
    return res.status(500).json({ error: msg });
  }
});

// Phase G-3 — Make boost integration callback routes. ALL THREE registered
// BEFORE express.json() for the same reason as resend-webhook above: HMAC
// verification needs the raw request body bytes verbatim. Each uses
// express.raw scoped to its own path.
//
// See .ruflo/phase-g3-design.md §3.4 for the contract.

// Route A — Make -> CB after boost create completes (active OR failed).
// HMAC-verified via webhook-auth.verifyInbound. Calls helpers.markBoostActive
// or markBoostFailed depending on payload.status. Idempotent on request_id
// (== boost_runs.id) — last-write-wins for boost_campaign_id / boost_ad_id.
app.post('/api/social-boost-callback', express.raw({ type: 'application/json', limit: '256kb' }), async (req, res) => {
  const { handleBoostCallback } = require('./lib/social-engine/routes');
  const helpers = require('./lib/social-engine/helpers');
  return handleBoostCallback(req, res, helpers);
});

// Route B — Make -> CB after daily reconcile pulls insights. HMAC-verified.
// Iterates payload.metrics[] and calls markBoostMetrics(boost_campaign_id, ...)
// per row. Per-row errors caught and returned in the response without
// aborting subsequent rows. Idempotent — markBoostMetrics is UPDATE-by-
// campaign-id, not accumulating.
app.post('/api/social-boost-reconcile', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  const { handleBoostReconcile } = require('./lib/social-engine/routes');
  const helpers = require('./lib/social-engine/helpers');
  return handleBoostReconcile(req, res, helpers);
});

// Route C — Make pulls this once per reconcile run to find which boost_runs
// to fetch insights for. HMAC-verified — Make signs an empty body via
// MAKE_WEBHOOK_SECRET. The route accepts either x-cb-signature header OR
// query-string ?sig= (Make's HTTP module supports either).
app.get('/api/social-boost-active', express.raw({ type: 'application/json', limit: '4kb' }), async (req, res) => {
  const { handleBoostActive } = require('./lib/social-engine/routes');
  const { supabase } = require('./lib/supabase');
  return handleBoostActive(req, res, { supabase });
});

// Unsubscribe endpoint — Phase B follow-up (GDPR/PECR).
// Public (no auth) — anyone with a valid token can opt out. Two methods:
//   GET  /u?e=&t=  — HTML confirmation page (regular click-through)
//   POST /u?e=&t=  — one-click (RFC 8058, fired by Gmail/Outlook native UI)
//
// Both verify the HMAC token; mismatch → 404 (do not reveal which addresses
// are real). On success, the recipient is added to `suppression` with
// reason='unsubscribe' — idempotent via addSuppression's no-op-on-duplicate.
async function handleUnsubscribe(req, res) {
  try {
    const { applyUnsubscribe } = require('./lib/unsubscribe');
    const e = (req.query && req.query.e) || (req.body && req.body.e);
    const t = (req.query && req.query.t) || (req.body && req.body.t);
    const result = await applyUnsubscribe(e, t);
    if (!result.ok) {
      // 404 not 401 — don't tell scrapers which addresses are real.
      return res.status(404).send('Not found');
    }
    if (req.method === 'POST') {
      return res.status(200).json({ ok: true });
    }
    return res.status(200).send(
      `<!doctype html><meta charset="utf-8"><title>Unsubscribed</title>` +
      `<body style="font:16px system-ui;margin:60px auto;max-width:480px;text-align:center;">` +
      `<h1 style="font-weight:600;">You're unsubscribed</h1>` +
      `<p>We won't email <strong>${result.email.replace(/[<>&"]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c]))}</strong> again.</p>` +
      `<p style="color:#888;font-size:13px;">If this was a mistake, reply to the original email and we'll fix it.</p>` +
      `</body>`
    );
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    console.error(`[unsubscribe] ${req.method} /u: ${msg}`);
    return res.status(500).send('Server error');
  }
}
app.get('/u', handleUnsubscribe);
app.post('/u', express.urlencoded({ extended: false }), handleUnsubscribe);

app.use(express.json());
app.use('/output', express.static(path.join(__dirname, 'output')));

// Cookie parser — MUST run before any route or middleware that reads req.cookies
// (e.g. requireAuth). Express runs middleware in registration order, so this
// has to come before app.use('/api', ...) and before route handlers below.
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [key, val] = c.trim().split('=');
      req.cookies[key] = val;
    });
  }
  next();
});

// Health check (no auth — used by Railway)
app.get('/health', (req, res) => res.json({ ok: true }));

// /diag — proves whether the Telegram polling loop is actually alive.
// pollLastAt should be < ~32s ago in a healthy state (long-poll = 30s
// timeout + setTimeout + handler time). pollCount should be increasing
// across requests. Anything else means polling is dead and clicks are
// going to /dev/null. Also fetches the bot's own getMe + webhook info
// for a one-shot diagnostic.
app.get('/diag', async (req, res) => {
  const out = {
    process_uptime_s: Math.round(process.uptime()),
    poll: telegramHandlers.getDiagnostics(),
    telegram: { ok: false },
  };
  try {
    if (BOT_TOKEN) {
      const [me, wh] = await Promise.all([
        fetch(`${API}/getMe`).then(r => r.json()),
        fetch(`${API}/getWebhookInfo`).then(r => r.json()),
      ]);
      out.telegram = {
        ok: !!me.ok,
        username: me.result?.username,
        webhook_url: wh.result?.url || '',
        pending_update_count: wh.result?.pending_update_count,
        last_error: wh.result?.last_error_message || null,
      };
    } else {
      out.telegram.error = 'BOT_TOKEN not set';
    }
  } catch (err) {
    out.telegram.error = err.message;
  }
  res.json(out);
});

// Review API (auth via API key, not session cookie)
app.use('/api', reviewRouter);

// ── AUTH MIDDLEWARE ──
function requireAuth(req, res, next) {
  // No credentials configured — allow through (dev/unconfigured state already warned above).
  if (!HASH && !LEGACY_PASSWORD) return next();

  // Check session cookie or query param — constant-time compare against SESSION_TOKEN.
  // SESSION_TOKEN is an HMAC of the hash, so it never carries the plaintext password.
  const token = req.cookies?.auth || req.query.token || req.headers['x-auth-token'];
  if (SESSION_TOKEN && safeEqual(token, SESSION_TOKEN)) {
    // First-hit-via-?token=: set the cookie and redirect to a clean URL so
    // the secret doesn't linger in browser history.
    if (req.query.token && !req.cookies?.auth && req.method === 'GET') {
      res.setHeader('Set-Cookie', `auth=${SESSION_TOKEN}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
      const otherParams = new URLSearchParams();
      for (const [k, v] of Object.entries(req.query)) {
        if (k !== 'token' && typeof v === 'string') otherParams.append(k, v);
      }
      const qs = otherParams.toString();
      return res.redirect(302, req.path + (qs ? '?' + qs : ''));
    }
    return next();
  }

  // Show login form for any HTML page route. /api/* and non-GET requests
  // get JSON 401 so client code can handle them programmatically.
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.send(loginPage(null, req.path));
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── LOGIN ──
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const returnTo = (req.body.returnTo || '/').replace(/[^a-zA-Z0-9/_-]/g, '');
  if (verifyPassword(req.body.password)) {
    // Set cookie to the session token (HMAC-derived), never the plaintext password.
    res.setHeader('Set-Cookie', `auth=${SESSION_TOKEN}; HttpOnly; Path=/; Max-Age=86400; SameSite=Lax`);
    return res.redirect(returnTo || '/');
  }
  res.status(401).send(loginPage('Wrong password', returnTo));
});

// ── GROWTH BRAIN DASHBOARD ──
// New HTMX dashboard at /dashboard (Phase A). Protected by requireAuth.
app.use('/dashboard', requireAuth, require('./routes/dashboard'));

// Phase D — Performance tab metrics endpoint.
//
// Returns the rendered metrics fragment for the Performance partial's
// inner #perf-content div (server-rendered HTML, NOT JSON — matches the
// HTMX house style; routes/dashboard/today.js and approve.js do the same).
//
// Query: ?window=7d|30d|all (default 7d).
//
// Implementation note for the coder: SQL helpers live in
// lib/dashboard/performance-queries.js. Page-load fires ~28 sub-millisecond
// queries (4 content + 8 outbound × 3 tracks); no caching needed at
// current volumes. See .ruflo/phase-d-design.md §4 for the SQL sketches
// and the layout reference.
app.get('/api/dashboard/performance/metrics', requireAuth, async (req, res) => {
  try {
    // Accept either `window=7d|30d|all` (HTMX form value) or `days=7|30`
    // (explicit numeric override). Default 7 days.
    const winParam = req.query.window;
    const daysParam = req.query.days;
    let windowDays = 7;
    if (daysParam != null) {
      const n = parseInt(daysParam, 10);
      if (Number.isFinite(n) && n > 0) windowDays = n;
    } else if (winParam === '30d') {
      windowDays = 30;
    } else if (winParam === 'all') {
      windowDays = 'all';
    } else {
      windowDays = 7;
    }

    const { getMetrics, renderPerformanceFragment } = require('./lib/dashboard/performance-queries');
    const metrics = await getMetrics({ windowDays });
    const html = renderPerformanceFragment({ windowDays, metrics });
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
  } catch (err) {
    console.error('[api/dashboard/performance/metrics] error:', err.message);
    res.status(500).set('Content-Type', 'text/html; charset=utf-8')
       .send(`<p class="error">Failed to load metrics: ${String(err.message).replace(/[<>&"]/g, '?')}</p>`);
  }
});

// ── DASHBOARD (legacy review UI at /) ──
// The legacy inline dashboard is consolidated into /dashboard (Studio,
// Design, Editorial tabs). dashboardPage() is removed in the editorial-port
// PR; until then the root simply forwards.
app.get('/', requireAuth, (req, res) => {
  res.redirect(302, '/dashboard');
});

// ── APPROVE / REJECT ──
app.post('/api/posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const post = await updatePostStatus(req.params.id, 'approved');
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const post = await updatePostStatus(req.params.id, 'rejected');
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BLOG POST APPROVE / REJECT ──
// Optional `?brand=bridgematch` (defaults to auctionbrain) selects which
// Supabase project the update lands in. Matches the Telegram callback behaviour.
app.post('/api/blog-posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const brand = req.query.brand === 'bridgematch' ? 'bridgematch' : 'auctionbrain';
    const post = await updateBlogPostStatus(req.params.id, 'approved', {}, brand);
    // Cross-pollinate: create a content seed from the approved blog
    try {
      await saveSeed({
        source: 'blog_approved',
        summary: `New blog: ${post.title}`,
        key_points: post.summary || post.meta_description || '',
        brand: post.brand || brand,
        tags: post.tags || []
      });
      console.log(`[Cross-pollinate] Seed created from blog: ${post.title}`);
    } catch (seedErr) {
      console.error(`[Cross-pollinate] Seed creation failed: ${seedErr.message}`);
    }
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/blog-posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const brand = req.query.brand === 'bridgematch' ? 'bridgematch' : 'auctionbrain';
    const post = await updateBlogPostStatus(req.params.id, 'rejected', {}, brand);
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTML PAGES ──

function loginPage(error, returnTo = '/') {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ContentBrain — Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login { background: #fff; border-radius: 12px; padding: 48px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); width: 360px; }
  h1 { font-size: 24px; color: #1a2b4b; margin-bottom: 24px; }
  input { width: 100%; padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; margin-bottom: 16px; }
  button { width: 100%; padding: 12px; background: #0f8a5f; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
  button:hover { background: #0d7a54; }
  .error { color: #C0392B; font-size: 14px; margin-bottom: 12px; }
</style>
</head><body>
<div class="login">
  <h1>ContentBrain</h1>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/login">
    <input type="hidden" name="returnTo" value="${returnTo}">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

function dashboardPage(socialPosts, blogPosts, filter) {
  const socialCards = socialPosts.map(post => `
    <div class="card" id="card-${post.id}" data-type="social">
      <div class="card-header">
        <span class="badge brand-${post.brand}">${post.brand}</span>
        <span class="badge platform">${post.platform}</span>
        <span class="badge template">${post.template_type}</span>
      </div>
      ${post.image_url ? `<img src="/output/${post.image_url}" class="preview" alt="preview">` : ''}
      ${post.video_url ? `<div class="video-wrap"><video src="/output/${post.video_url}" class="preview" controls muted preload="metadata"></video><span class="video-badge">MP4</span></div>` : ''}
      <div class="copy">
        <strong>${escapeHtml(post.copy_headline || '')}</strong>
        <p>${escapeHtml(post.copy_body || '')}</p>
        ${post.copy_cta ? `<p class="cta">${escapeHtml(post.copy_cta)}</p>` : ''}
      </div>
      <div class="actions">
        <button class="btn approve" onclick="action('${post.id}','approve','social')">Approve</button>
        <button class="btn reject" onclick="action('${post.id}','reject','social')">Reject</button>
      </div>
    </div>
  `).join('');

  const filteredBlogPosts = (filter === 'blog') ? blogPosts.filter(p => (p.post_type || 'blog') === 'blog')
    : (filter === 'guide') ? blogPosts.filter(p => p.post_type === 'guide')
    : blogPosts;

  const blogCards = filteredBlogPosts.map(post => {
    const postType = post.post_type || 'blog';
    const brandLabel = post.brand === 'bridgematch' ? 'bridgematch' : 'auctionbrain';
    const preview = (post.summary || post.meta_description || '').slice(0, 200);
    return `
    <div class="card" id="card-${post.id}" data-type="${postType}">
      <div class="card-header">
        <span class="badge brand-${brandLabel}">${brandLabel}</span>
        <span class="badge type-badge">${postType}</span>
        ${post.evaluation_score ? `<span class="badge score">${post.evaluation_score}/10</span>` : ''}
      </div>
      <div class="copy">
        <strong>${escapeHtml(post.title || '')}</strong>
        ${post.word_count || post.content ? `<p class="meta-info">${post.content ? Math.round(post.content.split(/\\s+/).length) + ' words' : ''}</p>` : ''}
        <p>${escapeHtml(preview)}</p>
        ${post.tags && post.tags.length ? `<p class="tags">${post.tags.map(t => '#' + t).join(' ')}</p>` : ''}
      </div>
      <div class="actions">
        <button class="btn approve" onclick="action('${post.id}','approve','blog')">Approve</button>
        <button class="btn reject" onclick="action('${post.id}','reject','blog')">Reject</button>
      </div>
    </div>
  `;
  }).join('');

  const totalCount = socialPosts.length + filteredBlogPosts.length;
  const filterParam = (f) => f === 'all' ? '/' : `/?type=${f}`;
  const activeClass = (f) => f === filter ? 'tab active' : 'tab';

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ContentBrain — Review</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 24px; }
  h1 { font-size: 28px; color: #1a2b4b; margin-bottom: 8px; }
  .subtitle { color: #666; margin-bottom: 16px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 24px; }
  .tab { padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 600; text-decoration: none; color: #666; background: #e8e8e8; transition: all 0.2s; }
  .tab:hover { background: #ddd; }
  .tab.active { background: #1a2b4b; color: #faf8f4; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 24px; }
  .card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); transition: opacity 0.3s; }
  .card.done { opacity: 0.3; pointer-events: none; }
  .card-header { padding: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.03em; }
  .brand-auctionbrain { background: #1a2b4b; color: #faf8f4; }
  .brand-bridgematch { background: #0f8a5f; color: #fff; }
  .platform { background: #e8e8e8; color: #333; }
  .template { background: #fdf2e9; color: #C0392B; }
  .type-badge { background: #e8f4fd; color: #1a6fb5; }
  .score { background: #e8fdf0; color: #0f8a5f; }
  .preview { width: 100%; aspect-ratio: 1; object-fit: cover; }
  .video-wrap { position: relative; }
  .video-wrap video { width: 100%; aspect-ratio: 1; object-fit: cover; background: #000; }
  .video-badge { position: absolute; top: 8px; right: 8px; background: #C0392B; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .copy { padding: 16px; }
  .copy strong { display: block; font-size: 18px; color: #1a2b4b; margin-bottom: 8px; }
  .copy p { color: #555; line-height: 1.5; margin-bottom: 8px; white-space: pre-line; }
  .copy .cta { color: #0f8a5f; font-weight: 500; }
  .copy .meta-info { font-size: 13px; color: #999; }
  .copy .tags { font-size: 12px; color: #888; }
  .actions { padding: 16px; display: flex; gap: 12px; border-top: 1px solid #eee; }
  .btn { flex: 1; padding: 10px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn.approve { background: #0f8a5f; color: #fff; }
  .btn.approve:hover { background: #0d7a54; }
  .btn.reject { background: #f5f5f5; color: #C0392B; border: 1px solid #eee; }
  .btn.reject:hover { background: #fde8e8; }
  .empty { text-align: center; color: #999; padding: 80px; font-size: 18px; }
</style>
</head><body>
  <h1>ContentBrain</h1>
  <p class="subtitle">${totalCount} draft${totalCount !== 1 ? 's' : ''} awaiting review</p>
  <div class="tabs">
    <a class="${activeClass('all')}" href="${filterParam('all')}">All</a>
    <a class="${activeClass('social')}" href="${filterParam('social')}">Social</a>
    <a class="${activeClass('blog')}" href="${filterParam('blog')}">Blog</a>
    <a class="${activeClass('guide')}" href="${filterParam('guide')}">Guide</a>
  </div>
  <div class="grid">
    ${totalCount ? socialCards + blogCards : '<div class="empty">No drafts to review. All clear.</div>'}
  </div>
  <script>
    async function action(id, type, contentKind) {
      const card = document.getElementById('card-' + id);
      const endpoint = contentKind === 'blog' ? '/api/blog-posts/' : '/api/posts/';
      try {
        const res = await fetch(endpoint + id + '/' + type, { method: 'POST' });
        if (res.ok) {
          card.classList.add('done');
          setTimeout(() => card.remove(), 500);
          const remaining = document.querySelectorAll('.card:not(.done)').length;
          document.querySelector('.subtitle').textContent = remaining + ' draft' + (remaining !== 1 ? 's' : '') + ' awaiting review';
        }
      } catch (err) { alert('Error: ' + err.message); }
    }
  </script>
</body></html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── CRON JOBS ── (moved to lib/cron-jobs.js — registered at startup below)
registerCronJobs();

// ── TELEGRAM BOT POLLING ── (moved to lib/telegram-handlers/ — started in app.listen below)

// ── EDITORIAL DASHBOARD ──────────────────────────────────────────────────────

const _llmForEditorial = createLLM();
const SUPPORTED_IMAGE_TYPES_ED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

app.get('/content', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editorial.html'));
});

app.get('/api/content/coverage', requireAuth, async (req, res) => {
  try {
    const posts = await getPublishedBlogPostsBothBrands();
    const brand = req.query.brand; // optional filter

    const filtered = brand ? posts.filter(p => p.brand === brand) : posts;

    // Build tag frequency map
    const tagCount = {};
    for (const post of filtered) {
      const tags = Array.isArray(post.tags) ? post.tags : [];
      for (const tag of tags) {
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      }
    }

    // Classify: 0 = gap, 1-2 = covered, 3+ = saturated
    const coverage = Object.entries(tagCount)
      .map(([tag, count]) => ({
        tag,
        count,
        status: count >= 3 ? 'saturated' : 'covered'
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ posts: filtered.length, coverage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/content/queue', requireAuth, async (req, res) => {
  try {
    const drafts = await getDraftBlogPosts();
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/content/briefs', requireAuth, async (req, res) => {
  try {
    const briefs = await getPendingBriefsAll();
    res.json({ briefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/brief', requireAuth, async (req, res) => {
  try {
    const { brand, message, topic, angle } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    const brief = await saveBrief({ brand: brand || null, message: message.trim(), topic: topic || null, angle: angle || null });
    res.json({ ok: true, brief });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for the Reddit-thread → brief promotion. Same logic as
// the daily cron at 06:30 UTC, exposed so the editor can pull fresh briefs
// on demand from the Brief Queue panel.
app.post('/api/content/refresh-reddit-briefs', requireAuth, async (req, res) => {
  try {
    const { promoteRedditThreadsToBriefs } = require('./lib/reddit-briefs');
    const result = await promoteRedditThreadsToBriefs();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/brief/:id/dismiss', requireAuth, async (req, res) => {
  try {
    await dismissBrief(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/seed', requireAuth, async (req, res) => {
  try {
    const { brand, content, title } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
    const seed = await saveSeed({ brand: brand || null, content: content.trim(), title: title?.trim() || null });
    res.json({ ok: true, seed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accepts { mimeType, data (base64), filename } — extracts content via Claude
app.post('/api/content/upload', requireAuth, async (req, res) => {
  try {
    const { mimeType, data, filename } = req.body;
    if (!data) return res.status(400).json({ error: 'data (base64) is required' });

    const isPdf = mimeType === 'application/pdf';
    const isImage = SUPPORTED_IMAGE_TYPES_ED.includes(mimeType);
    if (!isPdf && !isImage) return res.status(400).json({ error: `Unsupported type: ${mimeType}` });

    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data } };

    const response = await _llmForEditorial.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text: 'Extract all useful editorial content from this document — headlines, article text, statistics, quotes, opinions. Format as clean markdown. Skip ads, subscription offers, navigation, and page numbers.' }
        ]
      }]
    });

    const extracted = response.content[0]?.text || '';
    if (extracted.length < 20) return res.status(422).json({ error: 'Could not extract readable content' });

    res.json({ ok: true, extracted, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch the full blog post so the editor can amend it before approving.
// Returns the row including content_md/content_html — heavier than the
// queue listing, but only fired when the editor actually opens the amend form.
app.get('/api/content/blog/:brand/:id', requireAuth, async (req, res) => {
  try {
    const { brand, id } = req.params;
    const post = await getBlogPostById(id, brand);
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Amend a draft blog post in-place. Updates whichever of title / summary /
// content_md were sent in the body. content_html is regenerated from the
// new content_md so the published version stays in sync — the landing
// site renders content_html, not content_md.
app.patch('/api/content/blog/:brand/:id', requireAuth, async (req, res) => {
  try {
    const { brand, id } = req.params;
    const { title, summary, content_md } = req.body;
    const updates = {};
    if (typeof title === 'string') {
      if (!title.trim()) return res.status(400).json({ error: 'title cannot be empty' });
      if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
      updates.title = title.trim();
    }
    if (typeof summary === 'string') {
      if (summary.length > 500) return res.status(400).json({ error: 'summary too long (max 500)' });
      updates.summary = summary.trim();
    }
    if (typeof content_md === 'string') {
      if (!content_md.trim()) return res.status(400).json({ error: 'content cannot be empty' });
      if (content_md.length > 50000) return res.status(400).json({ error: 'content too long (max 50k)' });
      updates.content_md = content_md;
      // Regenerate content_html from the amended markdown so the landing
      // site (which reads content_html) doesn't fall behind.
      try {
        const { marked } = require('marked');
        updates.content_html = marked.parse(content_md);
      } catch (mdErr) {
        return res.status(500).json({ error: `markdown render failed: ${mdErr.message}` });
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No editable fields provided' });

    const { getBlogClient } = require('./lib/supabase');
    const client = getBlogClient(brand);
    const { data, error } = await client.from('blog_posts').update(updates).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/approve/:brand/:id', requireAuth, async (req, res) => {
  try {
    const { brand, id } = req.params;
    await updateBlogPostStatus(id, 'approved', {}, brand);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/reject/:brand/:id', requireAuth, async (req, res) => {
  try {
    const { brand, id } = req.params;
    const { feedback } = req.body;
    await updateBlogPostStatus(id, 'rejected', { revision_feedback: feedback || '' }, brand);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SOCIAL DASHBOARD ─────────────────────────────────────────────────────────

// Consolidated into the dashboard Studio tab.
app.get('/social', requireAuth, (req, res) => {
  res.redirect(302, '/dashboard?tab=studio');
});

// /api/social/* JSON endpoints — extracted verbatim to routes/api-social.js
// (pure move). Shared by the Studio tab and Telegram-side flows.
app.use('/api/social', requireAuth, require('./routes/api-social'));

// ── UNIFIED CONTROL PANEL (/levers) ──
//
// Surfaces every lever currently controllable via Telegram in a single web
// page so the operator doesn't have to remember command syntax. The page
// is just HTML + vanilla JS — no framework, no build step. All state lives
// in app_config; this layer is purely a UI on top of runtime-config.

// Consolidated into the dashboard Design tab.
app.get('/levers', requireAuth, (req, res) => {
  res.redirect(302, '/dashboard?tab=design');
});

// Full snapshot of every lever value, plus the menus the UI needs to render
// (theme list, archetype list, template list, brand list).
app.get('/api/levers', requireAuth, async (req, res) => {
  try {
    const runtimeConfig = require('./lib/runtime-config');
    const { THEMES, THEME_NAMES, DEFAULT_THEME_NAME } = require('./lib/themes');
    const { ARCHETYPES, DEFAULT_SCHEDULE } = require('./lib/lot-picker');
    const { brands: defaultBrands, templateTypes } = require('./lib/config');

    const brandList = Object.keys(defaultBrands);

    const perBrand = {};
    for (const brand of brandList) {
      const [tone, messages, audience, directive, visualDirective] = await Promise.all([
        runtimeConfig.getBrandTone(brand),
        runtimeConfig.getBrandMessages(brand),
        runtimeConfig.getBrandAudience(brand),
        runtimeConfig.getBrandDirective(brand),
        runtimeConfig.getBrandVisualDirective(brand),
      ]);
      perBrand[brand] = {
        name: defaultBrands[brand].name,
        url: defaultBrands[brand].url,
        tone, audience, directive,
        visual_directive: visualDirective,
        messages: Array.isArray(messages) ? messages : [],
      };
    }

    const [activeBrands, templateWeights, hookPatterns, ctaPatterns] = await Promise.all([
      runtimeConfig.getActiveBrands(),
      runtimeConfig.getTemplateWeights(),
      runtimeConfig.getHookPatterns(),
      runtimeConfig.getCtaPatterns(),
    ]);

    // Schedule lever isn't exposed via runtime-config helpers — read directly.
    const { supabase } = require('./lib/supabase');
    let lotSchedule = DEFAULT_SCHEDULE;
    try {
      const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('brand', 'global')
        .eq('key', 'lot_archetype_schedule')
        .maybeSingle();
      if (Array.isArray(data?.value) && data.value.length === 7) lotSchedule = data.value;
    } catch {}

    res.json({
      brands: brandList,
      perBrand,
      global: {
        active_brands: activeBrands,
        template_weights: templateWeights,
        hook_patterns: hookPatterns,
        cta_patterns: ctaPatterns,
        lot_archetype_schedule: lotSchedule,
      },
      menus: {
        themes: THEME_NAMES.map(n => ({ name: n, label: THEMES[n].label, description: THEMES[n].description, isDefault: n === DEFAULT_THEME_NAME })),
        archetypes: ARCHETYPES,
        templateTypes,
      },
    });
  } catch (err) {
    console.error('[GET /api/levers] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Set one lever. Body: { brand: 'auctionbrain'|'bridgematch'|'global', key: '<lever key>', value: <any JSON> }
// Empty string or null clears (forwards to clearLever) so the UI can wire one save handler.
app.post('/api/levers', requireAuth, async (req, res) => {
  try {
    const { brand, key, value } = req.body || {};
    if (!brand || !key) return res.status(400).json({ error: 'brand and key required' });
    const runtimeConfig = require('./lib/runtime-config');
    const isEmpty = value == null || (typeof value === 'string' && value.trim() === '');
    if (isEmpty) {
      await runtimeConfig.clearLever(brand, key);
    } else {
      await runtimeConfig.setLever(brand, key, value);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/levers] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Recent published blogs across both brands, with public URLs. Used by the
// "Live Blogs" panel in /levers so the operator can see what's already on
// the landing pages and avoid approving a duplicate that's just been
// re-suggested by the content engine.
app.get('/api/levers/live-blogs', requireAuth, async (req, res) => {
  try {
    const { getPublishedBlogPostsBothBrands } = require('./lib/supabase');
    const posts = await getPublishedBlogPostsBothBrands();
    const BRAND_BLOG_URL = {
      auctionbrain: 'https://www.auctionbrain.co.uk/blog',
      bridgematch: 'https://bridgematch.co.uk/blog',
    };
    const slim = posts.slice(0, 60).map(p => ({
      id: p.id,
      title: p.title,
      slug: p.slug,
      brand: p.brand,
      published_at: p.published_at,
      url: `${BRAND_BLOG_URL[p.brand] || BRAND_BLOG_URL.auctionbrain}/${p.slug}`,
    }));
    res.json({ posts: slim });
  } catch (err) {
    console.error('[GET /api/levers/live-blogs] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// AI-assisted pattern drafter. Operator types a rough idea ("something about
// underestimating a property's potential") and Claude returns a polished
// pattern body in the existing menu format. Used by the "Draft with AI"
// button in /levers next to the Add input.
app.post('/api/levers/pattern/draft', requireAuth, async (req, res) => {
  try {
    const { type, idea } = req.body || {};
    // Shared with the dashboard Design tab — single source of truth for the
    // prompt logic lives in lib/dashboard/design-queries.draftPattern.
    const { draftPattern } = require('./lib/dashboard/design-queries');
    const suggestion = await draftPattern(type, idea);
    res.json({ suggestion });
  } catch (err) {
    const isInput = /must be|required/.test(err.message);
    if (!isInput) console.error('[POST /api/levers/pattern/draft] error:', err.message);
    res.status(isInput ? 400 : 500).json({ error: err.message });
  }
});

// Manual content-generation trigger. Bypasses the once-per-day dedupe in
// runGenerate so the operator can re-run on demand from the UI.
app.post('/api/triggers/generate', requireAuth, async (req, res) => {
  // Don't await — generation can take 30–90s. Fire-and-forget, return immediately.
  setImmediate(() => {
    runGenerate({ force: true }).catch(err => {
      console.error('[POST /api/triggers/generate] runGenerate error:', err.message);
      sendNotification(`Manual /generate failed: ${err.message.slice(0, 200)}`).catch(() => {});
    });
  });
  res.json({ ok: true, message: 'Generation started — drafts will appear in /social shortly.' });
});

// Manual Lot of the Day trigger. Same fire-and-forget pattern.
app.post('/api/triggers/lot', requireAuth, async (req, res) => {
  const { archetype } = req.body || {};
  setImmediate(async () => {
    try {
      const { runLotOfTheDay } = require('./lib/lot-flow');
      await runLotOfTheDay(archetype ? { forceArchetype: archetype } : {});
    } catch (err) {
      console.error('[POST /api/triggers/lot] runLotOfTheDay error:', err.message);
      try { await sendNotification(`Manual Lot of the Day failed: ${err.message.slice(0, 200)}`); } catch {}
    }
  });
  res.json({ ok: true, message: 'Lot of the Day started — script alert will arrive in Telegram shortly.' });
});

// ── START ──
app.listen(PORT, async () => {
  console.log(`ContentBrain review UI running on port ${PORT}`);
  console.log('Cron: generate at 7am daily, publish every 15 mins');
  console.log('Telegram: polling for approve/reject buttons');

  // Notify on startup so you know the server is alive
  const drafts = await getDraftPosts().catch(() => []);
  const approved = await getApprovedPosts().catch(() => []);
  await sendNotification(
    `<b>ContentBrain started</b>\n\n` +
    `Drafts: ${drafts.length} | Approved: ${approved.length}\n` +
    `Publishing: ${process.env.FB_PAGE_ACCESS_TOKEN ? 'Facebook Direct' : process.env.MAKE_WEBHOOK_URL ? 'Make.com' : 'NOT CONFIGURED'}`
  );

  // Defensive: if a stray webhook is set on the bot token, getUpdates
  // returns 409 Conflict on every poll and inbound callback_query
  // updates vanish. Outbound sends still work, so the bug is invisible
  // from outside (health=200, sendMessage=200, but button presses go
  // to the void). Deleting any existing webhook on startup is a no-op
  // when none is set. drop_pending_updates=false preserves any genuine
  // queued message updates that survived the webhook→polling switch.
  try {
    if (BOT_TOKEN) {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=false`);
      const j = await r.json();
      if (j.ok) console.log(`[startup] deleteWebhook: ${j.description || 'ok'}`);
      else console.warn(`[startup] deleteWebhook failed: ${JSON.stringify(j)}`);
    }
  } catch (err) {
    console.warn(`[startup] deleteWebhook error: ${err.message}`);
  }

  // Self-heal: if any blog/guide drafts have stale buttons (because the
  // poll loop was dead when you tried to click them), re-send fresh
  // review cards now so the next click actually fires.
  await telegramHandlers.resendDraftReviewCards();

  // Restores the persisted getUpdates offset (no duplicate re-processing
  // after redeploys), then enters the poll loop.
  telegramHandlers.startTelegramPolling();
});
