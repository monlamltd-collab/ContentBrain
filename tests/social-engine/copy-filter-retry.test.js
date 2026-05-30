// Phase G — copy.js filter-retry loop coverage.
//
// Mock the Anthropic SDK + runtime-config + themes so the copywriter can be
// exercised without external dependencies. Asserts:
//   - first attempt clean → returns, single SDK call
//   - filter block on attempt 1 → retries, succeeds on attempt 2
//   - all attempts blocked → throws with .blocks attached
//   - JSON parse error → regen hint includes 'Return ONLY the JSON object'
//   - filter mode='social' on every call
//   - lot-of-day-traffic + superlative-reel delegate to generateLotContent
//   - monet mode validation (follow_prompt + null cta)
//   - traffic mode validation (cta contains auctionbrain.co.uk)

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const COPY_PATH = require.resolve('../../lib/social-engine/copy');
const SDK_PATH = require.resolve('@anthropic-ai/sdk');
const RUNTIME_CFG_PATH = require.resolve('../../lib/runtime-config');
const THEMES_PATH = require.resolve('../../lib/themes');
const LOT_CONTENT_PATH = require.resolve('../../lib/lot-content');
const FILTERS_PATH = require.resolve('../../lib/outbound-filters');

let nextResponses = []; // queue of text strings
let lastCallArgs = [];
let lastLotContentArgs = null;
let lotContentResponse = null;
let lastFilterCalls = []; // every runFilters call

class MockAnthropic {
  constructor() {
    this.messages = {
      create: async (args) => {
        lastCallArgs.push(args);
        if (!nextResponses.length) throw new Error('Mock Anthropic ran out of queued responses');
        const text = nextResponses.shift();
        return { content: [{ type: 'text', text }] };
      },
    };
  }
}

function loadCopyFresh() {
  delete require.cache[COPY_PATH];
  delete require.cache[SDK_PATH];
  delete require.cache[RUNTIME_CFG_PATH];
  delete require.cache[THEMES_PATH];
  delete require.cache[LOT_CONTENT_PATH];
  delete require.cache[FILTERS_PATH];

  require.cache[SDK_PATH] = {
    id: SDK_PATH,
    filename: SDK_PATH,
    loaded: true,
    exports: MockAnthropic,
  };

  require.cache[RUNTIME_CFG_PATH] = {
    id: RUNTIME_CFG_PATH,
    filename: RUNTIME_CFG_PATH,
    loaded: true,
    exports: {
      getResolvedBrand: async () => ({
        name: 'AuctionBrain',
        url: 'auctionbrain.co.uk',
        audience: 'UK property investors',
        tone: 'sharp, data-driven',
        messages: ['168 auction houses'],
        _directive: null,
      }),
    },
  };

  require.cache[THEMES_PATH] = {
    id: THEMES_PATH,
    filename: THEMES_PATH,
    loaded: true,
    exports: {
      renderThemeMenu: () => 'THEMES: field-notes, dossier',
      THEME_NAMES: ['field-notes', 'dossier'],
      DEFAULT_THEME_NAME: 'field-notes',
    },
  };

  require.cache[LOT_CONTENT_PATH] = {
    id: LOT_CONTENT_PATH,
    filename: LOT_CONTENT_PATH,
    loaded: true,
    exports: {
      generateLotContent: async (args) => {
        lastLotContentArgs = args;
        return lotContentResponse || {
          hook_headline: 'Cardiff guide £62k',
          key_bullets: ['Two-bed terrace', 'Yield 8.4% est.', 'Auctions Tuesday'],
          voiceover_script: 'Long script here.',
          caption_facebook: 'Caption stub',
          visual_style: 'field-notes',
        };
      },
      ARCHETYPE_FRAMES: {},
    },
  };

  // Wrap the real outbound-filters so we can spy on opts.mode without
  // changing behaviour — runFilters re-exports from the cached module.
  const realFilters = require('../../lib/outbound-filters');
  require.cache[FILTERS_PATH] = {
    id: FILTERS_PATH,
    filename: FILTERS_PATH,
    loaded: true,
    exports: {
      ...realFilters,
      runFilters: (input, opts) => {
        lastFilterCalls.push({ input, opts });
        return realFilters.runFilters(input, opts);
      },
    },
  };

  return require('../../lib/social-engine/copy');
}

const cleanMonetResponse = JSON.stringify({
  copy_headline: 'Five unloved Welsh terraces',
  copy_body: 'All up for auction this fortnight. None on Rightmove.',
  copy_cta: null,
  follow_prompt: 'Tap follow for more Welsh finds',
  visual_style: 'field-notes',
  frame_captions: ['Cardiff', 'Newport', 'Swansea', 'Llanelli'],
});

const cleanTrafficResponse = JSON.stringify({
  copy_headline: 'Best yield this fortnight',
  copy_body: 'Cardiff terrace; 8.4% est. gross yield. Bidding Tuesday.',
  copy_cta: 'See the lot — auctionbrain.co.uk',
  follow_prompt: null,
  visual_style: 'field-notes',
  frame_captions: [],
});

