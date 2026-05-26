// Phase E — closed-loop/funded-deals tests.
//
// Mocks lib/supabase via require.cache injection (same pattern as
// tests/dashboard/performance.test.js). Covers:
//   - getProspectOutcomes happy path + cache hit avoids second query
//   - getProspectOutcomes returns [] on falsy prospectId
//   - getProspectOutcomes returns [] on Supabase error (doesn't throw)
//   - insertOutcome validates claude_fact + deal_amount
//   - insertOutcome happy path returns { id }

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SUP_PATH = require.resolve('../../lib/supabase');
const MOD_PATH = require.resolve('../../lib/closed-loop/funded-deals');

let fakeOutcomes; // [{id,prospect_id,claude_fact,...}]
let outcomeQueryCalls; // counter to test cache
let lastInsert; // captured insert payload
let nextInsertError; // string or null
let nextSelectError; // string or null

function makeFakeSupabase() {
  return {
    from(table) {
      const state = { table, filters: [], orderCol: null, asc: true, limit_: null, isNotClauses: [] };

      const api = {
        select(_sel) { return api; },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
        not(col, _op, _val) { state.isNotClauses.push(col); return api; },
        order(col, opts) { state.orderCol = col; state.asc = opts ? !!opts.ascending : true; return api; },
        limit(n) { state.limit_ = n; return api; },
        in(col, vals) { state.filters.push({ op: 'in', col, val: vals }); return api; },
        ilike(col, val) { state.filters.push({ op: 'ilike', col, val }); return api; },
        is(col, val) { state.filters.push({ op: 'is', col, val }); return api; },
        async maybeSingle() {
          if (nextSelectError) return { data: null, error: { message: nextSelectError } };
          const rows = runFilter();
          return { data: rows[0] || null, error: null };
        },
        async single() {
          if (nextSelectError) return { data: null, error: { message: nextSelectError } };
          const rows = runFilter();
          return { data: rows[0] || null, error: null };
        },
        insert(payload) {
          lastInsert = payload;
          return {
            select() {
              return {
                async single() {
                  if (nextInsertError) return { data: null, error: { message: nextInsertError } };
                  return { data: { id: 'new-id-1' }, error: null };
                },
              };
            },
          };
        },
        then(resolve) {
          if (nextSelectError) return resolve({ data: null, error: { message: nextSelectError } });
          const rows = runFilter();
          resolve({ data: rows, error: null });
        },
      };

      function runFilter() {
        if (table === 'outbound_outcomes') outcomeQueryCalls += 1;
        let rows = (fakeOutcomes || []).slice();
        for (const f of state.filters) {
          if (f.op === 'eq') rows = rows.filter(r => r[f.col] === f.val);
          if (f.op === 'in') rows = rows.filter(r => f.val.includes(r[f.col]));
        }
        if (state.orderCol) {
          rows.sort((a, b) => {
            const va = a[state.orderCol], vb = b[state.orderCol];
            if (va < vb) return state.asc ? -1 : 1;
            if (va > vb) return state.asc ? 1 : -1;
            return 0;
          });
        }
        if (state.limit_ !== null) rows = rows.slice(0, state.limit_);
        return rows;
      }

      return api;
    },
  };
}

function loadFresh() {
  delete require.cache[SUP_PATH];
  delete require.cache[MOD_PATH];
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
  return require('../../lib/closed-loop/funded-deals');
}

beforeEach(() => {
  fakeOutcomes = [];
  outcomeQueryCalls = 0;
  lastInsert = null;
  nextInsertError = null;
  nextSelectError = null;
});

// ── getProspectOutcomes ───────────────────────────────────────────────────

test('getProspectOutcomes: returns [] when prospectId is falsy', async () => {
  const mod = loadFresh();
  assert.deepEqual(await mod.getProspectOutcomes(null), []);
  assert.deepEqual(await mod.getProspectOutcomes(''), []);
  assert.deepEqual(await mod.getProspectOutcomes(undefined), []);
});

test('getProspectOutcomes: returns rows ordered by closed_at DESC and respects limit', async () => {
  fakeOutcomes = [
    { id: 'o1', prospect_id: 'p1', claude_fact: 'old', closed_at: '2026-01-01T00:00:00Z' },
    { id: 'o2', prospect_id: 'p1', claude_fact: 'new', closed_at: '2026-04-01T00:00:00Z' },
    { id: 'o3', prospect_id: 'p2', claude_fact: 'other', closed_at: '2026-05-01T00:00:00Z' },
  ];
  const mod = loadFresh();
  const rows = await mod.getProspectOutcomes('p1', { limit: 2 });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].claude_fact, 'new');
  assert.equal(rows[1].claude_fact, 'old');
});

