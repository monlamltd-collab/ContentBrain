// Phase G — picker.js edge cases.
//
// Mocks every lower-level helper (helpers.js + lib/supabase + lib/lot-picker)
// so we exercise the picker's dedupe + retry logic without hitting Supabase.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const PICKER_PATH = require.resolve('../../lib/social-engine/picker');
const HELPERS_PATH = require.resolve('../../lib/social-engine/helpers');
const SUPABASE_PATH = require.resolve('../../lib/supabase');
const LOT_PICKER_PATH = require.resolve('../../lib/lot-picker');

let mockState;

function loadPickerFresh(overrides = {}) {
  delete require.cache[PICKER_PATH];
  delete require.cache[HELPERS_PATH];
  delete require.cache[SUPABASE_PATH];
  delete require.cache[LOT_PICKER_PATH];

  const helpersStub = {
    findLotsByRegion: overrides.findLotsByRegion || (async () => mockState.regionLots),
    findLotsByYieldBand: overrides.findLotsByYieldBand || (async () => mockState.yieldLots),
    findLotsByDealTag: overrides.findLotsByDealTag || (async () => mockState.dealLots),
    aggregateLotStats: overrides.aggregateLotStats || (async (opts) => {
      if (opts && opts.groupBy) return mockState.aggGroup;
      return mockState.aggSummary;
    }),
    hasFeaturedAnyLot: overrides.hasFeaturedAnyLot || (async () => mockState.allFeatured),
    getRecentNicheTags: overrides.getRecentNicheTags || (async () => mockState.recentTags),
  };
  require.cache[HELPERS_PATH] = {
    id: HELPERS_PATH,
    filename: HELPERS_PATH,
    loaded: true,
    exports: helpersStub,
  };

  const supabaseStub = {
    findLotsByArchetype: overrides.findLotsByArchetype || (async () => mockState.archetypeLots),
    findLotsBySuperlative: overrides.findLotsBySuperlative || (async () => []),
    hasFeaturedLot: overrides.hasFeaturedLot || (async () => mockState.singleFeatured),
    supabase: {},
  };
  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH,
    filename: SUPABASE_PATH,
    loaded: true,
    exports: supabaseStub,
  };

  const lotPickerStub = {
    pickLotOfTheDay: overrides.pickLotOfTheDay || (async () => mockState.lotOfDay),
    pickWeeklySuperlatives: overrides.pickWeeklySuperlatives || (async () => mockState.weeklySuperlatives),
  };
  require.cache[LOT_PICKER_PATH] = {
    id: LOT_PICKER_PATH,
    filename: LOT_PICKER_PATH,
    loaded: true,
    exports: lotPickerStub,
  };

  return require('../../lib/social-engine/picker');
}

function fakeLot(id, extras = {}) {
  return {
    id,
    address: `${id} High St`,
    postcode: 'CF10',
    price: 62000,
    est_gross_yield: 8.4,
    image_url: `https://x/${id}.jpg`,
    images: null,
    score: 7,
    auction_date: '2026-06-01',
    ...extras,
  };
}

beforeEach(() => {
  mockState = {
    regionLots: [],
    yieldLots: [],
    dealLots: [],
    archetypeLots: [],
    aggSummary: { count: 0, avg_price: null, avg_yield: null, pct_below_market_gt_0: 0 },
    aggGroup: [],
    allFeatured: false,
    singleFeatured: false,
    recentTags: [],
    lotOfDay: null,
    weeklySuperlatives: [],
  };
});

// ── No candidates ─────────────────────────────────────────────────────

test('niche-hook with no candidates from any tag → throws', async () => {
  mockState.regionLots = [];
  mockState.yieldLots = [];
  mockState.dealLots = [];
  const { pickNicheHook } = loadPickerFresh();
  try {
    await pickNicheHook({ rng: () => 0.01 });
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /no qualifying candidate for niche-hook/);
  }
});

// ── All featured → retry then throw ──────────────────────────────────

test('niche-hook: all candidates featured <60d → eventually throws after 3 attempts', async () => {
  mockState.regionLots = [fakeLot('a'), fakeLot('b'), fakeLot('c'), fakeLot('d'), fakeLot('e')];
  mockState.yieldLots = [fakeLot('f'), fakeLot('g'), fakeLot('h'), fakeLot('i')];
  mockState.dealLots = [fakeLot('j'), fakeLot('k'), fakeLot('l'), fakeLot('m')];
  mockState.allFeatured = true;
  const { pickNicheHook } = loadPickerFresh();
  try {
    await pickNicheHook({ rng: () => 0.5 });
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /no qualifying candidate/);
  }
});

