'use strict';

// Phase F-1 — Pipeline tab tests.
//
// Unit tests for pure helpers (parseWindow, buildBridgematchJumpUrl) plus
// mocked-Supabase smoke tests covering all 9 route handlers (4 GET + 5
// POST). Side-effect ordering for the multi-step wrong-contact handler is
// asserted directly.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const SUP_PATH = require.resolve('../../lib/supabase');
const SEQ_PATH = require.resolve('../../lib/sequence');
const SUPP_PATH = require.resolve('../../lib/suppression');
const QUERIES_PATH = require.resolve('../../lib/dashboard/pipeline-queries');
const RENDER_PATH = require.resolve('../../lib/dashboard/pipeline-render');
const ROUTE_PATH = require.resolve('../../routes/dashboard/pipeline');

// ── Test state — reset by beforeEach ──────────────────────────────────────

let replies;        // by id → row (with joined contact)
let sequences;      // by id → row (with joined contact)
let contacts;       // by id → row (mutated by metadata updates)
let postsList;      // array of outbound posts
let repliesList;    // array of replies (for list reads)
let sequencesList;  // array of sequences (for list reads)
let updatesLog;     // [{table, id, patch}]
let suppressionCalls;
let sequenceCalls;
let advanceResults; // queue of results to return from advanceSequence

function freshFixture() {
  replies = {};
  sequences = {};
  contacts = {};
  postsList = [];
  repliesList = [];
  sequencesList = [];
  updatesLog = [];
  suppressionCalls = [];
  sequenceCalls = [];
  advanceResults = [];
}

// ── Fake Supabase ─────────────────────────────────────────────────────────

