// Performance queries — mocked Supabase, asserts metrics shape and the
// rendered HTML fragment for the per-track funnel.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── Mock Supabase that returns canned rows by table + filters ────────────

let fixture; // see freshFixture below

function freshFixture() {
  fixture = {
    posts: [], // {id, track, status, published_at, copy_headline, meta}
    prospects: [], // {id, type, created_at}
    contacts: [], // {id, prospect_id, created_at, metadata}
    sequences: [], // {id, track, created_at, status}
    replies: [], // {id, contact_id, classified_intent, created_at}
    // Phase G-4 weekly-review tables:
    post_metrics: [], // {post_id, engagements, fetched_at}
    boost_runs: [], // {id, spend_pence, ad_new_follows, status, created_at}
    social_audience_daily: [], // {brand, recorded_at, followers_count}
    suppression: [], // {email_or_domain, created_at}
  };
  errOverrides = {}; // Map<table, error message> for "relation does not exist" tests
}

let errOverrides = {};

function makeFakeSupabase() {
  return { from: (table) => makeQuery(table) };
}

function makeQuery(table) {
  const state = {
    table,
    selectMode: null, // 'count' | 'rows'
    filters: [], // [{op,col,val}]
    orderBy: null,
  };
  const matchRow = (row) => {
    for (const f of state.filters) {
      if (f.op === 'eq' && row[f.col] !== f.val) return false;
      if (f.op === 'gte' && !(row[f.col] >= f.val)) return false;
      if (f.op === 'in' && !f.val.includes(row[f.col])) return false;
    }
    return true;
  };
  const api = {
    select(_sel, opts) {
      state.selectMode = opts && opts.count === 'exact' ? 'count' : 'rows';
      return api;
    },
    eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
    gte(col, val) { state.filters.push({ op: 'gte', col, val }); return api; },
    in(col, val) { state.filters.push({ op: 'in', col, val }); return api; },
    not(_col, _op, _val) { return api; },
    order(col, opts) { state.orderBy = { col, opts }; return api; },
    then(resolve) {
      const errMsg = errOverrides[state.table];
      if (errMsg) {
        return resolve({ data: null, count: null, error: { message: errMsg } });
      }
      let rows = (fixture[state.table] || []).filter(matchRow);
      if (state.orderBy) {
        const { col, opts: oOpts } = state.orderBy;
        const asc = oOpts && oOpts.ascending !== false;
        rows = rows.slice().sort((a, b) => {
          const ac = a[col]; const bc = b[col];
          if (ac === bc) return 0;
          return asc ? (ac > bc ? 1 : -1) : (ac > bc ? -1 : 1);
        });
      }
      if (state.selectMode === 'count') {
        resolve({ data: null, count: rows.length, error: null });
      } else {
        resolve({ data: rows, error: null });
      }
    },
  };
  return api;
}

