// Phase G — Supabase helpers + small utilities for social-engine.
//
// All read/write functions touching boost_runs, social_audience_daily, and
// Phase G-specific queries on the posts and lots tables live here. Pulled
// out of lib/supabase.js to keep that file under the house cap.
//
// Every function is async and returns a JS value (no raw Supabase result
// objects leak). Errors throw — callers wrap when they want graceful
// degradation.

const { supabase } = require('../supabase');
const {
  SOCIAL_TRACK,
  BREAKOUT_OVERRIDE_HOURS,
  BREAKOUT_THRESHOLD,
  BREAKOUT_AMPLIFY_WEIGHT,
} = require('./constants');

// ── Mode-mix and lifecycle ─────────────────────────────────────────────────

/**
 * Count social posts in a rolling window, grouped by meta.social_mode.
 * @param {number} days  rolling window (default 7); MUST be >= 1.
 * @returns {Promise<{monet: number, traffic: number, total: number}>}
 */
async function getSocialModeCounts(days = 7) {
  if (!Number.isFinite(days) || days < 1) {
    throw new Error(`getSocialModeCounts: days must be >= 1 (got ${days})`);
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('posts')
    .select('meta')
    .eq('track', SOCIAL_TRACK)
    .gte('created_at', since);
  if (error) throw new Error(`getSocialModeCounts failed: ${error.message}`);

  let monet = 0;
  let traffic = 0;
  for (const row of data || []) {
    const m = (row && row.meta && row.meta.social_mode) || null;
    if (m === 'monet') monet += 1;
    else if (m === 'traffic') traffic += 1;
  }
  return { monet, traffic, total: monet + traffic };
}

/**
 * Returns the most recent social posts published in the last `days` days,
 * ordered by published_at DESC. Used by the orchestrator for novelty-
 * constraint context blocks.
 * @param {number} days  default 14
 * @returns {Promise<Array<object>>}
 */
async function getRecentSocialPosts(days = 14) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('posts')
    .select('id, copy_headline, copy_body, template_type, meta, published_at, created_at')
    .eq('track', SOCIAL_TRACK)
    .gte('created_at', since)
    .order('published_at', { ascending: false, nullsFirst: false });
  if (error) throw new Error(`getRecentSocialPosts failed: ${error.message}`);
  return data || [];
}

/**
 * Has any of these lot ids been featured in a social/lot post in the last
 * `daysWindow` days? Checks both meta->>'lot_id' (single-lot) and
 * meta->'lot_ids' jsonb-array overlap (multi-lot).
 * @param {string[]} lotIds
 * @param {number} daysWindow  default 60 (matches existing hasFeaturedLot)
 * @returns {Promise<boolean>}
 */
async function hasFeaturedAnyLot(lotIds, daysWindow = 60) {
  if (!Array.isArray(lotIds) || lotIds.length === 0) return false;
  const since = new Date(Date.now() - daysWindow * 24 * 60 * 60 * 1000).toISOString();

  // Single-lot path — any meta.lot_id ∈ lotIds.
  const { data: singles, error: e1 } = await supabase
    .from('posts')
    .select('id')
    .gte('created_at', since)
    .in('meta->>lot_id', lotIds)
    .limit(1);
  if (e1) throw new Error(`hasFeaturedAnyLot (single) failed: ${e1.message}`);
  if ((singles || []).length > 0) return true;

  // Multi-lot path — meta.lot_ids overlaps lotIds. Use jsonb `?|` operator
  // via the `cs` (contains) filter as a fallback when overlap isn't directly
  // exposed by PostgREST. We probe one id at a time but short-circuit on
  // first hit — keeps the round-trip count low when most lookups are misses.
  for (const id of lotIds) {
    // eslint-disable-next-line no-await-in-loop
    const { data, error } = await supabase
      .from('posts')
      .select('id')
      .gte('created_at', since)
      .filter('meta->lot_ids', 'cs', JSON.stringify([id]))
      .limit(1);
    if (error) throw new Error(`hasFeaturedAnyLot (multi) failed: ${error.message}`);
    if ((data || []).length > 0) return true;
  }
  return false;
}

