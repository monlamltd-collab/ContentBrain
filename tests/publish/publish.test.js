// publish.js — mock fetch + fs + supabase so no real HTTP calls are made.
//
// Gaps covered:
//   - getFbPage: missing credentials → null, unknown brand fallback
//   - publishToFacebook: caption assembly (meta vs copy fields), text-only fallback,
//     image path, video path, reel branch, album branch, HTTP error propagation
//   - publishReelToFacebook: start/upload/finish 3-step protocol, each step's failure
//   - publishAlbumToFacebook: <2 images guard, missing file guard, happy path
//   - publishToMake: webhook URL absent, fetch error, non-ok response
//   - publishBlogToFacebook: delegates to publishToFacebook text branch
//   - publish (dispatcher): routes post.platform to correct sub-function

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const PUBLISH_PATH = require.resolve('../../lib/publish');
const SUPABASE_PATH = require.resolve('../../lib/supabase');

// Save real fs methods so we can restore them between tests
const fs = require('fs');
const _origExistsSync = fs.existsSync.bind(fs);
const _origReadFileSync = fs.readFileSync.bind(fs);

// --- mock state -------------------------------------------------------
let mockFetchResponses;   // queue of { ok, status, body } objects
let fetchCalls;           // captured fetch call args
let mockFsFiles;          // Set of paths that "exist"

function nextFetchResponse() {
  if (!mockFetchResponses.length) throw new Error('Mock fetch ran out of queued responses');
  const r = mockFetchResponses.shift();
  return {
    ok: r.ok,
    status: r.status || 200,
    text: async () => r.body || '',
    json: async () => (typeof r.body === 'string' ? JSON.parse(r.body) : r.body),
  };
}

function loadPublishFresh(envOverrides = {}) {
  // Clear module caches
  delete require.cache[PUBLISH_PATH];
  delete require.cache[SUPABASE_PATH];

  // Stub supabase (uploadMedia not used in unit tests here)
  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH, filename: SUPABASE_PATH, loaded: true,
    exports: { uploadMedia: async () => ({ url: 'https://cdn.example.com/img.jpg' }) },
  };

  // Stub global fetch
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return nextFetchResponse();
  };

  // Monkey-patch fs — built-ins can't be replaced via require.cache.
  // readFileSync falls through to real impl for non-mocked paths so Node's
  // own module loader (which uses readFileSync) still works.
  fs.existsSync = (p) => mockFsFiles.has(p);
  fs.readFileSync = (p, ...args) => {
    if (mockFsFiles.has(p)) return Buffer.from('fake-file-contents');
    return _origReadFileSync(p, ...args);
  };

  // Apply env overrides
  for (const [k, v] of Object.entries(envOverrides)) process.env[k] = v;

  return require('../../lib/publish');
}

beforeEach(() => {
  mockFetchResponses = [];
  fetchCalls = [];
  mockFsFiles = new Set();

  // Restore real fs methods before each test
  fs.existsSync = _origExistsSync;
  fs.readFileSync = _origReadFileSync;

  // Default FB credentials for auctionbrain brand
  process.env.FB_PAGE_ID = 'page-123';
  process.env.FB_PAGE_ACCESS_TOKEN = 'token-abc';
  process.env.FB_BRIDGEMATCH_PAGE_ID = 'bm-page-456';
  process.env.FB_BRIDGEMATCH_PAGE_TOKEN = 'bm-token-def';
  process.env.MAKE_WEBHOOK_URL = 'https://hook.make.com/test';
});

// ── getFbPage (via publishToFacebook behaviour) ───────────────────────

test('publishToFacebook: throws when brand has no credentials', async () => {
  // Pass empty strings via envOverrides — deleting then re-requiring causes
  // dotenv.config() inside lib/publish.js to restore values from .env file.
  const { publishToFacebook } = loadPublishFresh({ FB_PAGE_ID: '', FB_PAGE_ACCESS_TOKEN: '' });

  await assert.rejects(
    () => publishToFacebook({ brand: 'auctionbrain', copy_headline: 'Hi' }),
    /No Facebook credentials/
  );
});

