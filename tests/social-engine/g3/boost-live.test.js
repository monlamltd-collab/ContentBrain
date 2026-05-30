// Phase G-3 — requestBoost live webhook fire path.
//
// Builds on tests/social-engine/boost-runs.test.js. Tests the PR3 surface:
//   - dedupe: when getActiveBoostRunsForPost returns >0 rows, returns the
//     existing id with deduped=true, fires no webhook, inserts no row
//   - live fire: when MAKE_BOOST_WEBHOOK_URL set + MAKE_WEBHOOK_SECRET set,
//     POSTs to the URL with x-cb-signature header and a JSON body that
//     matches the expected schema (request_id, post_id, fb_post_id, ...)
//   - non-2xx response: markBoostFailed called with the truncated body,
//     fired_webhook=false, NEVER throws
//   - fetch throw: markBoostFailed called with the error message
//   - signOutbound throw (MAKE_WEBHOOK_SECRET unset): markBoostFailed,
//     no fetch, returns fired_webhook=false
//   - URL unset: no fetch, fired_webhook=false (PR2 fallback)

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const BOOST_PATH = require.resolve('../../../lib/social-engine/boost');
const HELPERS_PATH = require.resolve('../../../lib/social-engine/helpers');

let insertCalls = [];
let activeRows = [];
let markFailedCalls = [];
let fetchCalls = [];
let nextFetchResponses = [];
const originalFetch = global.fetch;

function loadFresh() {
  delete require.cache[BOOST_PATH];
  delete require.cache[HELPERS_PATH];
  require.cache[HELPERS_PATH] = {
    id: HELPERS_PATH,
    filename: HELPERS_PATH,
    loaded: true,
    exports: {
      insertBoostRun: async (row) => {
        insertCalls.push(row);
        return { id: 'boost-99', ...row, status: 'pending' };
      },
      getActiveBoostRunsForPost: async (_postId) => activeRows,
      markBoostFailed: async (id, msg) => {
        markFailedCalls.push({ id, msg });
        return { id, status: 'failed' };
      },
    },
  };
  return require('../../../lib/social-engine/boost');
}

