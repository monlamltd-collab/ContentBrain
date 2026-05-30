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
 * @param {string} track  one of 'lender' | 'broker' | 'auction_house'
 * @returns {Promise<string>}  the resolved RFC 5322 from-address
 *
 * IMPLEMENTATION STUB — Phase F-2 architect deliverable. Coder fills in the
 * runtime-config lookup body. See design doc §3.1 / §6.2.
 */
async function getResendFrom(track) {
  throw new Error('NOT_IMPLEMENTED: getResendFrom — coder owns the body');
}

module.exports = {
  getResendFrom,
  // Exported for tests + the coder's implementation; not part of the public surface.
  _internals: { DEFAULTS, ENV_KEYS },
};