function makeFakeSupabase() {
  return {
    from(table) {
      const state = {
        table,
        filters: [],
        pendingUpdate: null,
        orderCol: null,
        orderAsc: true,
        limitN: null,
        rangeFrom: null,
        rangeTo: null,
      };
      const matchRow = (row) => {
        for (const f of state.filters) {
          const v = row[f.col];
          if (f.op === 'eq' && v !== f.val) return false;
          if (f.op === 'gte' && !(v >= f.val)) return false;
          if (f.op === 'lte' && !(v <= f.val)) return false;
          if (f.op === 'lt'  && !(v <  f.val)) return false;
          if (f.op === 'in'  && !f.val.includes(v)) return false;
        }
        return true;
      };
      const finalise = () => {
        let rows;
        if (state.table === 'replies') rows = repliesList.filter(matchRow);
        else if (state.table === 'sequences') rows = sequencesList.filter(matchRow);
        else if (state.table === 'posts') rows = postsList.filter(matchRow);
        else if (state.table === 'contacts') rows = Object.values(contacts).filter(matchRow);
        else if (state.table === 'suppression') rows = [];
        else rows = [];

        if (state.orderCol) {
          rows = rows.slice().sort((a, b) => {
            const av = a[state.orderCol] || '';
            const bv = b[state.orderCol] || '';
            if (av === bv) return 0;
            return (av < bv ? -1 : 1) * (state.orderAsc ? 1 : -1);
          });
        }
        if (state.rangeFrom != null && state.rangeTo != null) {
          rows = rows.slice(state.rangeFrom, state.rangeTo + 1);
        } else if (state.limitN != null) {
          rows = rows.slice(0, state.limitN);
        }
        return rows;
      };
      const api = {
        select(_sel, opts) {
          state.selectOpts = opts || null;
          return api;
        },
        update(patch) { state.pendingUpdate = patch; return api; },
        insert() { throw new Error('insert not mocked'); },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
        gte(col, val) { state.filters.push({ op: 'gte', col, val }); return api; },
        lte(col, val) { state.filters.push({ op: 'lte', col, val }); return api; },
        lt(col, val)  { state.filters.push({ op: 'lt',  col, val }); return api; },
        in(col, val)  { state.filters.push({ op: 'in',  col, val }); return api; },
        order(col, o) { state.orderCol = col; state.orderAsc = !(o && o.ascending === false); return api; },
        limit(n)      { state.limitN = n; return api; },
        range(from, to) { state.rangeFrom = from; state.rangeTo = to; return api; },
        async maybeSingle() {
          if (state.table === 'replies') {
            const id = state.filters.find(f => f.col === 'id')?.val;
            return { data: replies[id] || null, error: null };
          }
          if (state.table === 'sequences') {
            const id = state.filters.find(f => f.col === 'id')?.val;
            return { data: sequences[id] || null, error: null };
          }
          if (state.table === 'contacts') {
            const id = state.filters.find(f => f.col === 'id')?.val;
            return { data: contacts[id] || null, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve) {
          if (state.pendingUpdate) {
            const id = state.filters.find(f => f.col === 'id')?.val;
            updatesLog.push({ table: state.table, id, patch: state.pendingUpdate });
            if (state.table === 'contacts' && contacts[id]) {
              Object.assign(contacts[id], state.pendingUpdate);
            }
            if (state.table === 'replies' && replies[id]) {
              Object.assign(replies[id], state.pendingUpdate);
            }
            if (state.table === 'sequences' && sequences[id]) {
              Object.assign(sequences[id], state.pendingUpdate);
            }
            return resolve({ data: null, error: null });
          }
          resolve({ data: finalise(), error: null });
        },
      };
      return api;
    },
  };
}

// ── Fake sequence + suppression libs ──────────────────────────────────────

function makeFakeSequence() {
  return {
    async pauseSequence(id, reason) {
      sequenceCalls.push({ op: 'pause', id, reason });
      if (sequences[id]) {
        sequences[id].status = 'paused';
        sequences[id].ended_reason = reason;
      }
      return { ok: true };
    },
    async completeSequence(id, reason) {
      sequenceCalls.push({ op: 'complete', id, reason });
      if (sequences[id]) {
        sequences[id].status = 'completed';
        sequences[id].ended_reason = reason;
      }
      return { ok: true };
    },
    async advanceSequence(id) {
      sequenceCalls.push({ op: 'advance', id });
      if (advanceResults.length) {
        const r = advanceResults.shift();
        if (r instanceof Error) throw r;
        return r;
      }
      return { ok: true, nextStep: (sequences[id] && sequences[id].current_step + 1) || 2, queuedPostId: 'queued-1', completed: false };
    },
    async bumpSequenceOnSendSuccess() { return { ok: true }; },
  };
}

function makeFakeSuppression() {
  return {
    async addSuppression(email, reason) {
      suppressionCalls.push({ email, reason });
      return { inserted: true, emailOrDomain: email, reason };
    },
    async isSuppressed() { return { suppressed: false }; },
  };
}

// ── Test app loader (fresh modules per test) ──────────────────────────────

function loadAppFresh() {
  delete require.cache[SUP_PATH];
  delete require.cache[SEQ_PATH];
  delete require.cache[SUPP_PATH];
  delete require.cache[QUERIES_PATH];
  delete require.cache[RENDER_PATH];
  delete require.cache[ROUTE_PATH];

  const sb = makeFakeSupabase();
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: { supabase: sb },
  };
  require.cache[SEQ_PATH] = {
    id: SEQ_PATH, filename: SEQ_PATH, loaded: true,
    exports: makeFakeSequence(),
  };
  require.cache[SUPP_PATH] = {
    id: SUPP_PATH, filename: SUPP_PATH, loaded: true,
    exports: makeFakeSuppression(),
  };

  const router = require('../../routes/dashboard/pipeline');
  const app = express();
  app.use('/dashboard/pipeline', router);
  return app;
}

function startServer(app) {
  return new Promise(resolve => {
    const server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });
}

async function request(baseUrl, method, path, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl + path);
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      method,
      path: url.pathname + url.search,
      headers,
    }, (res) => {
      let chunks = '';
      res.on('data', c => chunks += c);
      res.on('end', () => resolve({ status: res.statusCode, body: chunks, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Fixture helpers ───────────────────────────────────────────────────────

function makeContact(id, prospect, extra = {}) {
  return {
    id,
    name: extra.name || 'Alice Test',
    email: extra.email || `${id}@example.com`,
    role: extra.role || 'BDM',
    metadata: extra.metadata || {},
    prospect,
  };
}

function makeProspect(id, type, extra = {}) {
  return {
    id,
    type,
    company_name: extra.company_name || 'Acme Loans Ltd',
    website: extra.website || null,
    metadata: extra.metadata || {},
  };
}

beforeEach(() => { freshFixture(); });

// ── Pure helper tests ─────────────────────────────────────────────────────

test('parseWindow defaults to 7d when both args omitted', () => {
  delete require.cache[QUERIES_PATH];
  const { parseWindow } = require('../../lib/dashboard/pipeline-queries');
  const w = parseWindow();
  assert.equal(w.label, '7d');
  const expected = Date.now() - 7 * 86400 * 1000;
  assert.ok(Math.abs(new Date(w.from).getTime() - expected) < 2000);
});

test('parseWindow honours windowDays', () => {
  delete require.cache[QUERIES_PATH];
  const { parseWindow } = require('../../lib/dashboard/pipeline-queries');
  const w = parseWindow({ windowDays: 30 });
  assert.equal(w.label, '30d');
  const expected = Date.now() - 30 * 86400 * 1000;
  assert.ok(Math.abs(new Date(w.from).getTime() - expected) < 2000);
});

test('parseWindow honours windowHours', () => {
  delete require.cache[QUERIES_PATH];
  const { parseWindow } = require('../../lib/dashboard/pipeline-queries');
  const w = parseWindow({ windowHours: 12 });
  assert.equal(w.label, '12h');
  const expected = Date.now() - 12 * 3600 * 1000;
  assert.ok(Math.abs(new Date(w.from).getTime() - expected) < 2000);
});

test('parseWindow returns the epoch for windowDays=all', () => {
  delete require.cache[QUERIES_PATH];
  const { parseWindow } = require('../../lib/dashboard/pipeline-queries');
  const w = parseWindow({ windowDays: 'all' });
  assert.equal(w.label, 'all');
  assert.equal(w.from, '1970-01-01T00:00:00.000Z');
});

test('buildBridgematchJumpUrl maps prospect types correctly', () => {
  delete require.cache[QUERIES_PATH];
  const { buildBridgematchJumpUrl } = require('../../lib/dashboard/pipeline-queries');

  const lender = { type: 'lender', company_name: 'Acme & Co Loans' };
  assert.equal(
    buildBridgematchJumpUrl(lender),
    'https://bridgematch.co.uk/admin/edit?lender=Acme%20%26%20Co%20Loans'
  );

  const brokerWithFrn = { type: 'broker', metadata: { frn: '450491' } };
  assert.equal(
    buildBridgematchJumpUrl(brokerWithFrn),
    'https://register.fca.org.uk/s/firm?id=450491'
  );

  const auctionHouse = { type: 'auction_house', website: 'https://allsop.co.uk' };
  assert.equal(buildBridgematchJumpUrl(auctionHouse), 'https://allsop.co.uk');

  // Fallback: unknown type → base URL.
  assert.equal(buildBridgematchJumpUrl({ type: 'unknown' }), 'https://bridgematch.co.uk');

  // Null prospect doesn't throw.
  assert.equal(buildBridgematchJumpUrl(null), 'https://bridgematch.co.uk');
});

test('buildBridgematchJumpUrl reads BRIDGEMATCH_BASE_URL at call time', () => {
  delete require.cache[QUERIES_PATH];
  const { buildBridgematchJumpUrl } = require('../../lib/dashboard/pipeline-queries');
  const old = process.env.BRIDGEMATCH_BASE_URL;
  process.env.BRIDGEMATCH_BASE_URL = 'https://staging.bridgematch.co.uk/';
  try {
    const url = buildBridgematchJumpUrl({ type: 'lender', company_name: 'X' });
    assert.equal(url, 'https://staging.bridgematch.co.uk/admin/edit?lender=X');
  } finally {
    if (old === undefined) delete process.env.BRIDGEMATCH_BASE_URL;
    else process.env.BRIDGEMATCH_BASE_URL = old;
  }
});

// ── GET route tests ───────────────────────────────────────────────────────

test('GET /dashboard/pipeline returns the tab shell HTML', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/pipeline/');
    assert.equal(res.status, 200);
    assert.match(res.body, /Pipeline/);
    assert.match(res.body, /pipeline-window-selector/);
    assert.match(res.body, /needs-attention/);
    assert.match(res.body, /active-sequences/);
    assert.match(res.body, /recent-activity/);
  } finally { server.close(); }
});

test('GET /needs-attention renders reply cards and a paused-sequence card', async () => {
  const now = new Date().toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect);
  contacts['c1'] = { ...contact };
  repliesList.push({
    id: 'r1', contact_id: 'c1', sequence_id: 's1', raw_body: 'I am keen',
    classified_intent: 'interested', requires_human: true, processed_at: now,
    created_at: now, confidence: 0.92, classifier_reasoning: 'positive tone',
    contact, sequence: { id: 's1', track: 'lender', current_step: 1, status: 'active', ended_reason: null, last_sent_at: now },
  });
  sequencesList.push({
    id: 's2', contact_id: 'c1', track: 'lender', current_step: 2, status: 'paused',
    ended_reason: 'awaiting_human', last_sent_at: now, next_scheduled_at: null, created_at: now,
    contact,
  });

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/pipeline/needs-attention?window=7d&intent=interested,questions,hostile,complaint');
    assert.equal(res.status, 200);
    assert.match(res.body, /reply-card-r1/);
    assert.match(res.body, /seq-card-s2/);
    assert.match(res.body, /intent-interested/);
    assert.match(res.body, /awaiting_human/);
    // hx-preserve on the details body
    assert.match(res.body, /hx-preserve="true"/);
  } finally { server.close(); }
});

