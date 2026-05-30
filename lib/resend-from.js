'use strict';

// ── Resend from-address resolver (Phase F-2) ─────────────────────────────
//
// Extracted from lib/publish.js to keep that file under 500 lines while
// introducing the new app_config-override precedence. The publish.js
// `RESEND_FROM` const used to be a static module-scope map populated at
// require-time from process.env; this module replaces it with an async
// resolver that honours runtime overrides written via the Settings tab.
//
// Precedence — first non-empty value wins:
//   1. app_config (brand='global', key='outbound.from.<track>')
//   2. process.env.RESEND_FROM_<TRACK>
//   3. hardcoded default
//
// Phase D context (kept from publish.js) — the only Resend domain verified
// today is `auctionbrain.co.uk` (apex); `outreach.bridgematch.co.uk` is
// still `not_started`. Defaults for broker + auction_house both ship from
// auctionbrain.co.uk; broker mirrors the dual-domain framing handled by
// the persona prompt's first body line. Flip via Settings → Outbound →
// From-address (or the env var) once bridgematch DNS is warmed.

require('dotenv').config();

const { VALID_TRACKS } = require('./sales-brain/constants');

// Outbound tracks supported by Resend (a subset of VALID_TRACKS — 'social'
// is the Facebook/IG path and doesn't have a from-address).
const RESEND_TRACKS = new Set(['lender', 'broker', 'auction_house']);

// Hardcoded defaults — final fallback if neither app_config nor env is set.
const DEFAULTS = {
  lender:        'Simon at BridgeMatch <outreach@outreach.bridgematch.co.uk>',
  broker:        'Simon Deeming <simon@auctionbrain.co.uk>',
  auction_house: 'Simon Deeming <simon@auctionbrain.co.uk>',
};

// Per-track env var names — kept stable so existing Railway config keeps working.
const ENV_KEYS = {
  lender:        'RESEND_FROM_LENDER',
  broker:        'RESEND_FROM_BROKER',
  auction_house: 'RESEND_FROM_AUCTION_HOUSE',
};

/**
 * Resolve the from-address for a track, honouring the app_config override.
 *
 * Precedence — first non-empty value wins:
 *   1. app_config (brand='global', key='outbound.from.<track>')
 *   2. process.env.RESEND_FROM_<TRACK>
 *   3. hardcoded DEFAULTS[track]
 *
 * Throws if `track` is not one of the Resend outbound tracks. Callers in
 * lib/publish.js already wrap this in try/catch and fall back to 'lender'
 * if the resolver throws on an unknown track.
 *
 * @param {string} track  one of 'lender' | 'broker' | 'auction_house'
 * @returns {Promise<string>}  the resolved RFC 5322 from-address
 */
async function getResendFrom(track) {
  if (typeof track !== 'string' || !RESEND_TRACKS.has(track)) {
    const valid = Array.from(RESEND_TRACKS).join(', ');
    throw new Error(`getResendFrom: invalid track '${track}'. Must be one of: ${valid}`);
  }

  // 1. app_config override — lazy-require runtime-config to keep this
  //    module free of a circular dep with lib/publish.js at boot time.
  try {
    // readRaw isn't exported by lib/runtime-config; setLever/clearLever are
    // the canonical mutators. For reads we go through loadAllLevers' cache
    // by piggy-backing on a fresh Supabase read scoped to (global, key).
    const { _readResendFromOverride } = module.exports._internals;
    const override = await _readResendFromOverride(track);
    if (typeof override === 'string' && override.trim()) {
      return override.trim();
    }
  } catch (err) {
    // Override lookup failed (transient Supabase error). Don't break the
    // send — log and fall through to env/default.
    console.warn(`[resend-from] override read for '${track}' failed: ${err.message}`);
  }

  // 2. Env var.
  const envKey = ENV_KEYS[track];
  const envVal = envKey ? process.env[envKey] : undefined;
  if (typeof envVal === 'string' && envVal.trim()) {
    return envVal.trim();
  }

  // 3. Hardcoded default — guaranteed present for every RESEND_TRACKS entry.
  return DEFAULTS[track];
}

// Internal Supabase read for the override row. Extracted so tests can stub
// it without standing up a fake Supabase client. Not part of the public
// surface — callers should use getResendFrom().
async function _readResendFromOverride(track) {
  // Lazy require so module load order with lib/publish.js stays clean and
  // tests can swap the supabase client per-test via require.cache.
  const { supabase } = require('./supabase');
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('brand', 'global')
    .eq('key', `outbound.from.${track}`)
    .maybeSingle();
  if (error) {
    throw new Error(`resend-from override read failed: ${error.message}`);
  }
  return data ? data.value : null;
}

module.exports = {
  getResendFrom,
  // Exported for tests + internal use. _readResendFromOverride is on
  // module.exports so monkey-patches in tests take effect on the call
  // inside getResendFrom (which reads via module.exports._internals).
  _internals: {
    DEFAULTS,
    ENV_KEYS,
    RESEND_TRACKS,
    VALID_TRACKS,
    _readResendFromOverride,
  },
};
