// Phase G — social-engine picker.
//
// Given today's chosen social_type, return a { pick, meta_payload,
// visual_hints } tuple. The picker DOES NOT call Claude, DOES NOT render —
// it only finds the source rows the copywriter will write about and the
// meta fields the orchestrator stamps on the post.
//
// Dedupe rules (every picker honours these BEFORE returning):
//   1. Single-lot picks: skip lots where hasFeaturedLot(lot.id, 60) is true.
//   2. Multi-lot picks: skip the entire set if hasFeaturedAnyLot(ids, 60).
//      Try a different niche tag and retry up to 3 times.
//   3. Image-required: ALL picks except curiosity-gap and data-shock filter
//      image_url IS NOT NULL.
//   4. Niche-tag uniqueness within 7 days: don't repeat the same niche_tag
//      value more than once per 7d.

const {
  SOCIAL_TYPES,
  REGIONAL_PRESET,
  NICHE_TAG_LIST,
  NICHE_TAG_LABELS,
} = require('./constants');

const {
  findLotsByRegion,
  findLotsByYieldBand,
  findLotsByDealTag,
  aggregateLotStats,
  hasFeaturedAnyLot,
  getRecentNicheTags,
} = require('./helpers');

// Existing lib/supabase helpers — used only for the lot-of-day-traffic
// delegation and for single-lot superlative picks.
const { findLotsBySuperlative, hasFeaturedLot } = require('../supabase');
const { pickLotOfTheDay, pickWeeklySuperlatives } = require('../lot-picker');

// ── Niche-tag selection (weighted random over NICHE_TAG_LIST) ──────────────

const REGIONAL_SLUGS = Object.values(REGIONAL_PRESET).map(r => r.slug);
const YIELD_TAGS = ['yield-8plus', 'yield-10plus'];
const PROP_TAGS = ['prop-terraced', 'prop-commercial', 'prop-flat'];
const DEAL_TAGS = ['refurb-projects', 'vacant-possession', 'below-market-20plus'];

function _weightedPick(weights, rng = Math.random) {
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total <= 0) {
    const keys = Object.keys(weights);
    return keys[Math.floor(rng() * keys.length)];
  }
  let r = rng() * total;
  for (const [k, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) return k;
  }
  return Object.keys(weights)[Object.keys(weights).length - 1];
}

/**
 * Pick a niche tag biased away from recently-used tags. Returns one of
 * NICHE_TAG_LIST.
 * @param {object} opts  { recentTags?: string[], rng?: () => number, breakoutTags?: string[] }
 */
function pickNicheTag(opts = {}) {
  const rng = opts.rng || Math.random;
  const recent = new Set(opts.recentTags || []);
  const breakoutSet = new Set(opts.breakoutTags || []);

  const weights = {};
  for (const tag of NICHE_TAG_LIST) {
    let w = 1.0;
    if (recent.has(tag)) w *= 0.2;        // strong penalty for recent re-use
    if (breakoutSet.has(tag)) w *= 2.0;   // amplify breakout-tagged niches
    weights[tag] = w;
  }
  return _weightedPick(weights, rng);
}

// ── Region helpers ─────────────────────────────────────────────────────────

function regionFromSlug(slug) {
  for (const region of Object.values(REGIONAL_PRESET)) {
    if (region.slug === slug) return region;
  }
  return null;
}

const REGION_PRIORITY = ['wales', 'south-yorkshire', 'manchester', 'north-east'];

// ── Type-specific pickers ──────────────────────────────────────────────────

/**
 * lot-of-day-traffic — reuses existing pickLotOfTheDay verbatim. The
 * orchestrator delegates further to runLotOfTheDay (lib/lot-flow.js) for
 * this type; this picker exists so dispatch is uniform.
 */
async function pickLotOfDayTraffic(opts = {}) {
  const pick = await pickLotOfTheDay();
  return {
    pick: { lot: pick.lot, archetype: pick.archetype, fallbackUsed: pick.fallbackUsed },
    meta_payload: {
      lot_id: pick.lot.id,
      lot_address: pick.lot.address,
      lot_image_url: pick.lot.image_url,
      archetype: pick.archetype,
    },
    visual_hints: {
      hero_image_url: pick.lot.image_url || null,
    },
  };
}

/**
 * hero-album — 1 lot with 2+ images. Falls back to image_url-only (album of 1)
 * if no multi-image candidates. Tries each archetype in turn (best-yield →
 * deepest-discount → ...).
 */
async function pickHeroAlbum(opts = {}) {
  const { findLotsByArchetype } = require('../supabase');
  const archetypes = ['best-yield', 'deepest-discount', 'dev-or-refurb', 'urgent'];

  for (const archetype of archetypes) {
    // eslint-disable-next-line no-await-in-loop
    const candidates = await findLotsByArchetype(archetype, { limit: 30 });
    for (const lot of candidates) {
      if (!lot.image_url) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await hasFeaturedLot(lot.id, 60)) continue;

      const images = Array.isArray(lot.images) ? lot.images.filter(Boolean) : [];
      const allImages = images.length > 0 ? images : [lot.image_url];
      return {
        pick: { lot, archetype, fallbackUsed: false },
        meta_payload: {
          lot_id: lot.id,
          lot_address: lot.address,
          lot_image_url: lot.image_url,
          archetype,
          album_images_source: allImages,
        },
        visual_hints: {
          hero_image_url: lot.image_url,
          sub_image_urls: allImages.slice(1, 5),
        },
      };
    }
  }
  throw new Error('picker: no qualifying candidate for hero-album');
}

