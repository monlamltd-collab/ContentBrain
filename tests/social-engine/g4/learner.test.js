// Phase G-4 — breakout learner coverage.
//
// Mocks lib/supabase + lib/social-engine/telegram-throttle via require.cache
// injection. Two surfaces under test:
//
//   computeBreakoutScore (pure):
//     - n < 5 baseline → returns {score: null, baseline_n: n, baseline_mean: null, baseline_stddev: null}
//     - stddev = 0 → returns {score: null, baseline_n: n, baseline_mean: <mean>, baseline_stddev: 0}
//     - normal case → returns Z value
//     - candidate engagements missing → treated as 0
//     - non-numeric baseline values → treated as 0
//
//   runBreakoutLearner (I/O):
//     - no candidates → silent return, zero counters
//     - candidate with sub-threshold score → meta written, no detected_at, no alert
//     - candidate crossing BREAKOUT_THRESHOLD (Z >= 2.5) → detected_at set, NO alert (sub-3.0)
//     - candidate crossing BREAKOUT_ALERT_THRESHOLD (Z >= 3.0) → detected_at set + alertOnce fires
//     - idempotency: re-run on a post with breakout_detected_at already set → no second alert
//     - candidate missing post_metrics → skipped silently

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const LEARNER_PATH = require.resolve('../../../lib/social-engine/learner');
const SUPABASE_PATH = require.resolve('../../../lib/supabase');
const THROTTLE_PATH = require.resolve('../../../lib/social-engine/telegram-throttle');

let fixture; // { posts: [...], post_metrics: [...] }
let updates; // captured posts.update payloads
let alertOnceCalls;

function freshFixture() {
  fixture = { posts: [], post_metrics: [] };
  updates = [];
  alertOnceCalls = [];
}

// ── Fake supabase ─────────────────────────────────────────────────────────

function makeQuery(table) {
  const state = {
    table,
    filters: [],
    orderBy: null,
    limitN: null,
    isUpdate: null,
    notFilter: null,
  };
  const matchRow = (row) => {
    for (const f of state.filters) {
      if (f.op === 'eq') {
        const val = _resolveCol(row, f.col);
        if (val !== f.val) return false;
      }
      if (f.op === 'neq') {
        const val = _resolveCol(row, f.col);
        if (val === f.val) return false;
      }
      if (f.op === 'gte') {
        const val = _resolveCol(row, f.col);
        if (!(val >= f.val)) return false;
      }
      if (f.op === 'gt') {
        const val = _resolveCol(row, f.col);
        if (!(val > f.val)) return false;
      }
      if (f.op === 'lte') {
        const val = _resolveCol(row, f.col);
        if (!(val <= f.val)) return false;
      }
      if (f.op === 'lt') {
        const val = _resolveCol(row, f.col);
        if (!(val < f.val)) return false;
      }
    }
    if (state.notFilter) {
      const val = _resolveCol(row, state.notFilter.col);
      if (state.notFilter.op === 'is' && state.notFilter.val === null) {
        if (val == null) return false;
      }
    }
    return true;
  };
  const api = {
    select() { return api; },
    eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
    neq(col, val) { state.filters.push({ op: 'neq', col, val }); return api; },
    gte(col, val) { state.filters.push({ op: 'gte', col, val }); return api; },
    gt(col, val) { state.filters.push({ op: 'gt', col, val }); return api; },
    lte(col, val) { state.filters.push({ op: 'lte', col, val }); return api; },
    lt(col, val) { state.filters.push({ op: 'lt', col, val }); return api; },
    not(col, op, val) { state.notFilter = { col, op, val }; return api; },
    order(col, opts) { state.orderBy = { col, opts }; return api; },
    limit(n) { state.limitN = n; return api; },
    update(payload) { state.isUpdate = payload; return api; },
    then(resolve) {
      if (state.isUpdate) {
        // Apply update in-place to matching rows in the fixture.
        const rows = (fixture[state.table] || []);
        let touched = 0;
        for (const row of rows) {
          if (matchRow(row)) {
            updates.push({ table: state.table, id: row.id, payload: state.isUpdate });
            Object.assign(row, state.isUpdate);
            touched += 1;
          }
        }
        return resolve({ data: null, error: null, count: touched });
      }
      let rows = (fixture[state.table] || []).filter(matchRow);
      if (state.orderBy) {
        rows = rows.slice().sort((a, b) => {
          const ac = a[state.orderBy.col];
          const bc = b[state.orderBy.col];
          const asc = state.orderBy.opts && state.orderBy.opts.ascending !== false;
          if (ac === bc) return 0;
          return asc ? (ac > bc ? 1 : -1) : (ac > bc ? -1 : 1);
        });
      }
      if (state.limitN != null) rows = rows.slice(0, state.limitN);
      return resolve({ data: rows, error: null });
    },
  };
  return api;
}

