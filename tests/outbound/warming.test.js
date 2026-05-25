// Warming — daily cap schedule, start_date lazy-init, budget arithmetic.
// Mocks the supabase client by pre-populating require.cache for ./lib/supabase
// before lib/warming.js is loaded.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

// ── Mock harness ─────────────────────────────────────────────────────────

let mockConfig = {};        // { key: value }
let postsCountByDay = 0;    // simulated count of posts published today
let lastWrittenKey = null;

function freshSupabaseStub() {
  // Track query state across the chain.
  let opState = null;

  return {
    from(table) {
      if (table === 'app_config') {
        return {
          select() {
            opState = { table, op: 'select', filters: {} };
            return this;
          },
          eq(col, val) {
            opState.filters[col] = val;
            return this;
          },
          maybeSingle() {
            const k = opState.filters.key;
            const v = mockConfig[k];
            return Promise.resolve({ data: v === undefined ? null : { value: v }, error: null });
          },
          upsert(row) {
            lastWrittenKey = row.key;
            mockConfig[row.key] = row.value;
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'posts') {
        return {
          select(_cols, opts) {
            opState = { table, op: 'select', head: opts && opts.head, count: opts && opts.count, filters: {} };
            return this;
          },
          eq(col, val) {
            opState.filters[col] = val;
            return this;
          },
          gte() { return this; },
          then(resolve) {
            return Promise.resolve({ count: postsCountByDay, error: null }).then(resolve);
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

function reloadWarming() {
  const supabasePath = require.resolve('../../lib/supabase');
  const warmingPath = require.resolve('../../lib/warming');
  // Stub supabase before warming loads it.
  require.cache[supabasePath] = {
    id: supabasePath,
    filename: supabasePath,
    loaded: true,
    exports: { supabase: freshSupabaseStub() },
  };
  delete require.cache[warmingPath];
  return require('../../lib/warming');
}

beforeEach(() => {
  mockConfig = {};
  postsCountByDay = 0;
  lastWrittenKey = null;
});

// ── capForDay — pure function, the heart of the schedule ─────────────────

test('capForDay: day 0 → 10', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(0), 10);
});

test('capForDay: day 2 (last day of band 1) → 10', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(2), 10);
});

test('capForDay: day 3 → 25', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(3), 25);
});

test('capForDay: day 7 → 50', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(7), 50);
});

test('capForDay: day 14 → 100', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(14), 100);
});

test('capForDay: day 21 → 200', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(21), 200);
});

test('capForDay: day 30 → steady cap (default 300)', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(30), 300);
});

test('capForDay: day 999 → steady cap', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(999), 300);
});

test('capForDay: steady cap override respected at day 30+', () => {
  const { capForDay } = reloadWarming();
  assert.equal(capForDay(30, 500), 500);
  assert.equal(capForDay(45, 500), 500);
});

test('capForDay: schedule unaffected by steady cap override before day 30', () => {
  const { capForDay } = reloadWarming();
  // The override only matters after day 29.
  assert.equal(capForDay(5, 999), 25);
});

// ── getCurrentCap — sets start_date lazily on first call ────────────────

test('getCurrentCap: missing start_date is initialised to today and cap=10', async () => {
  const { getCurrentCap } = reloadWarming();
  const r = await getCurrentCap('lender');
  assert.equal(r.cap, 10);
  assert.equal(r.day, 0);
  assert.equal(lastWrittenKey, 'outbound.warming.lender.start_date');
  // The written value should be today's ISO date string.
  assert.match(mockConfig['outbound.warming.lender.start_date'], /^\d{4}-\d{2}-\d{2}$/);
});

test('getCurrentCap: existing 5-day-old start_date → cap=25', async () => {
  const { getCurrentCap } = reloadWarming();
  const five_days_ago = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  mockConfig['outbound.warming.lender.start_date'] = five_days_ago;
  const r = await getCurrentCap('lender');
  assert.equal(r.cap, 25);
  assert.equal(r.day, 5);
});

test('getCurrentCap: rejects unknown track', async () => {
  const { getCurrentCap } = reloadWarming();
  await assert.rejects(() => getCurrentCap('unknown_track'), /Invalid track/);
});

// ── getRemainingBudget ──────────────────────────────────────────────────

test('getRemainingBudget: day 0, 0 sent → remaining 10', async () => {
  const { getRemainingBudget } = reloadWarming();
  postsCountByDay = 0;
  const r = await getRemainingBudget('lender');
  assert.equal(r.cap, 10);
  assert.equal(r.sentToday, 0);
  assert.equal(r.remaining, 10);
});

test('getRemainingBudget: day 0, 7 sent → remaining 3', async () => {
  const { getRemainingBudget } = reloadWarming();
  postsCountByDay = 7;
  const r = await getRemainingBudget('lender');
  assert.equal(r.remaining, 3);
});

test('getRemainingBudget: day 0, 15 sent (over cap) → remaining 0, never negative', async () => {
  const { getRemainingBudget } = reloadWarming();
  postsCountByDay = 15;
  const r = await getRemainingBudget('lender');
  assert.equal(r.remaining, 0);
  assert.equal(r.sentToday, 15);
  assert.equal(r.cap, 10);
});

// ── pause / resume ──────────────────────────────────────────────────────

test('pauseTrack + isPaused round-trip', async () => {
  const { pauseTrack, isPaused, resumeTrack } = reloadWarming();
  assert.equal(await isPaused('lender'), false);
  await pauseTrack('lender');
  assert.equal(await isPaused('lender'), true);
  await resumeTrack('lender');
  assert.equal(await isPaused('lender'), false);
});

test('pauseTrack rejects unknown track', async () => {
  const { pauseTrack } = reloadWarming();
  await assert.rejects(() => pauseTrack('zzz'), /Invalid track/);
});