test('GET /needs-attention renders empty fragment when nothing matches', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/pipeline/needs-attention');
    assert.equal(res.status, 200);
    assert.match(res.body, /No replies need your attention/);
  } finally { server.close(); }
});

test('GET /active-sequences renders cards + omits Load more when no more rows', async () => {
  const now = new Date().toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect);
  sequencesList.push({
    id: 's-active-1', contact_id: 'c1', track: 'lender', current_step: 1, status: 'active',
    last_sent_at: now, next_scheduled_at: new Date(Date.now() + 86400 * 1000).toISOString(),
    created_at: now, contact,
  });

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/pipeline/active-sequences?track=all&page=0');
    assert.equal(res.status, 200);
    assert.match(res.body, /seq-card-s-active-1/);
    assert.match(res.body, /status-active/);
    assert.match(res.body, /Force next step/);
    // hasMore=false → no load-more button
    assert.doesNotMatch(res.body, /pipeline-load-more/);
  } finally { server.close(); }
});

test('GET /recent-activity interleaves sends + replies', async () => {
  const now = Date.now();
  const recentSend = new Date(now - 1000).toISOString();
  const olderReply = new Date(now - 5 * 60 * 1000).toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect);
  postsList.push({
    id: 'p1', copy_headline: 'Hello', track: 'outbound', status: 'published',
    published_at: recentSend,
    meta: { track: 'lender', sequence_step: 1, contact_email: 'bdm@acme.co', company_name: 'Acme' },
  });
  repliesList.push({
    id: 'r1', classified_intent: 'questions', created_at: olderReply,
    contact: { id: 'c1', email: 'bdm@acme.co', prospect: { company_name: 'Acme' } },
  });

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/pipeline/recent-activity?window=24h');
    assert.equal(res.status, 200);
    assert.match(res.body, /activity-row outbound/);
    assert.match(res.body, /activity-row reply/);
    // Send was newer → appears first.
    const sendIdx = res.body.indexOf('activity-row outbound');
    const replyIdx = res.body.indexOf('activity-row reply');
    assert.ok(sendIdx < replyIdx, 'newer send should appear before older reply');
  } finally { server.close(); }
});