function _resolveCol(row, col) {
  // Supports plain column lookup. We don't use jsonb path filters in the
  // learner — only top-level columns + meta.<key> via post-fetch JS filters.
  return row[col];
}

function makeFakeSupabase() {
  return { from: (table) => makeQuery(table) };
}

// ── Loader ────────────────────────────────────────────────────────────────

function loadFresh() {
  delete require.cache[LEARNER_PATH];
  delete require.cache[SUPABASE_PATH];
  delete require.cache[THROTTLE_PATH];

  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH,
    filename: SUPABASE_PATH,
    loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };

  require.cache[THROTTLE_PATH] = {
    id: THROTTLE_PATH,
    filename: THROTTLE_PATH,
    loaded: true,
    exports: {
      alertOnce: async (eventType, identityKey, messageFn) => {
        alertOnceCalls.push({ eventType, identityKey, message: messageFn() });
        return { fired: true };
      },
      alertThrottled: async () => ({ fired: true, count: 1 }),
      ONCE_TTL_MS: 86400000,
      WINDOW_MS: 300000,
      MAX_ALERTS_PER_WINDOW: 3,
      _resetForTests: () => {},
    },
  };

  return require('../../../lib/social-engine/learner');
}

beforeEach(() => { freshFixture(); });
afterEach(() => { /* nothing to tear down */ });

// ── computeBreakoutScore (pure) ───────────────────────────────────────────

test('computeBreakoutScore: n < 5 → score: null', () => {
  const { computeBreakoutScore } = loadFresh();
  const out = computeBreakoutScore({ engagements: 50 }, [
    { engagements: 10 }, { engagements: 12 }, { engagements: 11 }, { engagements: 9 },
  ]);
  assert.equal(out.score, null);
  assert.equal(out.baseline_n, 4);
  assert.equal(out.baseline_mean, null);
  assert.equal(out.baseline_stddev, null);
});

test('computeBreakoutScore: stddev = 0 → score: null, baseline_stddev: 0', () => {
  const { computeBreakoutScore } = loadFresh();
  const out = computeBreakoutScore({ engagements: 50 }, [
    { engagements: 10 }, { engagements: 10 }, { engagements: 10 },
    { engagements: 10 }, { engagements: 10 }, { engagements: 10 },
  ]);
  assert.equal(out.score, null);
  assert.equal(out.baseline_n, 6);
  assert.equal(out.baseline_mean, 10);
  assert.equal(out.baseline_stddev, 0);
});

test('computeBreakoutScore: normal case returns a Z value', () => {
  const { computeBreakoutScore } = loadFresh();
  // baseline mean=10, stddev=sqrt(((-2)^2+(-1)^2+0^2+1^2+2^2)/5)=sqrt(2)≈1.414
  // candidate engagement=20 → Z = (20-10)/1.414 ≈ 7.07
  const out = computeBreakoutScore({ engagements: 20 }, [
    { engagements: 8 }, { engagements: 9 }, { engagements: 10 },
    { engagements: 11 }, { engagements: 12 },
  ]);
  assert.equal(out.baseline_n, 5);
  assert.equal(out.baseline_mean, 10);
  assert.ok(Math.abs(out.baseline_stddev - Math.sqrt(2)) < 1e-9);
  assert.ok(Math.abs(out.score - 10 / Math.sqrt(2)) < 1e-9);
});

