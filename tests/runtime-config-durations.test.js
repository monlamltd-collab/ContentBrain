// lib/runtime-config.js — template_durations lever (PR2).
//
// runtime-config.js creates its own Supabase client via createClient(), so
// we mock @supabase/supabase-js (not lib/supabase) via require.cache —
// same pattern as runtime-config-offset.test.js.

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

beforeEach(() => {
  mockRows = {};
});

test('unset lever → composition-matching defaults', async () => {
  const rc = loadFresh();
  assert.deepEqual(await rc.getTemplateDurations(), { stat: 6, hook: 7, list: 8, reel: 6 });
});

test('partial lever merges over defaults', async () => {
  mockRows['global/template_durations'] = { reel: 15 };
  const rc = loadFresh();
  assert.deepEqual(await rc.getTemplateDurations(), { stat: 6, hook: 7, list: 8, reel: 15 });
});

test('values clamp to 3–90 and ignore garbage', async () => {
  mockRows['global/template_durations'] = { reel: 600, stat: 1, hook: 'soon', list: -2 };
  const rc = loadFresh();
  const out = await rc.getTemplateDurations();
  assert.equal(out.reel, 90);
  assert.equal(out.stat, 3);
  assert.equal(out.hook, 7);  // garbage → default
  assert.equal(out.list, 8);  // negative → default
});

test('non-object lever value → defaults', async () => {
  mockRows['global/template_durations'] = [12, 13];
  const rc = loadFresh();
  assert.deepEqual(await rc.getTemplateDurations(), { stat: 6, hook: 7, list: 8, reel: 6 });
});
