'use strict';

// Phase F-2 — Settings tab tests.
//
// Coverage:
//   - lib/resend-from precedence chain (override → env → default → throw)
//   - getOutboundTrackStatus shape with mocked supabase + warming
//   - Smoke tests for each GET (200 + recognisable HTML fragment)
//   - POST handlers hit the right helpers (warming.pauseTrack, runtime-config
//     setLever/clearLever, suppression.removeSuppression, telegram.sendNotification)
//   - Bad input returns 400 + friendly error fragment
//
// Stubs the entire lib/supabase, lib/runtime-config, lib/warming,
// lib/suppression, lib/telegram and lib/resend-from modules via require.cache
// so the route file thinks it's wired to live deps.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const SUP_PATH = require.resolve('../../lib/supabase');
const RC_PATH = require.resolve('../../lib/runtime-config');
const WARM_PATH = require.resolve('../../lib/warming');
const SUPP_PATH = require.resolve('../../lib/suppression');
const TG_PATH = require.resolve('../../lib/telegram');
const RF_PATH = require.resolve('../../lib/resend-from');
const QUERIES_PATH = require.resolve('../../lib/dashboard/settings-queries');
const RENDER_PATH = require.resolve('../../lib/dashboard/settings-render');
const ROUTE_PATH = require.resolve('../../routes/dashboard/settings');

// ── Fake state — reset by beforeEach ─────────────────────────────────────

let appConfig;       // map `${brand}:${key}` -> value
let suppressionRows; // array of {email_or_domain, reason, added_at}
let pausedTracks;    // Set<track>
let setLeverCalls;   // [{brand, key, value}]
let clearLeverCalls; // [{brand, key}]
let pauseCalls;      // [{op, track}]
let suppressionCalls;// [{op, key, reason}]
let telegramCalls;   // [string]
let fromOverrides;   // { lender: string|null, ... }

function fresh() {
  appConfig = {};
  suppressionRows = [];
  pausedTracks = new Set();
  setLeverCalls = [];
  clearLeverCalls = [];
  pauseCalls = [];
  suppressionCalls = [];
  telegramCalls = [];
  fromOverrides = { lender: null, broker: null, auction_house: null };
}

// ── Fake supabase ────────────────────────────────────────────────────────

function makeFakeSupabase() {
  return {
    from(table) {
      const state = {
        table,
        filters: [],
        ilikePattern: null,
        orderCol: null,
        orderAsc: true,
        rangeFrom: null,
        rangeTo: null,
        pendingDelete: false,
        pendingUpdate: null,
        pendingUpsert: null,
        pendingInsert: null,
        selectArg: null,
      };
      const matchRow = (row) => {
        for (const f of state.filters) {
          const v = row[f.col];
          if (f.op === 'eq' && v !== f.val) return false;
        }
        if (state.ilikePattern && state.table === 'suppression') {
          const needle = state.ilikePattern.replace(/^%|%$/g, '').toLowerCase();
          if (!(row.email_or_domain || '').toLowerCase().includes(needle)) return false;
        }
        return true;
      };
      const finaliseList = () => {
        let rows;
        if (state.table === 'suppression') rows = suppressionRows.filter(matchRow);
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
        }
        return rows;
      };
      const api = {
        select(arg) { state.selectArg = arg; return api; },
        update(patch) { state.pendingUpdate = patch; return api; },
        upsert(row) { state.pendingUpsert = row; return api; },
        insert(row) { state.pendingInsert = row; return api; },
        delete() { state.pendingDelete = true; return api; },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
        ilike(col, pattern) { state.ilikePattern = pattern; return api; },
        order(col, opts) { state.orderCol = col; state.orderAsc = !(opts && opts.ascending === false); return api; },
        range(from, to) { state.rangeFrom = from; state.rangeTo = to; return api; },
        async maybeSingle() {
          if (state.table === 'app_config') {
            const brand = state.filters.find(f => f.col === 'brand')?.val;
            const key = state.filters.find(f => f.col === 'key')?.val;
            const v = appConfig[`${brand}:${key}`];
            return { data: v === undefined ? null : { value: v }, error: null };
          }
          if (state.table === 'suppression') {
            const key = state.filters.find(f => f.col === 'email_or_domain')?.val;
            const row = suppressionRows.find(r => r.email_or_domain === key);
            return { data: row || null, error: null };
          }
          return { data: null, error: null };
        },
        then(resolve) {
          if (state.pendingDelete && state.table === 'suppression') {
            const key = state.filters.find(f => f.col === 'email_or_domain')?.val;
            const before = suppressionRows.length;
            const removed = suppressionRows.filter(r => r.email_or_domain === key);
            suppressionRows = suppressionRows.filter(r => r.email_or_domain !== key);
            const data = removed.map(r => ({ email_or_domain: r.email_or_domain }));
            return resolve({ data, error: null });
          }
          if (state.pendingInsert && state.table === 'suppression') {
            const row = { added_at: new Date().toISOString(), ...state.pendingInsert };
            suppressionRows.unshift(row);
            return resolve({ data: null, error: null });
          }
          if (state.pendingUpsert && state.table === 'app_config') {
            const { brand, key, value } = state.pendingUpsert;
            appConfig[`${brand}:${key}`] = value;
            return resolve({ data: null, error: null });
          }
          if (state.pendingUpdate) {
            return resolve({ data: null, error: null });
          }
          return resolve({ data: finaliseList(), error: null });
        },
      };
      return api;
    },
  };
}

