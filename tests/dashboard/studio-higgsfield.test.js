// lib/dashboard/studio-higgsfield.js — job lifecycle (PR3).
// Mocks lib/supabase + lib/higgsfield + @supabase/supabase-js via
// require.cache so no network, no LLM, no real DB.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SUP_PATH = require.resolve('../../lib/supabase');
const SDK_PATH = require.resolve('@supabase/supabase-js');
const HF_PATH = require.resolve('../../lib/higgsfield');
const MOD_PATH = require.resolve('../../lib/dashboard/studio-higgsfield');
const QUERIES_PATH = require.resolve('../../lib/dashboard/studio-queries');
const RUNTIME_PATH = require.resolve('../../lib/runtime-config');

let rows;        // posts by id
let appConfig;   // { 'brand/key': value }
let hfBehavior;  // controls fake higgsfield

function fakeDb() {
  return {
    from(table) {
      const state = { table, filters: [], updatePayload: null };
      const finish = () => {
        if (table === 'app_config') {
          const brand = state.filters.find(f => f.col === 'brand');
          const key = state.filters.find(f => f.col === 'key');
          const v = appConfig[`${brand && brand.val}/${key && key.val}`];
          return { data: v === undefined ? null : { value: v }, error: null };
        }
        const id = state.filters.find(f => f.col === 'id');
        const row = rows[id && id.val] || null;
        if (state.updatePayload && row) Object.assign(row, state.updatePayload);
        return { data: row, error: row ? null : { message: 'not found' } };
      };
      const api = {
        select() { return api; },
        eq(col, val) { state.filters.push({ col, val }); return api; },
        update(p) { state.updatePayload = p; return api; },
        upsert: async (row) => { appConfig[`${row.brand}/${row.key}`] = row.value; return { error: null }; },
        delete() { return api; },
        single: async () => finish(),
        maybeSingle: async () => finish(),
        then(resolve) { resolve({ data: [], error: null }); },
      };
      return api;
    },
    storage: {
      from: () => ({
        upload: async () => ({ error: null }),
        getPublicUrl: (f) => ({ data: { publicUrl: `https://bucket.example/${f}` } }),
      }),
    },
  };
}

function inject(p, exportsObj) {
  delete require.cache[p];
  require.cache[p] = { id: p, filename: p, loaded: true, exports: exportsObj };
}

function loadModule() {
  delete require.cache[MOD_PATH];
  delete require.cache[QUERIES_PATH];
  delete require.cache[RUNTIME_PATH];
  const db = fakeDb();
  inject(SDK_PATH, { createClient: () => db });
  inject(SUP_PATH, {
    supabase: db,
    uploadMedia: async (fp, name) => `https://bucket.example/${name}`,
  });
  inject(HF_PATH, {
    isHiggsfieldConfigured: () => hfBehavior.configured,
    MODELS: { soulImage: 'soul/std', imageToVideo: 'dop/std' },
    submitGeneration: async (model, params) => {
      hfBehavior.submitted.push({ model, params });
      return { request_id: hfBehavior.nextId || 'req-1' };
    },
    getStatus: async () => hfBehavior.status(),
    downloadAsset: async (url, prefix) => ({ filename: `${prefix}-x.png`, outputPath: `/tmp/${prefix}-x.png` }),
    classifyError: (s) => ({ code: String(s), userMessage: `msg:${s}` }),
  });
  return require(MOD_PATH);
}

beforeEach(() => {
  rows = {
    p1: {
      id: 'p1', brand: 'auctionbrain', template_type: 'reel',
      image_url: 'orig.png', video_url: null,
      copy_headline: 'H', meta: {},
    },
  };
  appConfig = {};
  hfBehavior = { configured: true, submitted: [], status: () => ({ status: 'queued', assets: [] }) };
});

test('startImageJob: submits with reel 9:16 aspect, stores job, bumps usage', async () => {
  const hf = loadModule();
  const job = await hf.startImageJob('p1', 'a scene');
  assert.equal(job.status, 'queued');
  assert.equal(hfBehavior.submitted[0].model, 'soul/std');
  assert.equal(hfBehavior.submitted[0].params.aspect_ratio, '9:16');
  assert.equal(rows.p1.meta.higgsfield_jobs.length, 1);
  const usageKey = Object.keys(appConfig).find(k => k.includes('higgsfield.usage.'));
  assert.equal(appConfig[usageKey], 1);
});

test('one active job per post is enforced', async () => {
  const hf = loadModule();
  await hf.startImageJob('p1', 'one');
  await assert.rejects(() => hf.startImageJob('p1', 'two'), /already running/);
});

test('daily cap blocks new jobs', async () => {
  appConfig['global/higgsfield.daily_cap'] = 2;
  appConfig[`global/higgsfield.usage.${new Date().toISOString().slice(0, 10)}`] = 2;
  const hf = loadModule();
  await assert.rejects(() => hf.startImageJob('p1', 'x'), /cap reached/);
});

test('unconfigured client gives setup guidance', async () => {
  hfBehavior.configured = false;
  const hf = loadModule();
  await assert.rejects(() => hf.startImageJob('p1', 'x'), /not configured/);
});

test('refreshJob: completed → downloads, mirrors, appends variants', async () => {
  const hf = loadModule();
  await hf.startImageJob('p1', 'scene');
  hfBehavior.status = () => ({ status: 'completed', assets: [{ kind: 'image', url: 'https://cdn/a.png' }] });
  const { job, post } = await hf.refreshJob('p1', 'req-1');
  assert.equal(job.status, 'completed');
  assert.equal(post.meta.media_variants.length, 1);
  const v = post.meta.media_variants[0];
  assert.equal(v.kind, 'image');
  assert.match(v.bucket_url, /^https:\/\/bucket\.example\//);
  assert.equal(job.variant_ids[0], v.id);
});

test('refreshJob: nsfw surfaces the rephrase guidance and terminates', async () => {
  const hf = loadModule();
  await hf.startImageJob('p1', 'scene');
  hfBehavior.status = () => ({ status: 'nsfw', assets: [] });
  const { job } = await hf.refreshJob('p1', 'req-1');
  assert.equal(job.status, 'nsfw');
  assert.match(job.error, /msg:nsfw/);
});

test('startVideoJob uses meta duration clamped to the i2v envelope', async () => {
  rows.p1.meta = { duration_seconds: 30 };
  const fsReal = require('fs');
  const orig = fsReal.existsSync;
  fsReal.existsSync = () => true; // pretend orig.png is on disk
  try {
    const hf = loadModule();
    await hf.startVideoJob('p1', 'slow push in', 'current');
    const call = hfBehavior.submitted[0];
    assert.equal(call.model, 'dop/std');
    assert.equal(call.params.duration, 10); // 30s clamped to i2v max
    assert.match(call.params.image_url, /^https:\/\/bucket\.example\//);
  } finally {
    fsReal.existsSync = orig;
  }
});

test('useVariant flips image_url to the variant file', async () => {
  rows.p1.meta = {
    media_variants: [{ id: 'v1', kind: 'image', filename: 'hf-gen.png', bucket_url: 'https://bucket.example/hf-gen.png' }],
  };
  const fsReal = require('fs');
  const orig = fsReal.existsSync;
  fsReal.existsSync = () => true;
  try {
    const hf = loadModule();
    const { post } = await hf.useVariant('p1', 'v1');
    assert.equal(post.image_url, 'hf-gen.png');
  } finally {
    fsReal.existsSync = orig;
  }
});