// ── Single-image fallback ──────────────────────────────────────────────

test('hero-album: lot with no multi-image returns album-of-1', async () => {
  mockState.archetypeLots = [fakeLot('L1', { image_url: 'https://x/L1.jpg', images: null })];
  mockState.singleFeatured = false;
  const { pickHeroAlbum } = loadPickerFresh();
  const r = await pickHeroAlbum();
  assert.equal(r.meta_payload.lot_id, 'L1');
  assert.deepEqual(r.meta_payload.album_images_source, ['https://x/L1.jpg']);
});

test('hero-album: lot with multi-image returns the full array', async () => {
  mockState.archetypeLots = [fakeLot('L1', {
    image_url: 'https://x/L1.jpg',
    images: ['https://x/L1-a.jpg', 'https://x/L1-b.jpg', 'https://x/L1-c.jpg'],
  })];
  const { pickHeroAlbum } = loadPickerFresh();
  const r = await pickHeroAlbum();
  assert.equal(r.meta_payload.album_images_source.length, 3);
});

test('hero-album: all archetypes empty → throws', async () => {
  mockState.archetypeLots = [];
  const { pickHeroAlbum } = loadPickerFresh();
  try {
    await pickHeroAlbum();
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /no qualifying candidate for hero-album/);
  }
});

// ── Regional cascade ──────────────────────────────────────────────────

test('regional-roundup: wales empty, south-yorkshire OK → returns south-yorkshire', async () => {
  let callCount = 0;
  const { pickRegionalRoundup } = loadPickerFresh({
    findLotsByRegion: async (prefixes) => {
      callCount += 1;
      // First call (wales) returns nothing; second call (south-yorkshire) returns 5 lots
      if (callCount === 1) return [];
      return [fakeLot('s1'), fakeLot('s2'), fakeLot('s3'), fakeLot('s4'), fakeLot('s5')];
    },
  });
  const r = await pickRegionalRoundup();
  assert.equal(r.pick.region_slug, 'south-yorkshire');
  assert.equal(r.meta_payload.lot_ids.length, 5);
});

test('regional-roundup: all four regions under 4 lots → throws', async () => {
  const { pickRegionalRoundup } = loadPickerFresh({
    findLotsByRegion: async () => [fakeLot('a'), fakeLot('b')],  // only 2 lots
  });
  try {
    await pickRegionalRoundup();
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /no qualifying candidate for regional-roundup/);
  }
});

test('regional-roundup: lots featured recently → tries next region', async () => {
  let callCount = 0;
  const { pickRegionalRoundup } = loadPickerFresh({
    findLotsByRegion: async () => {
      callCount += 1;
      return [fakeLot(`l-${callCount}-1`), fakeLot(`l-${callCount}-2`), fakeLot(`l-${callCount}-3`), fakeLot(`l-${callCount}-4`), fakeLot(`l-${callCount}-5`)];
    },
    hasFeaturedAnyLot: async () => callCount === 1,  // first region all featured, second clean
  });
  const r = await pickRegionalRoundup();
  assert.equal(r.pick.region_slug, 'south-yorkshire');
});

// ── Aggregate-only types ────────────────────────────────────────────

test('curiosity-gap: no upcoming lots → throws', async () => {
  mockState.aggSummary = { count: 0, avg_price: null, avg_yield: null, pct_below_market_gt_0: 0 };
  const { pickCuriosityGap } = loadPickerFresh();
  try {
    await pickCuriosityGap();
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /no qualifying candidate for curiosity-gap/);
  }
});

test('curiosity-gap: returns pct_below_market when non-zero', async () => {
  mockState.aggSummary = { count: 502, avg_price: 80000, avg_yield: 8.4, pct_below_market_gt_0: 0.31 };
  const { pickCuriosityGap } = loadPickerFresh();
  const r = await pickCuriosityGap();
  assert.equal(r.pick.stat_key, 'pct_below_market');
  assert.equal(r.pick.stat_value, '31%');
});

test('data-shock: returns the most-below-market postcode area', async () => {
  mockState.aggGroup = [
    { key: 'CF', count: 50, avg_price: 80000, avg_yield: 8, pct_below_market_gt_0: 0.4 },
    { key: 'S', count: 30, avg_price: 70000, avg_yield: 8.5, pct_below_market_gt_0: 0.55 },
    { key: 'M', count: 25, avg_price: 90000, avg_yield: 7.5, pct_below_market_gt_0: 0.3 },
  ];
  const { pickDataShock } = loadPickerFresh();
  const r = await pickDataShock();
  assert.equal(r.pick.area, 'S');
  assert.equal(r.pick.stat_value, '55%');
});