test('GET /recent-activity renders empty fragment when no rows', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/pipeline/recent-activity?window=24h');
    assert.equal(res.status, 200);
    assert.match(res.body, /No recent activity/);
  } finally { server.close(); }
});

// ── POST route tests ──────────────────────────────────────────────────────

test('POST /reply/:id/resolve flips requires_human and renders resolved card', async () => {
  const now = new Date().toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect);
  contacts['c1'] = contact;
  replies['r1'] = {
    id: 'r1', contact_id: 'c1', sequence_id: null, raw_body: 'reply',
    classified_intent: 'interested', requires_human: true, processed_at: now,
    created_at: now, contact, sequence: null,
  };

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/pipeline/reply/r1/resolve');
    assert.equal(res.status, 200);
    assert.match(res.body, /reply-card-r1/);
    assert.match(res.body, /resolved/);
    const updates = updatesLog.filter(u => u.table === 'replies' && u.id === 'r1');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].patch.requires_human, false);
    // processed_at should NOT be in the patch (existing value present).
    assert.equal(updates[0].patch.processed_at, undefined);
  } finally { server.close(); }
});

test('POST /reply/:id/resolve returns 404 when reply does not exist', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/pipeline/reply/missing/resolve');
    assert.equal(res.status, 404);
    assert.match(res.body, /not found/);
  } finally { server.close(); }
});

