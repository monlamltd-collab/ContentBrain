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
  const bp = readBlueprint(
    path.join(__dirname, '..', '..', '..', 'scripts', 'make', 'ub-social-boost.blueprint.json'),
    { hookId: 3453292 }
  );
  assert.equal(bp.name, 'ub-social-boost');
  const json = JSON.stringify(bp.blueprint);
  assert.equal(json.match(/\"_[a-z]/g), null, 'stripped object still contains _-prefixed keys');
  assert.ok(bp.scheduling, 'expected scheduling lifted from blueprint');
  assert.equal(bp.blueprint.scheduling, undefined);
  assert.match(json, /"hook":3453292/);
  assert.match(json, /util:SetVariables/);
  assert.doesNotMatch(json, /util:SetVariables2/);
  assert.doesNotMatch(json, /"filter"/);
  assert.ok(bp.strippedFilters >= 1);
});

test('readBlueprint: reads ub-social-boost-reconcile.blueprint.json + scheduling = cron', () => {
  const { readBlueprint } = loadFresh();
  const bp = readBlueprint(
    path.join(__dirname, '..', '..', '..', 'scripts', 'make', 'ub-social-boost-reconcile.blueprint.json')
  );
  assert.equal(bp.name, 'ub-social-boost-reconcile');
  assert.equal(bp.scheduling.type, 'daily');
  assert.equal(bp.scheduling.time, '06:00');
  assert.equal(bp.blueprint.scheduling, undefined);
  // placeholder aggregator with _skipIfRejected removed
  const modules = bp.blueprint.flow.map((m) => m.module);
  assert.ok(!modules.includes('builtin:BasicAggregator') || modules.includes('builtin:Iterator'));
});

// ── provision (orchestration) ─────────────────────────────────

test('provision (dry-run): local-validates, lists hooks, makes no create calls', async () => {
  // dry-run ensureBoostHook path: GET hooks only
  nextFetchResponses.push({
    ok: true,
    body: {
      hooks: [
        {
          id: 7001,
          name: 'ub-social-boost webhook',
          typeName: 'gateway-webhook',
          gone: false,
          url: 'https://hook.eu1.make.com/abc',
        },
      ],
    },
  });

  const { provision } = loadFresh();
  const out = await provision({ dryRun: true });
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.includes('/hooks?teamId='));
  assert.equal(out.created.length, 0);
  assert.equal(out.skipped.length, 0);
});

test('provision: local validation failure aborts before network create', () => {
  const mod = loadFresh();
  assert.throws(
    () => mod.validateLocal({ name: 'x', blueprint: { flow: [] }, scheduling: { type: 'cron' } }),
    /flow must be a non-empty array/
  );
});

test('provision: creates both scenarios when none exist + returns webhook URL', async () => {
  // ensureBoostHook -> GET hooks empty
  nextFetchResponses.push({ ok: true, body: { hooks: [] } });
  // ensureBoostHook -> POST hook
  nextFetchResponses.push({
    ok: true,
    body: { hook: { id: 7001, url: 'https://hook.eu1.make.com/abc' } },
  });
  // listExistingScenarios
  nextFetchResponses.push({ ok: true, body: { scenarios: [] } });
  // create ub-social-boost
  nextFetchResponses.push({ ok: true, body: { scenario: { id: 9001, hookId: 7001, name: 'ub-social-boost' } } });
  // create reconcile
  nextFetchResponses.push({
    ok: true,
    body: { scenario: { id: 9002, hookId: null, name: 'ub-social-boost-reconcile' } },
  });

  const { provision } = loadFresh();
  const out = await provision({});
  assert.equal(out.created.length, 2);
  assert.equal(out.created[0].name, 'ub-social-boost');
  assert.equal(out.created[0].id, 9001);
  assert.equal(out.created[1].name, 'ub-social-boost-reconcile');
  assert.equal(out.created[1].id, 9002);
  assert.equal(out.webhookUrl, 'https://hook.eu1.make.com/abc');

  // create calls must stringify blueprint + scheduling and omit top-level name
  const createCalls = fetchCalls.filter(
    (c) => c.opts && c.opts.method === 'POST' && String(c.url).endsWith('/scenarios')
  );
  assert.equal(createCalls.length, 2);
  const body = JSON.parse(createCalls[0].opts.body);
  assert.equal(typeof body.blueprint, 'string');
  assert.equal(typeof body.scheduling, 'string');
  assert.equal(body.teamId, 1406232);
  assert.equal(body.name, undefined);
  const parsedBp = JSON.parse(body.blueprint);
  assert.equal(parsedBp.name, 'ub-social-boost');
  assert.match(JSON.stringify(parsedBp), /"hook":7001/);
});

test('provision: idempotent — skips existing scenarios by name', async () => {
  // ensureBoostHook GET finds existing hook
  nextFetchResponses.push({
    ok: true,
    body: {
      hooks: [
        {
          id: 6001,
          name: 'ub-social-boost webhook',
          typeName: 'gateway-webhook',
          gone: false,
          url: 'https://hook.eu1.make.com/existing',
        },
      ],
    },
  });
  // listExistingScenarios -> both present
  nextFetchResponses.push({
    ok: true,
    body: {
      scenarios: [
        { id: 8001, name: 'ub-social-boost', hookId: 6001 },
        { id: 8002, name: 'ub-social-boost-reconcile', hookId: null },
      ],
    },
  });
  // getWebhookUrl for existing boost
  nextFetchResponses.push({
    ok: true,
    body: { hooks: [{ id: 6001, url: 'https://hook.eu1.make.com/existing' }] },
  });

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

test('renameModules + stripRouteFilters helpers', () => {
  const { renameModules, stripRouteFilters } = loadFresh();
  const renamed = renameModules({ module: 'util:SetVariables2', nested: { module: 'http:ActionSendData' } });
  assert.equal(renamed.module, 'util:SetVariables');
  assert.equal(renamed.nested.module, 'http:ActionSendData');
  const { value, strippedFilters } = stripRouteFilters({
    routes: [{ filter: { name: 'x' }, flow: [{ id: 1 }] }, { flow: [{ id: 2 }] }],
  });
  assert.equal(strippedFilters, 1);
  assert.equal(value.routes[0].filter, undefined);
  assert.ok(value.routes[0].flow);
});