test('computeBreakoutScore: missing post.engagements treated as 0', () => {
  const { computeBreakoutScore } = loadFresh();
  const out = computeBreakoutScore({}, [
    { engagements: 8 }, { engagements: 9 }, { engagements: 10 },
    { engagements: 11 }, { engagements: 12 },
  ]);
  // (0 - 10) / sqrt(2) ≈ -7.07
  assert.ok(out.score < 0);
  assert.equal(out.baseline_n, 5);
});

test('computeBreakoutScore: non-numeric baseline values treated as 0', () => {
  const { computeBreakoutScore } = loadFresh();
  const out = computeBreakoutScore({ engagements: 5 }, [
    { engagements: 'banana' }, { engagements: null }, { engagements: undefined },
    { engagements: 0 }, { engagements: 0 },
  ]);
  // All baseline coerce to 0, stddev = 0 → score: null
  assert.equal(out.score, null);
  assert.equal(out.baseline_stddev, 0);
});

// ── runBreakoutLearner (I/O) ──────────────────────────────────────────────

test('runBreakoutLearner: no candidates → silent return, zero counters', async () => {
  const { runBreakoutLearner } = loadFresh();
  const r = await runBreakoutLearner();
  assert.deepEqual(r, { scanned: 0, scored: 0, breakouts: 0, alerted: 0 });
  assert.equal(updates.length, 0);
  assert.equal(alertOnceCalls.length, 0);
});

test('runBreakoutLearner: sub-threshold score → meta written, no detected_at, no alert', async () => {
  const { runBreakoutLearner } = loadFresh();
  const now = Date.now();
  const candIso = new Date(now - 2 * 86400000).toISOString();
  const baseIso = new Date(now - 5 * 86400000).toISOString();

  // Candidate post with mode=monet
  fixture.posts.push({
    id: 'cand-1', track: 'social', brand: 'auctionbrain', published_at: candIso,
    template_type: 'niche-hook', meta: { social_mode: 'monet', niche_tag: 'wales' },
  });
  // 5 baseline posts in the 14d window before the candidate.
  for (let i = 0; i < 5; i += 1) {
    fixture.posts.push({
      id: `base-${i}`, track: 'social', brand: 'auctionbrain',
      published_at: baseIso, template_type: 'niche-hook',
      meta: { social_mode: 'monet', niche_tag: 'wales' },
    });
    fixture.post_metrics.push({ post_id: `base-${i}`, engagements: 10 + i, fetched_at: baseIso });
  }
  // Candidate's engagement = 13 → Z ≈ (13-12)/sqrt(2) ≈ 0.71 → below 2.5.
  fixture.post_metrics.push({ post_id: 'cand-1', engagements: 13, fetched_at: candIso });

  const r = await runBreakoutLearner();
  // Every post in the candidate window is scanned. Baselines also have
  // mode=monet so they're scanned too; most score null (not enough peers).
  assert.equal(r.scanned, 6);
  assert.equal(r.breakouts, 0);
  assert.equal(r.alerted, 0);
  // Cand-1 specifically: meta written with score, no detected_at.
  const candUpdate = updates.find((u) => u.id === 'cand-1');
  assert.ok(candUpdate, 'cand-1 meta should be written');
  const written = candUpdate.payload.meta;
  assert.ok(written.breakout_score != null, 'breakout_score should be written');
  assert.ok(written.breakout_score < 2.5, 'score should be sub-threshold');
  assert.ok(!written.breakout_detected_at, 'breakout_detected_at should NOT be set');
  assert.equal(alertOnceCalls.length, 0);
});