// ── Fake runtime-config / warming / suppression / telegram / resend-from

function makeFakeRuntimeConfig() {
  return {
    async setLever(brand, key, value) {
      setLeverCalls.push({ brand, key, value });
      appConfig[`${brand}:${key}`] = value;
    },
    async clearLever(brand, key) {
      clearLeverCalls.push({ brand, key });
      delete appConfig[`${brand}:${key}`];
    },
    async getActiveBrands() {
      const v = appConfig['global:active_brands'];
      return Array.isArray(v) ? v : ['auctionbrain'];
    },
    async getTemplateWeights() {
      const v = appConfig['global:template_weights'];
      return v && typeof v === 'object' ? v : { stat: 1, hook: 1, list: 1, reel: 1 };
    },
    async getBrandDirective(brand) {
      const v = appConfig[`${brand}:directive`];
      return typeof v === 'string' && v.trim() ? v : null;
    },
  };
}

function makeFakeWarming() {
  return {
    DEFAULT_STEADY_CAP: 300,
    async pauseTrack(track) { pauseCalls.push({ op: 'pause', track }); pausedTracks.add(track); },
    async resumeTrack(track) { pauseCalls.push({ op: 'resume', track }); pausedTracks.delete(track); },
    async isPaused(track) { return pausedTracks.has(track); },
    async getCurrentCap(track) { return { cap: 10, day: 0, startDate: '2026-05-25' }; },
    async getRemainingBudget(track) {
      return { remaining: 7, cap: 10, sentToday: 3, day: 0, startDate: '2026-05-25' };
    },
  };
}

function makeFakeSuppression() {
  return {
    async addSuppression(key, reason) {
      suppressionCalls.push({ op: 'add', key, reason });
      const k = key.trim().toLowerCase();
      if (!suppressionRows.find(r => r.email_or_domain === k)) {
        suppressionRows.unshift({ email_or_domain: k, reason, added_at: new Date().toISOString() });
      }
      return { inserted: true, emailOrDomain: k, reason };
    },
    async removeSuppression(key) {
      suppressionCalls.push({ op: 'remove', key });
      const k = key.trim().toLowerCase();
      const before = suppressionRows.length;
      suppressionRows = suppressionRows.filter(r => r.email_or_domain !== k);
      return { removed: suppressionRows.length < before, emailOrDomain: k };
    },
    async isSuppressed() { return { suppressed: false }; },
    invalidateCache() {},
  };
}

function makeFakeTelegram() {
  return {
    async sendNotification(msg) { telegramCalls.push(msg); return true; },
  };
}

