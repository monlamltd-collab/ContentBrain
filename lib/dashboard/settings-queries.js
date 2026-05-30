'use strict';

// ── Settings tab queries (Phase F-2) ──────────────────────────────────────
//
// Pure DB readers for the Settings tab. Mirrors the pipeline-queries.js
// shape: thin Supabase wrappers that return plain objects the renderers
// can consume directly. No mutations — every write goes through the
// existing helpers (runtime-config.setLever/clearLever, warming.pauseTrack/
// resumeTrack, suppression.addSuppression/removeSuppression).
//
// All bodies are STUBS — coder fills these per the design doc §2.
//
// Source of truth: .ruflo/phase-f-settings-tab-design.md.

const PAGE_SIZE = 25;

const VALID_TRACKS = ['lender', 'broker', 'auction_house'];

const VALID_CONTENT_BRANDS = ['auctionbrain', 'bridgematch'];

const VALID_TEMPLATE_TYPES = ['stat', 'hook', 'list', 'reel'];

/**
 * Read the live state for one outbound track. Used by both the initial
 * tab render and the per-card status fragment swap.
 *
 * Read paths:
 *   - cap, day, sentToday, startDate ← warming.getRemainingBudget(track)
 *     (also exposes the resolved current cap that already accounts for
 *     any steady_cap override in app_config)
 *   - isPaused              ← warming.isPaused(track)
 *   - steady_cap_override   ← runtime-config readRaw('global', `outbound.warming.${track}.steady_cap`)
 *     (null if no override; UI shows it as the empty input + the DEFAULT_STEADY_CAP placeholder)
 *   - from_address (override + resolved)
 *                           ← getResendFrom(track) gives the resolved value;
 *                             the raw override row tells us whether it's
 *                             coming from app_config, env or the default
 *   - tone                  ← runtime-config readRaw('global', `outbound_tone_${track}`)
 *
 * @param {string} track  one of VALID_TRACKS
 * @returns {Promise<{
 *   track: string,
 *   cap: number,
 *   day: number,
 *   sentToday: number,
 *   startDate: string|null,
 *   isPaused: boolean,
 *   steady_cap_override: number|null,
 *   from_address_override: string|null,
 *   from_address_resolved: string,
 *   tone: string|null,
 * }>}
 */
async function getOutboundTrackStatus(track) {
  throw new Error('NOT_IMPLEMENTED: getOutboundTrackStatus — coder owns the body');
}

/**
 * Paginated suppression list. Offset-based — same pattern as Pipeline
 * tab's getActiveSequences. Search filter `q` does a case-insensitive
 * substring match on email_or_domain (only applied when non-empty).
 *
 * Order: added_at DESC, NULLS LAST (older imported rows without a
 * timestamp sort to the end).
 *
 * @param {object} opts
 * @param {number} [opts.page=0]      zero-based
 * @param {number} [opts.pageSize=25]
 * @param {string} [opts.q]           optional substring filter
 * @returns {Promise<{
 *   rows: Array<{email_or_domain: string, reason: string, added_at: string|null}>,
 *   hasMore: boolean,
 *   page: number,
 *   pageSize: number,
 *   q: string,
 * }>}
 */
async function getSuppressionPage({ page = 0, pageSize = PAGE_SIZE, q = '' } = {}) {
  throw new Error('NOT_IMPLEMENTED: getSuppressionPage — coder owns the body');
}

/**
 * Read all Content-section levers in one batch (active_brands +
 * template_weights + per-brand editorial directives).
 *
 * Uses runtime-config.loadAllLevers + getActiveBrands + getTemplateWeights
 * + per-brand getBrandDirective. Returns the resolved values (defaults
 * already overlaid) so the renderer doesn't have to know about defaults.
 *
 * @returns {Promise<{
 *   active_brands: string[],
 *   template_weights: {stat: number, hook: number, list: number, reel: number},
 *   directives: {[brand: string]: string|null},
 * }>}
 */
async function getContentLevers() {
  throw new Error('NOT_IMPLEMENTED: getContentLevers — coder owns the body');
}

/**
 * Read all System-section levers in one batch.
 *
 * Reads via runtime-config.readRaw:
 *   - dashboard.bulk_approve_cap          (number; null = use default 10)
 *   - dashboard.send_telegram_receipt     (bool; null/missing = true)
 *   - outbound.suppression_check_enabled  (bool; null/missing = true)
 *
 * @returns {Promise<{
 *   bulk_approve_cap: number|null,
 *   send_telegram_receipt: boolean,
 *   suppression_check_enabled: boolean,
 * }>}
 */
async function getSystemLevers() {
  throw new Error('NOT_IMPLEMENTED: getSystemLevers — coder owns the body');
}

module.exports = {
  // Constants
  PAGE_SIZE,
  VALID_TRACKS,
  VALID_CONTENT_BRANDS,
  VALID_TEMPLATE_TYPES,

  // Read helpers
  getOutboundTrackStatus,
  getSuppressionPage,
  getContentLevers,
  getSystemLevers,
};
