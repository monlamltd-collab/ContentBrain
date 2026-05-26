// Phase E — dashboard approve outbound endpoints tests.
//
// Mocks lib/supabase + lib/publish to assert:
//   - /outbound/:id/approve invokes publish and renders the result fragment
//   - /outbound/:id/reject reads HX-Prompt header and writes
//     rejection_feedback
//   - /outbound/:id/revise stashes meta.revision_request and re-renders
//     the card with the badge
//   - /outbound/bulk reads req.body.postId (array via urlencoded), caps
//     at app_config.dashboard.bulk_approve_cap, iterates SEQUENTIALLY.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const SUP_PATH = require.resolve('../../lib/supabase');
const PUBLISH_PATH = require.resolve('../../lib/publish');
const ROUTE_PATH = require.resolve('../../routes/dashboard/approve');

// ── Fake state ────────────────────────────────────────────────────────────

let postsById;     // id -> row
let updatesLog;    // [{id, patch}]
let appConfig;     // map of `${brand}:${key}` -> value
let publishCalls;  // [{post, returnedAt}]
let publishResults; // queue of results to return — one per call

function makeFakeSupabase() {
  return {
    from(table) {
      const state = { table, filters: [], pendingUpdate: null };
      const api = {
        select(_sel) { return api; },
        update(patch) { state.pendingUpdate = patch; return api; },
        insert() { throw new Error('insert not mocked'); },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
        async maybeSingle() {
          if (state.table === 'app_config') {
            const brand = state.filters.find(f => f.col === 'brand')?.val;
            const key = state.filters.find(f => f.col === 'key')?.val;
            const v = appConfig[`${brand}:${key}`];
            return { data: v === undefined ? null : { value: v }, error: null };
          }
          if (state.table === 'posts') {
            const id = state.filters.find(f => f.col === 'id')?.val;
            const row = postsById[id];
            return { data: row || null, error: null };
          }
          return { data: null, error: null };
        },
        async single() {
          return api.maybeSingle();
        },
        then(resolve) {
          // Used by the .update().eq().then() chain.
          if (state.pendingUpdate && state.table === 'posts') {
            const id = state.filters.find(f => f.col === 'id')?.val;
            updatesLog.push({ id, patch: state.pendingUpdate });
            if (postsById[id]) Object.assign(postsById[id], state.pendingUpdate);
            return resolve({ data: null, error: null });
          }
          resolve({ data: null, error: null });
        },
      };
      return api;
    },
  };
}

// supabase mock for getPostById: lib/supabase exports `getPostById` directly
// (NOT via the .from() pattern in approve.js's bulk handler). Easiest: stub
// the whole module's exports.

function makeFakeSupabaseModule() {
  const sb = makeFakeSupabase();
  return {
    supabase: sb,
    async getPostById(id) {
      const row = postsById[id];
      if (!row) throw new Error(`Get post failed: not found ${id}`);
      return row;
    },
    async getApprovedPosts() { return []; },
  };
}

function makeFakePublish() {
  return {
    async publish(post) {
      publishCalls.push({ post, calledAt: Date.now() });
      if (publishResults.length) return publishResults.shift();
      return { ok: true, channel: 'resend', resendId: 'fake-1' };
    },
  };
}

function loadAppFresh() {
  delete require.cache[SUP_PATH];
  delete require.cache[PUBLISH_PATH];
  delete require.cache[ROUTE_PATH];
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: makeFakeSupabaseModule(),
  };
  require.cache[PUBLISH_PATH] = {
    id: PUBLISH_PATH, filename: PUBLISH_PATH, loaded: true,
    exports: makeFakePublish(),
  };
  const router = require('../../routes/dashboard/approve');
  const app = express();
  app.use('/dashboard/approve', router);
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
      path: url.pathname,
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

beforeEach(() => {
  postsById = {};
  updatesLog = [];
  appConfig = {};
  publishCalls = [];
  publishResults = [];
});

// ── approve ───────────────────────────────────────────────────────────────

test('POST /outbound/:id/approve calls publish and returns sent fragment', async () => {
  postsById['p1'] = {
    id: 'p1', status: 'draft', meta: { contact_email: 'bdm@acme.com' },
    copy_headline: 'Quick note', copy_body: 'Hello.',
    track: 'outbound', channel: 'resend',
  };
  publishResults.push({ ok: true, channel: 'resend', resendId: 'r-1' });

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/p1/approve');
    assert.equal(res.status, 200);
    assert.match(res.body, /Sent/);
    assert.match(res.body, /bdm@acme\.com/);
    assert.equal(publishCalls.length, 1);
    // The router flips status='approved' before publish().
    assert.ok(updatesLog.some(u => u.id === 'p1' && u.patch.status === 'approved'));
  } finally {
    server.close();
  }
});

test('POST /outbound/:id/approve renders SUPPRESSED fragment when publish reports suppression', async () => {
  postsById['p2'] = { id: 'p2', status: 'draft', meta: { contact_email: 'x@y.co' }, copy_headline: 'h', copy_body: 'b' };
  publishResults.push({ ok: true, channel: 'resend', suppressed: true, reason: 'unsubscribed' });

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/p2/approve');
    assert.equal(res.status, 200);
    assert.match(res.body, /Suppressed/);
    assert.match(res.body, /unsubscribed/);
  } finally {
    server.close();
  }
});

