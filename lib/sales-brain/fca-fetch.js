'use strict';

require('dotenv').config();

// ── FCA register fetch helper (Phase D) ───────────────────────────────────
//
// The FCA exposes THREE surfaces against the public register; this module
// wraps two of them (the third — the public-website search at
// register.fca.org.uk/s/ — is CAPTCHA-gated and out of scope).
//
// 1. FCA Connect Register API (V0.1) — FRN-keyed lookup endpoints:
//      GET https://register.fca.org.uk/services/V0.1/Firm/{FRN}
//      GET https://register.fca.org.uk/services/V0.1/Firm/{FRN}/Names
//      GET https://register.fca.org.uk/services/V0.1/Firm/{FRN}/Permissions
//      GET https://register.fca.org.uk/services/V0.1/Firm/{FRN}/Address
//    Auth: header `X-Auth-Email` + `X-Auth-Key` (free, requested via the
//    FCA Connect Register portal at https://register.fca.org.uk/Re/).
//    Rate limit: undocumented; researcher (.ruflo/phase-d-design.md §1.3)
//    recommends self-throttling to 5 req/sec with exponential backoff on 429.
//    No "list all firms" endpoint — FRN-keyed only. Discovery requires a
//    seed of FRNs (see fetchBulkRegister fallback OR a one-shot Firecrawl
//    of the public search).
//
// 2. FCA Public Data Extract — periodic bulk CSV/JSON dump of every
//    authorised firm. URL has historically lived at
//      https://register.fca.org.uk/servlet/servlet.FileDownload?file=<...>
//    but the path changes per release. Architect verified on 2026-05-25:
//      - The legacy Salesforce-style servlet URL returns 401 to anonymous
//        GET. The bulk extract is NOT publicly downloadable without an
//        account.
//      - The FCA's documented public-data page at
//        https://www.fca.org.uk/firms/financial-services-register/access-data
//        was unreachable from the dev box (likely transient).
//    Net: bulk extract IS gated. The importer's first-pass strategy must
//    be either (a) Connect API per-FRN with a Firecrawl-seeded FRN list,
//    or (b) a paid third-party dataset. See researcher §1.3 + §5.5.
//
// This module is a thin wrapper. It does NOT decide discovery strategy —
// import-brokers.js owns that. It DOES:
//   - own the HTTP boilerplate (headers, retries, backoff)
//   - own response shape normalisation (Connect API returns a "Data"
//     array even for single-record responses — flatten)
//   - own the file-cache pattern so re-running an importer doesn't
//     re-hit the API for FRNs already fetched this run

const FCA_API_BASE = 'https://register.fca.org.uk/services/V0.1';
const FCA_BULK_PAGE = 'https://www.fca.org.uk/firms/financial-services-register/access-data';

/**
 * Fetch the FCA public bulk data extract (or note where it lives if
 * the URL has changed). Best-effort: this is documented to be gated
 * behind an FCA account; the coder should NOT block Phase D on this.
 *
 * Two acceptable behaviours:
 *
 *   (a) If `opts.url` is provided, download from that URL using
 *       `opts.cookieJar` or `opts.bearerToken` for auth. Write the
 *       response to a file at `opts.destPath` (default
 *       'data/fca-bulk-extract.csv') and return the resolved path.
 *
 *   (b) If `opts.url` is omitted, return an Error with a descriptive
 *       message AND a non-fatal exit code so the importer can decide
 *       to fall back to the Firecrawl-seeded FRN approach.
 *
 * This function intentionally does NOT scrape the public-search website
 * (CAPTCHA-gated). Use Firecrawl from a separate helper if discovery
 * via the search UI is the chosen path.
 *
 * Test smoke (the coder writes):
 *   await fetchBulkRegister({ url: 'https://...', destPath: '/tmp/fca.csv' })
 *     // → returns '/tmp/fca.csv' on success
 *
 *   await fetchBulkRegister({})
 *     // → throws Error('FCA bulk extract URL not provided...')
 *
 * @param {object} [opts]
 * @param {string} [opts.url]         Direct download URL (current location
 *                                    must be confirmed by ops — see header
 *                                    comment).
 * @param {string} [opts.bearerToken] Optional auth for `url`.
 * @param {string} [opts.destPath]    Where to save the file. Default
 *                                    'data/fca-bulk-extract.csv'.
 * @returns {Promise<string>}         Absolute path to the downloaded file.
 * @throws  {Error}                   When the URL is missing or download
 *                                    fails. Caller should fall back.
 */
async function fetchBulkRegister(opts = {}) {
  throw new Error('fetchBulkRegister: not yet implemented (Phase D coder stub)');
}

/**
 * Fetch a single firm by FRN via the FCA Connect Register V0.1 API.
 *
 * Surface map (one HTTP call per surface — caller decides which it needs):
 *   - 'firm'        → /Firm/{FRN}             (basic + status)
 *   - 'names'       → /Firm/{FRN}/Names       (trading names)
 *   - 'permissions' → /Firm/{FRN}/Permissions (regulated activities)
 *   - 'address'     → /Firm/{FRN}/Address     (principal office)
 *
 * The default (no `surfaces` opt) fetches all four sequentially and
 * returns a merged object — convenient for the importer's "per-FRN
 * enrichment" pass. Honours the 5 req/sec self-throttle.
 *
 * Auth: header `X-Auth-Email` = process.env.FCA_AUTH_EMAIL,
 *       header `X-Auth-Key`   = process.env.FCA_AUTH_KEY.
 * Both come from the FCA Connect portal registration. The importer
 * should fail loudly if either is missing — print a one-line "request
 * a key at register.fca.org.uk/Re/" hint.
 *
 * The Connect API wraps its response in:
 *   { Status: 'FSR-API-04-01-00', ResultInfo: {...}, Message: '...',
 *     Data: [ {...the actual record...} ] }
 * Caller wants `Data[0]` (or `Data` for list-shaped surfaces like
 * Names/Permissions). This function flattens the wrapper and returns
 * the inner payload; on a non-OK Status it throws with the Message.
 *
 * Test smoke (when an FCA key is present):
 *   const firm = await fetchFirmByFrn('122702');
 *   // firm = { Organisation_Name: '...', Status: 'Authorised', ... }
 *
 * @param {string|number} frn
 * @param {object} [opts]
 * @param {Array<'firm'|'names'|'permissions'|'address'>} [opts.surfaces]
 *   Which Connect surfaces to hit. Default: all four, merged.
 * @returns {Promise<object>} Merged firm record. Shape depends on opts.surfaces.
 * @throws  {Error}            On missing env, non-2xx response, or non-OK
 *                             Status field in the Connect envelope.
 */
async function fetchFirmByFrn(frn, opts = {}) {
  throw new Error('fetchFirmByFrn: not yet implemented (Phase D coder stub)');
}

module.exports = {
  fetchBulkRegister,
  fetchFirmByFrn,
  FCA_API_BASE,
  FCA_BULK_PAGE,
};