/**
 * niche-hook — picks a niche tag, then 5-6 lots in that niche. Retries up
 * to 3 different tags if the first set is all featured / empty.
 */
async function pickNicheHook(opts = {}) {
  const recentTags = await getRecentNicheTags(7);
  const rng = opts.rng || Math.random;
  const breakoutTags = opts.breakoutTags || [];
  const triedTags = new Set();

  for (let attempt = 0; attempt < 3; attempt++) {
    let tag = opts.forceTag && !triedTags.has(opts.forceTag) ? opts.forceTag : null;
    if (!tag) {
      // Pick a fresh tag we haven't already tried this call.
      for (let i = 0; i < 20; i++) {
        const t = pickNicheTag({ recentTags, rng, breakoutTags });
        if (!triedTags.has(t)) { tag = t; break; }
      }
    }
    if (!tag) break;
    triedTags.add(tag);

    let lots = [];
    try {
      if (REGIONAL_SLUGS.includes(tag)) {
        const region = regionFromSlug(tag);
        // eslint-disable-next-line no-await-in-loop
        lots = await findLotsByRegion(region.postcode_prefixes, { limit: 30, minScore: 5 });
      } else if (tag === 'yield-8plus') {
        // eslint-disable-next-line no-await-in-loop
        lots = await findLotsByYieldBand({ minYield: 8, maxYield: 10, limit: 30 });
      } else if (tag === 'yield-10plus') {
        // eslint-disable-next-line no-await-in-loop
        lots = await findLotsByYieldBand({ minYield: 10, limit: 30 });
      } else if (PROP_TAGS.includes(tag) || DEAL_TAGS.includes(tag)) {
        // eslint-disable-next-line no-await-in-loop
        lots = await findLotsByDealTag(tag, { limit: 30 });
      }
    } catch (err) {
      console.warn(`[picker:niche-hook] tag '${tag}' query failed: ${err.message}`);
      continue;
    }

    // Need at least 4 lots for a credible niche-hook collage.
    if (!lots || lots.length < 4) continue;

    const subset = lots.slice(0, 6);
    const ids = subset.map(l => l.id);
    // eslint-disable-next-line no-await-in-loop
    if (await hasFeaturedAnyLot(ids, 60)) continue;

    return {
      pick: { lots: subset, niche_tag: tag },
      meta_payload: {
        niche_tag: tag,
        region_slug: REGIONAL_SLUGS.includes(tag) ? tag : null,
        lot_ids: ids,
      },
      visual_hints: {
        hero_image_url: subset[0].image_url,
        sub_image_urls: subset.slice(1, 5).map(l => l.image_url).filter(Boolean),
        niche_tag_label: NICHE_TAG_LABELS[tag] || tag,
      },
    };
  }
  throw new Error('picker: no qualifying candidate for niche-hook');
}

/**
 * superlative-reel — reuses existing pickWeeklySuperlatives. Picks the first
 * superlative whose lot hasn't been featured.
 */
async function pickSuperlativeReel(opts = {}) {
  const picks = await pickWeeklySuperlatives();
  if (!picks.length) throw new Error('picker: no qualifying candidate for superlative-reel');
  const { superlative, lot } = picks[0];
  return {
    pick: { lot, archetype: superlative, superlative },
    meta_payload: {
      lot_id: lot.id,
      lot_address: lot.address,
      lot_image_url: lot.image_url,
      archetype: superlative,
      superlative,
      is_reel: true,
    },
    visual_hints: {
      hero_image_url: lot.image_url || null,
    },
  };
}

/**
 * curiosity-gap — aggregate-only. Returns a headline-worthy fact pulled
 * from aggregateLotStats({ groupBy: null }) over upcoming lots.
 */
async function pickCuriosityGap(opts = {}) {
  const summary = await aggregateLotStats({ groupBy: null });
  if (!summary || !summary.count) {
    throw new Error('picker: no qualifying candidate for curiosity-gap (no upcoming lots)');
  }

  // Pick the most striking fact available.
  const facts = [];
  if (summary.pct_below_market_gt_0 > 0) {
    const pct = Math.round(summary.pct_below_market_gt_0 * 100);
    facts.push({
      stat_key: 'pct_below_market',
      stat_value: `${pct}%`,
      narrative_context: `${pct}% of upcoming UK auction lots are listed below their street-average comp.`,
    });
  }
  if (Number.isFinite(summary.avg_yield) && summary.avg_yield > 0) {
    facts.push({
      stat_key: 'avg_yield',
      stat_value: `${summary.avg_yield.toFixed(1)}%`,
      narrative_context: `Average estimated gross yield across upcoming auction lots: ${summary.avg_yield.toFixed(1)}%.`,
    });
  }
  if (!facts.length) {
    facts.push({
      stat_key: 'upcoming_count',
      stat_value: String(summary.count),
      narrative_context: `${summary.count} UK auction lots are coming up.`,
    });
  }

  const fact = facts[0];
  return {
    pick: { ...fact, summary },
    meta_payload: {
      stat_key: fact.stat_key,
      stat_value: fact.stat_value,
    },
    visual_hints: {},
  };
}