beforeEach(() => {
  insertCalls = [];
  activeRows = [];
  markFailedCalls = [];
  fetchCalls = [];
  nextFetchResponses = [];
  delete process.env.MAKE_BOOST_WEBHOOK_URL;
  delete process.env.MAKE_WEBHOOK_SECRET;
  delete process.env.BASE_URL;
  delete process.env.FB_PAGE_ID;

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

// ── Dedupe ────────────────────────────────────────────────────

test('dedupe: existing pending boost returns existing id without inserting or firing', async () => {
  activeRows = [{ id: 'existing-77', status: 'pending' }];
  const { requestBoost } = loadFresh();
  const r = await requestBoost({ id: 'p-1', meta: {} }, 'fb-1');
  assert.equal(r.deduped, true);
  assert.equal(r.boost_run_id, 'existing-77');
  assert.equal(r.fired_webhook, false);
  assert.equal(insertCalls.length, 0);
  assert.equal(fetchCalls.length, 0);
});

test('dedupe: existing active boost (not pending) also blocks re-fire', async () => {
  activeRows = [{ id: 'existing-active-42', status: 'active' }];
  const { requestBoost } = loadFresh();
  const r = await requestBoost({ id: 'p-2', meta: {} }, 'fb-2');
  assert.equal(r.deduped, true);
  assert.equal(r.boost_run_id, 'existing-active-42');
});

// ── URL unset (PR2 fallback) ──────────────────────────────────

test('URL unset: no fetch, fired_webhook=false', async () => {
  const { requestBoost } = loadFresh();
  const r = await requestBoost({ id: 'p-3', meta: { niche_tag: 'wales' } }, 'fb-3');
  assert.equal(r.fired_webhook, false);
  assert.equal(insertCalls.length, 1);
  assert.equal(fetchCalls.length, 0);
});

// ── Live fire success ─────────────────────────────────────────

test('live fire: POSTs signed payload with all required fields', async () => {
  process.env.MAKE_BOOST_WEBHOOK_URL = 'https://hook.eu1.make.com/abc123';
  process.env.MAKE_WEBHOOK_SECRET = 'test-secret-XXX';
  process.env.BASE_URL = 'https://contentbrain.up.railway.app';
  process.env.FB_PAGE_ID = 'page-aaa';
  nextFetchResponses.push({ ok: true, body: { ok: true } });

  const { requestBoost } = loadFresh();
  const r = await requestBoost({ id: 'post-uuid-1', meta: { niche_tag: 'wales' } }, 'fb-post-id-xyz');

  assert.equal(r.fired_webhook, true);
  assert.equal(r.boost_run_id, 'boost-99');
  assert.equal(fetchCalls.length, 1);

  const call = fetchCalls[0];
  assert.equal(call.url, 'https://hook.eu1.make.com/abc123');
  assert.equal(call.opts.method, 'POST');
  assert.equal(call.opts.headers['content-type'], 'application/json');
  assert.match(call.opts.headers['x-cb-signature'], /^sha256=[a-f0-9]{64}$/);

  const sent = JSON.parse(call.opts.body);
  assert.equal(sent.request_id, 'boost-99');
  assert.equal(sent.post_id, 'post-uuid-1');
  assert.equal(sent.fb_post_id, 'fb-post-id-xyz');
  assert.equal(sent.page_id, 'page-aaa');
  assert.equal(sent.objective, 'OUTCOME_ENGAGEMENT');
  assert.equal(sent.daily_budget_pence, 200);
  assert.equal(sent.duration_hours, 24);
  assert.equal(sent.callback_url, 'https://contentbrain.up.railway.app/api/social-boost-callback');
  assert.deepEqual(sent.audience_spec.geo_locations_cities.sort(), ['Cardiff', 'Newport', 'Swansea']);

  // Signature should match what signOutbound computes for the body
  const expectedSig = 'sha256=' + crypto.createHmac('sha256', 'test-secret-XXX').update(call.opts.body).digest('hex');
  assert.equal(call.opts.headers['x-cb-signature'], expectedSig);

  assert.equal(markFailedCalls.length, 0);
});

test('live fire: BASE_URL trailing slash stripped from callback_url', async () => {
  process.env.MAKE_BOOST_WEBHOOK_URL = 'https://hook.eu1.make.com/x';
  process.env.MAKE_WEBHOOK_SECRET = 's';
  process.env.BASE_URL = 'https://contentbrain.up.railway.app/';
  nextFetchResponses.push({ ok: true, body: {} });

  const { requestBoost } = loadFresh();
  await requestBoost({ id: 'p', meta: {} }, 'fb-x');
  const sent = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(sent.callback_url, 'https://contentbrain.up.railway.app/api/social-boost-callback');
});

// ── Non-2xx response ──────────────────────────────────────────

test('live fire: non-2xx response calls markBoostFailed + returns fired_webhook=false (no throw)', async () => {
  process.env.MAKE_BOOST_WEBHOOK_URL = 'https://hook.eu1.make.com/x';
  process.env.MAKE_WEBHOOK_SECRET = 's';
  nextFetchResponses.push({ ok: false, status: 502, body: 'Bad Gateway' });

  const { requestBoost } = loadFresh();
  const r = await requestBoost({ id: 'p-bad', meta: {} }, 'fb-bad');
  assert.equal(r.fired_webhook, false);
  assert.equal(r.boost_run_id, 'boost-99');
  assert.equal(markFailedCalls.length, 1);
  assert.equal(markFailedCalls[0].id, 'boost-99');
  assert.match(markFailedCalls[0].msg, /Make webhook returned 502/);
});

// ── Fetch throw ───────────────────────────────────────────────

test('live fire: network throw calls markBoostFailed + returns fired_webhook=false', async () => {
  process.env.MAKE_BOOST_WEBHOOK_URL = 'https://hook.eu1.make.com/x';
  process.env.MAKE_WEBHOOK_SECRET = 's';
  global.fetch = async () => { throw new Error('ECONNREFUSED'); };

  const { requestBoost } = loadFresh();
  const r = await requestBoost({ id: 'p-net', meta: {} }, 'fb-net');
  assert.equal(r.fired_webhook, false);
  assert.equal(markFailedCalls.length, 1);
  assert.match(markFailedCalls[0].msg, /Make webhook fetch failed/);
  assert.match(markFailedCalls[0].msg, /ECONNREFUSED/);
});

// ── signOutbound throw ────────────────────────────────────────

test('live fire: MAKE_WEBHOOK_SECRET unset -> markBoostFailed, no fetch, no throw', async () => {
  process.env.MAKE_BOOST_WEBHOOK_URL = 'https://hook.eu1.make.com/x';
  // MAKE_WEBHOOK_SECRET deliberately unset
  const { requestBoost } = loadFresh();
  const r = await requestBoost({ id: 'p-nosig', meta: {} }, 'fb-nosig');
  assert.equal(r.fired_webhook, false);
  assert.equal(fetchCalls.length, 0);
  assert.equal(markFailedCalls.length, 1);
  assert.match(markFailedCalls[0].msg, /signOutbound failed/);
});
