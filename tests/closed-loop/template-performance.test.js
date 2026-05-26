// Phase E — closed-loop/template-performance tests.
//
// Mocks lib/supabase via require.cache injection. Covers:
//   - empty case (no posts → [])
//   - happy case with 3 template_types, two above the noise floor + one below
//   - groups sorted DESC by reply_rate
//   - top_cta_pattern picked from the highest-engagement posts in the group

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SUP_PATH = require.resolve('../../lib/supabase');
const MOD_PATH = require.resolve('../../lib/closed-loop/template-performance');

let fakePosts;     // posts table mock
let fakeReplies;   // replies table mock
let queryLog;

function makeFakeSupabase() {
  return {
    from(table) {
      const state = {
        table,
        filters: [],
        countMode: false,
        head: false,
      };
      const api = {
        select(_sel, opts) {
          if (opts && opts.count === 'exact') state.countMode = true;
          if (opts && opts.head) state.head = true;
          return api;
        },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
        gte(col, val) { state.filters.push({ op: 'gte', col, val }); return api; },
        in(col, vals) { state.filters.push({ op: 'in', col, val: vals }); return api; },
        not(col, _op, _val) { state.filters.push({ op: 'not_null', col }); return api; },
        order() { return api; },
        limit() { return api; },
        ilike() { return api; },
        is() { return api; },
        async maybeSingle() {
          return { data: null, error: null };
        },
        then(resolve) {
          queryLog.push({ table, filters: state.filters.slice(), count: state.countMode });
          let rows = [];
          if (table === 'posts') rows = (fakePosts || []).slice();
          else if (table === 'replies') rows = (fakeReplies || []).slice();
          for (const f of state.filters) {
            if (f.op === 'eq') rows = rows.filter(r => r[f.col] === f.val);
            if (f.op === 'gte') rows = rows.filter(r => r[f.col] >= f.val);
            if (f.op === 'in') rows = rows.filter(r => f.val.includes(r[f.col]));
          }
          if (state.countMode) {
            resolve({ data: null, count: rows.length, error: null });
          } else {
            resolve({ data: rows, error: null });
          }
        },
      };
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
  return require('../../lib/closed-loop/template-performance');
}

beforeEach(() => {
  fakePosts = [];
  fakeReplies = [];
  queryLog = [];
});

test('getTemplatePerformance: returns [] when no posts in the window', async () => {
  const { getTemplatePerformance } = loadFresh();
  const out = await getTemplatePerformance('auctionbrain', 30);
  assert.deepEqual(out, []);
});

test('getTemplatePerformance: returns [] when brand is falsy', async () => {
  const { getTemplatePerformance } = loadFresh();
  assert.deepEqual(await getTemplatePerformance('', 30), []);
  assert.deepEqual(await getTemplatePerformance(null, 30), []);
});

test('getTemplatePerformance: excludes groups under the 5-post noise floor', async () => {
  // 3 posts of template_type 'hook' → under threshold, must NOT appear.
  // 6 posts of template_type 'stat' → over threshold, must appear.
  const now = new Date().toISOString();
  fakePosts = [];
  for (let i = 0; i < 3; i++) {
    fakePosts.push({
      id: `h${i}`, brand: 'auctionbrain', status: 'published',
      published_at: now, template_type: 'hook',
      copy_headline: `hook ${i}`, meta: {},
      post_metrics: [{ engagements: 10, clicks: 1, reach: 100 }],
    });
  }
  for (let i = 0; i < 6; i++) {
    fakePosts.push({
      id: `s${i}`, brand: 'auctionbrain', status: 'published',
      published_at: now, template_type: 'stat',
      copy_headline: `stat ${i}`, meta: {},
      post_metrics: [{ engagements: 20, clicks: 2, reach: 200 }],
    });
  }

  const { getTemplatePerformance } = loadFresh();
  const out = await getTemplatePerformance('auctionbrain', 30);

  assert.equal(out.length, 1, 'only the stat group should pass the noise floor');
  assert.equal(out[0].template_type, 'stat');
  assert.equal(out[0].posts_published, 6);
  assert.equal(out[0].total_engagement, 6 * 20);
});

test('getTemplatePerformance: three groups, sorted DESC by reply_rate', async () => {
  const now = new Date().toISOString();
  fakePosts = [];
  // Group A — 'stat' — 6 posts, low engagement
  for (let i = 0; i < 6; i++) {
    fakePosts.push({
      id: `a${i}`, brand: 'auctionbrain', status: 'published',
      published_at: now, template_type: 'stat',
      copy_headline: `stat ${i}`, meta: {},
      post_metrics: [{ engagements: 5, clicks: 1, reach: 100 }],
    });
  }
  // Group B — 'hook' — 6 posts, high engagement
  for (let i = 0; i < 6; i++) {
    fakePosts.push({
      id: `b${i}`, brand: 'auctionbrain', status: 'published',
      published_at: now, template_type: 'hook',
      copy_headline: `hook ${i}`, meta: { cta_pattern: 'browse-now' },
      post_metrics: [{ engagements: 50, clicks: 5, reach: 100 }],
    });
  }
  // Group C — 'reel' — 7 posts, medium engagement
  for (let i = 0; i < 7; i++) {
    fakePosts.push({
      id: `c${i}`, brand: 'auctionbrain', status: 'published',
      published_at: now, template_type: 'reel',
      copy_headline: `reel ${i}`, meta: {},
      post_metrics: [{ engagements: 20, clicks: 2, reach: 100 }],
    });
  }

  const { getTemplatePerformance } = loadFresh();
  const out = await getTemplatePerformance('auctionbrain', 30);

  assert.equal(out.length, 3);
  // hook has the highest engagement per post (which is the proxy reply_rate
  // for social groups), so it should sort first.
  assert.equal(out[0].template_type, 'hook');
  assert.equal(out[1].template_type, 'reel');
  assert.equal(out[2].template_type, 'stat');
  // hook group's top_cta_pattern is the only one with a cta_pattern set.
  assert.equal(out[0].top_cta_pattern, 'browse-now');
  // top_subject is the highest-engagement post's headline.
  assert.match(out[0].top_subject, /hook/);
});

test('getTemplatePerformance: outbound group with contact_ids uses replies/posts ratio', async () => {
  const now = new Date().toISOString();
  fakePosts = [];
  for (let i = 0; i < 5; i++) {
    fakePosts.push({
      id: `o${i}`, brand: 'bridgematch', status: 'published',
      published_at: now, template_type: 'outbound',
      copy_headline: `outbound ${i}`,
      meta: { contact_id: `c${i}` },
      post_metrics: [],
    });
  }
  // 2 replies — should give reply_rate = 0.4
  fakeReplies = [
    { id: 'r1', contact_id: 'c0' },
    { id: 'r2', contact_id: 'c1' },
  ];

  const { getTemplatePerformance } = loadFresh();
  const out = await getTemplatePerformance('bridgematch', 30);
  assert.equal(out.length, 1);
  assert.equal(out[0].template_type, 'outbound');
  assert.equal(out[0].posts_published, 5);
  assert.equal(out[0].replies, 2);
  assert.ok(Math.abs(out[0].reply_rate - 0.4) < 0.001);
});

test('getTemplatePerformance: handles missing post_metrics gracefully', async () => {
  const now = new Date().toISOString();
  fakePosts = [];
  for (let i = 0; i < 5; i++) {
    fakePosts.push({
      id: `n${i}`, brand: 'auctionbrain', status: 'published',
      published_at: now, template_type: 'static',
      copy_headline: `nothing ${i}`, meta: {},
      // post_metrics omitted — Supabase returns null for the embed
    });
  }

  const { getTemplatePerformance } = loadFresh();
  const out = await getTemplatePerformance('auctionbrain', 30);
  assert.equal(out.length, 1);
  assert.equal(out[0].posts_published, 5);
  assert.equal(out[0].total_engagement, 0);
  assert.equal(out[0].top_cta_pattern, null);
});