test('getProspectOutcomes: second call within TTL hits the cache (no second query)', async () => {
  fakeOutcomes = [{ id: 'o1', prospect_id: 'p1', claude_fact: 'a', closed_at: '2026-01-01T00:00:00Z' }];
  const mod = loadFresh();
  await mod.getProspectOutcomes('p1');
  await mod.getProspectOutcomes('p1');
  assert.equal(outcomeQueryCalls, 1, 'second call should be cached');
});

test('getProspectOutcomes: returns [] on Supabase error (does not throw)', async () => {
  nextSelectError = 'connection reset';
  const mod = loadFresh();
  const rows = await mod.getProspectOutcomes('p1');
  assert.deepEqual(rows, []);
});

test('getProspectOutcomes: different limits use separate cache keys', async () => {
  fakeOutcomes = [
    { id: 'o1', prospect_id: 'p1', claude_fact: 'a', closed_at: '2026-01-01T00:00:00Z' },
    { id: 'o2', prospect_id: 'p1', claude_fact: 'b', closed_at: '2026-02-01T00:00:00Z' },
  ];
  const mod = loadFresh();
  await mod.getProspectOutcomes('p1', { limit: 1 });
  await mod.getProspectOutcomes('p1', { limit: 2 });
  assert.equal(outcomeQueryCalls, 2, 'different limits should re-query');
});

// ── insertOutcome ─────────────────────────────────────────────────────────

test('insertOutcome: rejects empty claude_fact', async () => {
  const mod = loadFresh();
  await assert.rejects(
    () => mod.insertOutcome({ closed_at: '2026-01-01', claude_fact: '' }),
    /claude_fact is required/,
  );
  await assert.rejects(
    () => mod.insertOutcome({ closed_at: '2026-01-01', claude_fact: '   ' }),
    /claude_fact is required/,
  );
  await assert.rejects(
    () => mod.insertOutcome({ closed_at: '2026-01-01' }),
    /claude_fact is required/,
  );
});

test('insertOutcome: rejects non-numeric deal_amount', async () => {
  const mod = loadFresh();
  await assert.rejects(
    () => mod.insertOutcome({ closed_at: '2026-01-01', claude_fact: 'ok', deal_amount: 'abc' }),
    /deal_amount must be numeric/,
  );
});

test('insertOutcome: accepts null deal_amount', async () => {
  const mod = loadFresh();
  const r = await mod.insertOutcome({ closed_at: '2026-01-01', claude_fact: 'ok', deal_amount: null });
  assert.equal(r.id, 'new-id-1');
  assert.equal(lastInsert.deal_amount, null);
});

test('insertOutcome: rejects missing closed_at', async () => {
  const mod = loadFresh();
  await assert.rejects(
    () => mod.insertOutcome({ claude_fact: 'ok' }),
    /closed_at is required/,
  );
});

test('insertOutcome: returns id on success', async () => {
  const mod = loadFresh();
  const r = await mod.insertOutcome({
    prospect_id: 'p1',
    closed_at: '2026-01-01T00:00:00Z',
    claude_fact: 'BridgeMatch closed £450k for Acme in April.',
    deal_amount: 450000,
    deal_type: 'auction-purchase',
    source: 'manual-csv',
  });
  assert.equal(r.id, 'new-id-1');
  assert.equal(lastInsert.claude_fact, 'BridgeMatch closed £450k for Acme in April.');
  assert.equal(lastInsert.source, 'manual-csv');
  assert.equal(lastInsert.deal_amount, 450000);
});

test('insertOutcome: trims whitespace from claude_fact', async () => {
  const mod = loadFresh();
  await mod.insertOutcome({
    closed_at: '2026-01-01',
    claude_fact: '  trimmed  ',
  });
  assert.equal(lastInsert.claude_fact, 'trimmed');
});

test('insertOutcome: surfaces Supabase errors', async () => {
  nextInsertError = 'FK violation on prospect_id';
  const mod = loadFresh();
  await assert.rejects(
    () => mod.insertOutcome({ closed_at: '2026-01-01', claude_fact: 'ok' }),
    /insertOutcome failed: FK violation/,
  );
});