/**
 * regional-roundup — picks a region (priority cascade), then findLotsByRegion
 * for 4-5 carousel frames.
 */
async function pickRegionalRoundup(opts = {}) {
  const forceRegion = opts.forceRegion;
  const order = forceRegion ? [forceRegion, ...REGION_PRIORITY.filter(r => r !== forceRegion)] : REGION_PRIORITY;

  for (const slug of order) {
    const region = regionFromSlug(slug);
    if (!region) continue;
    let lots;
    try {
      // eslint-disable-next-line no-await-in-loop
      lots = await findLotsByRegion(region.postcode_prefixes, { limit: 30, minScore: 5 });
    } catch (err) {
      console.warn(`[picker:regional-roundup] ${slug} query failed: ${err.message}`);
      continue;
    }
    if (!lots || lots.length < 4) continue;

    const subset = lots.slice(0, 5);
    const ids = subset.map(l => l.id);
    // eslint-disable-next-line no-await-in-loop
    if (await hasFeaturedAnyLot(ids, 60)) continue;

    return {
      pick: { lots: subset, region_slug: slug },
      meta_payload: {
        niche_tag: slug,
        region_slug: slug,
        lot_ids: ids,
      },
      visual_hints: {
        hero_image_url: subset[0].image_url,
        sub_image_urls: subset.slice(1, 5).map(l => l.image_url).filter(Boolean),
        niche_tag_label: NICHE_TAG_LABELS[slug] || slug,
      },
    };
  }
  throw new Error('picker: no qualifying candidate for regional-roundup');
}

/**
 * data-shock — aggregate-only. Picks the most extreme group from
 * aggregateLotStats({ groupBy: 'postcode_area' }) or 'house'.
 */
async function pickDataShock(opts = {}) {
  const byArea = await aggregateLotStats({ groupBy: 'postcode_area' });
  let extreme = null;
  if (Array.isArray(byArea) && byArea.length) {
    // Find the group with the highest below_market percentage.
    extreme = byArea
      .filter(g => g.count >= 5)
      .sort((a, b) => (b.pct_below_market_gt_0 - a.pct_below_market_gt_0))[0];
  }
  if (!extreme) {
    throw new Error('picker: no qualifying candidate for data-shock');
  }
  const pct = Math.round((extreme.pct_below_market_gt_0 || 0) * 100);
  return {
    pick: {
      stat_key: 'pct_below_market_by_area',
      stat_value: `${pct}%`,
      area: extreme.key,
      narrative_context: `In postcode area ${extreme.key}, ${pct}% of upcoming auction lots are below their street-average comp. (n=${extreme.count})`,
    },
    meta_payload: {
      stat_key: 'pct_below_market_by_area',
      stat_value: `${pct}%`,
      area: extreme.key,
    },
    visual_hints: {},
  };
}

// ── Main dispatcher ────────────────────────────────────────────────────────

/**
 * @param {string} socialType  one of SOCIAL_TYPES
 * @param {object} opts        type-specific overrides
 * @returns {Promise<{ pick: object, meta_payload: object, visual_hints: object }>}
 * @throws when no qualifying candidate exists
 */
async function pickForType(socialType, opts = {}) {
  switch (socialType) {
    case SOCIAL_TYPES.LOT_OF_DAY_TRAFFIC: return pickLotOfDayTraffic(opts);
    case SOCIAL_TYPES.HERO_ALBUM:         return pickHeroAlbum(opts);
    case SOCIAL_TYPES.NICHE_HOOK:         return pickNicheHook(opts);
    case SOCIAL_TYPES.SUPERLATIVE_REEL:   return pickSuperlativeReel(opts);
    case SOCIAL_TYPES.CURIOSITY_GAP:      return pickCuriosityGap(opts);
    case SOCIAL_TYPES.REGIONAL_ROUNDUP:   return pickRegionalRoundup(opts);
    case SOCIAL_TYPES.DATA_SHOCK:         return pickDataShock(opts);
    default:
      throw new Error(`picker: unknown socialType '${socialType}'`);
  }
}

module.exports = {
  pickForType,
  pickNicheTag,
  // Per-type pickers exposed for tests
  pickLotOfDayTraffic,
  pickHeroAlbum,
  pickNicheHook,
  pickSuperlativeReel,
  pickCuriosityGap,
  pickRegionalRoundup,
  pickDataShock,
};
