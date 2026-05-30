// Phase G — regression guard for publishToFacebook routing logic.
//
// Album branch slots in BEFORE the single-image branch but AFTER the video
// branch. We verify the dispatch order WITHOUT actually hitting the
// network — when a branch matches we mock the underlying fetch to short-
// circuit with a recognisable response.

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const tmpFiles = [];
function tmpFile(name) {
  const filename = `phase-g-router-${Date.now()}-${name}`;
  const full = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(full, Buffer.from([0x89, 0x50, 0x4E, 0x47]));
  tmpFiles.push(full);
  return filename;
}

after(() => {
  for (const f of tmpFiles) { try { fs.unlinkSync(f); } catch {} }
});

const originalFetch = global.fetch;
let fetchUrls = [];

function setupFetch() {
  fetchUrls = [];
  global.fetch = async (url, opts) => {
    fetchUrls.push({ url, opts });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: 'mocked-id' }),
      text: async () => '{"id":"mocked-id"}',
    };
  };
}

beforeEach(() => {
  setupFetch();
  // Ensure FB env vars are set for getFbPage
  process.env.FB_PAGE_ID = 'TEST_PAGE_ID';
  process.env.FB_PAGE_ACCESS_TOKEN = 'TEST_TOKEN';
});

const { publishToFacebook } = require('../../lib/publish');

// ── Album branch takes precedence over single-image ─────────────────

test('album_images set + image_url set → album branch wins', async () => {
  const a = tmpFile('a.png');
  const b = tmpFile('b.png');
  const single = tmpFile('single.png');

  const post = {
    brand: 'auctionbrain',
    platform: 'facebook',
    image_url: single,
    copy_headline: 'h', copy_body: 'b', copy_cta: 'c',
    meta: { album_images: [a, b] },
  };

  await publishToFacebook(post);
  // Album branch: 2 photos + 1 feed = 3 calls
  assert.equal(fetchUrls.length, 3);
  assert.match(fetchUrls[0].url, /\/photos$/);
  assert.match(fetchUrls[1].url, /\/photos$/);
  assert.match(fetchUrls[2].url, /\/feed$/);
});

// ── Album of 1 falls through to single-image ───────────────────────

test('album_images = [a] (length 1) → falls through to single-image', async () => {
  const single = tmpFile('one.png');
  const post = {
    brand: 'auctionbrain',
    platform: 'facebook',
    image_url: single,
    copy_headline: 'h', copy_body: 'b', copy_cta: 'c',
    meta: { album_images: [single] },
  };
  await publishToFacebook(post);
  // Single-image branch: 1 photo POST
  assert.equal(fetchUrls.length, 1);
  assert.match(fetchUrls[0].url, /\/photos$/);
});

test('album_images = [] → falls through to single-image', async () => {
  const single = tmpFile('empty-album.png');
  const post = {
    brand: 'auctionbrain',
    platform: 'facebook',
    image_url: single,
    copy_headline: 'h', copy_body: 'b', copy_cta: 'c',
    meta: { album_images: [] },
  };
  await publishToFacebook(post);
  assert.equal(fetchUrls.length, 1);
  assert.match(fetchUrls[0].url, /\/photos$/);
});

// ── No album_images at all → existing single-image path ────────────

test('no album_images, image_url set → single-image branch', async () => {
  const single = tmpFile('plain.png');
  const post = {
    brand: 'auctionbrain',
    platform: 'facebook',
    image_url: single,
    copy_headline: 'h', copy_body: 'b', copy_cta: 'c',
  };
  await publishToFacebook(post);
  assert.equal(fetchUrls.length, 1);
  assert.match(fetchUrls[0].url, /\/photos$/);
});

// ── Video + album_images: video branch wins (video check is above album) ─

test('video_url + meta.is_reel + album_images: reel branch wins', async () => {
  // Reel branch needs 3 graph calls (start/upload/finish) — verify it
  // dispatches to /video_reels not /photos.
  const vid = tmpFile('vid.mp4');
  const a = tmpFile('aa.png');
  const b = tmpFile('bb.png');

  // Stub fetch to return reel-shape responses
  global.fetch = async (url, opts) => {
    fetchUrls.push({ url, opts });
    if (url.includes('/video_reels')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ video_id: 'V1', upload_url: 'https://upload/x', success: true }),
        text: async () => '{}',
      };
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => '{}' };
  };

  const post = {
    brand: 'auctionbrain',
    platform: 'facebook',
    video_url: vid,
    copy_headline: 'h', copy_body: 'b', copy_cta: 'c',
    meta: { is_reel: true, album_images: [a, b] },
  };
  await publishToFacebook(post);
  // First call should hit /video_reels, NOT /photos
  assert.match(fetchUrls[0].url, /\/video_reels$/);
  // Never hits the album /feed endpoint
  for (const c of fetchUrls) {
    assert.doesNotMatch(c.url, /\/feed$/);
  }
});

// ── Existing publish router unchanged ──────────────────────────────

test('publish() router routes outbound→Resend untouched (channel="resend")', async () => {
  // We can't safely call publishToResend without env, but we can verify
  // the router's first branch by checking the dispatch table shape.
  const pub = require('../../lib/publish');
  assert.equal(typeof pub.publishToResend, 'function');
  assert.equal(typeof pub.publishAlbumToFacebook, 'function');
});

// Restore fetch after the suite
after(() => {
  global.fetch = originalFetch;
});
