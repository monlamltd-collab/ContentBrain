// Phase G-3 — audience snapshot coverage.
//
// Mocks global.fetch + helpers.upsertAudienceSnapshot. Tests:
//   - snapshotPageAudience('auctionbrain') skips silently when env unset
//   - snapshotPageAudience('bridgematch') skips silently when token env unset
//   - snapshotPageAudience throws on Graph API non-2xx (so caller can mark
//     the brand failed without aborting the next)
//   - snapshotPageAudience throws when Graph payload missing followers_count
//   - snapshotPageAudience(known brand) calls Graph with correct URL +
//     calls upsertAudienceSnapshot with parsed fields
//   - runDailyAudienceSnapshot attempts BOTH brands even when the first throws
//   - runDailyAudienceSnapshot returns the result object (never throws)

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const MOD_PATH = require.resolve('../../../lib/social-engine/audience');
const HELPERS_PATH = require.resolve('../../../lib/social-engine/helpers');
const TELEGRAM_PATH = require.resolve('../../../lib/telegram');

let upsertCalls = [];
let notifyCalls = [];
let fetchCalls = [];
let nextFetchResponses = [];
const originalFetch = global.fetch;

function loadFresh() {
  delete require.cache[MOD_PATH];
  delete require.cache[HELPERS_PATH];
  delete require.cache[TELEGRAM_PATH];

  require.cache[HELPERS_PATH] = {
    id: HELPERS_PATH,
    filename: HELPERS_PATH,
    loaded: true,
    exports: {
      upsertAudienceSnapshot: async (args) => {
        upsertCalls.push(args);
        return {
          brand: args.brand,
          page_id: args.page_id,
          followers_count: args.followers_count,
          fans_count: args.fans_count ?? null,
          follows_delta: 7,
          recorded_at: '2026-05-25',
        };
      },
    },
  };

  require.cache[TELEGRAM_PATH] = {
    id: TELEGRAM_PATH,
    filename: TELEGRAM_PATH,
    loaded: true,
    exports: {
      sendNotification: async (msg) => { notifyCalls.push(msg); },
    },
  };

  return require('../../../lib/social-engine/audience');
}

beforeEach(() => {
  upsertCalls = [];
  notifyCalls = [];
  fetchCalls = [];
  nextFetchResponses = [];

  delete process.env.FB_PAGE_ID;
  delete process.env.FB_PAGE_ACCESS_TOKEN;
  delete process.env.FB_BRIDGEMATCH_PAGE_ID;
  delete process.env.FB_BRIDGEMATCH_PAGE_TOKEN;

  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (!nextFetchResponses.length) throw new Error('Mock fetch out of responses');
    const r = nextFetchResponses.shift();
    return {
      ok: r.ok,
      status: r.status || (r.ok ? 200 : 400),
      json: async () => r.body || {},
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {})),
    };
  };
});

afterEach(() => {
  global.fetch = originalFetch;
});

// ── snapshotPageAudience ──────────────────────────────────────

test('snapshotPageAudience: unknown brand throws', async () => {
  const { snapshotPageAudience } = loadFresh();
  await assert.rejects(() => snapshotPageAudience('unknownbrand'), /unknown brand/);
});

test('snapshotPageAudience(auctionbrain): silent skip when FB_PAGE_ID unset', async () => {
  const { snapshotPageAudience } = loadFresh();
  const row = await snapshotPageAudience('auctionbrain');
  assert.equal(row, null);
  assert.equal(fetchCalls.length, 0);
  assert.equal(upsertCalls.length, 0);
});

test('snapshotPageAudience(auctionbrain): silent skip when FB_PAGE_ACCESS_TOKEN unset', async () => {
  process.env.FB_PAGE_ID = '12345';
  const { snapshotPageAudience } = loadFresh();
  const row = await snapshotPageAudience('auctionbrain');
  assert.equal(row, null);
  assert.equal(fetchCalls.length, 0);
});

test('snapshotPageAudience(bridgematch): silent skip when FB_BRIDGEMATCH_PAGE_TOKEN unset', async () => {
  process.env.FB_BRIDGEMATCH_PAGE_ID = '67890';
  const { snapshotPageAudience } = loadFresh();
  const row = await snapshotPageAudience('bridgematch');
  assert.equal(row, null);
});

test('snapshotPageAudience(auctionbrain): success calls Graph + upsertAudienceSnapshot', async () => {
  process.env.FB_PAGE_ID = 'page-aaa';
  process.env.FB_PAGE_ACCESS_TOKEN = 'token-aaa';
  nextFetchResponses.push({ ok: true, body: { fan_count: 510, followers_count: 525 } });

  const { snapshotPageAudience } = loadFresh();
  const row = await snapshotPageAudience('auctionbrain');

  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /graph\.facebook\.com\/v22\.0\/page-aaa\?/);
  assert.match(fetchCalls[0].url, /fields=fan_count,followers_count/);
  assert.match(fetchCalls[0].url, /access_token=token-aaa/);

  assert.equal(upsertCalls.length, 1);
  assert.equal(upsertCalls[0].brand, 'auctionbrain');
  assert.equal(upsertCalls[0].page_id, 'page-aaa');
  assert.equal(upsertCalls[0].followers_count, 525);
  assert.equal(upsertCalls[0].fans_count, 510);

  assert.equal(row.followers_count, 525);
  assert.equal(row.follows_delta, 7);
});