function makeFakeResendFrom() {
  return {
    async getResendFrom(track) {
      const override = fromOverrides[track];
      if (override) return override;
      const defaults = {
        lender: 'Simon at BridgeMatch <outreach@outreach.bridgematch.co.uk>',
        broker: 'Simon Deeming <simon@auctionbrain.co.uk>',
        auction_house: 'Simon Deeming <simon@auctionbrain.co.uk>',
      };
      if (defaults[track]) return defaults[track];
      throw new Error(`getResendFrom: invalid track '${track}'`);
    },
    _internals: { DEFAULTS: {}, ENV_KEYS: {}, RESEND_TRACKS: new Set(['lender', 'broker', 'auction_house']) },
  };
}

// ── Test app loader ──────────────────────────────────────────────────────

function loadAppFresh() {
  delete require.cache[SUP_PATH];
  delete require.cache[RC_PATH];
  delete require.cache[WARM_PATH];
  delete require.cache[SUPP_PATH];
  delete require.cache[TG_PATH];
  delete require.cache[RF_PATH];
  delete require.cache[QUERIES_PATH];
  delete require.cache[RENDER_PATH];
  delete require.cache[ROUTE_PATH];

  require.cache[SUP_PATH]  = { id: SUP_PATH,  filename: SUP_PATH,  loaded: true, exports: { supabase: makeFakeSupabase() } };
  require.cache[RC_PATH]   = { id: RC_PATH,   filename: RC_PATH,   loaded: true, exports: makeFakeRuntimeConfig() };
  require.cache[WARM_PATH] = { id: WARM_PATH, filename: WARM_PATH, loaded: true, exports: makeFakeWarming() };
  require.cache[SUPP_PATH] = { id: SUPP_PATH, filename: SUPP_PATH, loaded: true, exports: makeFakeSuppression() };
  require.cache[TG_PATH]   = { id: TG_PATH,   filename: TG_PATH,   loaded: true, exports: makeFakeTelegram() };
  require.cache[RF_PATH]   = { id: RF_PATH,   filename: RF_PATH,   loaded: true, exports: makeFakeResendFrom() };

  const router = require('../../routes/dashboard/settings');
  const app = express();
  app.use('/dashboard/settings', router);
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

function form(obj) {
  return new URLSearchParams(obj).toString();
}

// Convenience: POST a form body to the given path on baseUrl.
async function postForm(baseUrl, path, obj) {
  const body = form(obj);
  return request(baseUrl, 'POST', path, {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': String(body.length),
    },
    body,
  });
}

beforeEach(() => { fresh(); });

// ── resend-from precedence ───────────────────────────────────────────────

test('getResendFrom returns hardcoded default when no override + no env', async () => {
  delete require.cache[RF_PATH];
  delete require.cache[SUP_PATH];
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
  // dotenv repopulates env from .env on every require, so monkey-patch the
  // require.cache entry AFTER load to strip env, then re-resolve via the
  // already-cached exports. This isolates the test from .env contents.
  const { getResendFrom, _internals } = require('../../lib/resend-from');
  const saved = {
    L: process.env.RESEND_FROM_LENDER,
    B: process.env.RESEND_FROM_BROKER,
    A: process.env.RESEND_FROM_AUCTION_HOUSE,
  };
  delete process.env.RESEND_FROM_LENDER;
  delete process.env.RESEND_FROM_BROKER;
  delete process.env.RESEND_FROM_AUCTION_HOUSE;
  try {
    const v = await getResendFrom('lender');
    assert.equal(v, _internals.DEFAULTS.lender);
  } finally {
    if (saved.L !== undefined) process.env.RESEND_FROM_LENDER = saved.L;
    if (saved.B !== undefined) process.env.RESEND_FROM_BROKER = saved.B;
    if (saved.A !== undefined) process.env.RESEND_FROM_AUCTION_HOUSE = saved.A;
  }
});

test('getResendFrom prefers env over hardcoded default', async () => {
  delete require.cache[RF_PATH];
  delete require.cache[SUP_PATH];
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
  const prev = process.env.RESEND_FROM_LENDER;
  process.env.RESEND_FROM_LENDER = 'Env Person <env@example.com>';
  try {
    const { getResendFrom } = require('../../lib/resend-from');
    const v = await getResendFrom('lender');
    assert.equal(v, 'Env Person <env@example.com>');
  } finally {
    if (prev === undefined) delete process.env.RESEND_FROM_LENDER;
    else process.env.RESEND_FROM_LENDER = prev;
  }
});

