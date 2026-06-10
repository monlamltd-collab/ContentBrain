// Suppression — exact email match, domain match, cache TTL, miss returns false.
// We mock the Supabase client by pre-populating require.cache for ./lib/supabase
// before lib/suppression.js is loaded.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── Mock harness ─────────────────────────────────────────────────────────
// Reset cached suppression rows, swap a fresh supabase stub, reload the
// suppression module so its `cache` module-scoped variable starts clean.

let mockRows = [];
let selectCallCount = 0;
let lastInsert = null;
let raceMode = false; // when true, insert returns code 23505 (race condition)

function freshSupabaseStub() {
  return {
    from(table) {
      if (table === 'suppression') {
        return {
          select() {
            selectCallCount++;
            return Promise.resolve({ data: mockRows.slice(), error: null });
          },
          insert(row) {
            if (raceMode) {
              return Promise.resolve({ error: { code: '23505', message: 'duplicate key' } });
            }
            lastInsert = row;
            mockRows.push(row);
            return Promise.resolve({ error: null });
          },
          // .eq().maybeSingle() chain for addSuppression read-first
          eq() {
            return {
              maybeSingle: () => {
                const key = mockRows.find(r => r.email_or_domain === lastEqKey);
                return Promise.resolve({ data: key || null, error: null });
              },
            };
          },
        };
      }
      throw new Error(`suppression.test: unexpected table ${table}`);
    },
  };
}

let lastEqKey = null;
let leverEnabled = true; // mocked runtime-config isSuppressionCheckEnabled

function loadSuppressionFresh() {
  // Wipe both modules from cache so the suppression module re-initialises with
  // a fresh cache state and our latest stub.
  const supPath = require.resolve('../../lib/supabase');
  const runtimeCfgPath = require.resolve('../../lib/runtime-config');
  const suppressionPath = require.resolve('../../lib/suppression');
  delete require.cache[supPath];
  delete require.cache[runtimeCfgPath];
  delete require.cache[suppressionPath];

  require.cache[supPath] = {
    id: supPath,
    filename: supPath,
    loaded: true,
    exports: { supabase: freshSupabaseStub() },
  };

  // Mock the lever read (lazy-required inside isSuppressed)
  require.cache[runtimeCfgPath] = {
    id: runtimeCfgPath,
    filename: runtimeCfgPath,
    loaded: true,
    exports: { isSuppressionCheckEnabled: async () => leverEnabled },
  };

  return require('../../lib/suppression');
}

beforeEach(() => {
  mockRows = [];
  selectCallCount = 0;
  lastInsert = null;
  raceMode = false;
  lastEqKey = null;
  leverEnabled = true;
});

// ── Exact email match ────────────────────────────────────────────────────

test('isSuppressed: returns true on exact email match', async () => {
  mockRows = [{ email_or_domain: 'noisy@x.co', reason: 'manual' }];
  const sup = loadSuppressionFresh();
  const res = await sup.isSuppressed('noisy@x.co');
  assert.equal(res.suppressed, true);
  assert.equal(res.level, 'address');
  assert.equal(res.reason, 'manual');
});

test('isSuppressed: exact email match is case-insensitive', async () => {
  mockRows = [{ email_or_domain: 'noisy@x.co', reason: 'manual' }];
  const sup = loadSuppressionFresh();
  const res = await sup.isSuppressed('NOISY@X.CO');
  assert.equal(res.suppressed, true);
  assert.equal(res.level, 'address');
});

// ── Domain match ─────────────────────────────────────────────────────────

test('isSuppressed: returns true when domain on block list (someone@acme.com vs acme.com)', async () => {
  mockRows = [{ email_or_domain: 'acme.com', reason: 'complaint' }];
  const sup = loadSuppressionFresh();
  const res = await sup.isSuppressed('someone@acme.com');
  assert.equal(res.suppressed, true);
  assert.equal(res.level, 'domain');
  assert.equal(res.match, 'acme.com');
  assert.equal(res.reason, 'complaint');
});

test('isSuppressed: domain match works case-insensitively', async () => {
  mockRows = [{ email_or_domain: 'ACME.COM', reason: 'complaint' }];
  const sup = loadSuppressionFresh();
  const res = await sup.isSuppressed('Someone@Acme.com');
  assert.equal(res.suppressed, true);
});

test('isSuppressed: address-level match wins over domain-level when both present', async () => {
  mockRows = [
    { email_or_domain: 'specific@acme.com', reason: 'bounce' },
    { email_or_domain: 'acme.com',          reason: 'complaint' },
  ];
  const sup = loadSuppressionFresh();
  const res = await sup.isSuppressed('specific@acme.com');
  assert.equal(res.suppressed, true);
  assert.equal(res.level, 'address');
  assert.equal(res.reason, 'bounce');
});

