// Phase G-3 — three Express route handlers (callback, reconcile, active).
//
// Tests the handlers directly via mocked req/res objects. No HTTP server
// boot, no supertest dep. Each test asserts:
//   - valid sig + body -> 200 + correct helper called with correct args
//   - invalid sig -> 401
//   - missing required field -> 400 with explanatory error
//   - per-row error in reconcile -> 200 with ok=false in results (batch continues)
//   - active route: signed empty body OR query-string ?sig= both accepted

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const ROUTES_PATH = require.resolve('../../../lib/social-engine/routes');

const CALLBACK_SECRET = 'CB-SECRET-AAA';
const WEBHOOK_SECRET  = 'WB-SECRET-BBB';

beforeEach(() => {
  delete require.cache[ROUTES_PATH];
  delete require.cache[require.resolve('../../../lib/social-engine/webhook-auth')];
  process.env.MAKE_CALLBACK_SECRET = CALLBACK_SECRET;
  process.env.MAKE_WEBHOOK_SECRET = WEBHOOK_SECRET;
});

function signWith(secret, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  return 'sha256=' + crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}

function makeReq({ body, headers, query } = {}) {
  return {
    body: Buffer.isBuffer(body) ? body : (body == null ? undefined : Buffer.from(body)),
    headers: headers || {},
    query: query || {},
  };
}

// ── Route A: /api/social-boost-callback ───────────────────────

test('callback: valid active -> 200, markBoostActive called', async () => {
  const { handleBoostCallback } = require('../../../lib/social-engine/routes');
  const payload = JSON.stringify({
    request_id: 'boost-1',
    status: 'active',
    boost_campaign_id: 'fb-campaign-123',
    boost_ad_id: 'fb-ad-456',
    started_at: '2026-05-25T09:00:00Z',
  });
  const req = makeReq({ body: payload, headers: { 'x-make-signature': signWith(CALLBACK_SECRET, payload) } });
  const res = makeRes();
  let activeCalls = [];
  const deps = {
    markBoostActive: async (id, args) => { activeCalls.push({ id, args }); return { status: 'active' }; },
    markBoostFailed: async () => { throw new Error('should not be called'); },
  };
  await handleBoostCallback(req, res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.status, 'active');
  assert.equal(activeCalls.length, 1);
  assert.equal(activeCalls[0].id, 'boost-1');
  assert.equal(activeCalls[0].args.boost_campaign_id, 'fb-campaign-123');
  assert.equal(activeCalls[0].args.boost_ad_id, 'fb-ad-456');
  assert.equal(activeCalls[0].args.started_at, '2026-05-25T09:00:00Z');
});

test('callback: valid failed -> 200, markBoostFailed called with default message when error_message missing', async () => {
  const { handleBoostCallback } = require('../../../lib/social-engine/routes');
  const payload = JSON.stringify({ request_id: 'boost-2', status: 'failed' });
  const req = makeReq({ body: payload, headers: { 'x-make-signature': signWith(CALLBACK_SECRET, payload) } });
  const res = makeRes();
  let failedCalls = [];
  const deps = {
    markBoostActive: async () => { throw new Error('nope'); },
    markBoostFailed: async (id, msg) => { failedCalls.push({ id, msg }); return { status: 'failed' }; },
  };
  await handleBoostCallback(req, res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(failedCalls.length, 1);
  assert.equal(failedCalls[0].id, 'boost-2');
  assert.match(failedCalls[0].msg, /Make scenario reported failed/);
});

test('callback: invalid signature -> 401', async () => {
  const { handleBoostCallback } = require('../../../lib/social-engine/routes');
  const payload = JSON.stringify({ request_id: 'b', status: 'active' });
  const req = makeReq({ body: payload, headers: { 'x-make-signature': 'sha256=' + 'f'.repeat(64) } });
  const res = makeRes();
  await handleBoostCallback(req, res, { markBoostActive: async () => ({}), markBoostFailed: async () => ({}) });
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /signature/i);
});