/**
 * Returns recent niche tags from meta.niche_tag in the last `days` days.
 * Used by the picker to avoid repeating a niche too often.
 * @param {number} days  default 7
 * @returns {Promise<string[]>}
 */
async function getRecentNicheTags(days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('posts')
    .select('meta')
    .eq('track', SOCIAL_TRACK)
    .gte('created_at', since);
  if (error) throw new Error(`getRecentNicheTags failed: ${error.message}`);
  const out = [];
  for (const row of data || []) {
    const t = row && row.meta && row.meta.niche_tag;
    if (typeof t === 'string' && t) out.push(t);
  }
  return out;
}

// ── Breakout signals (live — Phase G-4) ────────────────────────────────────

/**
 * Returns true when at least one social post from the last
 * BREAKOUT_OVERRIDE_HOURS hours has meta.breakout_score >= BREAKOUT_THRESHOLD,
 * is in monet mode, has a niche_tag, AND that niche_tag has NOT been
 * re-featured since (so the breakout hasn't already been amplified).
 *
 * Reads `posts.meta.breakout_score` (written nightly by
 * lib/social-engine/learner.js#runBreakoutLearner). See
 * .ruflo/phase-g4-design.md §1.5.
 *
 * @returns {Promise<boolean>}
 */
async function isBreakoutActive() {
  const since = new Date(Date.now() - BREAKOUT_OVERRIDE_HOURS * 60 * 60 * 1000).toISOString();

  const { data: cands, error } = await supabase
    .from('posts')
    .select('id, published_at, meta')
    .eq('track', SOCIAL_TRACK)
    .gte('published_at', since)
    .not('meta->>breakout_score', 'is', null);
  if (error) throw new Error(`isBreakoutActive failed: ${error.message}`);

  for (const c of cands || []) {
    const score = Number(c.meta && c.meta.breakout_score);
    const tag = c.meta && c.meta.niche_tag;
    const mode = c.meta && c.meta.social_mode;
    if (!Number.isFinite(score) || score < BREAKOUT_THRESHOLD) continue;
    if (mode !== 'monet' || !tag) continue;

    // Has this niche_tag been re-featured since the breakout? If so, the
    // amplification has already happened — don't double-trigger.
    // eslint-disable-next-line no-await-in-loop
    const { data: subsequent, error: subErr } = await supabase
      .from('posts')
      .select('id')
      .eq('track', SOCIAL_TRACK)
      .gt('published_at', c.published_at)
      .eq('meta->>niche_tag', tag)
      .limit(1);
    if (subErr) throw new Error(`isBreakoutActive dedupe lookup failed: ${subErr.message}`);
    if ((subsequent || []).length === 0) return true;
  }
  return false;
}

/**
 * Returns breakout amplification tag descriptors for decideType()'s weight
 * bias. One row per non-already-amplified breakout in the last
 * BREAKOUT_OVERRIDE_HOURS hours. The orchestrator (decideType in
 * lib/social-engine/orchestrator.js) multiplies the matching template_type's
 * pick weight by `weight_multiplier`.
 *
 * @returns {Promise<Array<{type: string, niche_tag: string, weight_multiplier: number}>>}
 */
