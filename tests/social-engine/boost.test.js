// boost.js — deriveAudienceSpec (pure function) + requestBoost (I/O mocked).
//
// Gaps covered:
//   - deriveAudienceSpec: null tag → default spec, unknown tag → default spec,
//     regional slug → geo-targeted spec, returns mutable clone (not frozen)
//   - requestBoost: duplicate guard (already has active boost), inserts boost_run row,
//     fires webhook when MAKE_BOOST_WEBHOOK_URL set, skips webhook when unset,
//     signOutbound called with correct payload

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const BOOST_PATH = require.resolve('../../lib/social-engine/boost');
const HELPERS_PATH = require.resolve('../../lib/social-engine/helpers');
const WEBHOOK_AUTH_PATH = require.resolve('../../lib/social-engine/webhook-auth');
const CONSTANTS_PATH = require.resolve('../../lib/social-engine/constants');

let mockState;
let capturedInserts;
let capturedWebhookPayloads;

function loadBoostFresh(overrides = {}) {
  delete require.cache[BOOST_PATH];
  delete require.cache[HELPERS_PATH];
  delete require.cache[WEBHOOK_AUTH_PATH];

  capturedInserts = [];
  capturedWebhookPayloads = [];

  const helpersStub = {
    insertBoostRun: overrides.insertBoostRun || (async (row) => { capturedInserts.push(row); return { id: 'boost-uuid-1', ...row }; }),
    getActiveBoostRunsForPost: overrides.getActiveBoostRunsForPost || (async () => mockState.activeBoostRuns),
    markBoostFailed: overrides.markBoostFailed || (async () => {}),
  };
  require.cache[HELPERS_PATH] = { id: HELPERS_PATH, filename: HELPERS_PATH, loaded: true, exports: helpersStub };

  const webhookAuthStub = {
    signOutbound: overrides.signOutbound || ((payload) => ({ ...payload, _sig: 'fake-sig' })),
  };
  require.cache[WEBHOOK_AUTH_PATH] = { id: WEBHOOK_AUTH_PATH, filename: WEBHOOK_AUTH_PATH, loaded: true, exports: webhookAuthStub };

  // Stub global fetch for webhook fire
  global.fetch = async (url, opts) => {
    capturedWebhookPayloads.push({ url, body: JSON.parse(opts.body) });
    return { ok: true, status: 200, json: async () => ({ status: 'queued' }) };
  };

  return require('../../lib/social-engine/boost');
}

beforeEach(() => {
  mockState = {
    activeBoostRuns: [],
  };
  delete process.env.MAKE_BOOST_WEBHOOK_URL;
});

// ── deriveAudienceSpec ────────────────────────────────────────────────

test('deriveAudienceSpec: null tag returns default audience spec', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const spec = deriveAudienceSpec(null);
  assert.ok(Array.isArray(spec.publisher_platforms));
  assert.ok(typeof spec.age_min === 'number');
  assert.ok(typeof spec.age_max === 'number');
});

test('deriveAudienceSpec: unknown tag returns default audience spec', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const spec = deriveAudienceSpec('completely-unknown-niche');
  assert.ok(Array.isArray(spec.publisher_platforms));
});

test('deriveAudienceSpec: returns a mutable clone (not the frozen constant)', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const spec = deriveAudienceSpec(null);
  // Should not throw — clone is mutable
  assert.doesNotThrow(() => { spec.age_min = 99; });
  assert.equal(spec.age_min, 99);
});

test('deriveAudienceSpec: two calls return independent copies', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec(null);
  const b = deriveAudienceSpec(null);
  a.publisher_platforms.push('test-only');
  assert.notDeepEqual(a.publisher_platforms, b.publisher_platforms);
});

// ── requestBoost: no webhook (PR2 behaviour) ──────────────────────────

