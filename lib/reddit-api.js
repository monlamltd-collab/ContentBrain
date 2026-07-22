// lib/reddit-api.js — Reddit official OAuth JSON API (app-only / client_credentials).
//
// The free, allowed, NOT-IP-blocked way to read public subreddit listings and
// threads. Reddit 403-blocks Railway's datacenter IP for HTML scraping (both
// Crawlee and Firecrawl-basic), but the OAuth API on oauth.reddit.com is fine
// from the same IP and costs zero Firecrawl credits. ~36 calls/day sits far
// under the 100 req/min free limit.
//
// Returns the EXACT same shapes as the Crawlee parsers so reddit-scraper's
// downstream logic is identical:
//   fetchSubredditListingApi(sub) → [{ title, url, comment_count }]
//   fetchThreadApi(url)           → { title, selftext, top_comments[] }
//
// Setup (one-time): create a Reddit app at https://www.reddit.com/prefs/apps
// (type "script" or "web app"), then set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET
// (+ optional REDDIT_USER_AGENT) in Railway. When unset, the scraper falls back
// to the Crawlee-first / Firecrawl-bypass path (lib/fetch-html).
//
// parseApiListing / parseApiThread are pure (take parsed JSON) so tests run on
// fixtures with no network.

require('dotenv').config();

const OAUTH_BASE = 'https://oauth.reddit.com';
const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const MAX_COMMENTS = 8; // mirror reddit-scraper's bullet cap

function userAgent() {
  return process.env.REDDIT_USER_AGENT || 'web:contentbrain:v1.0 (by /u/contentbrain)';
}

function isRedditApiConfigured() {
  return !!(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

// ── App-only token (client_credentials), cached until shortly before expiry ──

let _token = null;
let _tokenExpiresAt = 0;

async function _getToken() {
  if (_token && Date.now() < _tokenExpiresAt) return _token;

  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) throw new Error('REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET not set');

  const basic = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': userAgent(),
    },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Reddit token ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.access_token) throw new Error('Reddit token response missing access_token');

  _token = data.access_token;
  // Refresh 60s early; default 1h if expires_in absent.
  _tokenExpiresAt = Date.now() + ((data.expires_in || 3600) - 60) * 1000;
  return _token;
}

async function _apiGet(path) {
  const token = await _getToken();
  const res = await fetch(`${OAUTH_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${token}`, 'User-Agent': userAgent() },
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Reddit API ${res.status} for ${path}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

// ── Pure parsers ────────────────────────────────────────────────────────────

/**
 * Parse a /top listing JSON payload.
 * @returns {Array<{title: string, url: string, comment_count: number, selftext: string}>}
 */
function parseApiListing(json) {
  const children = json && json.data && Array.isArray(json.data.children) ? json.data.children : [];
  const threads = [];
  for (const c of children) {
    const d = c && c.data;
    if (!d || d.stickied) continue; // skip pinned/announcement posts
    if (!d.title || !d.permalink) continue;
    threads.push({
      title: String(d.title).trim(),
      url: `https://www.reddit.com${d.permalink}`,
      comment_count: Number.isFinite(d.num_comments) ? d.num_comments : 0,
      // Retain listing content so the scraper can still save a useful source
      // if both per-thread extraction methods are temporarily unavailable.
      selftext: typeof d.selftext === 'string' ? d.selftext.trim() : '',
    });
  }
  return threads;
}

/**
 * Parse a thread JSON payload ([postListing, commentsListing]).
 * @returns {{title: string, selftext: string, top_comments: string[]}|null}
 */
function parseApiThread(json) {
  if (!Array.isArray(json) || json.length < 1) return null;
  const post = json[0] && json[0].data && json[0].data.children && json[0].data.children[0];
  const pd = post && post.data;
  if (!pd || !pd.title) return null;

  const top_comments = [];
  const commentChildren = json[1] && json[1].data && Array.isArray(json[1].data.children)
    ? json[1].data.children : [];
  for (const c of commentChildren) {
    if (top_comments.length >= MAX_COMMENTS) break;
    if (!c || c.kind !== 't1') continue; // skip "more"/non-comment nodes
    const d = c.data || {};
    if (d.stickied || d.author === 'AutoModerator') continue;
    const body = (d.body || '').trim();
    if (body) top_comments.push(body);
  }

  return { title: String(pd.title).trim(), selftext: (pd.selftext || '').trim(), top_comments };
}

// ── Public fetchers (Crawlee-shape compatible) ────────────────────────────

async function fetchSubredditListingApi(sub, { window = 'week', limit = 15 } = {}) {
  const json = await _apiGet(`/r/${sub}/top?t=${window}&limit=${limit}&raw_json=1`);
  return parseApiListing(json);
}

async function fetchThreadApi(threadUrl) {
  const m = String(threadUrl).match(/\/r\/([^/]+)\/comments\/([a-z0-9]+)/i);
  if (!m) throw new Error(`unrecognised reddit thread URL: ${threadUrl}`);
  const json = await _apiGet(`/r/${m[1]}/comments/${m[2]}?limit=${MAX_COMMENTS}&depth=1&sort=top&raw_json=1`);
  return parseApiThread(json);
}

module.exports = {
  isRedditApiConfigured,
  fetchSubredditListingApi,
  fetchThreadApi,
  parseApiListing,
  parseApiThread,
};