async function getBreakoutTags() {
  const since = new Date(Date.now() - BREAKOUT_OVERRIDE_HOURS * 60 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from('posts')
    .select('id, published_at, template_type, meta')
    .eq('track', SOCIAL_TRACK)
    .gte('published_at', since)
    .not('meta->>breakout_score', 'is', null);
  if (error) throw new Error(`getBreakoutTags failed: ${error.message}`);

  const out = [];
  for (const r of data || []) {
    const score = Number(r.meta && r.meta.breakout_score);
    const tag = r.meta && r.meta.niche_tag;
    const type = r.template_type;
    const mode = r.meta && r.meta.social_mode;
    if (!Number.isFinite(score) || score < BREAKOUT_THRESHOLD) continue;
    if (mode !== 'monet' || !tag || !type) continue;

    // Skip if already re-featured (mirrors isBreakoutActive dedupe).
    // eslint-disable-next-line no-await-in-loop
    const { data: subsequent, error: subErr } = await supabase
      .from('posts')
      .select('id')
      .eq('track', SOCIAL_TRACK)
      .gt('published_at', r.published_at)
      .eq('meta->>niche_tag', tag)
      .limit(1);
    if (subErr) throw new Error(`getBreakoutTags dedupe lookup failed: ${subErr.message}`);
    if ((subsequent || []).length > 0) continue;

    out.push({
      type,
      niche_tag: tag,
      weight_multiplier: BREAKOUT_AMPLIFY_WEIGHT,
    });
  }
  return out;
}

// ── Multi-lot picker support ───────────────────────────────────────────────

// Shared lot column list — mirrors lib/supabase.js LOT_COLS so the picker
// has every field generateLotContent's prompt + the templates need.
const LOT_COLS = 'id, house, lot_number, url, address, postcode, price, price_text, prop_type, beds, tenure, sqft, condition, image_url, images, bullets, auction_date, status, score, score_breakdown, opps, risks, deal_type, vacant, est_monthly_rent, est_annual_rent, est_gross_yield, street_avg, below_market, epc_rating, flood_risk';

function normalisePostcodePrefix(p) {
  return String(p || '').toUpperCase().replace(/\s+/g, '');
}

/**
 * Find candidate lots for a given postcode region (regional-roundup +
 * niche-hook geo-anchored).
 * @param {string|string[]} prefixes  e.g. 'CF' or ['CF','NP','SA']
 * @param {object} opts
 *   - limit: int (default 30)
 *   - minScore: int (default 5)
 *   - daysAhead: int (default 14) — auction window from today
 *   - imageRequired: bool (default true)
 * @returns {Promise<Array<object>>}
 */
async function findLotsByRegion(prefixes, opts = {}) {
  const list = (Array.isArray(prefixes) ? prefixes : [prefixes])
    .map(normalisePostcodePrefix)
    .filter(Boolean);
  if (!list.length) return [];

  const limit = opts.limit ?? 30;
  const minScore = opts.minScore ?? 5;
  const daysAhead = opts.daysAhead ?? 14;
  const imageRequired = opts.imageRequired !== false;

  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Build the OR clause for postcode prefixes. PostgREST handles ~10 ORs.
  const orClause = list.map(p => `postcode.ilike.${p}%`).join(',');

  let query = supabase
    .from('lots')
    .select(LOT_COLS)
    .gte('auction_date', today)
    .lte('auction_date', horizon)
    .gte('score', minScore)
    .or(orClause)
    .order('score', { ascending: false });

  if (imageRequired) {
    query = query.not('image_url', 'is', null).neq('image_url', '');
  }

  const { data, error } = await query.limit(limit);
  if (error) throw new Error(`findLotsByRegion(${list.join('|')}) failed: ${error.message}`);
  return data || [];
}

/**
 * Find lots in a yield band (niche-hook yield-anchored).
 * @param {object} opts
 *   - minYield: number (default 8)
 *   - maxYield: number (default Infinity)
 *   - limit: int (default 30)
 *   - daysAhead: int (default 14)
 *   - imageRequired: bool (default true)
 * @returns {Promise<Array<object>>}
 */
async function findLotsByYieldBand(opts = {}) {
  const minYield = opts.minYield ?? 8;
  const maxYield = opts.maxYield ?? Infinity;
  const limit = opts.limit ?? 30;
  const daysAhead = opts.daysAhead ?? 14;
  const imageRequired = opts.imageRequired !== false;

  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let query = supabase
    .from('lots')
    .select(LOT_COLS)
    .gte('auction_date', today)
    .lte('auction_date', horizon)
    .gte('est_gross_yield', minYield)
    .order('est_gross_yield', { ascending: false });

  if (Number.isFinite(maxYield)) {
    query = query.lte('est_gross_yield', maxYield);
  }
  if (imageRequired) {
    query = query.not('image_url', 'is', null).neq('image_url', '');
  }

  const { data, error } = await query.limit(limit);
  if (error) throw new Error(`findLotsByYieldBand failed: ${error.message}`);
  return data || [];
}

/**
 * Find lots matching a deal-type filter (refurb-projects, vacant-possession,
 * below-market-20plus, prop-terraced, prop-commercial, prop-flat).
 * @param {string} dealTag  one of the deal/prop niche tags
 * @param {object} opts     limit / daysAhead / imageRequired
 * @returns {Promise<Array<object>>}
 */
async function findLotsByDealTag(dealTag, opts = {}) {
  const limit = opts.limit ?? 30;
  const daysAhead = opts.daysAhead ?? 14;
  const imageRequired = opts.imageRequired !== false;

  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + daysAhead * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let query = supabase
    .from('lots')
    .select(LOT_COLS)
    .gte('auction_date', today)
    .lte('auction_date', horizon);

  switch (dealTag) {
    case 'refurb-projects':
      query = query
        .or('condition.ilike.%refurb%,condition.ilike.%develop%,deal_type.ilike.%refurb%,deal_type.ilike.%develop%')
        .order('score', { ascending: false });
      break;
    case 'vacant-possession':
      query = query.eq('vacant', true).order('score', { ascending: false });
      break;
    case 'below-market-20plus':
      query = query.gte('below_market', 20).order('below_market', { ascending: false });
      break;
    case 'prop-terraced':
      query = query.ilike('prop_type', '%terraced%').order('score', { ascending: false });
      break;
    case 'prop-commercial':
      query = query.ilike('prop_type', '%commercial%').order('score', { ascending: false });
      break;
    case 'prop-flat':
      query = query.ilike('prop_type', '%flat%').order('score', { ascending: false });
      break;
    default:
      throw new Error(`findLotsByDealTag: unknown tag '${dealTag}'`);
  }

  if (imageRequired) {
    query = query.not('image_url', 'is', null).neq('image_url', '');
  }

  const { data, error } = await query.limit(limit);
  if (error) throw new Error(`findLotsByDealTag(${dealTag}) failed: ${error.message}`);
  return data || [];
}

/**
 * Aggregate stats over upcoming lots. Used by curiosity-gap and data-shock.
 * The aggregation happens client-side (16,725 rows in one round-trip is
 * cheaper than building a SQL aggregate over PostgREST).
 * @param {object} opts
 *   - groupBy: null|'postcode_area'|'prop_type'|'house'
 *   - upcomingOnly: bool (default true; auction_date >= today)
 *   - minScore: number|null (default null = no filter)
 *   - limit: int (default 5000) — sanity cap on the raw fetch
 * @returns {Promise<object|Array<object>>}
 */
async function aggregateLotStats(opts = {}) {
  const groupBy = opts.groupBy || null;
  const upcomingOnly = opts.upcomingOnly !== false;
  const minScore = opts.minScore ?? null;
  const limit = opts.limit ?? 5000;

  let query = supabase
    .from('lots')
    .select('id, house, postcode, prop_type, price, score, est_gross_yield, below_market, auction_date, status');

  if (upcomingOnly) {
    const today = new Date().toISOString().slice(0, 10);
    query = query.gte('auction_date', today);
  }
  if (minScore != null) {
    query = query.gte('score', minScore);
  }

  const { data, error } = await query.limit(limit);
  if (error) throw new Error(`aggregateLotStats failed: ${error.message}`);
  const rows = data || [];

  function summarise(subset) {
    const count = subset.length;
    if (!count) {
      return { count: 0, avg_price: null, avg_yield: null, pct_below_market_gt_0: 0 };
    }
    let priceSum = 0, priceN = 0;
    let yieldSum = 0, yieldN = 0;
    let belowMarketHits = 0;
    for (const r of subset) {
      if (Number.isFinite(r.price)) { priceSum += r.price; priceN += 1; }
      if (Number.isFinite(r.est_gross_yield)) { yieldSum += r.est_gross_yield; yieldN += 1; }
      if (Number.isFinite(r.below_market) && r.below_market > 0) belowMarketHits += 1;
    }
    return {
      count,
      avg_price: priceN ? priceSum / priceN : null,
      avg_yield: yieldN ? yieldSum / yieldN : null,
      pct_below_market_gt_0: count ? belowMarketHits / count : 0,
    };
  }

  if (!groupBy) return summarise(rows);

  const groups = new Map();
  for (const r of rows) {
    let key = null;
    if (groupBy === 'postcode_area') {
      const m = String(r.postcode || '').toUpperCase().match(/^[A-Z]{1,2}/);
      key = m ? m[0] : null;
    } else if (groupBy === 'prop_type') {
      key = (r.prop_type || '').trim().toLowerCase() || null;
    } else if (groupBy === 'house') {
      key = (r.house || '').trim() || null;
    }
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }

  const out = [];
  for (const [key, subset] of groups) {
    out.push({ key, ...summarise(subset) });
  }
  // Largest first — callers usually want the most-extreme group.
  out.sort((a, b) => b.count - a.count);
  return out;
}

// ── boost_runs ─────────────────────────────────────────────────────────────

/**
 * Insert a pending boost_runs row. Throws on FK violation (post must exist).
 * @param {object} row
 *   - post_id: uuid (required)
 *   - daily_budget_pence: int (required)
 *   - duration_hours: int (default 24)
 *   - audience_spec: jsonb
 *   - meta: jsonb (optional — niche_tag, source, etc.)
 * @returns {Promise<object>}  inserted row
 */
async function insertBoostRun(row) {
  if (!row || !row.post_id) throw new Error('insertBoostRun: post_id is required');
  if (!Number.isFinite(row.daily_budget_pence) || row.daily_budget_pence <= 0) {
    throw new Error('insertBoostRun: daily_budget_pence must be a positive integer');
  }
  const payload = {
    post_id: row.post_id,
    daily_budget_pence: row.daily_budget_pence,
    duration_hours: row.duration_hours ?? 24,
    audience_spec: row.audience_spec || null,
    status: 'pending',
    meta: row.meta || null,
  };
  const { data, error } = await supabase
    .from('boost_runs')
    .insert(payload)
    .select()
    .single();
  if (error) throw new Error(`insertBoostRun failed: ${error.message}`);
  return data;
}

/**
 * Look up pending/active runs by post_id. Used by manual pause + reconcile.
 * @param {string} postId
 * @returns {Promise<Array<object>>}
 */
async function getActiveBoostRunsForPost(postId) {
  const { data, error } = await supabase
    .from('boost_runs')
    .select('*')
    .eq('post_id', postId)
    .in('status', ['pending', 'active'])
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getActiveBoostRunsForPost failed: ${error.message}`);
  return data || [];
}

/**
 * Flip a pending row to active when Make's callback arrives (PR3).
 * @param {string} boostRunId
 * @param {object} args  { boost_campaign_id, boost_ad_id, started_at }
 * @returns {Promise<object>}  updated row
 */
async function markBoostActive(boostRunId, { boost_campaign_id, boost_ad_id, started_at }) {
  const { data, error } = await supabase
    .from('boost_runs')
    .update({
      status: 'active',
      boost_campaign_id: boost_campaign_id || null,
      boost_ad_id: boost_ad_id || null,
      started_at: started_at || new Date().toISOString(),
    })
    .eq('id', boostRunId)
    .select()
    .single();
  if (error) throw new Error(`markBoostActive failed: ${error.message}`);
  return data;
}

/**
 * Update spend/ad metrics from the daily reconcile (PR3). Computes
 * cost_per_follow_pence = spend / new_follows when new_follows > 0.
 * @param {string} boostCampaignId
 * @param {object} metrics
 * @returns {Promise<object>}  updated row
 */
async function markBoostMetrics(boostCampaignId, metrics) {
  const spend = Number.isFinite(metrics.spend_pence) ? metrics.spend_pence : 0;
  const follows = Number.isFinite(metrics.ad_new_follows) ? metrics.ad_new_follows : 0;
  const cpf = follows > 0 ? spend / follows : null;

  const update = {
    spend_pence: spend,
    ad_impressions: metrics.ad_impressions ?? 0,
    ad_engagements: metrics.ad_engagements ?? 0,
    ad_new_follows: follows,
    ad_link_clicks: metrics.ad_link_clicks ?? 0,
    cost_per_follow_pence: cpf,
    raw_metrics: metrics.raw_metrics || null,
  };
  if (metrics.is_final) {
    update.status = 'complete';
    update.ended_at = metrics.as_of || new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('boost_runs')
    .update(update)
    .eq('boost_campaign_id', boostCampaignId)
    .select()
    .single();
  if (error) throw new Error(`markBoostMetrics failed: ${error.message}`);
  return data;
}

/**
 * Mark a pending/active row as failed with an error message stashed on meta.
 * @param {string} boostRunId
 * @param {string} errorMessage
 * @returns {Promise<object>}  updated row
 */
async function markBoostFailed(boostRunId, errorMessage) {
  // Read existing meta so we don't clobber niche_tag / source.
  const { data: existing, error: readErr } = await supabase
    .from('boost_runs')
    .select('meta')
    .eq('id', boostRunId)
    .single();
  if (readErr) throw new Error(`markBoostFailed read failed: ${readErr.message}`);

  const mergedMeta = { ...(existing && existing.meta ? existing.meta : {}), error: String(errorMessage || '') };
  const { data, error } = await supabase
    .from('boost_runs')
    .update({ status: 'failed', meta: mergedMeta, ended_at: new Date().toISOString() })
    .eq('id', boostRunId)
    .select()
    .single();
  if (error) throw new Error(`markBoostFailed failed: ${error.message}`);
  return data;
}

// ── social_audience_daily (PR3 surface — stubs callable from PR2) ──────────

/**
 * Insert today's follower snapshot. Computes follows_delta from the previous
 * day's row in the same brand/page (null when no prior row). Idempotent on
 * (brand, page_id, recorded_at) — re-runs the same day UPSERT.
 *
 * @param {object} args  { brand, page_id, followers_count, fans_count? }
 * @returns {Promise<object>}  upserted row
 */
async function upsertAudienceSnapshot({ brand, page_id, followers_count, fans_count }) {
  if (!brand || !page_id) throw new Error('upsertAudienceSnapshot: brand + page_id required');
  if (!Number.isFinite(followers_count)) throw new Error('upsertAudienceSnapshot: followers_count must be a number');

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Look up yesterday's row to compute delta.
  let follows_delta = null;
  const { data: prior, error: priorErr } = await supabase
    .from('social_audience_daily')
    .select('followers_count')
    .eq('brand', brand)
    .eq('page_id', page_id)
    .eq('recorded_at', yesterday)
    .maybeSingle();
  if (priorErr) throw new Error(`upsertAudienceSnapshot prior lookup failed: ${priorErr.message}`);
  if (prior && Number.isFinite(prior.followers_count)) {
    follows_delta = followers_count - prior.followers_count;
  }

  const payload = {
    brand,
    page_id,
    recorded_at: today,
    followers_count,
    fans_count: Number.isFinite(fans_count) ? fans_count : null,
    follows_delta,
    source: 'graph_api',
  };

  const { data, error } = await supabase
    .from('social_audience_daily')
    .upsert(payload, { onConflict: 'brand,page_id,recorded_at' })
    .select()
    .single();
  if (error) throw new Error(`upsertAudienceSnapshot failed: ${error.message}`);
  return data;
}

/**
 * Read the most recent N days of audience snapshots for charting (PR4
 * dashboard surface).
 * @param {object} args  { brand, days?: 30 }
 * @returns {Promise<Array<object>>}  ordered by recorded_at ASC
 */
async function getAudienceSeries({ brand, days = 30 }) {
  if (!brand) throw new Error('getAudienceSeries: brand required');
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('social_audience_daily')
    .select('*')
    .eq('brand', brand)
    .gte('recorded_at', since)
    .order('recorded_at', { ascending: true });
  if (error) throw new Error(`getAudienceSeries failed: ${error.message}`);
  return data || [];
}

module.exports = {
  // Mode-mix
  getSocialModeCounts,
  getRecentSocialPosts,
  hasFeaturedAnyLot,
  getRecentNicheTags,

  // Breakout (PR2 stubs)
  isBreakoutActive,
  getBreakoutTags,

  // Lot queries
  findLotsByRegion,
  findLotsByYieldBand,
  findLotsByDealTag,
  aggregateLotStats,

  // boost_runs
  insertBoostRun,
  getActiveBoostRunsForPost,
  markBoostActive,
  markBoostMetrics,
  markBoostFailed,

  // social_audience_daily
  upsertAudienceSnapshot,
  getAudienceSeries,

  // Util
  normalisePostcodePrefix,
  LOT_COLS,
};
