// Sanity checks for Phase G constants. Frozen-enum invariants and decision
// sentinels (TARGET_MONET_RATIO, BOOST_OBJECTIVE) live here so a drift to
// the constants file fails loudly.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const c = require('../../lib/social-engine/constants');

test('constants: SOCIAL_MODES is frozen', () => {
  assert.equal(Object.isFrozen(c.SOCIAL_MODES), true);
  // Silent-fail mutation should leave the value untouched (non-strict)
  // OR throw (strict). Either way the value must not change.
  const orig = c.SOCIAL_MODES.MONET;
  try { c.SOCIAL_MODES.MONET = 'changed'; } catch { /* expected in strict mode */ }
  assert.equal(c.SOCIAL_MODES.MONET, orig);
});

test('constants: SOCIAL_TYPES is frozen', () => {
  assert.equal(Object.isFrozen(c.SOCIAL_TYPES), true);
  const orig = c.SOCIAL_TYPES.HERO_ALBUM;
  try { c.SOCIAL_TYPES.HERO_ALBUM = 'changed'; } catch { /* expected in strict mode */ }
  assert.equal(c.SOCIAL_TYPES.HERO_ALBUM, orig);
});

test('constants: SOCIAL_TYPE_LIST matches SOCIAL_TYPES values', () => {
  const fromObj = Object.values(c.SOCIAL_TYPES).sort();
  const fromList = [...c.SOCIAL_TYPE_LIST].sort();
  assert.deepEqual(fromList, fromObj);
});

test('constants: TYPE_MODE_BIAS keys match SOCIAL_TYPE_LIST', () => {
  const k = Object.keys(c.TYPE_MODE_BIAS).sort();
  const l = [...c.SOCIAL_TYPE_LIST].sort();
  assert.deepEqual(k, l);
});

test('constants: TYPE_MODE_BIAS values are monet|traffic|either', () => {
  for (const v of Object.values(c.TYPE_MODE_BIAS)) {
    assert.ok(['monet', 'traffic', 'either'].includes(v), `bad bias '${v}'`);
  }
});

test('constants: every postcode prefix is uppercase + alpha-only', () => {
  for (const [, region] of Object.entries(c.REGIONAL_PRESET)) {
    for (const p of region.postcode_prefixes) {
      assert.match(p, /^[A-Z]{1,2}$/, `${p} should be 1-2 uppercase letters`);
    }
  }
});

test('constants: BOOST_OBJECTIVE === OUTCOME_ENGAGEMENT (decision #5 sentinel)', () => {
  assert.equal(c.BOOST_OBJECTIVE, 'OUTCOME_ENGAGEMENT');
});

test('constants: TARGET_MONET_RATIO === 0.70 (decision sentinel)', () => {
  assert.equal(c.TARGET_MONET_RATIO, 0.70);
});

test('constants: DEFAULT_DAILY_BUDGET_PENCE === 200 (£2/day decision #7)', () => {
  assert.equal(c.DEFAULT_DAILY_BUDGET_PENCE, 200);
});

test('constants: SOCIAL_BRAND is auctionbrain (decision #1 — single Page)', () => {
  assert.equal(c.SOCIAL_BRAND, 'auctionbrain');
});

test('constants: SOCIAL_TRACK is "social"', () => {
  assert.equal(c.SOCIAL_TRACK, 'social');
});

test('constants: BOOST_STATUSES includes the 4 lifecycle states', () => {
  assert.deepEqual([...c.BOOST_STATUSES].sort(), ['active', 'complete', 'failed', 'pending']);
});

test('constants: NICHE_TAG_LIST has 12 tags (lead-confirmed menu)', () => {
  assert.equal(c.NICHE_TAG_LIST.length, 12);
});

test('constants: NICHE_TAG_LABELS keys match NICHE_TAG_LIST', () => {
  const k = Object.keys(c.NICHE_TAG_LABELS).sort();
  const l = [...c.NICHE_TAG_LIST].sort();
  assert.deepEqual(k, l);
});

test('constants: REGIONAL_PRESET keys appear in NICHE_TAG_LIST (slugified)', () => {
  for (const region of Object.values(c.REGIONAL_PRESET)) {
    assert.ok(
      c.NICHE_TAG_LIST.includes(region.slug),
      `regional preset slug '${region.slug}' must appear in NICHE_TAG_LIST`
    );
  }
});

test('constants: PUBLISH_SLOTS has 2 entries with valid hour/minute', () => {
  assert.equal(c.PUBLISH_SLOTS.length, 2);
  for (const s of c.PUBLISH_SLOTS) {
    assert.ok(s.hour >= 0 && s.hour < 24);
    assert.ok(s.minute >= 0 && s.minute < 60);
  }
});

test('constants: CB_SOCIAL_* prefixes are < 25 chars (Telegram 64-byte cap)', () => {
  for (const key of ['CB_SOCIAL_AMPLIFY', 'CB_SOCIAL_BOOST_NOW', 'CB_SOCIAL_PAUSE']) {
    assert.ok(c[key].length < 25, `${key}='${c[key]}' is ${c[key].length} chars; must be <25`);
  }
});

test('constants: smoke-require helpers.js does not throw at module-load', () => {
  // Loading helpers requires lib/supabase which needs SUPABASE_URL/KEY at
  // module load time. We don't call any helper here; we just confirm the
  // module loads and exports the expected surface. If Supabase env isn't
  // configured, lib/supabase still constructs a client object — the network
  // call only happens on a query.
  const h = require('../../lib/social-engine/helpers');
  assert.equal(typeof h.getSocialModeCounts, 'function');
  assert.equal(typeof h.insertBoostRun, 'function');
  assert.equal(typeof h.aggregateLotStats, 'function');
  assert.equal(typeof h.isBreakoutActive, 'function');
});
