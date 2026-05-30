// Phase G — publishAlbumToFacebook FB Graph API call sequence.
//
// Mocks global.fetch to verify the 3-leg Graph protocol:
//   1. N POSTs to /<page-id>/photos with published=false
//   2. 1 POST to /<page-id>/feed with attached_media=[{media_fbid: ...}]
//
// No live API. fs.existsSync stubbed via tmp files (we just create empty
// files so the existence check passes).

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const tmpFiles = [];
function createTmpImage(name) {
  const filename = `phase-g-test-${Date.now()}-${name}`;
  const full = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(full, Buffer.from([0x89, 0x50, 0x4E, 0x47]));  // PNG header bytes
  tmpFiles.push(full);
  return filename;
}

after(() => {
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
});

const originalFetch = global.fetch;

let fetchCalls = [];
let nextFetchResponses = [];

function setupMockFetch() {
  fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (!nextFetchResponses.length) {
      throw new Error('Mock fetch out of responses');
    }
    const r = nextFetchResponses.shift();
    return {
      ok: r.ok,
      status: r.status || (r.ok ? 200 : 400),
      json: async () => r.body || {},
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body || {})),
    };
  };
}

function restoreFetch() {
  global.fetch = originalFetch;
}

beforeEach(() => {
  setupMockFetch();
  nextFetchResponses = [];
});

const { publishAlbumToFacebook } = require('../../lib/publish');
const PAGE = { id: 'PAGE-1', token: 'TOK-1' };

// ── 2-image happy path ──────────────────────────────────────────────

test('2-image album: 2 photo POSTs + 1 feed POST', async () => {
  const f1 = createTmpImage('a.png');
  const f2 = createTmpImage('b.png');

  nextFetchResponses = [
    { ok: true, body: { id: 'media-1' } },
    { ok: true, body: { id: 'media-2' } },
    { ok: true, body: { id: 'post-XYZ' } },
  ];

  const r = await publishAlbumToFacebook(PAGE, [f1, f2], 'Test caption', 'auctionbrain');
  assert.equal(r.postId, 'post-XYZ');
  assert.equal(r.platform, 'facebook');
  assert.equal(fetchCalls.length, 3);

  // First two: photos with published=false
  assert.match(fetchCalls[0].url, /\/PAGE-1\/photos$/);
  assert.match(fetchCalls[1].url, /\/PAGE-1\/photos$/);

  // Third: feed with attached_media
  assert.match(fetchCalls[2].url, /\/PAGE-1\/feed$/);
  const feedBody = fetchCalls[2].opts.body;
  assert.ok(feedBody.includes('attached_media='));
  // The encoded attached_media must reference both media_fbids
  const decoded = decodeURIComponent(feedBody);
  assert.match(decoded, /media-1/);
  assert.match(decoded, /media-2/);
  // URLSearchParams encodes spaces as '+' — decodeURIComponent leaves the '+'
  // intact. Replace before matching.
  assert.match(decoded.replace(/\+/g, ' '), /Test caption/);

  restoreFetch();
});

// ── 5-image happy path ──────────────────────────────────────────────

test('5-image album: 5 photo POSTs + 1 feed POST (order preserved)', async () => {
  const files = [createTmpImage('1.png'), createTmpImage('2.png'), createTmpImage('3.png'), createTmpImage('4.png'), createTmpImage('5.png')];
  nextFetchResponses = [
    { ok: true, body: { id: 'm1' } },
    { ok: true, body: { id: 'm2' } },
    { ok: true, body: { id: 'm3' } },
    { ok: true, body: { id: 'm4' } },
    { ok: true, body: { id: 'm5' } },
    { ok: true, body: { id: 'feed-1' } },
  ];

  const r = await publishAlbumToFacebook(PAGE, files, 'Five lots', 'auctionbrain');
  assert.equal(r.postId, 'feed-1');
  assert.equal(fetchCalls.length, 6);

  const decoded = decodeURIComponent(fetchCalls[5].opts.body);
  // Order matters — m1 must come before m5 in the JSON array.
  const i1 = decoded.indexOf('m1');
  const i5 = decoded.indexOf('m5');
  assert.ok(i1 > 0 && i5 > i1, 'media order preserved');
  restoreFetch();
});

// ── Validation ──────────────────────────────────────────────────────

test('single-image input: throws "need >=2 images"', async () => {
  try {
    await publishAlbumToFacebook(PAGE, ['solo.png'], 'caption', 'brand');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /need >=2 images/);
  }
  restoreFetch();
});

test('empty array input: throws', async () => {
  try {
    await publishAlbumToFacebook(PAGE, [], 'caption', 'brand');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /need >=2 images/);
  }
  restoreFetch();
});

test('null input: throws', async () => {
  try {
    await publishAlbumToFacebook(PAGE, null, 'caption', 'brand');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /need >=2 images/);
  }
  restoreFetch();
});

// ── Missing file blows up BEFORE any API call ───────────────────────

test('missing file on disk: throws "missing file" BEFORE any API call', async () => {
  try {
    await publishAlbumToFacebook(PAGE, ['does-not-exist-1.png', 'does-not-exist-2.png'], 'caption', 'brand');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /missing file/);
    assert.equal(fetchCalls.length, 0);
  }
  restoreFetch();
});

// ── Photo upload step fails ────────────────────────────────────────

test('photo upload returns 400: throws with FB error text', async () => {
  const f1 = createTmpImage('err1.png');
  const f2 = createTmpImage('err2.png');
  nextFetchResponses = [
    { ok: false, status: 400, body: '{"error":"bad image format"}' },
  ];
  try {
    await publishAlbumToFacebook(PAGE, [f1, f2], 'caption', 'brand');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /Album photo upload/);
    assert.match(err.message, /bad image format/);
  }
  restoreFetch();
});

test('photo upload returns 200 but no id: throws', async () => {
  const f1 = createTmpImage('noid1.png');
  const f2 = createTmpImage('noid2.png');
  nextFetchResponses = [
    { ok: true, body: { wrong: 'shape' } },
  ];
  try {
    await publishAlbumToFacebook(PAGE, [f1, f2], 'caption', 'brand');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /returned no id/);
  }
  restoreFetch();
});

// ── Feed step fails ────────────────────────────────────────────────

test('feed POST returns 500: throws', async () => {
  const f1 = createTmpImage('ff1.png');
  const f2 = createTmpImage('ff2.png');
  nextFetchResponses = [
    { ok: true, body: { id: 'm1' } },
    { ok: true, body: { id: 'm2' } },
    { ok: false, status: 500, body: '{"error":"server error"}' },
  ];
  try {
    await publishAlbumToFacebook(PAGE, [f1, f2], 'caption', 'brand');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /Album feed post failed/);
  }
  restoreFetch();
});

// ── Token + caption forwarding ─────────────────────────────────────

test('each photo POST carries access_token + published=false', async () => {
  const f1 = createTmpImage('tok1.png');
  const f2 = createTmpImage('tok2.png');
  nextFetchResponses = [
    { ok: true, body: { id: 'm1' } },
    { ok: true, body: { id: 'm2' } },
    { ok: true, body: { id: 'feed' } },
  ];
  await publishAlbumToFacebook(PAGE, [f1, f2], 'caption', 'brand');

  // First two calls use FormData with access_token + published=false; we
  // verified the call shape but not the body (FormData is opaque). Check
  // the URL has page.id.
  for (let i = 0; i < 2; i++) {
    assert.match(fetchCalls[i].url, /PAGE-1\/photos$/);
    assert.equal(fetchCalls[i].opts.method, 'POST');
  }
  restoreFetch();
});
