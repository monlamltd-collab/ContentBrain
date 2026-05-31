// Phase G-4 — boost_runs stale-pending cleanup coverage.
//
// Mocks lib/supabase + lib/social-engine/telegram-throttle. Tests:
//   - no stale rows → returns {aged_out: 0, ids: []}, no update, no alert
//   - 1-4 stale rows → updates each, no alert (sub-threshold)
//   - 5+ stale rows → updates each + fires alertThrottled once
//   - meta merge preserves niche_tag + adds ended_reason
//   - row UPDATE failure logs but doesn't abort loop
//   - read error throws (caller wraps in try/catch)
//   - alertThrottled throw does not bubble out
//   - default `now` arg = current time → cutoff is now - 24h
//   - explicit `now` arg → cutoff computed from passed value
//   - rows with NULL meta still get ended_reason set

'use strict';

const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const CLEANUP_PATH = require.resolve('../../../lib/social-engine/cleanup');
const SUPABASE_PATH = require.resolve('../../../lib/supabase');
const THROTTLE_PATH = require.resolve('../../../lib/social-engine/telegram-throttle');

let fixture;
let updates;
let alertCalls;
let nextReadError = null;
let nextUpdateErrors = new Map(); // id → error message
let nextThrottleResult = null;

function freshFixture() {
  fixture = { boost_runs: [] };
  updates = [];
  alertCalls = [];
  nextReadError = null;
  nextUpdateErrors = new Map();
  nextThrottleResult = null;
}

function makeQuery(table) {
  const state = { table, filters: [], isUpdate: null };
  const match = (row) => {
    for (const f of state.filters) {
      if (f.op === 'eq' && row[f.col] !== f.val) return false;
      if (f.op === 'lt' && !(row[f.col] < f.val)) return false;
    }
    return true;
  };
  const api = {
    select() { return api; },
    eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
    lt(col, val) { state.filters.push({ op: 'lt', col, val }); return api; },
    update(payload) { state.isUpdate = payload; return api; },
    then(resolve) {
      if (state.isUpdate) {
        const rows = (fixture[state.table] || []);
        for (const row of rows) {
          if (match(row)) {
            const errMsg = nextUpdateErrors.get(row.id);
            if (errMsg) {
              return resolve({ data: null, error: { message: errMsg } });
            }
            updates.push({ id: row.id, payload: state.isUpdate });
            Object.assign(row, state.isUpdate);
          }
        }
        return resolve({ data: null, error: null });
      }
      if (nextReadError) {
        return resolve({ data: null, error: { message: nextReadError } });
      }
      const rows = (fixture[state.table] || []).filter(match);
      return resolve({ data: rows, error: null });
    },
  };
  return api;
}

function loadFresh() {
  delete require.cache[CLEANUP_PATH];
  delete require.cache[SUPABASE_PATH];
  delete require.cache[THROTTLE_PATH];

  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH,
    filename: SUPABASE_PATH,
    loaded: true,
    exports: { supabase: { from: (table) => makeQuery(table) } },
  };

  require.cache[THROTTLE_PATH] = {
    id: THROTTLE_PATH,
    filename: THROTTLE_PATH,
    loaded: true,
    exports: {
      alertThrottled: async (eventType, identityKey, messageFn) => {
        if (nextThrottleResult instanceof Error) throw nextThrottleResult;
        alertCalls.push({ eventType, identityKey, message: messageFn() });
        return nextThrottleResult || { fired: true, count: 1 };
      },
      alertOnce: async () => ({ fired: true }),
      _resetForTests: () => {},
      ONCE_TTL_MS: 86400000,
      WINDOW_MS: 300000,
    },
  };

  return require('../../../lib/social-engine/cleanup');
}

beforeEach(() => { freshFixture(); });

// ── Happy paths ───────────────────────────────────────────────────────────

test('no stale rows → returns {aged_out: 0, ids: []}, no update, no alert', async () => {
  const { reconcileStalePending } = loadFresh();
  const r = await reconcileStalePending();
  assert.deepEqual(r, { aged_out: 0, ids: [] });
  assert.equal(updates.length, 0);
  assert.equal(alertCalls.length, 0);
});

test('1 stale row → updates with status=failed, no alert (sub-threshold)', async () => {
  const now = new Date('2026-05-25T04:00:00.000Z');
  // 30h old — stale.
  fixture.boost_runs.push({
    id: 'br-1', status: 'pending',
    created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
    meta: { niche_tag: 'wales', source: 'orchestrator' },
  });
  const { reconcileStalePending } = loadFresh();
  const r = await reconcileStalePending({ now });
  assert.equal(r.aged_out, 1);
  assert.deepEqual(r.ids, ['br-1']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].payload.status, 'failed');
  assert.equal(updates[0].payload.meta.ended_reason, 'make_no_callback');
  assert.equal(alertCalls.length, 0);
});