test('runBreakoutLearner: Z crosses BREAKOUT_THRESHOLD (>=2.5, <3.0) → detected_at set, no alert', async () => {
  const { runBreakoutLearner } = loadFresh();
  const now = Date.now();
  const candIso = new Date(now - 2 * 86400000).toISOString();
  const baseIso = new Date(now - 5 * 86400000).toISOString();

  fixture.posts.push({
    id: 'cand-1', track: 'social', brand: 'auctionbrain', published_at: candIso,
    template_type: 'niche-hook', meta: { social_mode: 'monet', niche_tag: 'wales' },
  });
  // Baseline 5 posts: engagements 10,10,10,10,11 → mean=10.2, stddev≈0.4
  fixture.posts.push({ id: 'b1', track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
  fixture.posts.push({ id: 'b2', track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
  fixture.posts.push({ id: 'b3', track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
  fixture.posts.push({ id: 'b4', track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
  fixture.posts.push({ id: 'b5', track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
  ['b1', 'b2', 'b3', 'b4'].forEach((id) => fixture.post_metrics.push({ post_id: id, engagements: 10, fetched_at: baseIso }));
  fixture.post_metrics.push({ post_id: 'b5', engagements: 11, fetched_at: baseIso });

  // Candidate engagement 11.3 → Z ≈ (11.3 - 10.2) / 0.4 = 2.75 (crosses 2.5, below 3.0)
  fixture.post_metrics.push({ post_id: 'cand-1', engagements: 11.3, fetched_at: candIso });

  const r = await runBreakoutLearner();
  assert.equal(r.breakouts, 1);
  assert.equal(r.alerted, 0, 'sub-3.0 Z should NOT trigger Telegram alert');
  const written = updates.find((u) => u.id === 'cand-1').payload.meta;
  assert.ok(written.breakout_score >= 2.5 && written.breakout_score < 3.0);
  assert.ok(written.breakout_detected_at, 'breakout_detected_at should be set');
  assert.equal(alertOnceCalls.length, 0);
});

test('runBreakoutLearner: Z crosses BREAKOUT_ALERT_THRESHOLD (>=3.0) → alertOnce fires', async () => {
  const { runBreakoutLearner } = loadFresh();
  const now = Date.now();
  const candIso = new Date(now - 2 * 86400000).toISOString();
  const baseIso = new Date(now - 5 * 86400000).toISOString();

  fixture.posts.push({
    id: 'cand-X', track: 'social', brand: 'auctionbrain', published_at: candIso,
    template_type: 'curiosity-gap', meta: { social_mode: 'monet', niche_tag: 'manchester' },
  });
  // Baseline: 5 posts at engagement = 10 each, with one outlier of 12.
  // mean=10.4, var=((-0.4)^2*4 + 1.6^2)/5 = (0.64 + 2.56)/5 = 0.64, stddev=0.8
  for (let i = 0; i < 4; i += 1) {
    fixture.posts.push({ id: `b${i}`, track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
    fixture.post_metrics.push({ post_id: `b${i}`, engagements: 10, fetched_at: baseIso });
  }
  fixture.posts.push({ id: 'b4', track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
  fixture.post_metrics.push({ post_id: 'b4', engagements: 12, fetched_at: baseIso });

  // Candidate engagement 13.5 → Z = (13.5 - 10.4) / 0.8 = 3.875 → fires alert.
  fixture.post_metrics.push({ post_id: 'cand-X', engagements: 13.5, fetched_at: candIso });

  const r = await runBreakoutLearner();
  assert.equal(r.breakouts, 1);
  assert.equal(r.alerted, 1);
  assert.equal(alertOnceCalls.length, 1);
  assert.equal(alertOnceCalls[0].eventType, 'breakout-detected');
  assert.equal(alertOnceCalls[0].identityKey, 'cand-X');
  assert.match(alertOnceCalls[0].message, /EXCEPTIONAL/);
  assert.match(alertOnceCalls[0].message, /manchester/);
  assert.match(alertOnceCalls[0].message, /curiosity-gap/);
});

test('runBreakoutLearner: idempotent — re-run on post with existing breakout_detected_at does NOT re-alert', async () => {
  const { runBreakoutLearner } = loadFresh();
  const now = Date.now();
  const candIso = new Date(now - 2 * 86400000).toISOString();
  const baseIso = new Date(now - 5 * 86400000).toISOString();

  fixture.posts.push({
    id: 'cand-Y', track: 'social', brand: 'auctionbrain', published_at: candIso,
    template_type: 'niche-hook',
    meta: {
      social_mode: 'monet', niche_tag: 'wales',
      breakout_detected_at: '2026-01-01T00:00:00.000Z', // already detected on a prior run
    },
  });
  for (let i = 0; i < 4; i += 1) {
    fixture.posts.push({ id: `b${i}`, track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
    fixture.post_metrics.push({ post_id: `b${i}`, engagements: 10, fetched_at: baseIso });
  }
  fixture.posts.push({ id: 'b4', track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
  fixture.post_metrics.push({ post_id: 'b4', engagements: 12, fetched_at: baseIso });
  fixture.post_metrics.push({ post_id: 'cand-Y', engagements: 13.5, fetched_at: candIso });

  const r = await runBreakoutLearner();
  assert.equal(r.breakouts, 0, 'breakouts only counts FIRST-detection');
  assert.equal(r.alerted, 0, 'no second alert for already-detected post');
  assert.equal(alertOnceCalls.length, 0);
  // Score is still re-computed and written.
  const written = updates.find((u) => u.id === 'cand-Y');
  assert.ok(written, 'meta should still be written (score refresh)');
  assert.equal(written.payload.meta.breakout_detected_at, '2026-01-01T00:00:00.000Z',
    'existing detected_at must NOT be overwritten');
});

test('runBreakoutLearner: candidate with no post_metrics row → skipped silently', async () => {
  const { runBreakoutLearner } = loadFresh();
  const now = Date.now();
  const candIso = new Date(now - 2 * 86400000).toISOString();

  fixture.posts.push({
    id: 'cand-Z', track: 'social', brand: 'auctionbrain', published_at: candIso,
    template_type: 'niche-hook', meta: { social_mode: 'monet', niche_tag: 'wales' },
  });
  // No post_metrics row for cand-Z.

  const r = await runBreakoutLearner();
  assert.equal(r.scanned, 1);
  assert.equal(r.scored, 0, 'missing metrics should not count as scored');
  assert.equal(updates.length, 0);
});

test('runBreakoutLearner: traffic-mode candidate scored but uses traffic baseline cohort', async () => {
  const { runBreakoutLearner } = loadFresh();
  const now = Date.now();
  const candIso = new Date(now - 2 * 86400000).toISOString();
  const baseIso = new Date(now - 5 * 86400000).toISOString();

  fixture.posts.push({
    id: 'tcand', track: 'social', brand: 'auctionbrain', published_at: candIso,
    template_type: 'lot-of-day-traffic', meta: { social_mode: 'traffic', niche_tag: 'wales' },
  });
  // 3 traffic baseline posts (n<5 → null score) — exercises the
  // mode-segregation: a separate cohort of 5 monet posts must NOT count
  // toward the traffic candidate's baseline.
  for (let i = 0; i < 3; i += 1) {
    fixture.posts.push({ id: `t${i}`, track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'traffic' } });
    fixture.post_metrics.push({ post_id: `t${i}`, engagements: 10, fetched_at: baseIso });
  }
  for (let i = 0; i < 5; i += 1) {
    fixture.posts.push({ id: `m${i}`, track: 'social', brand: 'auctionbrain', published_at: baseIso, meta: { social_mode: 'monet' } });
    fixture.post_metrics.push({ post_id: `m${i}`, engagements: 10, fetched_at: baseIso });
  }
  fixture.post_metrics.push({ post_id: 'tcand', engagements: 50, fetched_at: candIso });

  const r = await runBreakoutLearner();
  assert.equal(r.breakouts, 0, 'baseline_n<5 → null score → no breakout');
  // Score should be null in the written meta for the traffic candidate.
  const candUpdate = updates.find((u) => u.id === 'tcand');
  assert.ok(candUpdate, 'tcand meta should be written');
  assert.equal(candUpdate.payload.meta.breakout_score, null,
    'traffic cohort has only 3 peers → null score (mode isolation works)');
  assert.equal(candUpdate.payload.meta.breakout_baseline_n, 3);
});

test('runBreakoutLearner: candidate without social_mode is scanned but not scored', async () => {
  const { runBreakoutLearner } = loadFresh();
  const now = Date.now();
  const candIso = new Date(now - 2 * 86400000).toISOString();

  fixture.posts.push({
    id: 'cand-NoMode', track: 'social', brand: 'auctionbrain', published_at: candIso,
    template_type: 'niche-hook', meta: { niche_tag: 'wales' },
  });
  fixture.post_metrics.push({ post_id: 'cand-NoMode', engagements: 100, fetched_at: candIso });

  const r = await runBreakoutLearner();
  assert.equal(r.scanned, 1);
  assert.equal(r.scored, 0);
  assert.equal(updates.length, 0);
});
