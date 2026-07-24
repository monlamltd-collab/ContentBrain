'use strict';

/**
 * Live-inventory helpers for ContentBrain lot pickers.
 *
 * Aligns with AuctionBrain lifecycle/MMOA model:
 * - Traditional live = real auction_date >= today (and usually within a content horizon)
 * - MMOA/continuous must NOT ride on sentinel date 2099-12-31
 * - Prefer lot_search_state when deployed; fall back to lots with safe date bounds
 *
 * Spec: AuctionBrain-Landing/docs/lot-lifecycle-filters.md
 */

const SENTINEL_AUCTION_DATE = '2099-12-31';
const REAL_DATE_BEFORE = '2090-01-01';
const DEFAULT_MMOA_STALE_DAYS = 30;

/** @param {Date} [now] */
function todayUTC(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** @param {number} days @param {Date} [now] */
function daysAheadUTC(days, now = new Date()) {
  return new Date(now.getTime() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** @param {number} days @param {Date} [now] */
function daysAgoISO(days, now = new Date()) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function isRealAuctionDate(d) {
  if (d == null || d === '') return false;
  const s = String(d).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && s < REAL_DATE_BEFORE;
}

function isSentinelDate(d) {
  return String(d || '').slice(0, 10) === SENTINEL_AUCTION_DATE;
}

/**
 * Apply traditional "upcoming within window" bounds that exclude sentinel 2099 dates.
 * Use on `lots` table queries (fallback path).
 *
 * @param {any} query supabase query builder
 * @param {object} opts
 * @param {string} opts.today YYYY-MM-DD
 * @param {string} [opts.horizonEnd] YYYY-MM-DD inclusive upper bound
 * @param {boolean} [opts.requireAvailable]
 */
function applyTraditionalLiveWindow(query, opts = {}) {
  const today = opts.today || todayUTC();
  query = query.gte('auction_date', today).lt('auction_date', REAL_DATE_BEFORE);
  if (opts.horizonEnd) {
    query = query.lte('auction_date', opts.horizonEnd);
  }
  if (opts.requireAvailable) {
    query = query.eq('status', 'available');
  }
  return query;
}

/**
 * PostgREST OR clause: traditional live within horizon OR fresh MMOA available.
 * Requires columns on target relation: auction_date, status, last_seen_at.
 *
 * Note: without calendar join, MMOA is approximated as:
 *   available + null auction_date + fresh last_seen
 * OR available + sentinel auction_date + fresh last_seen
 * This may include a few unknown-date traditionals; lot_search_state is preferred.
 *
 * @param {object} opts
 * @param {string} opts.today
 * @param {string} [opts.horizonEnd]
 * @param {number} [opts.mmoaStaleDays]
 * @param {Date} [opts.now]
 */
function liveInventoryOrClause(opts = {}) {
  const today = opts.today || todayUTC(opts.now);
  const staleDays = opts.mmoaStaleDays ?? DEFAULT_MMOA_STALE_DAYS;
  const seenSince = daysAgoISO(staleDays, opts.now);
  const horizon = opts.horizonEnd;

  const traditional = horizon
    ? `and(auction_date.gte.${today},auction_date.lt.${REAL_DATE_BEFORE},auction_date.lte.${horizon},status.eq.available)`
    : `and(auction_date.gte.${today},auction_date.lt.${REAL_DATE_BEFORE},status.eq.available)`;

  // Sentinel continuous catalogues sometimes store 2099 on the lot row.
  const mmoaSentinel = `and(auction_date.eq.${SENTINEL_AUCTION_DATE},status.eq.available,last_seen_at.gte.${seenSince})`;
  // Continuous catalogues often leave auction_date null.
  const mmoaNull = `and(auction_date.is.null,status.eq.available,last_seen_at.gte.${seenSince})`;

  return `${traditional},${mmoaSentinel},${mmoaNull}`;
}

/**
 * Prefer lot_search_state live rows when the Step A view exists.
 * Returns { data, error, source: 'lot_search_state'|'lots' }.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {object} opts
 * @param {string} opts.select
 * @param {number} [opts.limit]
 * @param {string} [opts.today]
 * @param {string} [opts.horizonEnd] applied to traditional live only
 * @param {boolean} [opts.imageRequired]
 * @param {number|null} [opts.minScore]
 * @param {(q:any)=>any} [opts.refine] extra filters on the builder
 * @param {{column:string, ascending:boolean}} [opts.order]
 * @param {boolean} [opts.includeMmoa] default true
 * @param {'traditional'|'mmoa'|'both'} [opts.format] default both
 */
async function queryLiveLots(supabase, opts = {}) {
  const select = opts.select;
  if (!select) throw new Error('queryLiveLots: select required');
  const limit = opts.limit ?? 30;
  const today = opts.today || todayUTC();
  const includeMmoa = opts.includeMmoa !== false && opts.format !== 'traditional';
  const traditionalOnly = opts.format === 'traditional' || opts.includeMmoa === false;
  const mmoaOnly = opts.format === 'mmoa';

  // --- preferred path: Step A view ---
  try {
    let states;
    if (mmoaOnly) states = ['live_mmoa'];
    else if (traditionalOnly) states = ['live_traditional'];
    else states = ['live_traditional', 'live_mmoa'];

    let q = supabase.from('lot_search_state').select(select).in('lifecycle_state', states);

    if (opts.horizonEnd && !mmoaOnly) {
      // Keep MMOA; bound traditional effective dates when present.
      q = q.or(
        `lifecycle_state.eq.live_mmoa,and(lifecycle_state.eq.live_traditional,effective_auction_date.lte.${opts.horizonEnd})`
      );
    }

    if (opts.imageRequired) {
      q = q.not('image_url', 'is', null).neq('image_url', '');
    }
    if (opts.minScore != null) {
      q = q.gte('score', opts.minScore);
    }
    if (typeof opts.refine === 'function') {
      q = opts.refine(q) || q;
    }
    if (opts.order) {
      q = q.order(opts.order.column, { ascending: opts.order.ascending });
    }

    const { data, error } = await q.limit(limit);
    if (!error) {
      return { data: data || [], error: null, source: 'lot_search_state' };
    }
    // undefined relation / permission → fall through
    if (!/does not exist|42P01|lot_search_state|permission|schema cache/i.test(error.message || '')) {
      return { data: null, error, source: 'lot_search_state' };
    }
  } catch (err) {
    // fall through to lots
  }

  // --- fallback path: lots table with safe bounds ---
  let q = supabase.from('lots').select(select);

  if (mmoaOnly) {
    const seenSince = daysAgoISO(DEFAULT_MMOA_STALE_DAYS);
    q = q.eq('status', 'available').gte('last_seen_at', seenSince).or(
      `auction_date.is.null,auction_date.eq.${SENTINEL_AUCTION_DATE}`
    );
  } else if (traditionalOnly) {
    q = applyTraditionalLiveWindow(q, {
      today,
      horizonEnd: opts.horizonEnd,
      requireAvailable: true,
    });
  } else {
    q = q.or(liveInventoryOrClause({ today, horizonEnd: opts.horizonEnd }));
  }

  if (opts.imageRequired) {
    q = q.not('image_url', 'is', null).neq('image_url', '');
  }
  if (opts.minScore != null) {
    q = q.gte('score', opts.minScore);
  }
  if (typeof opts.refine === 'function') {
    q = opts.refine(q) || q;
  }
  if (opts.order) {
    q = q.order(opts.order.column, { ascending: opts.order.ascending });
  }

  const { data, error } = await q.limit(limit);
  return { data: data || [], error, source: 'lots' };
}

/**
 * Filter in-memory rows that must never be treated as traditional upcoming.
 * @param {object[]} rows
 * @param {object} [opts]
 */
function rejectNonActionableLiveRows(rows, opts = {}) {
  const today = opts.today || todayUTC();
  const horizonEnd = opts.horizonEnd || null;
  return (rows || []).filter((r) => {
    if (isSentinelDate(r.auction_date) || isSentinelDate(r.lot_auction_date)) {
      // MMOA-ish — keep only if available
      return !opts.traditionalOnly && r.status === 'available';
    }
    if (isRealAuctionDate(r.auction_date) || isRealAuctionDate(r.effective_auction_date)) {
      const d = String(r.effective_auction_date || r.auction_date).slice(0, 10);
      if (d < today) return false;
      if (horizonEnd && d > horizonEnd) return false;
      return true;
    }
    // null date: only keep when not traditionalOnly (possible MMOA)
    return !opts.traditionalOnly && r.status === 'available';
  });
}

module.exports = {
  SENTINEL_AUCTION_DATE,
  REAL_DATE_BEFORE,
  DEFAULT_MMOA_STALE_DAYS,
  todayUTC,
  daysAheadUTC,
  daysAgoISO,
  isRealAuctionDate,
  isSentinelDate,
  applyTraditionalLiveWindow,
  liveInventoryOrClause,
  queryLiveLots,
  rejectNonActionableLiveRows,
};