const blockedResponse = JSON.stringify({
  copy_headline: 'Wealth creation guide',
  copy_body: 'Find passive income via UK auction property — BridgeMatch can help.',
  copy_cta: null,
  follow_prompt: 'Tap follow if you love finance.',
  visual_style: 'field-notes',
  frame_captions: [],
});

beforeEach(() => {
  nextResponses = [];
  lastCallArgs = [];
  lastLotContentArgs = null;
  lotContentResponse = null;
  lastFilterCalls = [];
});

// ── A. First attempt clean ──────────────────────────────────────────────

test('first attempt clean → returns, one SDK call', async () => {
  nextResponses = [cleanMonetResponse];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [{ address: '12 High St', postcode: 'CF10', price: 62000, est_gross_yield: 8.4 }] },
    meta_payload: { niche_tag: 'wales' },
    visual_hints: {},
  });
  assert.equal(r.copy_headline, 'Five unloved Welsh terraces');
  assert.equal(r.follow_prompt, 'Tap follow for more Welsh finds');
  assert.equal(r.copy_cta, null);
  assert.equal(lastCallArgs.length, 1);
  assert.equal(lastFilterCalls.length, 1);
});

// ── B. Filter mode is 'social' ─────────────────────────────────────────

test('filter call uses opts.mode = "social"', async () => {
  nextResponses = [cleanMonetResponse];
  const { generateSocialCopy } = loadCopyFresh();
  await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.equal(lastFilterCalls[0].opts.mode, 'social');
});

// ── C. Filter block on attempt 1 → retry → success ─────────────────────

test('blocked then clean → retries, returns', async () => {
  nextResponses = [blockedResponse, cleanMonetResponse];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.equal(r.copy_headline, 'Five unloved Welsh terraces');
  assert.equal(lastCallArgs.length, 2);
});

// ── D. All 3 attempts blocked → throws with .blocks ───────────────────

test('all 3 attempts blocked → throws with .blocks', async () => {
  nextResponses = [blockedResponse, blockedResponse, blockedResponse];
  const { generateSocialCopy } = loadCopyFresh();
  try {
    await generateSocialCopy({
      socialType: 'niche-hook',
      socialMode: 'monet',
      pick: { lots: [] },
      meta_payload: { niche_tag: 'wales' },
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /filter blocks not resolved/);
    assert.ok(Array.isArray(err.blocks), 'err.blocks should be an array');
    assert.ok(err.blocks.length > 0, 'err.blocks should be populated');
  }
});

// ── E. JSON parse error → regen hint mentions return-only-JSON ────────

test('JSON parse error → retries with helpful regen hint', async () => {
  nextResponses = [
    'I cannot do that, sorry.',     // attempt 1: not JSON
    cleanMonetResponse,             // attempt 2: clean
  ];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.equal(r.copy_headline, 'Five unloved Welsh terraces');
  assert.equal(lastCallArgs.length, 2);
  // The second user prompt MUST contain the regen-hint banner.
  const secondUser = lastCallArgs[1].messages[0].content;
  assert.match(secondUser, /Return ONLY the JSON object/);
});

// ── F. Traffic-mode validation ─────────────────────────────────────────

test('traffic mode: response must contain auctionbrain.co.uk', async () => {
  const badTraffic = JSON.stringify({
    copy_headline: 'A nice hook',
    copy_body: 'Some body.',
    copy_cta: 'Visit our site',  // missing auctionbrain.co.uk
    follow_prompt: null,
    visual_style: 'field-notes',
  });
  nextResponses = [badTraffic, cleanTrafficResponse];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'traffic',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  // UTM stamp expected on the bare-domain CTA
  assert.match(r.copy_cta, /utm_source=facebook/);
  assert.equal(lastCallArgs.length, 2);
});

test('traffic mode: UTM stamper appends params to CTA URL', async () => {
  nextResponses = [cleanTrafficResponse];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'traffic',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.match(r.copy_cta, /utm_source=facebook/);
  assert.match(r.copy_cta, /utm_campaign=auctionbrain_niche-hook_/);
});

// ── G. Monet-mode validation ───────────────────────────────────────────

test('monet mode: missing follow_prompt → retries', async () => {
  const noFollow = JSON.stringify({
    copy_headline: 'Hook',
    copy_body: 'Body',
    copy_cta: null,
    follow_prompt: null,
    visual_style: 'field-notes',
  });
  nextResponses = [noFollow, cleanMonetResponse];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.equal(r.follow_prompt, 'Tap follow for more Welsh finds');
  assert.equal(lastCallArgs.length, 2);
});

test('monet mode: follow_prompt without "Hit/Tap/Follow" → retries', async () => {
  const badPrefix = JSON.stringify({
    copy_headline: 'Hook',
    copy_body: 'Body',
    copy_cta: null,
    follow_prompt: 'Subscribe to our page.',  // wrong prefix
    visual_style: 'field-notes',
  });
  nextResponses = [badPrefix, cleanMonetResponse];
  const { generateSocialCopy } = loadCopyFresh();
  await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.equal(lastCallArgs.length, 2);
});

test('monet mode: copy_cta set → retries (monet must be null)', async () => {
  const withCta = JSON.stringify({
    copy_headline: 'Hook',
    copy_body: 'Body',
    copy_cta: 'Visit auctionbrain.co.uk',
    follow_prompt: 'Tap follow for more',
    visual_style: 'field-notes',
  });
  nextResponses = [withCta, cleanMonetResponse];
  const { generateSocialCopy } = loadCopyFresh();
  await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.equal(lastCallArgs.length, 2);
});

// ── H. Delegation paths (lot-of-day + superlative-reel) ───────────────

test('lot-of-day-traffic delegates to generateLotContent, no SDK call here', async () => {
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'lot-of-day-traffic',
    socialMode: 'traffic',
    pick: { lot: { id: 'L1', address: '12 High St' }, archetype: 'best-yield' },
    meta_payload: {},
  });
  assert.equal(r.copy_headline, 'Cardiff guide £62k');
  assert.equal(lastCallArgs.length, 0, 'should NOT call the SDK directly');
  assert.deepEqual(lastLotContentArgs.archetype, 'best-yield');
  assert.equal(lastFilterCalls.length, 0, 'should NOT re-run filters');
});