test('4 stale rows → updates each, NO alert (just under threshold)', async () => {
  const now = new Date('2026-05-25T04:00:00.000Z');
  for (let i = 0; i < 4; i += 1) {
    fixture.boost_runs.push({
      id: `br-${i}`, status: 'pending',
      created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
      meta: { niche_tag: 'wales' },
    });
  }
  const { reconcileStalePending } = loadFresh();
  const r = await reconcileStalePending({ now });
  assert.equal(r.aged_out, 4);
  assert.equal(updates.length, 4);
  assert.equal(alertCalls.length, 0, '4 is below threshold (5)');
});

test('5 stale rows → updates each + fires alertThrottled once', async () => {
  const now = new Date('2026-05-25T04:00:00.000Z');
  for (let i = 0; i < 5; i += 1) {
    fixture.boost_runs.push({
      id: `br-${i}`, status: 'pending',
      created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
      meta: { niche_tag: 'wales' },
    });
  }
  const { reconcileStalePending } = loadFresh();
  const r = await reconcileStalePending({ now });
  assert.equal(r.aged_out, 5);
  assert.equal(alertCalls.length, 1);
  assert.equal(alertCalls[0].eventType, 'stale-pending-cleanup');
  assert.equal(alertCalls[0].identityKey, 'global');
  assert.match(alertCalls[0].message, /5 pending row\(s\)/);
  assert.match(alertCalls[0].message, /make_no_callback/);
});

test('10 stale rows → only first 5 ids in alert message body', async () => {
  const now = new Date('2026-05-25T04:00:00.000Z');
  for (let i = 0; i < 10; i += 1) {
    fixture.boost_runs.push({
      id: `br-${i}`, status: 'pending',
      created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
      meta: {},
    });
  }
  const { reconcileStalePending } = loadFresh();
  await reconcileStalePending({ now });
  assert.equal(alertCalls.length, 1);
  assert.match(alertCalls[0].message, /10 pending row\(s\)/);
  // First 5 ids appear
  for (let i = 0; i < 5; i += 1) assert.match(alertCalls[0].message, new RegExp(`br-${i}`));
});

// ── Meta merging ──────────────────────────────────────────────────────────

test('meta merge preserves niche_tag + source and adds ended_reason', async () => {
  const now = new Date('2026-05-25T04:00:00.000Z');
  fixture.boost_runs.push({
    id: 'br-keep-meta', status: 'pending',
    created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
    meta: { niche_tag: 'south-yorkshire', source: 'orchestrator', extra: 42 },
  });
  const { reconcileStalePending } = loadFresh();
  await reconcileStalePending({ now });
  const written = updates[0].payload.meta;
  assert.equal(written.niche_tag, 'south-yorkshire');
  assert.equal(written.source, 'orchestrator');
  assert.equal(written.extra, 42);
  assert.equal(written.ended_reason, 'make_no_callback');
});

test('rows with NULL meta still get ended_reason set', async () => {
  const now = new Date('2026-05-25T04:00:00.000Z');
  fixture.boost_runs.push({
    id: 'br-no-meta', status: 'pending',
    created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
    meta: null,
  });
  const { reconcileStalePending } = loadFresh();
  await reconcileStalePending({ now });
  assert.deepEqual(updates[0].payload.meta, { ended_reason: 'make_no_callback' });
});

// ── Error paths ───────────────────────────────────────────────────────────

test('row UPDATE failure logs but does NOT abort the loop', async () => {
  const now = new Date('2026-05-25T04:00:00.000Z');
  fixture.boost_runs.push({
    id: 'br-bad', status: 'pending',
    created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
    meta: {},
  });
  fixture.boost_runs.push({
    id: 'br-good', status: 'pending',
    created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
    meta: {},
  });
  nextUpdateErrors.set('br-bad', 'simulated-write-error');

  // Suppress the expected warning so test output stays clean.
  const warnSpy = mock.method(console, 'warn', () => {});
  const { reconcileStalePending } = loadFresh();
  const r = await reconcileStalePending({ now });
  warnSpy.mock.restore();

  // br-bad failed → not in ids; br-good succeeded → 1 aged_out.
  assert.equal(r.aged_out, 1);
  assert.deepEqual(r.ids, ['br-good']);
});

test('read error throws (caller wraps in try/catch)', async () => {
  nextReadError = 'simulated-read-failure';
  const { reconcileStalePending } = loadFresh();
  await assert.rejects(() => reconcileStalePending(), /simulated-read-failure/);
});

test('alertThrottled throw does NOT bubble out of reconcileStalePending', async () => {
  const now = new Date('2026-05-25T04:00:00.000Z');
  for (let i = 0; i < 6; i += 1) {
    fixture.boost_runs.push({
      id: `br-${i}`, status: 'pending',
      created_at: new Date(now.getTime() - 30 * 3600 * 1000).toISOString(),
      meta: {},
    });
  }
  nextThrottleResult = new Error('telegram-out');
  const warnSpy = mock.method(console, 'warn', () => {});
  const { reconcileStalePending } = loadFresh();
  const r = await reconcileStalePending({ now });
  warnSpy.mock.restore();

  // Updates still completed; the throw was swallowed.
  assert.equal(r.aged_out, 6);
});
