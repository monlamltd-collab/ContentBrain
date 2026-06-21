// tests/reddit-api.test.js — Reddit OAuth API. Pure parsers on fixtures, plus
// the token + fetch flow with global.fetch stubbed (no network).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const API_PATH = require.resolve('../lib/reddit-api');
const realFetch = global.fetch;

function loadFresh() {
  delete require.cache[API_PATH];
  return require('../lib/reddit-api');
}

// ── Pure parsers ────────────────────────────────────────────────────────────

const { parseApiListing, parseApiThread } = require('../lib/reddit-api');

const LISTING_JSON = {
  kind: 'Listing',
  data: {
    children: [
      { kind: 't3', data: { title: 'How fast can I get a bridge?', permalink: '/r/bridging/comments/abc123/how_fast/', num_comments: 14, stickied: false } },
      { kind: 't3', data: { title: 'PINNED: rules', permalink: '/r/bridging/comments/pin/rules/', num_comments: 0, stickied: true } },
      { kind: 't3', data: { title: 'Exit fees?', permalink: '/r/bridging/comments/def456/exit/' } }, // no num_comments → 0
    ],
  },
};

test('parseApiListing: maps title/www-permalink/num_comments, skips stickied', () => {
  const threads = parseApiListing(LISTING_JSON);
  assert.equal(threads.length, 2);
  assert.equal(threads[0].title, 'How fast can I get a bridge?');
  assert.equal(threads[0].url, 'https://www.reddit.com/r/bridging/comments/abc123/how_fast/');
  assert.equal(threads[0].comment_count, 14);
  assert.equal(threads[1].comment_count, 0); // missing num_comments → 0
  assert.ok(!threads.some(t => /PINNED/.test(t.title)), 'stickied post excluded');
});

test('parseApiListing: empty / malformed → []', () => {
  assert.deepEqual(parseApiListing({}), []);
  assert.deepEqual(parseApiListing(null), []);
  assert.deepEqual(parseApiListing({ data: { children: [] } }), []);
});

const THREAD_JSON = [
  { kind: 'Listing', data: { children: [
    { kind: 't3', data: { title: 'How fast can I get a bridge?', selftext: 'Auction, 20 days to complete.' } },
  ] } },
  { kind: 'Listing', data: { children: [
    { kind: 't1', data: { body: 'A good broker can do 10-14 days.', author: 'helpful_user' } },
    { kind: 't1', data: { body: 'sticky note', stickied: true } },
    { kind: 't1', data: { body: 'Beep boop rules', author: 'AutoModerator' } },
    { kind: 't1', data: { body: 'Watch the exit fees.', author: 'other' } },
    { kind: 'more', data: { children: ['x', 'y'] } },
  ] } },
];

test('parseApiThread: title + selftext + top-level comments, skips sticky/AutoMod/more', () => {
  const t = parseApiThread(THREAD_JSON);
  assert.equal(t.title, 'How fast can I get a bridge?');
  assert.match(t.selftext, /20 days to complete/);
  assert.deepEqual(t.top_comments, ['A good broker can do 10-14 days.', 'Watch the exit fees.']);
});

test('parseApiThread: caps comments at 8', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ kind: 't1', data: { body: `comment ${i}`, author: 'u' } }));
  const json = [
    { data: { children: [{ kind: 't3', data: { title: 'T', selftext: '' } }] } },
    { data: { children: many } },
  ];
  assert.equal(parseApiThread(json).top_comments.length, 8);
});

test('parseApiThread: link post (no selftext) → empty selftext', () => {
  const json = [
    { data: { children: [{ kind: 't3', data: { title: 'Link', selftext: '' } }] } },
    { data: { children: [{ kind: 't1', data: { body: 'First!' } }] } },
  ];
  const t = parseApiThread(json);
  assert.equal(t.selftext, '');
  assert.deepEqual(t.top_comments, ['First!']);
});

test('parseApiThread: malformed payload → null', () => {
  assert.equal(parseApiThread([]), null);
  assert.equal(parseApiThread(null), null);
  assert.equal(parseApiThread([{ data: { children: [] } }]), null);
});

// ── isRedditApiConfigured ─────────────────────────────────────────────────

test('isRedditApiConfigured: true only with both id + secret', () => {
  const { isRedditApiConfigured } = loadFresh();
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
  assert.equal(isRedditApiConfigured(), false);
  process.env.REDDIT_CLIENT_ID = 'id';
  assert.equal(isRedditApiConfigured(), false);
  process.env.REDDIT_CLIENT_SECRET = 'secret';
  assert.equal(isRedditApiConfigured(), true);
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
});

// ── Token + fetch flow (global.fetch stubbed) ──────────────────────────────

let calls;
beforeEach(() => {
  calls = [];
  process.env.REDDIT_CLIENT_ID = 'cid';
  process.env.REDDIT_CLIENT_SECRET = 'csecret';
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    if (url.includes('/api/v1/access_token')) {
      return { ok: true, json: async () => ({ access_token: 'tok-123', expires_in: 3600 }) };
    }
    if (url.includes('/top?')) {
      return { ok: true, json: async () => LISTING_JSON };
    }
    if (url.includes('/comments/')) {
      return { ok: true, json: async () => THREAD_JSON };
    }
    return { ok: false, status: 404, text: async () => 'nope' };
  };
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.REDDIT_CLIENT_ID;
  delete process.env.REDDIT_CLIENT_SECRET;
});

test('fetchSubredditListingApi: gets a bearer token then hits oauth.reddit.com', async () => {
  const { fetchSubredditListingApi } = loadFresh();
  const threads = await fetchSubredditListingApi('bridging', { window: 'week' });

  assert.equal(threads.length, 2);
  // token call first, with Basic auth + client_credentials body
  assert.match(calls[0].url, /api\/v1\/access_token/);
  assert.match(calls[0].opts.headers.Authorization, /^Basic /);
  assert.equal(calls[0].opts.body, 'grant_type=client_credentials');
  // listing call on oauth host with bearer token
  assert.match(calls[1].url, /^https:\/\/oauth\.reddit\.com\/r\/bridging\/top\?t=week/);
  assert.equal(calls[1].opts.headers.Authorization, 'Bearer tok-123');
});

test('fetchThreadApi: derives the comments path from a www URL', async () => {
  const { fetchThreadApi } = loadFresh();
  const t = await fetchThreadApi('https://www.reddit.com/r/bridging/comments/abc123/how_fast/');
  assert.equal(t.title, 'How fast can I get a bridge?');
  const apiCall = calls.find(c => /\/comments\//.test(c.url));
  assert.match(apiCall.url, /\/r\/bridging\/comments\/abc123\?/);
});

test('fetchSubredditListingApi: reuses the cached token across calls', async () => {
  const { fetchSubredditListingApi } = loadFresh();
  await fetchSubredditListingApi('bridging');
  await fetchSubredditListingApi('HousingUK');
  const tokenCalls = calls.filter(c => /access_token/.test(c.url));
  assert.equal(tokenCalls.length, 1, 'token fetched once, then reused');
});
