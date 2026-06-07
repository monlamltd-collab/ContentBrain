// Phase G — Social Engine constants
//
// Single source of truth for every enum, threshold, and brand-token Phase G
// uses. Imported by orchestrator, picker, copy, helpers, filters. No code
// outside this file declares these strings.
//
// All collections are Object.freeze()d so a stray mutation can't drift the
// system. The arrays mirror the object keys so callers can iterate without
// repeating the literal strings.

// ── Mode + type enums ──────────────────────────────────────────────────────

const SOCIAL_MODES = Object.freeze({ MONET: 'monet', TRAFFIC: 'traffic' });
const SOCIAL_MODE_LIST = Object.freeze(['monet', 'traffic']);

const SOCIAL_TYPES = Object.freeze({
  HERO_ALBUM:        'hero-album',
  NICHE_HOOK:        'niche-hook',
  SUPERLATIVE_REEL:  'superlative-reel',
  CURIOSITY_GAP:     'curiosity-gap',
  LOT_OF_DAY_TRAFFIC:'lot-of-day-traffic',
  REGIONAL_ROUNDUP:  'regional-roundup',
  DATA_SHOCK:        'data-shock',
});

const SOCIAL_TYPE_LIST = Object.freeze([
  'hero-album', 'niche-hook', 'superlative-reel',
  'curiosity-gap', 'lot-of-day-traffic', 'regional-roundup', 'data-shock',
]);

// Default mode bias per type. The orchestrator uses this when there's no
// explicit override from mode-mix balancing or breakout amplification.
// 'either' = orchestrator MUST collapse to monet|traffic before insert.
const TYPE_MODE_BIAS = Object.freeze({
  'hero-album':         'monet',
  'niche-hook':         'monet',
  'superlative-reel':   'monet',
  'curiosity-gap':      'monet',
  'lot-of-day-traffic': 'traffic',
  'regional-roundup':   'monet',
  'data-shock':         'monet',
});

// ── Mode-mix targets ───────────────────────────────────────────────────────

const TARGET_MONET_RATIO = 0.70;     // 70% monetisation / 30% traffic, rolling 7d
const MODE_MIX_HYSTERESIS = 0.10;    // +0.10 band before flipping into traffic
const MODE_MIX_WINDOW_DAYS = 7;

// ── Breakout amplification ─────────────────────────────────────────────────

const BREAKOUT_THRESHOLD = 2.5;        // engagement Z-score to mark as breakout (architecture Part 10 §3 — amplify cutoff)
const BREAKOUT_ALERT_THRESHOLD = 3.0;  // engagement Z-score to fire Telegram "exceptional" alert (Part 10 §5)
const BREAKOUT_BASELINE_DAYS = 14;     // rolling baseline window for engagement Z-score
const BREAKOUT_MIN_BASELINE_POSTS = 5; // floor — Z-score requires ≥5 prior same-mode posts to compute
const BREAKOUT_OVERRIDE_HOURS = 48;    // force-monet window after a breakout
const BREAKOUT_AMPLIFY_WEIGHT = 2.0;   // 2x type-pick weight for 7d post-breakout
const BREAKOUT_DECAY_DAYS = 7;

// ── Brand + page ───────────────────────────────────────────────────────────
// Decision #1 / Risk #9 — only AuctionBrain ever gets social-engine posts.
// Hard-pin so a stray BridgeMatch insert can't sneak in.

const SOCIAL_BRAND = 'auctionbrain';
const SOCIAL_PLATFORM = 'facebook';
const SOCIAL_CHANNEL = 'facebook';
const SOCIAL_TRACK = 'social';

// ── Boost (paid amplification) ─────────────────────────────────────────────

const DEFAULT_DAILY_BUDGET_PENCE = 200;   // £2/day decision #7
const DEFAULT_BOOST_DURATION_HOURS = 24;
const BOOST_OBJECTIVE = 'OUTCOME_ENGAGEMENT'; // decision #5 — locked
const BOOST_STATUSES = Object.freeze(['pending', 'active', 'complete', 'failed']);

// ── Regional preset (decision #4) ──────────────────────────────────────────
// Drives default audience_spec when boost_eligible=true and niche_tag is
// either a regional tag or empty. Postcode-prefix lists are used by the
// picker (regional-roundup, niche-hook) to filter lots; the city + region
// names are used by Make to build the FB Marketing API audience_spec.

const REGIONAL_PRESET = Object.freeze({
  wales: {
    slug: 'wales',
    postcode_prefixes: ['CF', 'NP', 'SA', 'LL', 'LD', 'SY'],
    fb_cities: ['Cardiff', 'Newport', 'Swansea'],
    fb_regions: [{ key: 'WLS' }],
  },
  south_yorkshire: {
    slug: 'south-yorkshire',
    postcode_prefixes: ['S', 'DN'],
    fb_cities: ['Sheffield', 'Doncaster'],
    fb_regions: [],
  },
  manchester: {
    slug: 'manchester',
    postcode_prefixes: ['M', 'OL', 'BL', 'SK'],
    fb_cities: ['Manchester'],
    fb_regions: [],
  },
  north_east: {
    slug: 'north-east',
    postcode_prefixes: ['NE', 'SR', 'TS', 'DH'],
    fb_cities: ['Newcastle upon Tyne', 'Sunderland'],
    fb_regions: [],
  },
});