test('POST /reply/:id/meeting-booked writes contacts.metadata.meeting_booked_at + resolves', async () => {
  const now = new Date().toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect, { metadata: { existing: 'keep-me' } });
  contacts['c1'] = { ...contact };
  replies['r1'] = {
    id: 'r1', contact_id: 'c1', sequence_id: null, raw_body: 'b',
    classified_intent: 'interested', requires_human: true, processed_at: now,
    created_at: now, contact, sequence: null,
  };

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/pipeline/reply/r1/meeting-booked');
    assert.equal(res.status, 200);
    assert.match(res.body, /meeting-booked/);
    const contactUpdate = updatesLog.find(u => u.table === 'contacts' && u.id === 'c1');
    assert.ok(contactUpdate, 'contact metadata should have been patched');
    assert.ok(contactUpdate.patch.metadata.meeting_booked_at, 'meeting_booked_at should be set');
    assert.equal(contactUpdate.patch.metadata.existing, 'keep-me', 'existing metadata should survive merge');
    const replyUpdate = updatesLog.find(u => u.table === 'replies' && u.id === 'r1');
    assert.ok(replyUpdate);
    assert.equal(replyUpdate.patch.requires_human, false);
  } finally { server.close(); }
});

test('POST /reply/:id/wrong-contact runs all three side-effects IN ORDER', async () => {
  const now = new Date().toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect, { email: 'wrong@acme.co' });
  contacts['c1'] = contact;
  sequences['s1'] = {
    id: 's1', contact_id: 'c1', track: 'lender', current_step: 1, status: 'active',
    last_sent_at: now, next_scheduled_at: null, created_at: now, contact,
  };
  replies['r1'] = {
    id: 'r1', contact_id: 'c1', sequence_id: 's1', raw_body: 'b',
    classified_intent: 'questions', requires_human: true, processed_at: now,
    created_at: now, contact, sequence: sequences['s1'],
  };

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/pipeline/reply/r1/wrong-contact');
    assert.equal(res.status, 200);
    // Empty fragment + pipeline-refresh trigger.
    assert.equal(res.body, '');
    assert.equal(res.headers['hx-trigger'], 'pipeline-refresh');

    // Side-effect ordering:
    //   1. addSuppression(email, 'wrong_person')
    //   2. completeSequence(s1, 'wrong_person')
    //   3. UPDATE replies SET requires_human=false
    assert.equal(suppressionCalls.length, 1);
    assert.equal(suppressionCalls[0].email, 'wrong@acme.co');
    assert.equal(suppressionCalls[0].reason, 'wrong_person');

    assert.equal(sequenceCalls.length, 1);
    assert.equal(sequenceCalls[0].op, 'complete');
    assert.equal(sequenceCalls[0].id, 's1');
    assert.equal(sequenceCalls[0].reason, 'wrong_person');

    const replyUpdate = updatesLog.find(u => u.table === 'replies' && u.id === 'r1');
    assert.ok(replyUpdate);
    assert.equal(replyUpdate.patch.requires_human, false);
  } finally { server.close(); }
});