test('POST /outbound/:id/approve renders DEFERRED fragment when warming cap reached', async () => {
  postsById['p3'] = { id: 'p3', status: 'draft', meta: { contact_email: 'x@y.co' }, copy_headline: 'h', copy_body: 'b' };
  publishResults.push({ ok: true, channel: 'resend', deferred: true, reason: 'warming_cap_reached' });

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/p3/approve');
    assert.equal(res.status, 200);
    assert.match(res.body, /Deferred/);
    assert.match(res.body, /warming_cap_reached/);
  } finally {
    server.close();
  }
});

// ── reject ────────────────────────────────────────────────────────────────

test('POST /outbound/:id/reject reads HX-Prompt header and writes rejection_feedback', async () => {
  postsById['p4'] = { id: 'p4', status: 'draft', meta: {}, copy_headline: 'h', copy_body: 'b' };

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/p4/reject', {
      headers: { 'HX-Prompt': 'tone is off' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body, '', 'reject fragment should be empty so the card disappears');
    const updates = updatesLog.filter(u => u.id === 'p4');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].patch.status, 'rejected');
    assert.equal(updates[0].patch.rejection_feedback, 'tone is off');
  } finally {
    server.close();
  }
});

test('POST /outbound/:id/reject without HX-Prompt header still works (rejection_feedback null)', async () => {
  postsById['p5'] = { id: 'p5', status: 'draft', meta: {}, copy_headline: 'h', copy_body: 'b' };

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/p5/reject');
    assert.equal(res.status, 200);
    const updates = updatesLog.filter(u => u.id === 'p5');
    assert.equal(updates.length, 1);
    assert.equal(updates[0].patch.rejection_feedback, null);
  } finally {
    server.close();
  }
});

// ── revise ────────────────────────────────────────────────────────────────

test('POST /outbound/:id/revise stashes feedback and renders Pending revision card', async () => {
  postsById['p6'] = {
    id: 'p6', status: 'draft',
    meta: { contact_email: 'bdm@acme.com', sequence_step: 1 },
    copy_headline: 'Quick note', copy_body: 'Hello.',
    brand: 'bridgematch', track: 'lender',
  };

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/p6/revise', {
      headers: { 'HX-Prompt': 'mention the auction angle' },
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /Pending revision/);
    assert.match(res.body, /mention the auction angle/);
    const update = updatesLog.find(u => u.id === 'p6');
    assert.ok(update);
    assert.equal(update.patch.status, 'draft');
    assert.equal(update.patch.meta.revision_request, 'mention the auction angle');
  } finally {
    server.close();
  }
});

// ── bulk ──────────────────────────────────────────────────────────────────

test('POST /outbound/bulk iterates SEQUENTIALLY (not Promise.all)', async () => {
  for (const id of ['b1', 'b2', 'b3']) {
    postsById[id] = { id, status: 'draft', meta: { contact_email: `${id}@y.co` }, copy_headline: 'h', copy_body: 'b' };
  }
  // Force each publish to take some time + record order.
  const order = [];
  let publishIdx = 0;
  publishResults.push(
    null, null, null  // placeholders; we'll override below
  );
  // Re-init publish module to use sequential delays.
  delete require.cache[PUBLISH_PATH];
  require.cache[PUBLISH_PATH] = {
    id: PUBLISH_PATH, filename: PUBLISH_PATH, loaded: true,
    exports: {
      async publish(post) {
        const idx = publishIdx++;
        const startedAt = order.length;
        order.push({ id: post.id, started: startedAt });
        // Sleep — if Promise.all was used, all three would start at order=0.
        // Sequential code waits for the prior await to resolve before the
        // next .push fires.
        await new Promise(r => setTimeout(r, 15));
        return { ok: true, channel: 'resend', resendId: `r-${idx}` };
      },
    },
  };
  // Re-clone the route to pick up the new publish stub.
  delete require.cache[ROUTE_PATH];
  const router = require('../../routes/dashboard/approve');
  const app = express();
  app.use('/dashboard/approve', router);

  const { server, baseUrl } = await startServer(app);
  try {
    const body = 'postId=b1&postId=b2&postId=b3';
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/bulk', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /3 sent/);
    // Sequential: each push happens AFTER the previous finished.
    assert.equal(order.length, 3);
    assert.equal(order[0].started, 0);
    assert.equal(order[1].started, 1);
    assert.equal(order[2].started, 2);
  } finally {
    server.close();
  }
});

test('POST /outbound/bulk respects the cap from app_config', async () => {
  for (let i = 0; i < 5; i++) {
    postsById[`x${i}`] = { id: `x${i}`, status: 'draft', meta: { contact_email: `x${i}@y.co` }, copy_headline: 'h', copy_body: 'b' };
  }
  appConfig['global:dashboard.bulk_approve_cap'] = 2;
  publishResults.push(
    { ok: true, channel: 'resend', resendId: 'r-1' },
    { ok: true, channel: 'resend', resendId: 'r-2' },
  );

  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const body = 'postId=x0&postId=x1&postId=x2&postId=x3&postId=x4';
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/bulk', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(publishCalls.length, 2, 'only 2 should be processed under the cap');
    assert.match(res.body, /Capped at 2/);
    assert.match(res.body, /selected 5/);
  } finally {
    server.close();
  }
});

test('POST /outbound/bulk with no postIds returns the empty-selection fragment', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'POST', '/dashboard/approve/outbound/bulk', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: '',
    });
    assert.equal(res.status, 200);
    assert.match(res.body, /No outbound drafts were selected/);
    assert.equal(publishCalls.length, 0);
  } finally {
    server.close();
  }
});