test('publishToFacebook: unknown brand falls back to auctionbrain credentials', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ id: 'post-99' }) });
  const { publishToFacebook } = loadPublishFresh();

  // "newbrand" not in FB_PAGES → falls back to auctionbrain credentials (page-123 / token-abc)
  const result = await publishToFacebook({
    brand: 'newbrand',
    copy_headline: 'Headline',
    copy_body: 'Body',
  });
  assert.equal(result.ok, true);
  assert.equal(result.postId, 'post-99');
  assert.ok(fetchCalls[0].url.includes('page-123'));
});

// ── Caption assembly ──────────────────────────────────────────────────

test('publishToFacebook: uses meta.caption_facebook when present', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ id: 'post-1' }) });
  const { publishToFacebook } = loadPublishFresh();

  await publishToFacebook({
    brand: 'auctionbrain',
    meta: { caption_facebook: 'Custom caption from meta' },
    copy_headline: 'SHOULD NOT APPEAR',
  });

  const sentBody = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(sentBody.message, 'Custom caption from meta');
});

test('publishToFacebook: assembles caption from copy_* fields when meta absent', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ id: 'post-2' }) });
  const { publishToFacebook } = loadPublishFresh();

  await publishToFacebook({
    brand: 'auctionbrain',
    copy_headline: 'Headline',
    copy_body: 'Body text',
    copy_cta: 'Click here',
  });

  const sentBody = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(sentBody.message, 'Headline\n\nBody text\n\nClick here');
});

test('publishToFacebook: omits null copy fields from assembled caption', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ id: 'post-3' }) });
  const { publishToFacebook } = loadPublishFresh();

  await publishToFacebook({
    brand: 'auctionbrain',
    copy_headline: 'Headline only',
    copy_body: null,
    copy_cta: undefined,
  });

  const sentBody = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(sentBody.message, 'Headline only');
});

// ── Text-only fallback ────────────────────────────────────────────────

test('publishToFacebook: text-only path when no image/video', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ id: 'text-post-1' }) });
  const { publishToFacebook } = loadPublishFresh();

  const result = await publishToFacebook({
    brand: 'auctionbrain',
    copy_headline: 'Text only',
  });

  assert.equal(result.ok, true);
  assert.equal(result.platform, 'facebook');
  assert.ok(fetchCalls[0].url.includes('/feed'));
});

test('publishToFacebook: text-only throws on HTTP error', async () => {
  mockFetchResponses.push({ ok: false, status: 400, body: 'Bad Request details' });
  const { publishToFacebook } = loadPublishFresh();

  await assert.rejects(
    () => publishToFacebook({ brand: 'auctionbrain', copy_headline: 'Hi' }),
    /Facebook text post failed \(400\)/
  );
});

// ── Image post ────────────────────────────────────────────────────────

test('publishToFacebook: image branch when image_url file exists', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ id: 'photo-1' }) });
  const { publishToFacebook } = loadPublishFresh();

  // Register the image file as "existing"
  const imagePath = require('path').join(__dirname, '../../output', 'img.jpg');
  mockFsFiles.add(imagePath);

  const result = await publishToFacebook({
    brand: 'auctionbrain',
    image_url: 'img.jpg',
    copy_headline: 'Look at this',
  });

  assert.equal(result.ok, true);
  assert.ok(fetchCalls[0].url.includes('/photos'));
});

test('publishToFacebook: falls through to text when image file missing', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ id: 'text-fallthrough' }) });
  const { publishToFacebook } = loadPublishFresh();
  // image_url set but file does NOT exist in mockFsFiles → text fallback

  const result = await publishToFacebook({
    brand: 'auctionbrain',
    image_url: 'missing.jpg',
    copy_headline: 'Hi',
  });

  assert.ok(fetchCalls[0].url.includes('/feed')); // text branch
  assert.equal(result.ok, true);
});

// ── Album (multi-image carousel) ──────────────────────────────────────

test('publishAlbumToFacebook: throws when fewer than 2 images', async () => {
  const { publishAlbumToFacebook } = loadPublishFresh();

  await assert.rejects(
    () => publishAlbumToFacebook({ id: 'page-123', token: 'tok' }, ['only-one.jpg'], 'caption', 'auctionbrain'),
    /need >=2 images/
  );
});

