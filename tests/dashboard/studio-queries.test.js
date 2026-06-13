// lib/dashboard/studio-queries.js — filter plumbing + meta merge.
// Mocks lib/supabase via require.cache injection (house pattern).
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SUP_PATH = require.resolve('../../lib/supabase');
const MOD_PATH = require.resolve('../../lib/dashboard/studio-queries');

let fakePosts;
let queryLog;
let updates;

function makeFakeSupabase() {
  return {
    from(table) {
      const state = { table, filters: [], updatePayload: null };
      const api = {
        select() { return api; },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
        or(expr) { state.filters.push({ op: 'or', expr }); return api; },
        order() { return api; },
        update(payload) { state.updatePayload = payload; return api; },
        single() { return api.maybeSingle(); },
        async maybeSingle() {
          queryLog.push(state);
          if (state.updatePayload) {
            updates.push({ table, payload: state.updatePayload, filters: state.filters });
            const id = state.filters.find(f => f.op === 'eq' && f.col === 'id');
            const row = (fakePosts || []).find(r => r.id === (id && id.val));
            return { data: { ...row, ...state.updatePayload }, error: null };
          }
          const id = state.filters.find(f => f.op === 'eq' && f.col === 'id');
          const row = (fakePosts || []).find(r => r.id === (id && id.val)) || null;
          return { data: row, error: null };
        },
        then(resolve) {
          queryLog.push(state);
          let rows = (fakePosts || []).slice();
          for (const f of state.filters) {
            if (f.op === 'eq') rows = rows.filter(r => r[f.col] === f.val);
            if (f.op === 'or') {
              const m = /ilike\.%(.+?)%/.exec(f.expr);
              const term = m ? m[1].toLowerCase() : '';
              rows = rows.filter(r =>
                (r.copy_headline || '').toLowerCase().includes(term) ||
                (r.copy_body || '').toLowerCase().includes(term));
            }
          }
          resolve({ data: rows, error: null });
        },
      };
      return api;
    },
  };
}

beforeEach(() => {
  fakePosts = [
    { id: 'p1', status: 'draft', brand: 'auctionbrain', template_type: 'reel', copy_headline: 'Auction surge', copy_body: 'x', meta: { keep: 1 } },
    { id: 'p2', status: 'draft', brand: 'bridgematch', template_type: 'stat', copy_headline: 'Bridging rates', copy_body: 'y', meta: null },
    { id: 'p3', status: 'approved', brand: 'auctionbrain', template_type: 'reel', copy_headline: 'Approved one', copy_body: 'z' },
  ];
  queryLog = [];
  updates = [];
  delete require.cache[SUP_PATH];
  delete require.cache[MOD_PATH];
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
});

test('getStudioPosts: drafts only, newest first query issued', async () => {
  const { getStudioPosts } = require(MOD_PATH);
  const posts = await getStudioPosts({});
  assert.equal(posts.length, 2);
  assert.ok(posts.every(p => p.status === 'draft'));
});

test('getStudioPosts: brand + type filters apply; invalid values ignored', async () => {
  const { getStudioPosts } = require(MOD_PATH);
  const brandOnly = await getStudioPosts({ brand: 'auctionbrain' });
  assert.deepEqual(brandOnly.map(p => p.id), ['p1']);
  const badBrand = await getStudioPosts({ brand: 'DROP TABLE' });
  assert.equal(badBrand.length, 2);
});

test('getStudioPosts: q searches headline/body and strips or-specials', async () => {
  const { getStudioPosts } = require(MOD_PATH);
  const hits = await getStudioPosts({ q: 'bridging' });
  assert.deepEqual(hits.map(p => p.id), ['p2']);
  // parens/commas/percent are stripped before the or-expression
  await getStudioPosts({ q: 'a,b(c)%' });
  const orFilter = queryLog.flatMap(s => s.filters).find(f => f.op === 'or' && f.expr.includes('a b c'));
  assert.ok(orFilter, 'sanitized term used in or()');
});

test('mergePostMeta: merges patch over existing meta, null deletes', async () => {
  const { mergePostMeta } = require(MOD_PATH);
  const row = await mergePostMeta('p1', { duration_seconds: 12, keep: null });
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].payload.meta, { duration_seconds: 12 });
  assert.equal(row.meta.duration_seconds, 12);
});

test('mergePostMeta: missing post throws', async () => {
  const { mergePostMeta } = require(MOD_PATH);
  await assert.rejects(() => mergePostMeta('nope', { a: 1 }), /not found/);
});

test('getMusicTracks returns a sorted array of audio filenames', () => {
  const { getMusicTracks } = require(MOD_PATH);
  const tracks = getMusicTracks();
  assert.ok(Array.isArray(tracks));
  const sorted = [...tracks].sort();
  assert.deepEqual(tracks, sorted);
});