test('callback: missing request_id -> 400', async () => {
  const { handleBoostCallback } = require('../../../lib/social-engine/routes');
  const payload = JSON.stringify({ status: 'active' });
  const req = makeReq({ body: payload, headers: { 'x-make-signature': signWith(CALLBACK_SECRET, payload) } });
  const res = makeRes();
  await handleBoostCallback(req, res, { markBoostActive: async () => ({}), markBoostFailed: async () => ({}) });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /request_id required/);
});

test('callback: unknown status -> 400', async () => {
  const { handleBoostCallback } = require('../../../lib/social-engine/routes');
  const payload = JSON.stringify({ request_id: 'b', status: 'paused' });
  const req = makeReq({ body: payload, headers: { 'x-make-signature': signWith(CALLBACK_SECRET, payload) } });
  const res = makeRes();
  await handleBoostCallback(req, res, { markBoostActive: async () => ({}), markBoostFailed: async () => ({}) });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /unknown status: paused/);
});

test('callback: helper throws -> 500', async () => {
  const { handleBoostCallback } = require('../../../lib/social-engine/routes');
  const payload = JSON.stringify({ request_id: 'b', status: 'active' });
  const req = makeReq({ body: payload, headers: { 'x-make-signature': signWith(CALLBACK_SECRET, payload) } });
  const res = makeRes();
  const deps = {
    markBoostActive: async () => { throw new Error('db down'); },
    markBoostFailed: async () => ({}),
  };
  await handleBoostCallback(req, res, deps);
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /db down/);
});

// ── Route B: /api/social-boost-reconcile ──────────────────────

test('reconcile: valid batch -> 200, markBoostMetrics called per row', async () => {
  const { handleBoostReconcile } = require('../../../lib/social-engine/routes');
  const body = JSON.stringify({
    as_of: '2026-05-26T06:05:00Z',
    metrics: [
      { boost_campaign_id: 'c1', spend_pence: 200, ad_impressions: 1000, ad_new_follows: 5, is_final: false },
      { boost_campaign_id: 'c2', spend_pence: 400, ad_impressions: 2000, ad_new_follows: 10, is_final: true },
    ],
  });
  const req = makeReq({ body, headers: { 'x-make-signature': signWith(CALLBACK_SECRET, body) } });
  const res = makeRes();
  let metricsCalls = [];
  const deps = {
    markBoostMetrics: async (id, args) => { metricsCalls.push({ id, args }); return { status: args.is_final ? 'complete' : 'active' }; },
  };
  await handleBoostReconcile(req, res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.processed, 2);
  assert.equal(metricsCalls.length, 2);
  assert.equal(metricsCalls[0].id, 'c1');
  assert.equal(metricsCalls[0].args.as_of, '2026-05-26T06:05:00Z');
  assert.equal(metricsCalls[0].args.spend_pence, 200);
  assert.equal(metricsCalls[1].args.is_final, true);
  assert.equal(res.body.results[0].ok, true);
  assert.equal(res.body.results[1].status, 'complete');
});

test('reconcile: per-row failure does NOT abort batch', async () => {
  const { handleBoostReconcile } = require('../../../lib/social-engine/routes');
  const body = JSON.stringify({
    as_of: '2026-05-26T06:05:00Z',
    metrics: [
      { boost_campaign_id: 'c1', spend_pence: 200 },
      { boost_campaign_id: 'c2', spend_pence: 400 },
      { boost_campaign_id: 'c3', spend_pence: 100 },
    ],
  });
  const req = makeReq({ body, headers: { 'x-make-signature': signWith(CALLBACK_SECRET, body) } });
  const res = makeRes();
  const deps = {
    markBoostMetrics: async (id) => {
      if (id === 'c2') throw new Error('row c2 violates check constraint');
      return { status: 'active' };
    },
  };
  await handleBoostReconcile(req, res, deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.processed, 3);
  assert.equal(res.body.results[0].ok, true);
  assert.equal(res.body.results[1].ok, false);
  assert.match(res.body.results[1].error, /check constraint/);
  assert.equal(res.body.results[2].ok, true);
});