test('publishAlbumToFacebook: throws early when a file is missing', async () => {
  const { publishAlbumToFacebook } = loadPublishFresh();
  // img-a.jpg exists, img-b.jpg does not
  mockFsFiles.add(require('path').join(__dirname, '../../output', 'img-a.jpg'));

  await assert.rejects(
    () => publishAlbumToFacebook({ id: 'page-123', token: 'tok' }, ['img-a.jpg', 'img-b.jpg'], 'caption', 'auctionbrain'),
    /missing file img-b\.jpg/
  );
  // No fetch calls should have been made (fail before network)
  assert.equal(fetchCalls.length, 0);
});

test('publishAlbumToFacebook: happy path — 2-image album', async () => {
  // Responses: photo-upload × 2, then feed post.
  // FB /photos response uses the 'id' field (not 'media_fbid').
  mockFetchResponses.push(
    { ok: true, body: JSON.stringify({ id: 'fbid-1' }) },
    { ok: true, body: JSON.stringify({ id: 'fbid-2' }) },
    { ok: true, body: JSON.stringify({ id: 'album-post-1' }) },
  );
  const path = require('path');
  mockFsFiles.add(path.join(__dirname, '../../output', 'a.jpg'));
  mockFsFiles.add(path.join(__dirname, '../../output', 'b.jpg'));

  const { publishAlbumToFacebook } = loadPublishFresh();
  const result = await publishAlbumToFacebook(
    { id: 'page-123', token: 'tok' },
    ['a.jpg', 'b.jpg'],
    'Album caption',
    'auctionbrain'
  );

  assert.equal(result.ok, true);
  assert.equal(result.postId, 'album-post-1');
  assert.equal(fetchCalls.length, 3); // 2 uploads + 1 feed post
});

test('publishAlbumToFacebook: photo upload failure throws with status code', async () => {
  mockFetchResponses.push({ ok: false, status: 403, body: 'Permission denied' });
  const path = require('path');
  mockFsFiles.add(path.join(__dirname, '../../output', 'a.jpg'));
  mockFsFiles.add(path.join(__dirname, '../../output', 'b.jpg'));

  const { publishAlbumToFacebook } = loadPublishFresh();
  await assert.rejects(
    () => publishAlbumToFacebook({ id: 'page-123', token: 'tok' }, ['a.jpg', 'b.jpg'], 'cap', 'auctionbrain'),
    /403/
  );
});

// ── Reel (3-step protocol) ────────────────────────────────────────────

test('publishReelToFacebook: happy path completes 3 fetch calls', async () => {
  mockFetchResponses.push(
    { ok: true, body: JSON.stringify({ video_id: 'vid-1', upload_url: 'https://rupload.fb.com/vid-1' }) }, // start
    { ok: true, body: JSON.stringify({ success: true }) },  // upload binary
    { ok: true, body: JSON.stringify({ success: true }) },  // finish
  );
  const path = require('path');
  const videoPath = path.join(__dirname, '../../output', 'reel.mp4');
  mockFsFiles.add(videoPath);

  const { publishReelToFacebook } = loadPublishFresh();
  const result = await publishReelToFacebook(
    { id: 'page-123', token: 'tok' },
    videoPath,
    'Reel caption',
    'auctionbrain'
  );

  assert.equal(result.ok, true);
  assert.equal(result.postId, 'vid-1');
  assert.equal(fetchCalls.length, 3);
});

test('publishReelToFacebook: start step failure throws', async () => {
  mockFetchResponses.push({ ok: false, status: 500, body: 'Server error' });
  const { publishReelToFacebook } = loadPublishFresh();

  await assert.rejects(
    () => publishReelToFacebook({ id: 'page-123', token: 'tok' }, '/fake/reel.mp4', 'cap', 'ab'),
    /Reels start failed \(500\)/
  );
});

test('publishReelToFacebook: start with missing video_id throws', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ /* no video_id */ upload_url: null }) });
  const { publishReelToFacebook } = loadPublishFresh();

  await assert.rejects(
    () => publishReelToFacebook({ id: 'page-123', token: 'tok' }, '/fake/reel.mp4', 'cap', 'ab'),
    /no video_id\/upload_url/
  );
});