test('getResendFrom prefers app_config override over env', async () => {
  delete require.cache[RF_PATH];
  delete require.cache[SUP_PATH];
  fresh();
  appConfig['global:outbound.from.lender'] = 'Override Person <override@example.com>';
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
  const prev = process.env.RESEND_FROM_LENDER;
  process.env.RESEND_FROM_LENDER = 'Env Person <env@example.com>';
  try {
    const { getResendFrom } = require('../../lib/resend-from');
    const v = await getResendFrom('lender');
    assert.equal(v, 'Override Person <override@example.com>');
  } finally {
    if (prev === undefined) delete process.env.RESEND_FROM_LENDER;
    else process.env.RESEND_FROM_LENDER = prev;
  }
});

test('getResendFrom throws for unknown track', async () => {
  delete require.cache[RF_PATH];
  delete require.cache[SUP_PATH];
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
  const { getResendFrom } = require('../../lib/resend-from');
  await assert.rejects(() => getResendFrom('zzz'), /invalid track/);
});

// ── getOutboundTrackStatus shape ─────────────────────────────────────────

test('getOutboundTrackStatus returns expected shape with no overrides', async () => {
  fresh();
  // Make sure resend-from gives the default (no override).
  delete require.cache[QUERIES_PATH];
  delete require.cache[RC_PATH];
  delete require.cache[WARM_PATH];
  delete require.cache[RF_PATH];
  delete require.cache[SUP_PATH];
  require.cache[SUP_PATH]  = { id: SUP_PATH,  filename: SUP_PATH,  loaded: true, exports: { supabase: makeFakeSupabase() } };
  require.cache[RC_PATH]   = { id: RC_PATH,   filename: RC_PATH,   loaded: true, exports: makeFakeRuntimeConfig() };
  require.cache[WARM_PATH] = { id: WARM_PATH, filename: WARM_PATH, loaded: true, exports: makeFakeWarming() };
  require.cache[RF_PATH]   = { id: RF_PATH,   filename: RF_PATH,   loaded: true, exports: makeFakeResendFrom() };

  const { getOutboundTrackStatus } = require('../../lib/dashboard/settings-queries');
  const status = await getOutboundTrackStatus('lender');
  assert.equal(status.track, 'lender');
  assert.equal(status.cap, 10);
  assert.equal(status.day, 0);
  assert.equal(status.sentToday, 3);
  assert.equal(status.isPaused, false);
  assert.equal(status.steady_cap_default, 300);
  assert.equal(status.steady_cap_override, null);
  assert.equal(status.from_address_override, null);
  assert.match(status.from_address_resolved, /BridgeMatch/);
  assert.equal(status.tone_override, null);
});

test('getOutboundTrackStatus surfaces app_config overrides', async () => {
  fresh();
  appConfig['global:outbound.warming.lender.steady_cap'] = 250;
  appConfig['global:outbound.from.lender'] = 'Override <o@x.co>';
  appConfig['global:outbound_tone_lender'] = 'Punchy, no fluff.';
  delete require.cache[QUERIES_PATH];
  delete require.cache[RC_PATH];
  delete require.cache[WARM_PATH];
  delete require.cache[RF_PATH];
  delete require.cache[SUP_PATH];
  require.cache[SUP_PATH]  = { id: SUP_PATH,  filename: SUP_PATH,  loaded: true, exports: { supabase: makeFakeSupabase() } };
  require.cache[RC_PATH]   = { id: RC_PATH,   filename: RC_PATH,   loaded: true, exports: makeFakeRuntimeConfig() };
  require.cache[WARM_PATH] = { id: WARM_PATH, filename: WARM_PATH, loaded: true, exports: makeFakeWarming() };
  fromOverrides.lender = 'Override <o@x.co>';
  require.cache[RF_PATH]   = { id: RF_PATH,   filename: RF_PATH,   loaded: true, exports: makeFakeResendFrom() };

  const { getOutboundTrackStatus } = require('../../lib/dashboard/settings-queries');
  const status = await getOutboundTrackStatus('lender');
  assert.equal(status.steady_cap_override, 250);
  assert.equal(status.from_address_override, 'Override <o@x.co>');
  assert.equal(status.from_address_resolved, 'Override <o@x.co>');
  assert.equal(status.tone_override, 'Punchy, no fluff.');
});