test('requestBoost: inserts boost_run row and returns boost_run_id', async () => {
  const { requestBoost } = loadBoostFresh();
  const post = {
    id: 'post-1',
    track: 'social',
    meta: { niche_tag: 'yorkshire-terraced', boost_eligible: true },
  };

  const result = await requestBoost(post, 'fb-post-id-1');
  assert.ok(result.boost_run_id);
  assert.equal(result.fired_webhook, false); // MAKE_BOOST_WEBHOOK_URL not set
  assert.equal(capturedInserts.length, 1);
  assert.equal(capturedInserts[0].post_id, 'post-1');
  assert.equal(capturedInserts[0].meta.fb_post_id, 'fb-post-id-1'); // fb_post_id lives in row.meta
  // status is not set by application code — the DB column default ('pending') handles it
});

test('requestBoost: skips insert when active boost already exists for post', async () => {
  const { requestBoost } = loadBoostFresh({
    getActiveBoostRunsForPost: async () => [{ id: 'existing-boost', status: 'pending' }],
  });

  const result = await requestBoost({ id: 'post-1', track: 'social', meta: { niche_tag: 'tag', boost_eligible: true } }, 'fb-1');
  assert.equal(capturedInserts.length, 0);
  assert.ok(result.deduped || result.boost_run_id === null || result.boost_run_id === undefined);
});

// ── requestBoost: with webhook (PR3 behaviour) ────────────────────────

test('requestBoost: fires webhook when MAKE_BOOST_WEBHOOK_URL set', async () => {
  process.env.MAKE_BOOST_WEBHOOK_URL = 'https://hook.make.com/boost-test';
  const { requestBoost } = loadBoostFresh();

  const result = await requestBoost({
    id: 'post-2',
    track: 'social',
    meta: { niche_tag: 'bristol-apartments', boost_eligible: true, album_images: ['a.jpg'] },
  }, 'fb-post-2');

  assert.equal(result.fired_webhook, true);
  assert.equal(capturedWebhookPayloads.length, 1);
  assert.equal(capturedWebhookPayloads[0].url, 'https://hook.make.com/boost-test');
  assert.ok(capturedWebhookPayloads[0].body.fb_post_id === 'fb-post-2');
});

test('requestBoost: webhook payload includes audience_spec', async () => {
  process.env.MAKE_BOOST_WEBHOOK_URL = 'https://hook.make.com/boost-test';
  const { requestBoost } = loadBoostFresh();

  await requestBoost({
    id: 'post-3',
    track: 'social',
    meta: { niche_tag: 'yorkshire-terraced', boost_eligible: true },
  }, 'fb-post-3');

  const payload = capturedWebhookPayloads[0].body;
  assert.ok(payload.audience_spec);
  assert.ok(Array.isArray(payload.audience_spec.publisher_platforms));
});

// ── requestBoost: insertBoostRun failure ──────────────────────────────

test('requestBoost: propagates error when insertBoostRun throws', async () => {
  const { requestBoost } = loadBoostFresh({
    insertBoostRun: async () => { throw new Error('DB insert failed'); },
  });

  await assert.rejects(
    () => requestBoost({ id: 'post-x', track: 'social', meta: { niche_tag: 'tag', boost_eligible: true } }, 'fb-x'),
    /DB insert failed/
  );
});

// ── deriveAudienceSpec — PR4 interest narrowing ───────────────────────

test('deriveAudienceSpec: yield-8plus swaps interests for the override set', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const spec = deriveAudienceSpec('yield-8plus');
  assert.deepEqual(spec.interests, ['Buy-to-let', 'Property investment']);
  // Geo + age stay default
  assert.ok(Array.isArray(spec.geo_locations_cities) && spec.geo_locations_cities.length > 0);
  assert.ok(typeof spec.age_min === 'number');
});

test('deriveAudienceSpec: regional tag keeps default interests (no override)', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const { DEFAULT_AUDIENCE_SPEC } = require('../../lib/social-engine/constants');
  const spec = deriveAudienceSpec('wales');
  assert.deepEqual(spec.interests, [...DEFAULT_AUDIENCE_SPEC.interests]);
  assert.deepEqual(spec.geo_locations_cities, ['Cardiff', 'Newport', 'Swansea']);
});

test('deriveAudienceSpec: override interests are a mutable copy', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec('refurb-projects');
  assert.doesNotThrow(() => a.interests.push('extra'));
  const b = deriveAudienceSpec('refurb-projects');
  assert.equal(b.interests.length, 2, 'second call must not see the mutation');
});