function loadPerfFresh() {
  const supPath = require.resolve('../../lib/supabase');
  const qPath = require.resolve('../../lib/dashboard/performance-queries');
  delete require.cache[supPath];
  delete require.cache[qPath];
  require.cache[supPath] = {
    id: supPath, filename: supPath, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
  return require('../../lib/dashboard/performance-queries');
}

beforeEach(() => { freshFixture(); });

test('windowStart maps numeric days + all', () => {
  const { windowStart } = loadPerfFresh();
  assert.equal(windowStart('all'), '1970-01-01T00:00:00.000Z');
  const sevenAgo = new Date(Date.now() - 7 * 86400 * 1000);
  const got = windowStart(7);
  // within 1 second
  assert.ok(Math.abs(new Date(got).getTime() - sevenAgo.getTime()) < 2000);
});

test('getMetrics returns the documented shape with all three tracks', async () => {
  const { getMetrics } = loadPerfFresh();
  // Seed: 1 published social post (no FB meta) + 1 lender prospect + 1 contact
  const now = new Date().toISOString();
  fixture.posts.push({
    id: 'p1', track: 'social', status: 'published', published_at: now,
    copy_headline: 'Hello', meta: { fb_engagement: 100, fb_reach: 500 },
  });
  fixture.prospects.push({ id: 'pr1', type: 'lender', created_at: now });
  fixture.contacts.push({ id: 'c1', prospect_id: 'pr1', created_at: now, metadata: {} });
  fixture.sequences.push({ id: 's1', track: 'lender', created_at: now });

  const m = await getMetrics({ windowDays: 7 });
  assert.equal(m.window.days, 7);
  assert.equal(m.content.posts_count, 1);
  assert.equal(m.content.fb_engagement, 100);
  assert.equal(m.content.fb_reach, 500);
  assert.equal(m.content.recent_top3.length, 1);

  // All three tracks present
  for (const track of ['lender', 'broker', 'auction_house']) {
    assert.ok(m.outbound[track], `${track} missing`);
    assert.equal(typeof m.outbound[track].prospects, 'number');
    assert.equal(typeof m.outbound[track].contacts, 'number');
  }
  assert.equal(m.outbound.lender.prospects, 1);
  assert.equal(m.outbound.lender.contacts, 1);
  assert.equal(m.outbound.lender.sequences_active, 1);
  assert.equal(m.outbound.broker.prospects, 0);
  assert.equal(m.outbound.auction_house.prospects, 0);
});

test('getMetrics counts replies + interested + meetings for lender track', async () => {
  const { getMetrics } = loadPerfFresh();
  const now = new Date().toISOString();
  fixture.prospects.push({ id: 'pr1', type: 'lender', created_at: now });
  fixture.contacts.push({
    id: 'c1', prospect_id: 'pr1', created_at: now,
    metadata: { meeting_booked_at: now },
  });
  fixture.replies.push(
    { id: 'r1', contact_id: 'c1', classified_intent: 'interested', created_at: now },
    { id: 'r2', contact_id: 'c1', classified_intent: 'questions', created_at: now },
  );
  fixture.posts.push({
    id: 'p1', track: 'outbound', status: 'published', published_at: now,
    meta: { track: 'lender', opens: 3 },
  });

  const m = await getMetrics({ windowDays: 30 });
  assert.equal(m.outbound.lender.replies, 2);
  assert.equal(m.outbound.lender.interested, 1);
  assert.equal(m.outbound.lender.sent, 1);
  assert.equal(m.outbound.lender.opens, 1);
  assert.equal(m.outbound.lender.meetings, 1);
});

test('renderPerformanceFragment renders all three track columns', () => {
  const { renderPerformanceFragment } = loadPerfFresh();
  const html = renderPerformanceFragment({
    windowDays: 7,
    metrics: {
      window: { days: 7 },
      content: {
        posts_count: 14,
        fb_reach: 12450,
        fb_engagement: 892,
        recent_top3: [
          { id: 'p1', copy_headline: 'Hove flat sold', engagement: 312 },
        ],
      },
      outbound: {
        lender: { prospects: 69, contacts: 96, sequences_active: 12, sent: 43, opens: 28, replies: 5, interested: 1, meetings: 0 },
        broker: { prospects: 0, contacts: 0, sequences_active: 0, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0 },
        auction_house: { prospects: 0, contacts: 0, sequences_active: 0, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0 },
      },
    },
  });

  // Headers
  assert.ok(/Content engagement/.test(html));
  assert.ok(/Outbound conversion/.test(html));
  assert.ok(/last 7 days/.test(html));

  // Content stats
  assert.ok(/Posts published/.test(html));
  assert.ok(/12,450/.test(html), 'reach should be formatted with commas');
  assert.ok(/892/.test(html));

  // Top 3
  assert.ok(/Hove flat sold/.test(html));
  assert.ok(/312 engagements/.test(html));

  // Funnel columns
  assert.ok(/<th>lender<\/th>/.test(html));
  assert.ok(/<th>broker<\/th>/.test(html));
  assert.ok(/<th>auction_house<\/th>/.test(html));

  // Row labels
  for (const lbl of ['Prospects', 'Contacts', 'Sequences', 'Sent', 'Opens', 'Replies', 'Interested', 'Meetings']) {
    assert.ok(new RegExp(`<th scope="row">${lbl}<\\/th>`).test(html), `missing row label ${lbl}`);
  }

  // Lender numbers present in order; check 69 and 96 appear
  assert.ok(/69/.test(html));
  assert.ok(/96/.test(html));
});

test('renderPerformanceFragment renders em-dash for null reach/engagement', () => {
  const { renderPerformanceFragment } = loadPerfFresh();
  const html = renderPerformanceFragment({
    windowDays: 'all',
    metrics: {
      window: { days: 'all' },
      content: { posts_count: 0, fb_reach: null, fb_engagement: null, recent_top3: [] },
      outbound: {
        lender: { prospects: 0, contacts: 0, sequences_active: 0, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0 },
        broker: { prospects: 0, contacts: 0, sequences_active: 0, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0 },
        auction_house: { prospects: 0, contacts: 0, sequences_active: 0, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0 },
      },
    },
  });

  assert.ok(/all time/.test(html));
  // null fb_* renders as em-dash, not 0
  assert.ok(/<dd>—<\/dd>/.test(html), 'null FB reach should render as em-dash');
  assert.ok(/No engagement data in this window/.test(html));
});

// ── Phase G-4 — weekly review block ──────────────────────────────────────

test('getMetrics includes a weekly_review block with default shape on empty data', async () => {
  const { getMetrics } = loadPerfFresh();
  const m = await getMetrics({ windowDays: 7 });
  assert.ok(m.weekly_review, 'weekly_review key should always be present');
  assert.deepEqual(m.weekly_review.mode_mix, { monet: 0, traffic: 0, total: 0 });
  assert.equal(m.weekly_review.breakout_count, 0);
  assert.deepEqual(m.weekly_review.top3_social, []);
  // follower_delta is the empty-brand object, not null, when the table exists but has no rows
  assert.ok(m.weekly_review.follower_delta);
  assert.equal(m.weekly_review.follower_delta.delta, null);
});

test('getWeeklyReview: counts mode mix correctly', async () => {
  const { getWeeklyReview, windowStart } = loadPerfFresh();
  const now = new Date().toISOString();
  fixture.posts.push({ id: 'p1', track: 'social', created_at: now, meta: { social_mode: 'monet' } });
  fixture.posts.push({ id: 'p2', track: 'social', created_at: now, meta: { social_mode: 'monet' } });
  fixture.posts.push({ id: 'p3', track: 'social', created_at: now, meta: { social_mode: 'traffic' } });
  const wr = await getWeeklyReview(windowStart(7));
  assert.deepEqual(wr.mode_mix, { monet: 2, traffic: 1, total: 3 });
});

test('getWeeklyReview: breakout_count counts only posts where score >= 2.5', async () => {
  const { getWeeklyReview, windowStart } = loadPerfFresh();
  const now = new Date().toISOString();
  fixture.posts.push({ id: 'p1', track: 'social', published_at: now, meta: { breakout_score: 3.0 } });
  fixture.posts.push({ id: 'p2', track: 'social', published_at: now, meta: { breakout_score: 1.2 } });
  fixture.posts.push({ id: 'p3', track: 'social', published_at: now, meta: { breakout_score: 2.5 } });
  fixture.posts.push({ id: 'p4', track: 'social', published_at: now, meta: { /* no score */ } });
  const wr = await getWeeklyReview(windowStart(7));
  assert.equal(wr.breakout_count, 2);
});

test('getWeeklyReview: top3_social ranks by latest engagement and trims to 3', async () => {
  const { getWeeklyReview, windowStart } = loadPerfFresh();
  const now = new Date().toISOString();
  fixture.posts.push({ id: 'p1', track: 'social', published_at: now, copy_headline: 'Top' });
  fixture.posts.push({ id: 'p2', track: 'social', published_at: now, copy_headline: 'Mid' });
  fixture.posts.push({ id: 'p3', track: 'social', published_at: now, copy_headline: 'Low' });
  fixture.posts.push({ id: 'p4', track: 'social', published_at: now, copy_headline: 'Trim' });
  fixture.post_metrics.push({ post_id: 'p1', engagements: 500, fetched_at: now });
  fixture.post_metrics.push({ post_id: 'p2', engagements: 100, fetched_at: now });
  fixture.post_metrics.push({ post_id: 'p3', engagements: 50, fetched_at: now });
  fixture.post_metrics.push({ post_id: 'p4', engagements: 10, fetched_at: now });
  const wr = await getWeeklyReview(windowStart(7));
  assert.equal(wr.top3_social.length, 3);
  assert.equal(wr.top3_social[0].copy_headline, 'Top');
  assert.equal(wr.top3_social[0].engagements, 500);
  assert.equal(wr.top3_social[2].copy_headline, 'Low');
});

test('getWeeklyReview: follower_delta = last - first when ≥2 rows', async () => {
  const { getWeeklyReview, windowStart } = loadPerfFresh();
  // Anchor relative to today so the 7d window catches both rows
  // regardless of when the test runs.
  const today = new Date().toISOString().slice(0, 10);
  const fiveAgo = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
  fixture.social_audience_daily.push({ brand: 'auctionbrain', recorded_at: fiveAgo, followers_count: 100 });
  fixture.social_audience_daily.push({ brand: 'auctionbrain', recorded_at: today, followers_count: 117 });
  const wr = await getWeeklyReview(windowStart(7));
  assert.equal(wr.follower_delta.first, 100);
  assert.equal(wr.follower_delta.last, 117);
  assert.equal(wr.follower_delta.delta, 17);
});

test('getWeeklyReview: boost_summary aggregates spend + new follows + cpf', async () => {
  const { getWeeklyReview, windowStart } = loadPerfFresh();
  const now = new Date().toISOString();
  fixture.boost_runs.push({ id: 'b1', spend_pence: 200, ad_new_follows: 4, status: 'complete', created_at: now });
  fixture.boost_runs.push({ id: 'b2', spend_pence: 200, ad_new_follows: 1, status: 'complete', created_at: now });
  const wr = await getWeeklyReview(windowStart(7));
  assert.equal(wr.boost_summary.runs, 2);
  assert.equal(wr.boost_summary.spend_pence, 400);
  assert.equal(wr.boost_summary.new_follows, 5);
  assert.equal(wr.boost_summary.cost_per_follower_pence, 80);
});

test('getWeeklyReview: boost_summary cost_per_follower null when zero follows', async () => {
  const { getWeeklyReview, windowStart } = loadPerfFresh();
  const now = new Date().toISOString();
  fixture.boost_runs.push({ id: 'b1', spend_pence: 200, ad_new_follows: 0, status: 'complete', created_at: now });
  const wr = await getWeeklyReview(windowStart(7));
  assert.equal(wr.boost_summary.cost_per_follower_pence, null);
});

test('getWeeklyReview: missing sequences table degrades to null, not throw', async () => {
  const { getWeeklyReview, windowStart } = loadPerfFresh();
  errOverrides.sequences = 'relation "sequences" does not exist';
  const wr = await getWeeklyReview(windowStart(7));
  assert.equal(wr.sequence_health, null);
});

test('getWeeklyReview: missing suppression table degrades to null, not throw', async () => {
  const { getWeeklyReview, windowStart } = loadPerfFresh();
  errOverrides.suppression = 'relation "suppression" does not exist';
  const wr = await getWeeklyReview(windowStart(7));
  assert.equal(wr.suppression_activity, null);
});

test('renderPerformanceFragment: Weekly review section renders ABOVE Content engagement', () => {
  const { renderPerformanceFragment } = loadPerfFresh();
  const html = renderPerformanceFragment({
    windowDays: 7,
    metrics: {
      window: { days: 7 },
      content: { posts_count: 5, fb_reach: 100, fb_engagement: 10, recent_top3: [] },
      outbound: {
        lender: { prospects: 0, contacts: 0, sequences_active: 0, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0 },
        broker: { prospects: 0, contacts: 0, sequences_active: 0, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0 },
        auction_house: { prospects: 0, contacts: 0, sequences_active: 0, sent: 0, opens: 0, replies: 0, interested: 0, meetings: 0 },
      },
      weekly_review: {
        mode_mix: { monet: 5, traffic: 2, total: 7 },
        top3_social: [{ id: 'p1', copy_headline: 'Wales gem', engagements: 312 }],
        breakout_count: 1,
        follower_delta: { brand: 'auctionbrain', first: 100, last: 117, delta: 17 },
        boost_summary: { spend_pence: 400, new_follows: 5, cost_per_follower_pence: 80, runs: 2 },
        suppression_activity: { added: 3 },
        sequence_health: { active: 4, paused: 1 },
      },
    },
  });

  // Weekly review block must appear ABOVE the Content engagement section.
  const wrIdx = html.indexOf('Weekly review');
  const ceIdx = html.indexOf('Content engagement');
  assert.ok(wrIdx >= 0, 'weekly review heading present');
  assert.ok(ceIdx >= 0, 'content engagement heading present');
  assert.ok(wrIdx < ceIdx, 'weekly review must render BEFORE content engagement');

  // Key fields rendered correctly
  assert.ok(/5 \/ 2/.test(html), 'mode mix monet/traffic');
  assert.ok(/Breakouts detected/.test(html));
  assert.ok(/\+17/.test(html), 'follower delta should be signed');
  assert.ok(/£4\.00/.test(html), 'spend in pounds, two decimals');
  assert.ok(/£0\.80/.test(html), 'cost per follower in pounds, two decimals');
  assert.ok(/Wales gem/.test(html));
  assert.ok(/312 engagements/.test(html));
  assert.ok(/Suppressions added/.test(html));
  assert.ok(/Sequences \(active \/ paused\)/.test(html));
  assert.ok(/4 \/ 1/.test(html));
});

test('renderWeeklyReview: empty/null fields render em-dashes and empty list', () => {
  const { renderWeeklyReview } = loadPerfFresh();
  const html = renderWeeklyReview({
    mode_mix: { monet: 0, traffic: 0, total: 0 },
    top3_social: [],
    breakout_count: 0,
    follower_delta: { brand: 'auctionbrain', first: null, last: null, delta: null },
    boost_summary: { spend_pence: 0, new_follows: 0, cost_per_follower_pence: null, runs: 0 },
    suppression_activity: null,
    sequence_health: null,
  });
  assert.ok(/No social engagement data this week/.test(html));
  assert.ok(/£0\.00/.test(html), 'zero spend should still render as £0.00');
  // cost-per-follower null → em-dash
  assert.ok(/<dd>—<\/dd>/.test(html));
  // Suppression + sequence lines absent when their data is null
  assert.ok(!/Suppressions added/.test(html));
  assert.ok(!/Sequences \(active/.test(html));
});

test('renderWeeklyReview: missing wr arg returns empty string (defensive)', () => {
  const { renderWeeklyReview } = loadPerfFresh();
  assert.equal(renderWeeklyReview(null), '');
  assert.equal(renderWeeklyReview(undefined), '');
});

// ── renderAudienceSection (PR4 sparkline) ─────────────────────────────────

test('renderAudienceSection: renders SVG sparkline with start/now/change', () => {
  const { renderAudienceSection } = loadPerfFresh();
  const series = [
    { recorded_at: '2026-05-11', followers_count: 100 },
    { recorded_at: '2026-05-18', followers_count: 130 },
    { recorded_at: '2026-05-25', followers_count: 180 },
  ];
  const html = renderAudienceSection(series);
  assert.ok(/Audience growth/.test(html));
  assert.ok(/<svg /.test(html));
  assert.ok(/<polyline /.test(html));
  assert.ok(/100/.test(html), 'start value shown');
  assert.ok(/180/.test(html), 'now value shown');
  assert.ok(/\+80/.test(html), 'positive delta with + sign');
  assert.ok(/perf-delta-up/.test(html));
});

test('renderAudienceSection: negative delta gets down class', () => {
  const { renderAudienceSection } = loadPerfFresh();
  const html = renderAudienceSection([
    { recorded_at: '2026-05-11', followers_count: 200 },
    { recorded_at: '2026-05-25', followers_count: 150 },
  ]);
  assert.ok(/perf-delta-down/.test(html));
  assert.ok(/-50/.test(html));
});

test('renderAudienceSection: empty or single-point series renders nothing', () => {
  const { renderAudienceSection } = loadPerfFresh();
  assert.equal(renderAudienceSection([]), '');
  assert.equal(renderAudienceSection(null), '');
  assert.equal(renderAudienceSection([{ recorded_at: '2026-05-11', followers_count: 100 }]), '');
});

test('renderPerformanceFragment includes audience section when series present', () => {
  const { renderPerformanceFragment } = loadPerfFresh();
  const html = renderPerformanceFragment({
    windowDays: 7,
    metrics: {
      window: { days: 7 },
      content: { posts_count: 0, fb_reach: null, fb_engagement: null, recent_top3: [] },
      outbound: {
        lender: {}, broker: {}, auction_house: {},
      },
      audience_series: [
        { recorded_at: '2026-05-11', followers_count: 10 },
        { recorded_at: '2026-05-25', followers_count: 20 },
      ],
    },
  });
  assert.ok(/Audience growth/.test(html));
  // Missing series degrades silently
  const html2 = renderPerformanceFragment({
    windowDays: 7,
    metrics: {
      window: { days: 7 },
      content: { posts_count: 0, fb_reach: null, fb_engagement: null, recent_top3: [] },
      outbound: { lender: {}, broker: {}, auction_house: {} },
    },
  });
  assert.ok(!/Audience growth/.test(html2));
});