test('reconcile: missing metrics array -> 400', async () => {
  const { handleBoostReconcile } = require('../../../lib/social-engine/routes');
  const body = JSON.stringify({ as_of: 'now' });
  const req = makeReq({ body, headers: { 'x-make-signature': signWith(CALLBACK_SECRET, body) } });
  const res = makeRes();
  await handleBoostReconcile(req, res, { markBoostMetrics: async () => ({}) });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /metrics array required/);
});

test('reconcile: invalid signature -> 401', async () => {
  const { handleBoostReconcile } = require('../../../lib/social-engine/routes');
  const body = JSON.stringify({ metrics: [] });
  const req = makeReq({ body, headers: { 'x-make-signature': 'sha256=' + '0'.repeat(64) } });
  const res = makeRes();
  await handleBoostReconcile(req, res, { markBoostMetrics: async () => ({}) });
  assert.equal(res.statusCode, 401);
});

// ── Route C: /api/social-boost-active ─────────────────────────

function mockSupabase(rows) {
  const q = {
    select() { return q; },
    in() { return q; },
    not() { return q; },
    order() { return Promise.resolve({ data: rows, error: null }); },
  };
  return { from: () => q };
}

function mockSupabaseError(message) {
  const q = {
    select() { return q; },
    in() { return q; },
    not() { return q; },
    order() { return Promise.resolve({ data: null, error: { message } }); },
  };
  return { from: () => q };
}

test('active: signed empty body via x-cb-signature -> 200 rows mapped', async () => {
  const { handleBoostActive } = require('../../../lib/social-engine/routes');
  const sig = signWith(WEBHOOK_SECRET, Buffer.alloc(0));
  const req = makeReq({ headers: { 'x-cb-signature': sig } });
  const res = makeRes();
  const supabase = mockSupabase([
    { id: 'b1', boost_campaign_id: 'fb-c1', status: 'active', started_at: '2026-05-25T09:00:00Z', duration_hours: 24 },
    { id: 'b2', boost_campaign_id: 'fb-c2', status: 'pending', started_at: '2026-05-26T09:00:00Z', duration_hours: 48 },
  ]);
  await handleBoostActive(req, res, { supabase });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.runs.length, 2);
  assert.equal(res.body.runs[0].request_id, 'b1');
  assert.equal(res.body.runs[0].boost_campaign_id, 'fb-c1');
  assert.equal(res.body.runs[0].duration_hours, 24);
});

test('active: query-string sig fallback also accepted', async () => {
  const { handleBoostActive } = require('../../../lib/social-engine/routes');
  const sig = signWith(WEBHOOK_SECRET, Buffer.alloc(0));
  const req = makeReq({ query: { sig } });
  const res = makeRes();
  await handleBoostActive(req, res, { supabase: mockSupabase([]) });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.runs, []);
});

test('active: invalid signature -> 401', async () => {
  const { handleBoostActive } = require('../../../lib/social-engine/routes');
  const req = makeReq({ headers: { 'x-cb-signature': 'sha256=' + 'a'.repeat(64) } });
  const res = makeRes();
  await handleBoostActive(req, res, { supabase: mockSupabase([]) });
  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /signature/i);
});

test('active: no signature anywhere -> 401', async () => {
  const { handleBoostActive } = require('../../../lib/social-engine/routes');
  const req = makeReq({});
  const res = makeRes();
  await handleBoostActive(req, res, { supabase: mockSupabase([]) });
  assert.equal(res.statusCode, 401);
});

test('active: supabase error -> 500', async () => {
  const { handleBoostActive } = require('../../../lib/social-engine/routes');
  const sig = signWith(WEBHOOK_SECRET, Buffer.alloc(0));
  const req = makeReq({ headers: { 'x-cb-signature': sig } });
  const res = makeRes();
  await handleBoostActive(req, res, { supabase: mockSupabaseError('connection refused') });
  assert.equal(res.statusCode, 500);
  assert.match(res.body.error, /connection refused/);
});