test('data-shock: no groups → throws', async () => {
  mockState.aggGroup = [];
  const { pickDataShock } = loadPickerFresh();
  try {
    await pickDataShock();
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /no qualifying candidate for data-shock/);
  }
});

// ── pickForType dispatch ────────────────────────────────────────────

test('pickForType dispatches correctly per socialType', async () => {
  mockState.archetypeLots = [fakeLot('L1')];
  mockState.aggSummary = { count: 502, avg_price: 80000, avg_yield: 8.4, pct_below_market_gt_0: 0.31 };
  mockState.aggGroup = [{ key: 'CF', count: 50, avg_price: 80000, avg_yield: 8, pct_below_market_gt_0: 0.4 }];
  const { pickForType } = loadPickerFresh();
  const a = await pickForType('hero-album');
  assert.equal(a.meta_payload.lot_id, 'L1');
  const b = await pickForType('curiosity-gap');
  assert.equal(b.pick.stat_key, 'pct_below_market');
  const c = await pickForType('data-shock');
  assert.equal(c.pick.area, 'CF');
});

test('pickForType throws on unknown type', async () => {
  const { pickForType } = loadPickerFresh();
  try {
    await pickForType('made-up-type');
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /unknown socialType/);
  }
});

// ── pickNicheTag biasing ────────────────────────────────────────────

test('pickNicheTag: recent tags get heavy penalty', () => {
  const { pickNicheTag } = loadPickerFresh();
  let walesHits = 0;
  let nonWalesHits = 0;
  // With wales in recentTags, wales should be picked far less than uniform.
  for (let i = 0; i < 1000; i++) {
    // Use a deterministic-ish RNG
    const tag = pickNicheTag({
      recentTags: ['wales'],
      rng: () => (i * 0.731 + 0.13) % 1,
    });
    if (tag === 'wales') walesHits++; else nonWalesHits++;
  }
  // Uniform would give ~1000/12 = ~83 hits for wales. With 0.2x weight, expect well under that.
  assert.ok(walesHits < 40, `wales hits=${walesHits}, expected <40 with 0.2x penalty`);
  assert.ok(nonWalesHits > 950);
});

test('pickNicheTag: breakout tags get 2x boost', () => {
  const { pickNicheTag } = loadPickerFresh();
  let walesHits = 0;
  for (let i = 0; i < 1000; i++) {
    const tag = pickNicheTag({
      recentTags: [],
      breakoutTags: ['wales'],
      rng: () => (i * 0.731 + 0.13) % 1,
    });
    if (tag === 'wales') walesHits++;
  }
  // Uniform ~83, with 2x ~154. Expect more than uniform.
  assert.ok(walesHits > 100, `wales hits with 2x boost=${walesHits}, expected >100`);
});

// ── Superlative-reel ──────────────────────────────────────────────

test('superlative-reel: returns first weekly pick', async () => {
  mockState.weeklySuperlatives = [
    { superlative: 'cheapest-week', lot: fakeLot('cheap') },
    { superlative: 'dearest-week', lot: fakeLot('dear') },
  ];
  const { pickSuperlativeReel } = loadPickerFresh();
  const r = await pickSuperlativeReel();
  assert.equal(r.pick.archetype, 'cheapest-week');
  assert.equal(r.meta_payload.is_reel, true);
});

test('superlative-reel: empty weekly picks → throws', async () => {
  mockState.weeklySuperlatives = [];
  const { pickSuperlativeReel } = loadPickerFresh();
  try {
    await pickSuperlativeReel();
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /no qualifying candidate for superlative-reel/);
  }
});

// ── Aggregate types don't dedupe (no lot_id involved) ──────────────

test('curiosity-gap does NOT call hasFeaturedAnyLot (no lots involved)', async () => {
  let dedupeCalls = 0;
  mockState.aggSummary = { count: 502, avg_price: 80000, avg_yield: 8.4, pct_below_market_gt_0: 0.31 };
  const { pickCuriosityGap } = loadPickerFresh({
    hasFeaturedAnyLot: async () => { dedupeCalls++; return false; },
  });
  await pickCuriosityGap();
  assert.equal(dedupeCalls, 0);
});
