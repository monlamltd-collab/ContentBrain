// Phase G-4 — coverage for the freshly-flipped breakout helpers.
//
// isBreakoutActive + getBreakoutTags graduated from PR2 stubs (return
// false / []) to live readers of posts.meta.breakout_score. Mocks
// lib/supabase to assert the dedupe + filter logic.
//
// Cases:
//   isBreakoutActive:
//     - no candidates → false
//     - candidate with score < threshold → false
//     - candidate in traffic mode → false (only monet amplifies)
//     - candidate missing niche_tag → false
//     - candidate eligible BUT niche already re-featured → false (dedupe)
//     - eligible candidate, no re-feature → true
//
//   getBreakoutTags:
//     - no eligible candidates → []
//     - one eligible monet candidate → 1 row with weight_multiplier=2.0
//     - re-featured niche is excluded
//     - score must be >= BREAKOUT_THRESHOLD (2.5)

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const HELPERS_PATH = require.resolve('../../lib/social-engine/helpers');
const SUPABASE_PATH = require.resolve('../../lib/supabase');

let fixture;

function freshFixture() {
  fixture = { posts: [] };
}

// Minimal fake supabase. Supports the operators isBreakoutActive +
// getBreakoutTags use: eq, gte, gt, not('meta->>...', 'is', null), limit.
// Filters on 'meta->>X' route through row.meta[X].

function _resolveCol(row, col) {
  const m = col.match(/^meta->>(.+)$/);
  if (m) return row.meta && row.meta[m[1]];
  return row[col];
}

function makeQuery(table) {
  const state = { table, filters: [], notFilter: null, limitN: null };
  const match = (row) => {
    for (const f of state.filters) {
      const val = _resolveCol(row, f.col);
      if (f.op === 'eq' && val !== f.val) return false;
      if (f.op === 'gte' && !(val >= f.val)) return false;
      if (f.op === 'gt' && !(val > f.val)) return false;
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
    gte(col, val) { state.filters.push({ op: 'gte', col, val }); return api; },
    gt(col, val) { state.filters.push({ op: 'gt', col, val }); return api; },
    not(col, op, val) { state.notFilter = { col, op, val }; return api; },
    limit(n) { state.limitN = n; return api; },
    then(resolve) {
      let rows = (fixture[state.table] || []).filter(match);
      if (state.limitN != null) rows = rows.slice(0, state.limitN);
      return resolve({ data: rows, error: null });
    },
  };
  return api;
}

function loadFresh() {
  delete require.cache[HELPERS_PATH];
  delete require.cache[SUPABASE_PATH];
  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH,
    filename: SUPABASE_PATH,
    loaded: true,
    exports: { supabase: { from: (table) => makeQuery(table) } },
  };
  return require('../../lib/social-engine/helpers');
}

beforeEach(() => { freshFixture(); });

// ── isBreakoutActive ──────────────────────────────────────────────────────

test('isBreakoutActive: no candidates → false', async () => {
  const { isBreakoutActive } = loadFresh();
  assert.equal(await isBreakoutActive(), false);
});

test('isBreakoutActive: candidate with score < threshold → false', async () => {
  fixture.posts.push({
    id: 'p1', track: 'social', published_at: new Date().toISOString(),
    meta: { breakout_score: 1.2, social_mode: 'monet', niche_tag: 'wales' },
  });
  const { isBreakoutActive } = loadFresh();
  assert.equal(await isBreakoutActive(), false);
});

test('isBreakoutActive: candidate in traffic mode → false (only monet amplifies)', async () => {
  fixture.posts.push({
    id: 'p1', track: 'social', published_at: new Date().toISOString(),
    meta: { breakout_score: 3.5, social_mode: 'traffic', niche_tag: 'wales' },
  });
  const { isBreakoutActive } = loadFresh();
  assert.equal(await isBreakoutActive(), false);
});

test('isBreakoutActive: candidate missing niche_tag → false', async () => {
  fixture.posts.push({
    id: 'p1', track: 'social', published_at: new Date().toISOString(),
    meta: { breakout_score: 3.5, social_mode: 'monet' },
  });
  const { isBreakoutActive } = loadFresh();
  assert.equal(await isBreakoutActive(), false);
});

test('isBreakoutActive: niche already re-featured after breakout → false (dedupe)', async () => {
  const now = Date.now();
  const breakoutAt = new Date(now - 20 * 60 * 60 * 1000).toISOString();
  const afterAt = new Date(now - 5 * 60 * 60 * 1000).toISOString();
  fixture.posts.push({
    id: 'breakout', track: 'social', published_at: breakoutAt,
    meta: { breakout_score: 3.5, social_mode: 'monet', niche_tag: 'wales' },
  });
  // A subsequent post on the same niche → amplification already happened.
  fixture.posts.push({
    id: 'follow-up', track: 'social', published_at: afterAt,
    meta: { social_mode: 'monet', niche_tag: 'wales' },
  });
  const { isBreakoutActive } = loadFresh();
  assert.equal(await isBreakoutActive(), false);
});

test('isBreakoutActive: eligible candidate with no re-feature → true', async () => {
  const breakoutAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  fixture.posts.push({
    id: 'breakout', track: 'social', published_at: breakoutAt,
    meta: { breakout_score: 3.5, social_mode: 'monet', niche_tag: 'wales' },
  });
  const { isBreakoutActive } = loadFresh();
  assert.equal(await isBreakoutActive(), true);
});

// ── getBreakoutTags ───────────────────────────────────────────────────────

test('getBreakoutTags: no eligible candidates → []', async () => {
  const { getBreakoutTags } = loadFresh();
  assert.deepEqual(await getBreakoutTags(), []);
});

test('getBreakoutTags: one eligible monet candidate → 1 row with weight_multiplier=2.0', async () => {
  const breakoutAt = new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString();
  fixture.posts.push({
    id: 'breakout', track: 'social', published_at: breakoutAt,
    template_type: 'niche-hook',
    meta: { breakout_score: 2.8, social_mode: 'monet', niche_tag: 'wales' },
  });
  const { getBreakoutTags } = loadFresh();
  const tags = await getBreakoutTags();
  assert.equal(tags.length, 1);
  assert.equal(tags[0].type, 'niche-hook');
  assert.equal(tags[0].niche_tag, 'wales');
  assert.equal(tags[0].weight_multiplier, 2.0);
});

test('getBreakoutTags: re-featured niche is excluded', async () => {
  const now = Date.now();
  fixture.posts.push({
    id: 'breakout', track: 'social',
    published_at: new Date(now - 20 * 60 * 60 * 1000).toISOString(),
    template_type: 'niche-hook',
    meta: { breakout_score: 2.8, social_mode: 'monet', niche_tag: 'wales' },
  });
  fixture.posts.push({
    id: 'follow', track: 'social',
    published_at: new Date(now - 5 * 60 * 60 * 1000).toISOString(),
    template_type: 'niche-hook',
    meta: { social_mode: 'monet', niche_tag: 'wales' },
  });
  const { getBreakoutTags } = loadFresh();
  assert.deepEqual(await getBreakoutTags(), []);
});

test('getBreakoutTags: score must be >= BREAKOUT_THRESHOLD (2.5)', async () => {
  fixture.posts.push({
    id: 'low-score', track: 'social',
    published_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString(),
    template_type: 'niche-hook',
    meta: { breakout_score: 2.49, social_mode: 'monet', niche_tag: 'wales' },
  });
  const { getBreakoutTags } = loadFresh();
  assert.deepEqual(await getBreakoutTags(), []);
});
