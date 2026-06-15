// lib/runtime-config.js — getBoostConfig (paid-ad spend levers).
// Mocks @supabase/supabase-js via require.cache (runtime-config builds its
// own client), same pattern as runtime-config-durations.test.js.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const RUNTIME_CFG_PATH = require.resolve('../lib/runtime-config');
const SUPABASE_SDK_PATH = require.resolve('@supabase/supabase-js');

let mockRows; // { 'brand/key': value }

function makeMockClient() {
  return {
    from: () => ({
      select: () => ({
        eq: (c1, brand) => ({
          eq: (c2, key) => ({
            maybeSingle: async () => {
              const v = mockRows[`${brand}/${key}`];
              return { data: v === undefined ? null : { value: v }, error: null };
            },
          }),
        }),
      }),
      upsert: async () => ({ error: null }),
      delete: () => ({ eq: () => ({ eq: async () => ({ error: null }) }) }),
    }),
  };
}

function loadFresh() {
  delete require.cache[RUNTIME_CFG_PATH];
  delete require.cache[SUPABASE_SDK_PATH];
  require.cache[SUPABASE_SDK_PATH] = {
    id: SUPABASE_SDK_PATH, filename: SUPABASE_SDK_PATH, loaded: true,
    exports: { createClient: () => makeMockClient() },
  };
  return require('../lib/runtime-config');
}

beforeEach(() => { mockRows = {}; });

test('defaults: disabled, £2/day, £50 cap', async () => {
  const rc = loadFresh();
  assert.deepEqual(await rc.getBoostConfig(), { enabled: false, dailyBudgetPence: 200, spendCapPence: 5000 });
});

test('enabled is strict — only a literal true switches spend on', async () => {
  // Fresh module per value so the 30s readRaw cache never masks a change.
  for (const v of ['true', 1, 'on', 'yes']) {
    mockRows = { 'global/boost.enabled': v };
    const rc = loadFresh();
    assert.equal((await rc.getBoostConfig()).enabled, false, `value ${JSON.stringify(v)} must NOT enable`);
  }
  mockRows = { 'global/boost.enabled': true };
  const rc = loadFresh();
  assert.equal((await rc.getBoostConfig()).enabled, true);
});

test('budget + cap clamp to safe bounds', async () => {
  let rc = loadFresh();
  mockRows['global/boost.daily_budget_pence'] = 999999;
  mockRows['global/boost.spend_cap_pence'] = 999999;
  let cfg = await rc.getBoostConfig();
  assert.equal(cfg.dailyBudgetPence, 2000);   // £20/day ceiling
  assert.equal(cfg.spendCapPence, 100000);    // £1000 ceiling

  rc = loadFresh();
  mockRows['global/boost.daily_budget_pence'] = 1;   // below £0.50 floor
  mockRows['global/boost.spend_cap_pence'] = 1;      // below £1 floor
  cfg = await rc.getBoostConfig();
  assert.equal(cfg.dailyBudgetPence, 50);
  assert.equal(cfg.spendCapPence, 100);
});

test('garbage values fall back to defaults', async () => {
  const rc = loadFresh();
  mockRows['global/boost.daily_budget_pence'] = 'lots';
  mockRows['global/boost.spend_cap_pence'] = null;
  const cfg = await rc.getBoostConfig();
  assert.equal(cfg.dailyBudgetPence, 200);
  assert.equal(cfg.spendCapPence, 5000);
});