test('getOutboundTrackStatus throws on invalid track', async () => {
  delete require.cache[QUERIES_PATH];
  const { getOutboundTrackStatus } = require('../../lib/dashboard/settings-queries');
  await assert.rejects(() => getOutboundTrackStatus('zzz'), /invalid track/);
});

// ── GET smoke tests ──────────────────────────────────────────────────────

test('GET /dashboard/settings returns the tab shell HTML', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/settings/');
    assert.equal(res.status, 200);
    assert.match(res.body, /Settings/);
    assert.match(res.body, /section-outbound/);
    assert.match(res.body, /section-suppression/);
    assert.match(res.body, /section-content/);
    assert.match(res.body, /section-system/);
  } finally { server.close(); }
});

test('GET /outbound/:track/status returns a track card fragment', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/settings/outbound/lender/status');
    assert.equal(res.status, 200);
    assert.match(res.body, /track-card-lender/);
    assert.match(res.body, /track-badge/);
    assert.match(res.body, /Steady-state cap/);
    assert.match(res.body, /From address override/);
    assert.match(res.body, /Tone override/);
  } finally { server.close(); }
});

test('GET /outbound/:track/status rejects bad track', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/settings/outbound/zzz/status');
    assert.equal(res.status, 400);
    assert.match(res.body, /error-flash/);
    assert.match(res.body, /Unknown track/);
  } finally { server.close(); }
});

test('GET /suppression renders empty state when no rows', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/settings/suppression?page=0');
    assert.equal(res.status, 200);
    assert.match(res.body, /No suppression entries/);
  } finally { server.close(); }
});

test('GET /suppression renders table fragment when rows present', async () => {
  const app = loadAppFresh();
  suppressionRows.push({ email_or_domain: 'noreply@example.com', reason: 'bounce', added_at: new Date().toISOString() });
  suppressionRows.push({ email_or_domain: 'spammy.co', reason: 'complaint', added_at: new Date().toISOString() });
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/settings/suppression?page=0');
    assert.equal(res.status, 200);
    assert.match(res.body, /suppression-table/);
    assert.match(res.body, /noreply@example.com/);
    assert.match(res.body, /spammy\.co/);
    assert.match(res.body, /reason-bounce/);
  } finally { server.close(); }
});

test('GET /content/brands renders both brand cards + template weights', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/settings/content/brands');
    assert.equal(res.status, 200);
    assert.match(res.body, /AuctionBrain/);
    assert.match(res.body, /BridgeMatch/);
    assert.match(res.body, /template-weights/);
    assert.match(res.body, /weight_stat/);
    assert.match(res.body, /weight_reel/);
  } finally { server.close(); }
});

test('GET /system renders the three system controls', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await request(baseUrl, 'GET', '/dashboard/settings/system');
    assert.equal(res.status, 200);
    assert.match(res.body, /bulk-approve-cap/);
    assert.match(res.body, /telegram-receipt/);
    assert.match(res.body, /suppression-check/);
    assert.match(res.body, /danger-control/);
  } finally { server.close(); }
});

// ── POST handler smoke tests ─────────────────────────────────────────────

test('POST /outbound/:track/pause calls warming.pauseTrack and returns saved fragment', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/lender/pause', {});
    assert.equal(res.status, 200);
    assert.equal(res.headers['hx-trigger'], 'settings-saved');
    assert.match(res.body, /track-card-lender/);
    assert.match(res.body, /saved-flash show/);
    assert.deepEqual(pauseCalls, [{ op: 'pause', track: 'lender' }]);
  } finally { server.close(); }
});

test('POST /outbound/:track/resume calls warming.resumeTrack', async () => {
  const app = loadAppFresh();
  pausedTracks.add('broker');
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/broker/resume', {});
    assert.equal(res.status, 200);
    assert.deepEqual(pauseCalls, [{ op: 'resume', track: 'broker' }]);
  } finally { server.close(); }
});

