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
    sequences: [], // {id, track, created_at}
    replies: [], // {id, contact_id, classified_intent, created_at}
  };
}

function makeFakeSupabase() {
  return { from: (table) => makeQuery(table) };
}

function makeQuery(table) {
  const state = {
    table,
    selectMode: null, // 'count' | 'rows'
    filters: [], // [{op,col,val}]
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
    then(resolve) {
      const rows = (fixture[table] || []).filter(matchRow);
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
