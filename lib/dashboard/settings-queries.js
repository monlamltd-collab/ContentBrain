'use strict';

// ── Settings tab queries (Phase F-2) ──────────────────────────────────────
//
// Pure DB readers for the Settings tab. Mirrors the pipeline-queries.js
// shape: thin Supabase wrappers that return plain objects the renderers
// can consume directly. No mutations — every write goes through the
// existing helpers (runtime-config.setLever/clearLever, warming.pauseTrack/
// resumeTrack, suppression.addSuppression/removeSuppression).
//
// Source of truth: .ruflo/phase-f-settings-tab-design.md.

const { supabase } = require('../supabase');
const runtimeConfig = require('../runtime-config');
const warming = require('../warming');
const { getResendFrom } = require('../resend-from');

const PAGE_SIZE = 25;

const VALID_TRACKS = ['lender', 'broker', 'auction_house'];

const VALID_CONTENT_BRANDS = ['auctionbrain', 'bridgematch'];

const VALID_TEMPLATE_TYPES = ['stat', 'hook', 'list', 'reel'];

const DEFAULT_BULK_APPROVE_CAP = 10;
const DEFAULT_STEADY_CAP = 300;
const DEFAULT_TEMPLATE_WEIGHTS = { stat: 1, hook: 1, list: 1, reel: 1 };

// Raw app_config reader — Supabase + brand/key + value column only.
// runtime-config doesn't expose `readRaw` on its public surface, so we do
// a thin pass-through here so settings-queries stays self-contained without
// reaching into runtime-config internals.
async function readAppConfigRaw(brand, key) {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('brand', brand)
    .eq('key', key)
    .maybeSingle();
  if (error) {
    console.warn(`[settings-queries] read ${brand}/${key} failed: ${error.message}`);
    return null;
  }
  return data ? data.value : null;
}

/**
 * Read the live state for one outbound track. Used by both the initial
 * tab render and the per-card status fragment swap.
 */
async function getOutboundTrackStatus(track) {
  if (!VALID_TRACKS.includes(track)) {
    throw new Error(`getOutboundTrackStatus: invalid track '${track}'`);
  }

  // Parallel reads — warming budget + paused flag + the per-track app_config
  // overrides + the resolved from-address (which itself reads app_config but
  // is cached at the supabase layer).
  const [budget, paused, steadyOverride, fromOverride, toneOverride, fromResolved] = await Promise.all([
    warming.getRemainingBudget(track),
    warming.isPaused(track),
    readAppConfigRaw('global', `outbound.warming.${track}.steady_cap`),
    readAppConfigRaw('global', `outbound.from.${track}`),
    readAppConfigRaw('global', `outbound_tone_${track}`),
    safeGetResendFrom(track),
  ]);

  return {
    track,
    cap: budget.cap,
    day: budget.day,
    sentToday: budget.sentToday,
    startDate: budget.startDate || null,
    isPaused: !!paused,
    steady_cap_default: DEFAULT_STEADY_CAP,
    steady_cap_override: typeof steadyOverride === 'number' ? steadyOverride : null,
    from_address_override: typeof fromOverride === 'string' && fromOverride.trim() ? fromOverride : null,
    from_address_resolved: fromResolved,
    tone_override: typeof toneOverride === 'string' && toneOverride.trim() ? toneOverride : null,
  };
}

async function safeGetResendFrom(track) {
  try {
    return await getResendFrom(track);
  } catch (err) {
    console.warn(`[settings-queries] getResendFrom('${track}') failed: ${err.message}`);
    return '';
  }
}

/**
 * Paginated suppression list. Offset-based, 25/page, ordered added_at DESC.
 * Optional substring filter `q` applies to email_or_domain (case-insensitive).
 */
async function getSuppressionPage({ page = 0, pageSize = PAGE_SIZE, q = '' } = {}) {
  const safePage = Number.isInteger(page) && page >= 0 ? page : 0;
  const safeSize = Number.isInteger(pageSize) && pageSize > 0 ? Math.min(pageSize, 100) : PAGE_SIZE;
  const safeQ = typeof q === 'string' ? q.trim() : '';

  // Fetch one extra row so we can infer hasMore without a count() round-trip.
  let query = supabase
    .from('suppression')
    .select('email_or_domain, reason, added_at')
    .order('added_at', { ascending: false, nullsFirst: false })
    .range(safePage * safeSize, safePage * safeSize + safeSize); // inclusive end → size+1 rows

  if (safeQ) {
    // ilike pattern — Supabase auto-escapes the value but we still want to
    // strip any '%' / '_' the user typed so the substring stays literal.
    const escaped = safeQ.replace(/[\\%_]/g, m => `\\${m}`);
    query = query.ilike('email_or_domain', `%${escaped}%`);
  }

  const { data, error } = await query;
  if (error) {
    throw new Error(`getSuppressionPage failed: ${error.message}`);
  }

  const all = Array.isArray(data) ? data : [];
  const hasMore = all.length > safeSize;
  const rows = hasMore ? all.slice(0, safeSize) : all;

  return { rows, hasMore, page: safePage, pageSize: safeSize, q: safeQ };
}

/**
 * Read all Content-section levers in one batch.
 */
async function getContentLevers() {
  const [activeBrands, weights, ...directiveValues] = await Promise.all([
    runtimeConfig.getActiveBrands(),
    runtimeConfig.getTemplateWeights(),
    ...VALID_CONTENT_BRANDS.map(b => runtimeConfig.getBrandDirective(b)),
  ]);

  const directives = {};
  VALID_CONTENT_BRANDS.forEach((b, i) => {
    directives[b] = directiveValues[i] || null;
  });

  // Ensure template weights cover all 4 template types (defaults to 1).
  const template_weights = { ...DEFAULT_TEMPLATE_WEIGHTS, ...(weights || {}) };

  return {
    active_brands: Array.isArray(activeBrands) ? activeBrands : [],
    template_weights,
    directives,
  };
}

/**
 * Read all System-section levers in one batch.
 */
async function getSystemLevers() {
  const [bulkCap, telegramReceipt, suppressionCheck] = await Promise.all([
    readAppConfigRaw('global', 'dashboard.bulk_approve_cap'),
    readAppConfigRaw('global', 'dashboard.send_telegram_receipt'),
    readAppConfigRaw('global', 'outbound.suppression_check_enabled'),
  ]);

  return {
    bulk_approve_cap: typeof bulkCap === 'number' ? bulkCap : null,
    // Defaults to ON when the row is missing — matches lib/outbound-receipt's
    // "missing row = default on" semantics.
    send_telegram_receipt: telegramReceipt !== false,
    // Defaults to ON when the row is missing — the safe failure mode for PECR.
    suppression_check_enabled: suppressionCheck !== false,
  };
}

module.exports = {
  // Constants
  PAGE_SIZE,
  VALID_TRACKS,
  VALID_CONTENT_BRANDS,
  VALID_TEMPLATE_TYPES,
  DEFAULT_BULK_APPROVE_CAP,
  DEFAULT_STEADY_CAP,
  DEFAULT_TEMPLATE_WEIGHTS,

  // Read helpers
  getOutboundTrackStatus,
  getSuppressionPage,
  getContentLevers,
  getSystemLevers,

  // Internal — exposed for tests.
  _internals: { readAppConfigRaw, safeGetResendFrom },
};