test('POST /sequence/:id/pause calls pauseSequence and renders paused card', async () => {
  const now = new Date().toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect);
  sequences['s1'] = {
    id: 's1', contact_id: 'c1', track: 'lender', current_step: 1, status: 'active',
    last_sent_at: now, next_scheduled_at: null, created_at: now, contact,
  };

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/pipeline/sequence/s1/pause');
    assert.equal(res.status, 200);
    assert.match(res.body, /seq-card-s1/);
    assert.match(res.body, /paused/);
    assert.equal(sequenceCalls.length, 1);
    assert.equal(sequenceCalls[0].op, 'pause');
    assert.equal(sequenceCalls[0].id, 's1');
    assert.equal(sequenceCalls[0].reason, 'manual_pause');
  } finally { server.close(); }
});

test('POST /sequence/:id/force-next calls advanceSequence and renders drafted state', async () => {
  const now = new Date().toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect);
  sequences['s1'] = {
    id: 's1', contact_id: 'c1', track: 'lender', current_step: 2, status: 'active',
    last_sent_at: now, next_scheduled_at: null, created_at: now, contact,
  };
  advanceResults.push({ ok: true, nextStep: 3, queuedPostId: 'draft-1', completed: false });

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/pipeline/sequence/s1/force-next');
    assert.equal(res.status, 200);
    assert.match(res.body, /seq-card-s1/);
    assert.match(res.body, /Step 3 drafted/);
    assert.match(res.body, /awaiting approval/);
    const advanceCalls = sequenceCalls.filter(c => c.op === 'advance');
    assert.equal(advanceCalls.length, 1);
  } finally { server.close(); }
});

test('POST /sequence/:id/force-next errors gracefully when sequence already completed', async () => {
  const now = new Date().toISOString();
  const prospect = makeProspect('pr1', 'lender');
  const contact = makeContact('c1', prospect);
  sequences['s1'] = {
    id: 's1', contact_id: 'c1', track: 'lender', current_step: 4, status: 'completed',
    last_sent_at: now, next_scheduled_at: null, created_at: now, contact,
  };
  // advanceSequence returns {ok: false} for non-active sequences.
  advanceResults.push({ ok: false, nextStep: 4, queuedPostId: null, completed: false });

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/pipeline/sequence/s1/force-next');
    // Graceful: 200 (not 500), card rendered with a "not active" message.
    assert.equal(res.status, 200);
    assert.match(res.body, /not active/);
  } finally { server.close(); }
});

test('POST /sequence/:id/force-next surfaces advanceSequence rejections as 500', async () => {
  sequences['s2'] = {
    id: 's2', contact_id: 'c1', track: 'lender', current_step: 1, status: 'active',
    last_sent_at: null, next_scheduled_at: null, created_at: new Date().toISOString(),
    contact: makeContact('c1', makeProspect('pr1', 'lender')),
  };
  advanceResults.push(new Error('Anthropic API rate limit'));

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/pipeline/sequence/s2/force-next');
    assert.equal(res.status, 500);
    assert.match(res.body, /Force next step failed/);
    assert.match(res.body, /Anthropic API rate limit/);
  } finally { server.close(); }
});