test('POST /outbound/:track/pause rejects unknown track', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/zzz/pause', {});
    assert.equal(res.status, 400);
    assert.match(res.body, /Unknown track/);
    assert.equal(pauseCalls.length, 0);
  } finally { server.close(); }
});

test('POST /outbound/:track/steady-cap writes a number via setLever', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/lender/steady-cap', { steady_cap: '250' });
    assert.equal(res.status, 200);
    assert.equal(setLeverCalls.length, 1);
    assert.equal(setLeverCalls[0].brand, 'global');
    assert.equal(setLeverCalls[0].key, 'outbound.warming.lender.steady_cap');
    assert.equal(setLeverCalls[0].value, 250);
  } finally { server.close(); }
});

test('POST /outbound/:track/steady-cap with reset=1 calls clearLever', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/lender/steady-cap', { reset: '1' });
    assert.equal(res.status, 200);
    assert.equal(clearLeverCalls.length, 1);
    assert.equal(clearLeverCalls[0].key, 'outbound.warming.lender.steady_cap');
  } finally { server.close(); }
});

test('POST /outbound/:track/steady-cap rejects out-of-range value', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/lender/steady-cap', { steady_cap: '9999' });
    assert.equal(res.status, 400);
    assert.match(res.body, /whole number between 0 and 2000/);
    assert.equal(setLeverCalls.length, 0);
  } finally { server.close(); }
});

test('POST /outbound/:track/from-address validates @ presence', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/lender/from-address', { from_address: 'not-an-email' });
    assert.equal(res.status, 400);
    assert.match(res.body, /must contain/);
    assert.equal(setLeverCalls.length, 0);
  } finally { server.close(); }
});

test('POST /outbound/:track/from-address writes a valid override', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/lender/from-address', { from_address: 'Sam <sam@example.com>' });
    assert.equal(res.status, 200);
    assert.equal(setLeverCalls[0].key, 'outbound.from.lender');
    assert.equal(setLeverCalls[0].value, 'Sam <sam@example.com>');
  } finally { server.close(); }
});

test('POST /outbound/:track/tone rejects overlong tone', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/outbound/lender/tone', { tone: 'x'.repeat(501) });
    assert.equal(res.status, 400);
    assert.match(res.body, /max 500/);
  } finally { server.close(); }
});

test('POST /suppression/add calls addSuppression and renders the new row', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/suppression/add', { email_or_domain: 'noreply@example.com', reason: 'manual' });
    assert.equal(res.status, 200);
    assert.match(res.body, /noreply@example.com/);
    assert.match(res.body, /reason-manual/);
    assert.equal(suppressionCalls.length, 1);
    assert.equal(suppressionCalls[0].op, 'add');
    assert.equal(suppressionCalls[0].key, 'noreply@example.com');
    assert.equal(suppressionCalls[0].reason, 'manual');
  } finally { server.close(); }
});

test('POST /suppression/add rejects bad reason', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/suppression/add', { email_or_domain: 'x@y.co', reason: 'totally-fake-reason' });
    assert.equal(res.status, 400);
    assert.match(res.body, /Invalid suppression reason/);
    assert.equal(suppressionCalls.length, 0);
  } finally { server.close(); }
});

test('POST /suppression/remove calls removeSuppression and sends Telegram receipt', async () => {
  const app = loadAppFresh();
  suppressionRows.push({ email_or_domain: 'old@example.com', reason: 'bounce', added_at: new Date().toISOString() });
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/suppression/remove', { email_or_domain: 'old@example.com' });
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
    assert.equal(suppressionCalls.length, 1);
    assert.equal(suppressionCalls[0].op, 'remove');
    assert.equal(telegramCalls.length, 1);
    assert.match(telegramCalls[0], /old@example.com/);
    assert.match(telegramCalls[0], /removed/);
  } finally { server.close(); }
});

test('POST /suppression/remove rejects empty key', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/suppression/remove', { email_or_domain: '' });
    assert.equal(res.status, 400);
    assert.equal(suppressionCalls.length, 0);
    assert.equal(telegramCalls.length, 0);
  } finally { server.close(); }
});