// Default audience_spec used when post has no specific niche_tag. Used by
// lib/social-engine/boost.js#deriveAudienceSpec.
const DEFAULT_AUDIENCE_SPEC = Object.freeze({
  geo_locations_cities: [
    'Cardiff', 'Newport', 'Swansea',
    'Sheffield', 'Doncaster',
    'Manchester',
    'Newcastle upon Tyne', 'Sunderland',
  ],
  geo_locations_regions: [{ key: 'WLS' }],
  age_min: 28,
  age_max: 65,
  interests: ['Property investment', 'Real estate auction', 'Property development', 'Buy-to-let'],
  publisher_platforms: ['facebook'],
});

// ── Niche-tag menu (lead's confirmed 12-tag list) ──────────────────────────
// Picker reads this for niche-hook tag selection. 4 regions + 2 yield bands +
// 3 prop types + 3 deal types.

const NICHE_TAG_LIST = Object.freeze([
  // Regions (4)
  'wales', 'south-yorkshire', 'manchester', 'north-east',
  // Yield bands (2)
  'yield-8plus', 'yield-10plus',
  // Prop type (3)
  'prop-terraced', 'prop-commercial', 'prop-flat',
  // Deal type (3)
  'refurb-projects', 'vacant-possession', 'below-market-20plus',
]);

// Human-readable labels for visual chips / Telegram messages.
const NICHE_TAG_LABELS = Object.freeze({
  'wales':                'Wales',
  'south-yorkshire':      'South Yorkshire',
  'manchester':           'Greater Manchester',
  'north-east':           'North-East',
  'yield-8plus':          'Yield 8%+',
  'yield-10plus':         'Yield 10%+',
  'prop-terraced':        'Terraced houses',
  'prop-commercial':      'Commercial lots',
  'prop-flat':            'Flats',
  'refurb-projects':      'Refurb projects',
  'vacant-possession':    'Vacant possession',
  'below-market-20plus':  '20%+ below market',
});

// ── Brand voice prompt tokens ──────────────────────────────────────────────
// Frozen string the copywriter splices into the system prompt. The full
// copy-pasteable text lives in lib/social-engine/copy.js (BRAND_VOICE_BLOCK).

const BRAND_VOICE_NAME = 'Unloved Britain';
const BRAND_VOICE_TAGLINE = "Daily finds from Britain's overlooked property market.";
const BRAND_VOICE_URL = 'auctionbrain.co.uk';

// ── Telegram callback prefixes ─────────────────────────────────────────────
// All Phase G callbacks prefix with `social-` so they're greppable separately
// from outbound. Callback labels stay < 25 chars to fit Telegram's 64-byte
// limit when concatenated with a UUID (18 + 36 = 54 bytes max).

const CB_SOCIAL_AMPLIFY = 'cb:social-amplify';
const CB_SOCIAL_BOOST_NOW = 'cb:social-boost-now';
const CB_SOCIAL_PAUSE = 'cb:social-pause';

// ── Schedule slots ─────────────────────────────────────────────────────────
// The orchestrator runs at 07:00 UTC and chooses today's publish hour from
// these slots. Pilot ships 1 post/day so only slot 0 is used; ramp to 2/day
// uses both.

const PUBLISH_SLOTS = Object.freeze([
  { hour: 9, minute: 0 },   // 09:00 — primary slot
  { hour: 17, minute: 0 },  // 17:00 — secondary slot for 2/day ramp
]);

module.exports = {
  // Mode + type
  SOCIAL_MODES,
  SOCIAL_MODE_LIST,
  SOCIAL_TYPES,
  SOCIAL_TYPE_LIST,
  TYPE_MODE_BIAS,

  // Mode-mix
  TARGET_MONET_RATIO,
  MODE_MIX_HYSTERESIS,
  MODE_MIX_WINDOW_DAYS,

  // Breakout
  BREAKOUT_THRESHOLD,
  BREAKOUT_ALERT_THRESHOLD,
  BREAKOUT_BASELINE_DAYS,
  BREAKOUT_MIN_BASELINE_POSTS,
  BREAKOUT_OVERRIDE_HOURS,
  BREAKOUT_AMPLIFY_WEIGHT,
  BREAKOUT_DECAY_DAYS,

  // Brand + page
  SOCIAL_BRAND,
  SOCIAL_PLATFORM,
  SOCIAL_CHANNEL,
  SOCIAL_TRACK,

  // Boost
  DEFAULT_DAILY_BUDGET_PENCE,
  DEFAULT_BOOST_DURATION_HOURS,
  BOOST_OBJECTIVE,
  BOOST_STATUSES,

  // Geography
  REGIONAL_PRESET,
  DEFAULT_AUDIENCE_SPEC,

  // Niches
  NICHE_TAG_LIST,
  NICHE_TAG_LABELS,

  // Brand voice
  BRAND_VOICE_NAME,
  BRAND_VOICE_TAGLINE,
  BRAND_VOICE_URL,

  // Telegram callbacks
  CB_SOCIAL_AMPLIFY,
  CB_SOCIAL_BOOST_NOW,
  CB_SOCIAL_PAUSE,

  // Schedule
  PUBLISH_SLOTS,
};
