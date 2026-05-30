// Phase G — boost.js + helpers boost_runs surface coverage.
//
// Mocks lib/supabase + lib/social-engine/helpers's underlying supabase
// client. Tests:
//   - deriveAudienceSpec(null) returns DEFAULT_AUDIENCE_SPEC
//   - deriveAudienceSpec(regional slug) returns the region's cities/regions
//   - deriveAudienceSpec(unknown tag) falls back to DEFAULT
//   - requestBoost inserts a pending row + does not fire webhook when
//     MAKE_BOOST_WEBHOOK_URL is unset
//   - requestBoost calls insertBoostRun with the expected payload

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const BOOST_PATH = require.resolve('../../lib/social-engine/boost');
const HELPERS_PATH = require.resolve('../../lib/social-engine/helpers');

let insertCalls = [];
let insertResponse = null;

function loadBoostFresh() {
  delete require.cache[BOOST_PATH];
  delete require.cache[HELPERS_PATH];
  require.cache[HELPERS_PATH] = {
    id: HELPERS_PATH,
    filename: HELPERS_PATH,
    loaded: true,
    exports: {
      insertBoostRun: async (row) => {
        insertCalls.push(row);
        return insertResponse || { id: 'boost-1', ...row, status: 'pending' };
      },
    },
  };
  return require('../../lib/social-engine/boost');
}

beforeEach(() => {
  insertCalls = [];
  insertResponse = null;
  delete process.env.MAKE_BOOST_WEBHOOK_URL;
});

// ── deriveAudienceSpec ─────────────────────────────────────────

test('deriveAudienceSpec(null) returns default audience', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec(null);
  assert.ok(Array.isArray(a.geo_locations_cities));
  assert.ok(a.geo_locations_cities.includes('Cardiff'));
  assert.equal(a.age_min, 28);
});

test('deriveAudienceSpec("wales") returns Cardiff/Newport/Swansea + WLS region', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec('wales');
  assert.deepEqual(a.geo_locations_cities.sort(), ['Cardiff', 'Newport', 'Swansea']);
  assert.deepEqual(a.geo_locations_regions, [{ key: 'WLS' }]);
});

test('deriveAudienceSpec("south-yorkshire") returns Sheffield + Doncaster', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec('south-yorkshire');
  assert.deepEqual(a.geo_locations_cities.sort(), ['Doncaster', 'Sheffield']);
});

test('deriveAudienceSpec("manchester") returns Manchester only', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec('manchester');
  assert.deepEqual(a.geo_locations_cities, ['Manchester']);
});

test('deriveAudienceSpec("north-east") returns Newcastle + Sunderland', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec('north-east');
  assert.deepEqual(a.geo_locations_cities.sort(), ['Newcastle upon Tyne', 'Sunderland']);
});

test('deriveAudienceSpec(non-regional tag) falls back to default audience', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec('yield-8plus');
  assert.ok(a.geo_locations_cities.includes('Cardiff'));
  assert.ok(a.geo_locations_cities.includes('Sheffield'));
  assert.equal(a.age_min, 28);
});

test('deriveAudienceSpec returns mutable copies (not frozen)', () => {
  const { deriveAudienceSpec } = loadBoostFresh();
  const a = deriveAudienceSpec(null);
  // Must be safely mutable so Make can serialise / extend
  a.geo_locations_cities.push('TestCity');
  assert.ok(a.geo_locations_cities.includes('TestCity'));
});

// ── requestBoost ──────────────────────────────────────────────

test('requestBoost inserts pending row, fired_webhook=false (no env)', async () => {
  const { requestBoost } = loadBoostFresh();
  const post = {
    id: 'post-1',
    meta: { niche_tag: 'wales' },
  };
  const r = await requestBoost(post, 'fb-post-id-xyz');
  assert.equal(r.fired_webhook, false);
  assert.equal(r.boost_run_id, 'boost-1');
  assert.equal(insertCalls.length, 1);

  const payload = insertCalls[0];
  assert.equal(payload.post_id, 'post-1');
  assert.equal(payload.daily_budget_pence, 200);     // £2/day decision
  assert.equal(payload.duration_hours, 24);
  assert.equal(payload.meta.niche_tag, 'wales');
  assert.equal(payload.meta.fb_post_id, 'fb-post-id-xyz');
  assert.equal(payload.meta.source, 'orchestrator');
  // audience_spec derived from 'wales'
  assert.deepEqual(payload.audience_spec.geo_locations_cities.sort(), ['Cardiff', 'Newport', 'Swansea']);
});

test('requestBoost with no niche_tag → default audience', async () => {
  const { requestBoost } = loadBoostFresh();
  const post = { id: 'post-2', meta: {} };
  await requestBoost(post, 'fb-post-id-2');
  assert.equal(insertCalls.length, 1);
  const a = insertCalls[0].audience_spec;
  assert.ok(a.geo_locations_cities.includes('Cardiff'));
  assert.ok(a.geo_locations_cities.includes('Sheffield'));
});

test('requestBoost: MAKE_BOOST_WEBHOOK_URL unset → fired_webhook=false', async () => {
  delete process.env.MAKE_BOOST_WEBHOOK_URL;
  const { requestBoost } = loadBoostFresh();
  const r = await requestBoost({ id: 'p-3', meta: { niche_tag: 'manchester' } }, 'fb-3');
  assert.equal(r.fired_webhook, false);
});

test('requestBoost: MAKE_BOOST_WEBHOOK_URL set → still false in PR2 (webhook leg deferred)', async () => {
  process.env.MAKE_BOOST_WEBHOOK_URL = 'https://hooks.eu1.make.com/test';
  const { requestBoost } = loadBoostFresh();
  const r = await requestBoost({ id: 'p-4', meta: { niche_tag: 'wales' } }, 'fb-4');
  // PR2 stub — even with env set, fired_webhook stays false. PR3 flips this.
  assert.equal(r.fired_webhook, false);
});

test('requestBoost throws if insertBoostRun throws', async () => {
  delete require.cache[BOOST_PATH];
  delete require.cache[HELPERS_PATH];
  require.cache[HELPERS_PATH] = {
    id: HELPERS_PATH,
    filename: HELPERS_PATH,
    loaded: true,
    exports: {
      insertBoostRun: async () => { throw new Error('FK violation'); },
    },
  };
  const { requestBoost } = require('../../lib/social-engine/boost');
  try {
    await requestBoost({ id: 'p-x', meta: {} }, 'fb-x');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /FK violation/);
  }
});