test('POST /content/brand/:brand/active adds brand to active_brands', async () => {
  const app = loadAppFresh();
  appConfig['global:active_brands'] = ['auctionbrain'];
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/content/brand/bridgematch/active', { active: 'on' });
    assert.equal(res.status, 200);
    const setCall = setLeverCalls.find(c => c.key === 'active_brands');
    assert.ok(setCall, 'active_brands should be written');
    assert.deepEqual(setCall.value.sort(), ['auctionbrain', 'bridgematch']);
  } finally { server.close(); }
});

test('POST /content/template-weights writes a valid weight object', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/content/template-weights', { weight_stat: '2', weight_hook: '1', weight_list: '3', weight_reel: '0' });
    assert.equal(res.status, 200);
    const setCall = setLeverCalls.find(c => c.key === 'template_weights');
    assert.ok(setCall);
    assert.deepEqual(setCall.value, { stat: 2, hook: 1, list: 3, reel: 0 });
  } finally { server.close(); }
});

test('POST /content/template-weights rejects out-of-range weight', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/content/template-weights', { weight_stat: '99', weight_hook: '1', weight_list: '1', weight_reel: '1' });
    assert.equal(res.status, 400);
    assert.match(res.body, /must be an integer 0-5/);
  } finally { server.close(); }
});

test('POST /content/brand/:brand/directive writes a trimmed directive', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/content/brand/auctionbrain/directive', { directive: '  Lean into stat hooks.  ' });
    assert.equal(res.status, 200);
    const setCall = setLeverCalls.find(c => c.brand === 'auctionbrain' && c.key === 'directive');
    assert.ok(setCall);
    assert.equal(setCall.value, 'Lean into stat hooks.');
  } finally { server.close(); }
});

test('POST /system/bulk-approve-cap writes a number in range', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/system/bulk-approve-cap', { cap: '25' });
    assert.equal(res.status, 200);
    const setCall = setLeverCalls.find(c => c.key === 'dashboard.bulk_approve_cap');
    assert.ok(setCall);
    assert.equal(setCall.value, 25);
  } finally { server.close(); }
});

test('POST /system/bulk-approve-cap rejects value > 50', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/system/bulk-approve-cap', { cap: '100' });
    assert.equal(res.status, 400);
    assert.match(res.body, /between 1 and 50/);
  } finally { server.close(); }
});

test('POST /system/telegram-receipt enabled=on clears the lever (default ON)', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/system/telegram-receipt', { enabled: 'on' });
    assert.equal(res.status, 200);
    const clearCall = clearLeverCalls.find(c => c.key === 'dashboard.send_telegram_receipt');
    assert.ok(clearCall, 'enabled=on should clear the row so default ON re-applies');
  } finally { server.close(); }
});

test('POST /system/telegram-receipt enabled absent writes false', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/system/telegram-receipt', {});
    assert.equal(res.status, 200);
    const setCall = setLeverCalls.find(c => c.key === 'dashboard.send_telegram_receipt');
    assert.ok(setCall);
    assert.equal(setCall.value, false);
  } finally { server.close(); }
});

test('POST /system/suppression-check writes the value + sends Telegram log', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/system/suppression-check', { enabled: 'on' });
    assert.equal(res.status, 200);
    const setCall = setLeverCalls.find(c => c.key === 'outbound.suppression_check_enabled');
    assert.ok(setCall);
    assert.equal(setCall.value, true);
    assert.equal(telegramCalls.length, 1);
    assert.match(telegramCalls[0], /suppression_check_enabled toggled/);
  } finally { server.close(); }
});

test('POST /system/suppression-check toggling OFF still logs to Telegram', async () => {
  const app = loadAppFresh();
  const { server, baseUrl } = await startServer(app);
  try {
    const res = await postForm(baseUrl, '/dashboard/settings/system/suppression-check', {});
    assert.equal(res.status, 200);
    const setCall = setLeverCalls.find(c => c.key === 'outbound.suppression_check_enabled');
    assert.ok(setCall);
    assert.equal(setCall.value, false);
    assert.equal(telegramCalls.length, 1);
    assert.match(telegramCalls[0], /OFF/);
  } finally { server.close(); }
});