test('snapshotPageAudience: falls back to fan_count when followers_count missing', async () => {
  process.env.FB_PAGE_ID = 'page-only-fan';
  process.env.FB_PAGE_ACCESS_TOKEN = 'token';
  nextFetchResponses.push({ ok: true, body: { fan_count: 300 } });

  const { snapshotPageAudience } = loadFresh();
  await snapshotPageAudience('auctionbrain');
  assert.equal(upsertCalls[0].followers_count, 300);
  assert.equal(upsertCalls[0].fans_count, 300);
});

test('snapshotPageAudience: throws on Graph 4xx', async () => {
  process.env.FB_PAGE_ID = 'p';
  process.env.FB_PAGE_ACCESS_TOKEN = 't';
  nextFetchResponses.push({ ok: false, status: 401, body: 'invalid token' });

  const { snapshotPageAudience } = loadFresh();
  await assert.rejects(() => snapshotPageAudience('auctionbrain'), /graph 401/);
  assert.equal(upsertCalls.length, 0);
});

test('snapshotPageAudience: throws when Graph payload has no follower fields', async () => {
  process.env.FB_PAGE_ID = 'p';
  process.env.FB_PAGE_ACCESS_TOKEN = 't';
  nextFetchResponses.push({ ok: true, body: { name: 'My Page' } });

  const { snapshotPageAudience } = loadFresh();
  await assert.rejects(() => snapshotPageAudience('auctionbrain'), /missing followers_count/);
});

// ── runDailyAudienceSnapshot ──────────────────────────────────

test('runDailyAudienceSnapshot: both brands attempted (success/success)', async () => {
  process.env.FB_PAGE_ID = 'p1';
  process.env.FB_PAGE_ACCESS_TOKEN = 't1';
  process.env.FB_BRIDGEMATCH_PAGE_ID = 'p2';
  process.env.FB_BRIDGEMATCH_PAGE_TOKEN = 't2';
  nextFetchResponses.push({ ok: true, body: { fan_count: 100, followers_count: 110 } });
  nextFetchResponses.push({ ok: true, body: { fan_count: 50,  followers_count: 55 } });

  const { runDailyAudienceSnapshot } = loadFresh();
  const out = await runDailyAudienceSnapshot();

  assert.equal(out.successes.length, 2);
  assert.equal(out.failures.length, 0);
  assert.equal(fetchCalls.length, 2);
  assert.equal(upsertCalls.length, 2);
  assert.equal(notifyCalls.length, 0);
});

test('runDailyAudienceSnapshot: continues to bridgematch when auctionbrain throws', async () => {
  process.env.FB_PAGE_ID = 'p1';
  process.env.FB_PAGE_ACCESS_TOKEN = 't1';
  process.env.FB_BRIDGEMATCH_PAGE_ID = 'p2';
  process.env.FB_BRIDGEMATCH_PAGE_TOKEN = 't2';
  nextFetchResponses.push({ ok: false, status: 500, body: 'oops' });
  nextFetchResponses.push({ ok: true, body: { fan_count: 50, followers_count: 55 } });

  const { runDailyAudienceSnapshot } = loadFresh();
  const out = await runDailyAudienceSnapshot();

  assert.equal(out.successes.length, 1);
  assert.equal(out.successes[0].brand, 'bridgematch');
  assert.equal(out.failures.length, 1);
  assert.equal(out.failures[0].brand, 'auctionbrain');
  assert.match(out.failures[0].error, /graph 500/);
  // Single summary Telegram message
  assert.equal(notifyCalls.length, 1);
  assert.match(notifyCalls[0], /Audience snapshot failed/);
  assert.match(notifyCalls[0], /auctionbrain/);
});

test('runDailyAudienceSnapshot: skipped brands do not count as failures', async () => {
  // Only auctionbrain configured. bridgematch silently skipped.
  process.env.FB_PAGE_ID = 'p1';
  process.env.FB_PAGE_ACCESS_TOKEN = 't1';
  nextFetchResponses.push({ ok: true, body: { fan_count: 100, followers_count: 110 } });

  const { runDailyAudienceSnapshot } = loadFresh();
  const out = await runDailyAudienceSnapshot();

  assert.equal(out.successes.length, 2);
  assert.equal(out.successes.find(s => s.brand === 'bridgematch').row, null);
  assert.equal(out.failures.length, 0);
  assert.equal(notifyCalls.length, 0);
});

test('runDailyAudienceSnapshot: never throws even when sendNotification throws', async () => {
  process.env.FB_PAGE_ID = 'p1';
  process.env.FB_PAGE_ACCESS_TOKEN = 't1';
  nextFetchResponses.push({ ok: false, status: 500, body: 'fail' });

  // Inject a throwing telegram before loading the module fresh.
  delete require.cache[MOD_PATH];
  delete require.cache[HELPERS_PATH];
  delete require.cache[TELEGRAM_PATH];
  require.cache[HELPERS_PATH] = {
    id: HELPERS_PATH,
    filename: HELPERS_PATH,
    loaded: true,
    exports: { upsertAudienceSnapshot: async (a) => a },
  };
  require.cache[TELEGRAM_PATH] = {
    id: TELEGRAM_PATH,
    filename: TELEGRAM_PATH,
    loaded: true,
    exports: { sendNotification: async () => { throw new Error('telegram down'); } },
  };
  const mod = require('../../../lib/social-engine/audience');

  const out = await mod.runDailyAudienceSnapshot();
  assert.equal(out.failures.length, 1);
});