test('superlative-reel delegates to generateLotContent', async () => {
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'superlative-reel',
    socialMode: 'monet',
    pick: { lot: { id: 'L1', address: '12 High St' }, archetype: 'cheapest-week' },
    meta_payload: {},
  });
  assert.equal(r.meta_additions.social_type, 'superlative-reel');
  assert.equal(lastCallArgs.length, 0);
});

// ── I. Caption assembly ───────────────────────────────────────────────

test('caption_facebook for monet mode contains follow_prompt, not cta', async () => {
  nextResponses = [cleanMonetResponse];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.match(r.caption_facebook, /Tap follow for more Welsh finds/);
  assert.doesNotMatch(r.caption_facebook, /auctionbrain\.co\.uk/);
});

test('caption_facebook for traffic mode contains UTM cta, not follow_prompt', async () => {
  nextResponses = [cleanTrafficResponse];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'traffic',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.match(r.caption_facebook, /auctionbrain\.co\.uk/);
  assert.match(r.caption_facebook, /utm_source=facebook/);
});

// ── J. visual_style fallback ──────────────────────────────────────────

test('unknown visual_style falls back to DEFAULT_THEME_NAME', async () => {
  const odd = JSON.stringify({
    copy_headline: 'Hook',
    copy_body: 'Body',
    copy_cta: null,
    follow_prompt: 'Tap follow for more',
    visual_style: 'made-up-theme',
  });
  nextResponses = [odd];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.equal(r.visual_style, 'field-notes');
});

// ── K. Curiosity-gap requires micro_stat ──────────────────────────────

test('curiosity-gap: missing micro_stat → retries', async () => {
  const noMicro = JSON.stringify({
    copy_headline: '1 in 6 lots withdrawn',
    copy_body: 'Last fortnight: 412 withdrawals.',
    copy_cta: null,
    follow_prompt: 'Tap follow for more auction context',
    visual_style: 'field-notes',
    // micro_stat missing
  });
  const goodCuriosity = JSON.stringify({
    copy_headline: '1 in 6 lots withdrawn',
    copy_body: 'Last fortnight: 412 withdrawals.',
    copy_cta: null,
    follow_prompt: 'Tap follow for more auction context',
    visual_style: 'field-notes',
    micro_stat: '1 in 6',
    micro_caption: 'withdrawn last fortnight',
  });
  nextResponses = [noMicro, goodCuriosity];
  const { generateSocialCopy } = loadCopyFresh();
  const r = await generateSocialCopy({
    socialType: 'curiosity-gap',
    socialMode: 'monet',
    pick: { stat_key: 'withdrawals', stat_value: '1 in 6' },
    meta_payload: {},
  });
  assert.equal(r.meta_additions.micro_stat, '1 in 6');
  assert.equal(lastCallArgs.length, 2);
});

// ── L. system prompt contains Unloved Britain block ───────────────────

test('system prompt contains Unloved Britain persona overlay', async () => {
  nextResponses = [cleanMonetResponse];
  const { generateSocialCopy } = loadCopyFresh();
  await generateSocialCopy({
    socialType: 'niche-hook',
    socialMode: 'monet',
    pick: { lots: [] },
    meta_payload: { niche_tag: 'wales' },
  });
  assert.match(lastCallArgs[0].system, /Unloved Britain/);
  assert.match(lastCallArgs[0].system, /British English ONLY/);
});

test('unknown socialType throws', async () => {
  const { generateSocialCopy } = loadCopyFresh();
  try {
    await generateSocialCopy({
      socialType: 'made-up-type',
      socialMode: 'monet',
      pick: {},
      meta_payload: {},
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /unknown socialType/);
  }
});

test('unknown socialMode throws', async () => {
  const { generateSocialCopy } = loadCopyFresh();
  try {
    await generateSocialCopy({
      socialType: 'niche-hook',
      socialMode: 'amazing',
      pick: {},
      meta_payload: {},
    });
    assert.fail('expected throw');
  } catch (err) {
    assert.match(err.message, /socialMode must be 'monet' or 'traffic'/);
  }
});