// ── Miss ─────────────────────────────────────────────────────────────────

test('isSuppressed: miss returns suppressed:false', async () => {
  mockRows = [{ email_or_domain: 'other@x.co', reason: 'manual' }];
  const sup = loadSuppressionFresh();
  const res = await sup.isSuppressed('safe@elsewhere.co.uk');
  assert.equal(res.suppressed, false);
  assert.equal(res.match, null);
  assert.equal(res.reason, null);
  assert.equal(res.level, null);
});

test('isSuppressed: empty / null / non-string input is a miss (not an error)', async () => {
  const sup = loadSuppressionFresh();
  assert.equal((await sup.isSuppressed('')).suppressed, false);
  assert.equal((await sup.isSuppressed(null)).suppressed, false);
  assert.equal((await sup.isSuppressed(undefined)).suppressed, false);
  assert.equal((await sup.isSuppressed(12345)).suppressed, false);
});

// ── Cache behaviour ──────────────────────────────────────────────────────

test('isSuppressed: cache prevents repeated Supabase reads within TTL', async () => {
  mockRows = [{ email_or_domain: 'a@x.co', reason: 'manual' }];
  const sup = loadSuppressionFresh();
  await sup.isSuppressed('a@x.co');
  await sup.isSuppressed('b@y.co');
  await sup.isSuppressed('c@z.co');
  assert.equal(selectCallCount, 1, 'expected exactly one cache load for three calls');
});

test('invalidateCache: forces the next call to refetch', async () => {
  mockRows = [{ email_or_domain: 'a@x.co', reason: 'manual' }];
  const sup = loadSuppressionFresh();
  await sup.isSuppressed('a@x.co');
  sup.invalidateCache();
  // Simulate a new bounce added between calls
  mockRows.push({ email_or_domain: 'b@y.co', reason: 'bounce' });
  const res = await sup.isSuppressed('b@y.co');
  assert.equal(res.suppressed, true, 'expected invalidated cache to pick up new row');
  assert.equal(selectCallCount, 2, 'expected two select calls (one cold, one after invalidate)');
});

test('isSuppressed: cache expires after TTL window', async () => {
  mockRows = [{ email_or_domain: 'a@x.co', reason: 'manual' }];
  const sup = loadSuppressionFresh();

  // Use fake time. node:test has t.mock.timers but we need module-scope time.
  // Easiest: monkey-patch Date.now temporarily.
  const realNow = Date.now;
  let fakeNow = realNow();
  Date.now = () => fakeNow;
  try {
    await sup.isSuppressed('a@x.co');
    fakeNow += (5 * 60 * 1000) + 1; // jump past the 5-min TTL
    await sup.isSuppressed('a@x.co');
    assert.equal(selectCallCount, 2, 'expected cache to expire after TTL and refetch');
  } finally {
    Date.now = realNow;
  }
});

// ── Dashboard lever read-side gate ───────────────────────────────────────

test('lever disabled: suppressed contact passes with disabled flag', async () => {
  mockRows = [{ email_or_domain: 'blocked@x.co', reason: 'manual' }];
  leverEnabled = false;
  const { isSuppressed } = loadSuppressionFresh();
  const r = await isSuppressed('blocked@x.co');
  assert.equal(r.suppressed, false);
  assert.equal(r.disabled, true, 'result must carry disabled:true so callers can log it');
});

test('lever enabled (default): suppressed contact blocks normally', async () => {
  mockRows = [{ email_or_domain: 'blocked@x.co', reason: 'manual' }];
  leverEnabled = true;
  const { isSuppressed } = loadSuppressionFresh();
  const r = await isSuppressed('blocked@x.co');
  assert.equal(r.suppressed, true);
  assert.equal(r.level, 'address');
});

test('lever read throwing: treated as enabled (fail safe)', async () => {
  mockRows = [{ email_or_domain: 'blocked@x.co', reason: 'bounce' }];
  const runtimeCfgPath = require.resolve('../../lib/runtime-config');
  const { isSuppressed } = (() => {
    const mod = loadSuppressionFresh();
    // Swap the lever mock for a throwing one AFTER load (lazy require re-reads cache)
    require.cache[runtimeCfgPath].exports = {
      isSuppressionCheckEnabled: async () => { throw new Error('config down'); },
    };
    return mod;
  })();
  const r = await isSuppressed('blocked@x.co');
  assert.equal(r.suppressed, true, 'config outage must NOT skip suppression');
});
