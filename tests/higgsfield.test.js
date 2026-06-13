// lib/higgsfield.js — platform API client (PR3).
// Pattern mirrors tests/firecrawl.test.js: stub global.fetch, reload the
// module fresh per test so env-var changes take effect.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const MOD_PATH = require.resolve('../lib/higgsfield');
const realFetch = global.fetch;

let fetchCalls;
let fetchResponder;

function loadFresh() {
  delete require.cache[MOD_PATH];
  return require(MOD_PATH);
}

beforeEach(() => {
  fetchCalls = [];
  fetchResponder = null;
  process.env.HIGGSFIELD_API_KEY = 'test-key';
  process.env.HIGGSFIELD_API_SECRET = 'test-secret';
  delete process.env.HIGGSFIELD_SOUL_MODEL;
  delete process.env.HIGGSFIELD_I2V_MODEL;
  global.fetch = async (url, opts = {}) => {
    fetchCalls.push({ url: String(url), opts });
    return fetchResponder(String(url), opts);
  };
});

afterEach(() => {
  global.fetch = realFetch;
});

function jsonResponse(body, { status = 200, contentType = 'application/json' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? contentType : null) },
    json: async () => body,
    text: async () => JSON.stringify(body),
    arrayBuffer: async () => Buffer.from(JSON.stringify(body)),
  };
}

test('isHiggsfieldConfigured needs BOTH env vars', () => {
  const hf = loadFresh();
  assert.equal(hf.isHiggsfieldConfigured(), true);
  delete process.env.HIGGSFIELD_API_SECRET;
  assert.equal(hf.isHiggsfieldConfigured(), false);
});

test('auth header is `Key key:secret`', () => {
  const hf = loadFresh();
  assert.equal(hf._internals.authHeader(), 'Key test-key:test-secret');
});

test('submitGeneration posts params to /{modelId} and returns request_id', async () => {
  fetchResponder = () => jsonResponse({ request_id: 'req-123' });
  const hf = loadFresh();
  const out = await hf.submitGeneration('higgsfield-ai/soul/standard', { prompt: 'p', aspect_ratio: '1:1' });
  assert.equal(out.request_id, 'req-123');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /platform\.higgsfield\.ai\/higgsfield-ai\/soul\/standard$/);
  assert.equal(fetchCalls[0].opts.method, 'POST');
  assert.deepEqual(JSON.parse(fetchCalls[0].opts.body), { prompt: 'p', aspect_ratio: '1:1' });
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Key test-key:test-secret');
});

test('submitGeneration: missing request_id and non-OK responses throw with detail', async () => {
  const hf = loadFresh();
  fetchResponder = () => jsonResponse({ nope: true });
  await assert.rejects(() => hf.submitGeneration('m', {}), /no request_id/);
  fetchResponder = () => jsonResponse({ error: 'Insufficient credits' }, { status: 402 });
  await assert.rejects(() => hf.submitGeneration('m', {}), /Higgsfield 402/);
});

test('getStatus normalizes statuses and extracts assets on completion', async () => {
  const hf = loadFresh();
  for (const [raw, expected] of [
    ['queued', 'queued'], ['in_progress', 'in_progress'], ['processing', 'in_progress'],
    ['completed', 'completed'], ['succeeded', 'completed'],
    ['nsfw', 'nsfw'], ['failed', 'failed'], ['error', 'failed'], ['mystery', 'queued'],
  ]) {
    fetchResponder = () => jsonResponse({ status: raw });
    const out = await hf.getStatus('r1');
    assert.equal(out.status, expected, `${raw} → ${expected}`);
  }

  fetchResponder = () => jsonResponse({
    status: 'completed',
    images: [{ url: 'https://cdn.x/a.png' }],
    result: { video: { url: 'https://cdn.x/b.mp4' } },
  });
  const done = await hf.getStatus('r1');
  assert.equal(done.assets.length, 2);
  assert.deepEqual(done.assets.find(a => a.kind === 'image').url, 'https://cdn.x/a.png');
  assert.deepEqual(done.assets.find(a => a.kind === 'video').url, 'https://cdn.x/b.mp4');
});

test('extractAssets infers video kind from extension and dedupes', () => {
  const hf = loadFresh();
  const assets = hf.extractAssets({
    results: [{ url: 'https://cdn.x/clip.mp4' }, { url: 'https://cdn.x/clip.mp4' }],
  });
  assert.equal(assets.length, 1);
  assert.equal(assets[0].kind, 'video');
});

test('waitForCompletion resolves on terminal status and times out otherwise', async () => {
  const hf = loadFresh();
  let polls = 0;
  fetchResponder = () => jsonResponse({ status: ++polls >= 3 ? 'completed' : 'queued' });
  const out = await hf.waitForCompletion('r1', { timeoutMs: 5000, pollMs: 5 });
  assert.equal(out.status, 'completed');

  fetchResponder = () => jsonResponse({ status: 'queued' });
  await assert.rejects(
    () => hf.waitForCompletion('r2', { timeoutMs: 30, pollMs: 5 }),
    /timed out/
  );
});

test('downloadAsset writes to output/ with sanitized prefix + inferred extension', async () => {
  const hf = loadFresh();
  fetchResponder = () => ({
    ok: true, status: 200,
    headers: { get: (k) => (k.toLowerCase() === 'content-type' ? 'image/png' : null) },
    arrayBuffer: async () => Buffer.from([137, 80, 78, 71]),
  });
  const { filename, outputPath } = await hf.downloadAsset('https://cdn.x/whatever?sig=1', '../evil/pre fix!');
  try {
    assert.match(filename, /^evil-pre-fix--\d+\.png$|^-?evil.*\.png$/);
    assert.ok(!filename.includes('/') && !filename.includes('\\'));
    assert.ok(fs.existsSync(outputPath));
    assert.equal(path.dirname(outputPath), path.join(__dirname, '..', 'output'));
  } finally {
    if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
  }
});

test('classifyError maps nsfw/failed/timeout/config to operator guidance', () => {
  const hf = loadFresh();
  assert.equal(hf.classifyError('nsfw').code, 'nsfw');
  assert.match(hf.classifyError('nsfw').userMessage, /rephrase/i);
  assert.equal(hf.classifyError('failed').code, 'failed');
  assert.equal(hf.classifyError(new Error('job r1 timed out after 300s')).code, 'timeout');
  assert.equal(hf.classifyError(new Error('Higgsfield not configured — set keys')).code, 'config');
  assert.equal(hf.classifyError(new Error('Higgsfield 500 for /x: boom')).code, 'http');
});