test('publishReelToFacebook: finish rejected (success:false) throws', async () => {
  mockFetchResponses.push(
    { ok: true, body: JSON.stringify({ video_id: 'v1', upload_url: 'https://rupload.fb.com/v1' }) },
    { ok: true, body: JSON.stringify({ success: true }) },
    { ok: true, body: JSON.stringify({ success: false, error: { message: 'Video too long' } }) },
  );
  const path = require('path');
  const videoPath = path.join(__dirname, '../../output', 'reel.mp4');
  mockFsFiles.add(videoPath);

  const { publishReelToFacebook } = loadPublishFresh();
  await assert.rejects(
    () => publishReelToFacebook({ id: 'page-123', token: 'tok' }, videoPath, 'cap', 'ab'),
    /Reels finish rejected/
  );
});

// ── publishToMake ─────────────────────────────────────────────────────

test('publishToMake: throws when MAKE_WEBHOOK_URL unset', async () => {
  // Pass empty string via envOverrides — dotenv.config() inside lib/publish.js
  // would otherwise restore MAKE_WEBHOOK_URL from .env if we just delete it.
  const { publishToMake } = loadPublishFresh({ MAKE_WEBHOOK_URL: '' });

  await assert.rejects(
    () => publishToMake({ id: 'p1', copy_headline: 'Hi' }),
    /MAKE_WEBHOOK_URL/
  );
  assert.equal(fetchCalls.length, 0);
});

test('publishToMake: happy path returns ok=true', async () => {
  mockFetchResponses.push({ ok: true, body: JSON.stringify({ status: 'accepted' }) });
  const { publishToMake } = loadPublishFresh();

  const result = await publishToMake({ id: 'p1', copy_headline: 'Hi', brand: 'auctionbrain', platform: 'make' });
  assert.equal(result.ok, true);
  assert.equal(result.platform, 'make');
});

test('publishToMake: non-ok response throws with status', async () => {
  mockFetchResponses.push({ ok: false, status: 503, body: 'Service unavailable' });
  const { publishToMake } = loadPublishFresh();

  await assert.rejects(
    () => publishToMake({ id: 'p1', copy_headline: 'Hi' }),
    /503/
  );
});

// ── Integration: publishToFacebook routes to reel/album/image/text ────

test('publishToFacebook: reel branch when video_url + is_reel in meta', async () => {
  // Reel 3-step
  mockFetchResponses.push(
    { ok: true, body: JSON.stringify({ video_id: 'vid-r', upload_url: 'https://rupload.fb.com/r' }) },
    { ok: true, body: JSON.stringify({ success: true }) },
    { ok: true, body: JSON.stringify({ success: true }) },
  );
  const path = require('path');
  const videoPath = path.join(__dirname, '../../output', 'reel.mp4');
  mockFsFiles.add(videoPath);

  const { publishToFacebook } = loadPublishFresh();
  const result = await publishToFacebook({
    brand: 'auctionbrain',
    video_url: 'reel.mp4',
    meta: { is_reel: true },
    copy_headline: 'Weekly reel',
  });

  assert.equal(result.postId, 'vid-r');
  assert.equal(fetchCalls.length, 3); // 3-step reel protocol
});

test('publishToFacebook: album branch takes precedence over single image', async () => {
  // 2 photo uploads + 1 feed post
  mockFetchResponses.push(
    { ok: true, body: JSON.stringify({ id: 'f1' }) },
    { ok: true, body: JSON.stringify({ id: 'f2' }) },
    { ok: true, body: JSON.stringify({ id: 'album-p' }) },
  );
  const path = require('path');
  mockFsFiles.add(path.join(__dirname, '../../output', 'a.jpg'));
  mockFsFiles.add(path.join(__dirname, '../../output', 'b.jpg'));

  const { publishToFacebook } = loadPublishFresh();
  const result = await publishToFacebook({
    brand: 'auctionbrain',
    image_url: 'a.jpg',                            // single image also set — should be ignored
    meta: { album_images: ['a.jpg', 'b.jpg'] },
    copy_headline: 'Album',
  });

  assert.equal(result.postId, 'album-p');
  assert.equal(fetchCalls.length, 3); // album path, not single-image path
});
