// runtime-config getTelegramOffset/setTelegramOffset — persistence for the
// Telegram getUpdates offset so redeploys don't re-process old updates.
//
// runtime-config.js creates its own Supabase client via createClient(), so
// we mock @supabase/supabase-js (not lib/supabase) via require.cache.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const RUNTIME_CFG_PATH = require.resolve('../lib/runtime-config');
const SUPABASE_SDK_PATH = require.resolve('@supabase/supabase-js');

let mockRows;      // { 'brand/key': value }
let upserts;       // captured upsert payloads
let readShouldError;

function makeMockClient() {
  return {
    from: () => ({
      select: () => ({
        eq: (c1, brand) => ({
          eq: (c2, key) => ({
            maybeSingle: async () => {
              if (readShouldError) return { data: null, error: { message: 'boom' } };
              const v = mockRows[`${brand}/${key}`];
              return { data: v === undefined ? null : { value: v }, error: null };
            },
          }),
        }),
      }),
      upsert: async (row) => {
        upserts.push(row);
        mockRows[`${row.brand}/${row.key}`] = row.value;
        return { error: null };
      },
      delete: () => ({
        eq: () => ({ eq: async () => ({ error: null }) }),
      }),
    }),
  };
}

function loadRuntimeConfigFresh() {
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
  upserts = [];
  readShouldError = false;
});

test('getTelegramOffset: missing row → 0', async () => {
  const rc = loadRuntimeConfigFresh();
  assert.equal(await rc.getTelegramOffset(), 0);
});

test('getTelegramOffset: read error → 0 (never throws into the poll loop)', async () => {
  readShouldError = true;
  const rc = loadRuntimeConfigFresh();
  assert.equal(await rc.getTelegramOffset(), 0);
});

test('setTelegramOffset then getTelegramOffset round-trips', async () => {
  const rc = loadRuntimeConfigFresh();
  await rc.setTelegramOffset(123456789);
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].brand, 'global');
  assert.equal(upserts[0].key, 'telegram.offset');
  assert.equal(upserts[0].value, 123456789);
  assert.equal(await rc.getTelegramOffset(), 123456789);
});

test('getTelegramOffset: non-numeric stored value → 0', async () => {
  mockRows['global/telegram.offset'] = 'garbage';
  const rc = loadRuntimeConfigFresh();
  assert.equal(await rc.getTelegramOffset(), 0);
});

test('getTelegramOffset: negative stored value → 0', async () => {
  mockRows['global/telegram.offset'] = -5;
  const rc = loadRuntimeConfigFresh();
  assert.equal(await rc.getTelegramOffset(), 0);
});
