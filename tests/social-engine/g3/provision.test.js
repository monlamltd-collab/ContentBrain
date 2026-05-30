// Phase G-3 — scripts/make/provision.js unit coverage.
//
// Tests the pure pieces (stripDocs, readBlueprint) + the orchestrated
// provision() flow via mocked global.fetch. No live Make API.

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const PROVISION_PATH = require.resolve('../../../scripts/make/provision');

let fetchCalls = [];
let nextFetchResponses = [];
const originalFetch = global.fetch;

function loadFresh() {
  delete require.cache[PROVISION_PATH];
  return require('../../../scripts/make/provision');
}

beforeEach(() => {
  fetchCalls = [];
  nextFetchResponses = [];
  process.env.MAKE_API_TOKEN = 'test-token-XYZ';
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (!nextFetchResponses.length) throw new Error(`Mock fetch out of responses for ${url}`);
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

// ── stripDocs ─────────────────────────────────────────────────

test('stripDocs: removes underscore-prefixed keys at every depth', () => {
  const { stripDocs } = loadFresh();
  const input = {
    a: 1,
    _b: 2,
    _doc: 'comment',
    c: {
      _d: 3,
      e: [1, 2, { _f: 0, g: 9 }],
      h: { _i: 4, j: 5 },
    },
  };
  const out = stripDocs(input);
  assert.deepEqual(out, { a: 1, c: { e: [1, 2, { g: 9 }], h: { j: 5 } } });
});

test('stripDocs: preserves arrays as arrays', () => {
  const { stripDocs } = loadFresh();
  const out = stripDocs({ list: [1, 2, 3] });
  assert.ok(Array.isArray(out.list));
  assert.equal(out.list.length, 3);
});

test('stripDocs: returns primitives unchanged', () => {
  const { stripDocs } = loadFresh();
  assert.equal(stripDocs(null), null);
  assert.equal(stripDocs(42), 42);
  assert.equal(stripDocs('text'), 'text');
});

// ── readBlueprint ─────────────────────────────────────────────

test('readBlueprint: reads ub-social-boost.blueprint.json + strips _-keys + lifts scheduling', () => {
  const { readBlueprint } = loadFresh();
  const bp = readBlueprint(path.join(__dirname, '..', '..', '..', 'scripts', 'make', 'ub-social-boost.blueprint.json'));
  assert.equal(bp.name, 'ub-social-boost');
  // _doc / _targetTeamId etc. gone
  const json = JSON.stringify(bp.blueprint);
  assert.equal(json.match(/"_[a-z]/g), null, 'stripped object still contains _-prefixed keys');
  // scheduling is type=immediately (webhook-driven) — present at top of source file
  assert.ok(bp.scheduling, 'expected scheduling lifted from blueprint');
});

test('readBlueprint: reads ub-social-boost-reconcile.blueprint.json + scheduling = cron', () => {
  const { readBlueprint } = loadFresh();
  const bp = readBlueprint(path.join(__dirname, '..', '..', '..', 'scripts', 'make', 'ub-social-boost-reconcile.blueprint.json'));
  assert.equal(bp.name, 'ub-social-boost-reconcile');
  assert.equal(bp.scheduling.type, 'cron');
  assert.equal(bp.scheduling.cron, '0 6 * * *');
  // scheduling lifted OUT of the blueprint
  assert.equal(bp.blueprint.scheduling, undefined);
});

// ── provision (orchestration) ─────────────────────────────────

test('provision (dry-run): validates both blueprints, makes no create calls', async () => {
  // Validator returns valid response for each blueprint.
  nextFetchResponses.push({ ok: true, body: { valid: true } });  // validate boost
  nextFetchResponses.push({ ok: true, body: { valid: true } });  // validate reconcile

  const { provision } = loadFresh();
  const out = await provision({ dryRun: true });
  assert.equal(fetchCalls.length, 2);  // 2 validate calls only
  assert.ok(fetchCalls[0].url.endsWith('/scenarios/validate-blueprint'));
  assert.equal(out.created.length, 0);
  assert.equal(out.skipped.length, 0);
});

test('provision: validator failure aborts before create', async () => {
  nextFetchResponses.push({ ok: true, body: { valid: false, errors: [{ message: 'bad module shape' }] } });
  const { provision } = loadFresh();
  await assert.rejects(() => provision({}), /failed validation/);
});

test('provision: creates both scenarios when none exist + returns webhook URL', async () => {
  // 2 validates
  nextFetchResponses.push({ ok: true, body: { valid: true } });
  nextFetchResponses.push({ ok: true, body: { valid: true } });
  // listExistingScenarios -> empty
  nextFetchResponses.push({ ok: true, body: { scenarios: [] } });
  // create ub-social-boost
  nextFetchResponses.push({ ok: true, body: { scenario: { id: 9001, hookId: 7001 } } });
  // getWebhookUrl for hook 7001
  nextFetchResponses.push({ ok: true, body: { hooks: [{ id: 7001, url: 'https://hook.eu1.make.com/abc' }] } });
  // create reconcile
  nextFetchResponses.push({ ok: true, body: { scenario: { id: 9002, hookId: null } } });

  const { provision } = loadFresh();
  const out = await provision({});
  assert.equal(out.created.length, 2);
  assert.equal(out.created[0].name, 'ub-social-boost');
  assert.equal(out.created[0].id, 9001);
  assert.equal(out.created[1].name, 'ub-social-boost-reconcile');
  assert.equal(out.created[1].id, 9002);
  assert.equal(out.webhookUrl, 'https://hook.eu1.make.com/abc');
});

test('provision: idempotent — skips existing scenarios by name', async () => {
  // 2 validates
  nextFetchResponses.push({ ok: true, body: { valid: true } });
  nextFetchResponses.push({ ok: true, body: { valid: true } });
  // listExistingScenarios -> both already present
  nextFetchResponses.push({ ok: true, body: {
    scenarios: [
      { id: 8001, name: 'ub-social-boost', hookId: 6001 },
      { id: 8002, name: 'ub-social-boost-reconcile', hookId: null },
    ],
  } });
  // getWebhookUrl for the existing ub-social-boost hook
  nextFetchResponses.push({ ok: true, body: { hooks: [{ id: 6001, url: 'https://hook.eu1.make.com/existing' }] } });

  const { provision } = loadFresh();
  const out = await provision({});
  assert.equal(out.created.length, 0);
  assert.equal(out.skipped.length, 2);
  assert.equal(out.skipped[0].id, 8001);
  assert.equal(out.webhookUrl, 'https://hook.eu1.make.com/existing');
});

test('provision: API errors propagate (non-2xx throws)', async () => {
  nextFetchResponses.push({ ok: false, status: 401, body: 'unauthorised' });
  const { provision } = loadFresh();
  await assert.rejects(() => provision({}), /401/);
});

test('makeApi: sends Authorization: Token <MAKE_API_TOKEN>', async () => {
  nextFetchResponses.push({ ok: true, body: { scenarios: [] } });
  const { listExistingScenarios } = loadFresh();
  await listExistingScenarios();
  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Token test-token-XYZ');
});
