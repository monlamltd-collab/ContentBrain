require('dotenv').config();
const express = require('express');
const path = require('path');
const { getDraftPosts, updatePostStatus, getPostById } = require('./lib/supabase');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.REVIEW_UI_PASSWORD;

app.use(express.json());
app.use('/output', express.static(path.join(__dirname, 'output')));

// ── AUTH MIDDLEWARE ──
function requireAuth(req, res, next) {
  // Check session cookie or query param
  const token = req.cookies?.auth || req.query.token || req.headers['x-auth-token'];
  if (token === PASSWORD) return next();

  // Show login form
  if (req.method === 'GET' && req.path === '/') {
    return res.send(loginPage());
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// Simple cookie parser
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

// ── LOGIN ──
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === PASSWORD) {
    res.setHeader('Set-Cookie', `auth=${PASSWORD}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect('/');
  }
  res.status(401).send(loginPage('Wrong password'));
});

// ── DASHBOARD ──
app.get('/', requireAuth, async (req, res) => {
  try {
    const posts = await getDraftPosts();
    res.send(dashboardPage(posts));
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
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

// ── HTML PAGES ──

function loginPage(error) {
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
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

function dashboardPage(posts) {
  const cards = posts.map(post => `
    <div class="card" id="card-${post.id}">
      <div class="card-header">
        <span class="badge brand-${post.brand}">${post.brand}</span>
        <span class="badge platform">${post.platform}</span>
        <span class="badge template">${post.template_type}</span>
      </div>
      ${post.image_url ? `<img src="/output/${post.image_url}" class="preview" alt="preview">` : ''}
      <div class="copy">
        <strong>${escapeHtml(post.copy_headline || '')}</strong>
        <p>${escapeHtml(post.copy_body || '')}</p>
        ${post.copy_cta ? `<p class="cta">${escapeHtml(post.copy_cta)}</p>` : ''}
      </div>
      <div class="actions">
        <button class="btn approve" onclick="action('${post.id}','approve')">Approve</button>
        <button class="btn reject" onclick="action('${post.id}','reject')">Reject</button>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ContentBrain — Review</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 24px; }
  h1 { font-size: 28px; color: #1a2b4b; margin-bottom: 8px; }
  .subtitle { color: #666; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 24px; }
  .card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); transition: opacity 0.3s; }
  .card.done { opacity: 0.3; pointer-events: none; }
  .card-header { padding: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.03em; }
  .brand-auctionbrain { background: #1a2b4b; color: #faf8f4; }
  .brand-bridgematch { background: #0f8a5f; color: #fff; }
  .platform { background: #e8e8e8; color: #333; }
  .template { background: #fdf2e9; color: #C0392B; }
  .preview { width: 100%; aspect-ratio: 1; object-fit: cover; }
  .copy { padding: 16px; }
  .copy strong { display: block; font-size: 18px; color: #1a2b4b; margin-bottom: 8px; }
  .copy p { color: #555; line-height: 1.5; margin-bottom: 8px; white-space: pre-line; }
  .copy .cta { color: #0f8a5f; font-weight: 500; }
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
  <p class="subtitle">${posts.length} draft${posts.length !== 1 ? 's' : ''} awaiting review</p>
  <div class="grid">
    ${posts.length ? cards : '<div class="empty">No drafts to review. All clear.</div>'}
  </div>
  <script>
    async function action(id, type) {
      const card = document.getElementById('card-' + id);
      try {
        const res = await fetch('/api/posts/' + id + '/' + type, { method: 'POST' });
        if (res.ok) {
          card.classList.add('done');
          setTimeout(() => card.remove(), 500);
          // Update count
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

// ── START ──
app.listen(PORT, () => {
  console.log(`ContentBrain review UI running on port ${PORT}`);
});
