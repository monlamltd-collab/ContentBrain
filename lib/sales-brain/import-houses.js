'use strict';

require('dotenv').config();

// ── Auction-house importer (Phase D) ──────────────────────────────────────
//
// Reads `HOUSE_DISPLAY_NAMES` + `HOUSE_ROOTS` from the Auction repo at
//   C:\Users\User\Documents\GitHub\Auction\lib\houses.js
// and upserts:
//   - ~218 prospects (type='auction_house', source='auction-brain')
//   - 1 synthesised generic-inbox contact per prospect WHERE a non-platform
//     domain is derivable (free-synthetic path — Simon's decision; see
//     .ruflo/phase-d-design.md §5.1 alt (c) + this file's header comment
//     in import-brokers.js for the wider FREE-SYNTHETIC rationale).
//
// Idempotent: re-running upserts on the same (source, lower(company_name))
// unique index used by import-lenders.js. Contacts upsert on
// (prospect_id, lower(email)).
//
// ── How we read houses.js (CJS vs ESM) ────────────────────────────────────
// The Auction repo is ESM (`export const HOUSE_DISPLAY_NAMES = ...`) and
// ContentBrain is CJS. A path-based `require('.../houses.js')` will fail
// with "Cannot use import statement outside a module".
//
// The CLEANEST path is dynamic ESM import:
//   const houses = await import('file:///C:/Users/User/.../Auction/lib/houses.js');
//   const { HOUSE_DISPLAY_NAMES, HOUSE_ROOTS } = houses;
// Node 20 supports `await import()` in CJS via the ESM loader. This is
// the path the coder should implement. The Auction `houses.js` calls
// `import { HEADERS } from './config.js';` at the top which imports
// without side effects — safe to evaluate.
//
// If the dynamic import path proves brittle (e.g. config.js side-effects
// surface later), the fallback is a thin regex-parse of the source file
// for the two `export const X = { ... };` blocks. The researcher rejected
// the snapshot-JSON approach the lenders importer uses because keeping
// the JSON in sync would be a fresh source of drift — direct read is
// fewer moving parts. Keep the helper here pluggable so either approach
// fits behind `readHouses()`.
//
// ── Mapping ──────────────────────────────────────────────────────────────
// For each slug → display_name:
//   type:          'auction_house'
//   company_name:  display_name
//   website:       deriveDomainFromUrl(HOUSE_ROOTS[slug]) — or null for
//                  retired houses (no HOUSE_ROOTS entry) and for platform-
//                  hosted houses (URL is `<slug>.eigonlineauctions.com` —
//                  the brand domain is not what we want as `info@<...>`).
//   source:        'auction-brain'                    (already in VALID_SOURCES)
//   metadata: {
//     slug,
//     display_name,
//     catalogue_root_url: HOUSE_ROOTS[slug] || null,
//     region:           inferRegion(slug),            (see below)
//     platform:         inferPlatform(HOUSE_ROOTS[slug]),
//     active:           !!HOUSE_ROOTS[slug],
//     imported_at:      ISO timestamp,
//   }
//
// `region` derivation rule — Simon's call, .ruflo/phase-d-design.md §5.6 +
// brief: auto-derive ONLY for Auction House UK regional branches whose
// slug starts with `auctionhouse` (e.g. `auctionhousenorthwest` → "North West",
// `auctionhouseeastanglia` → "East Anglia"). For every other slug, leave
// `region: null`. Format / RICS-regulation are punted to Phase E.
//
// ── Contact synthesis (FREE-SYNTHETIC) ────────────────────────────────────
// Per Simon's call:
//   - If `HOUSE_ROOTS[slug]` exists AND the derived host is NOT a known
//     multi-tenant platform (see derive-domain.PLATFORM_HOSTS), insert ONE
//     `contacts` row with email = deriveContactEmail({ domain, prefix:'info' }),
//     name = NULL, role = 'Generic inbox', confidence_score = 50,
//     source = 'manual' (we are MANUALLY synthesising — not a Hunter result,
//     not from the Auction repo's data).
//   - If the host IS a platform (the brand's "site" is just a hosted
//     subdomain), DO NOT synthesise — the email would land at the platform,
//     not the house. Skip and warn; Simon adds manually via the dashboard
//     when he has the real address.
//   - Hunter `email-verifier` calls are intentionally OMITTED in v1 (Simon's
//     FREE path). A coder-side flag `verifyWithHunter: true` may be added
//     later to enable per-pattern verification when budget permits.
//
// Expected counts (per researcher):
//   218 prospects, ~150-180 synthetic contacts. The remaining ~40 are
//   platform-hosted houses or houses without a HOUSE_ROOTS entry.

const path = require('path');
const { supabase } = require('../supabase');
const { assertSource } = require('./constants');
const { deriveDomainFromUrl, deriveContactEmail, isPlatformHost } = require('./derive-domain');

const DEFAULT_HOUSES_PATH = 'C:\\Users\\User\\Documents\\GitHub\\Auction\\lib\\houses.js';
const SOURCE = 'auction-brain';

/**
 * Run the auction-house importer end-to-end.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false]   Re-upsert every row even if
 *   metadata matches. Used to backfill new metadata keys.
 * @param {string}  [options.housesPath]    Override the path to Auction's
 *   houses.js. Defaults to the constant above; CI/tests may stub this.
 * @param {boolean} [options.synthesiseContacts=true] Insert a synthetic
 *   `info@<domain>` contact per non-platform house. Set false to import
 *   prospects only.
 * @returns {Promise<{
 *   prospects: { inserted: number, updated: number, skipped: number },
 *   contacts:  { inserted: number, updated: number, skipped: number },
 *   warnings: string[]
 * }>}
 *   Counts + per-row warnings (e.g. "skip <slug>: platform-hosted, no
 *   synthesised contact").
 */
async function importHouses({ force = false, housesPath, synthesiseContacts = true } = {}) {
  void force;
  void housesPath;
  void synthesiseContacts;
  assertSource(SOURCE);
  throw new Error('importHouses: not yet implemented (Phase D coder stub)');
}

/**
 * Read `HOUSE_DISPLAY_NAMES` + `HOUSE_ROOTS` from the Auction repo.
 *
 * Two acceptable implementations (coder picks; preferred is (a)):
 *
 *   (a) Dynamic ESM import — `await import('file://' + abs(housesPath))`.
 *       Returns an object with the named exports. Node 20+ in CJS.
 *
 *   (b) Regex-parse the source file for the two `export const X = {...};`
 *       blocks and `eval` each in a sandboxed Function. Brittle; only
 *       use if (a) hits side-effect pain from `./config.js`.
 *
 * @param {string} [housesPath]   Absolute path to Auction/lib/houses.js.
 *                                Defaults to DEFAULT_HOUSES_PATH.
 * @returns {Promise<{
 *   HOUSE_DISPLAY_NAMES: Record<string,string>,
 *   HOUSE_ROOTS:         Record<string,string>
 * }>}
 * @throws  {Error}                When the file is missing or parse fails.
 */
async function readHouses(housesPath = DEFAULT_HOUSES_PATH) {
  void path; // silence the linter — path is reserved for the coder's file:// URL build
  throw new Error('readHouses: not yet implemented (Phase D coder stub)');
}

/**
 * Auto-derive `metadata.region` from an auction-house slug.
 *
 * Auction House UK runs regional branches whose slugs share the
 * `auctionhouse` prefix — e.g. `auctionhousenorthwest`,
 * `auctionhousehull`, `auctionhouselincolnshire`. For these slugs, strip
 * the prefix and humanise the remainder ("northwest" → "North West",
 * "hullandeastyorkshire" → "Hull and East Yorkshire", etc.).
 *
 * For every other slug, return null. Format / national vs regional
 * is out of scope for v1 (Phase E).
 *
 * Test cases (coder locks in):
 *   inferRegion('auctionhousenorthwest')      === 'North West'
 *   inferRegion('auctionhouseeastanglia')     === 'East Anglia'
 *   inferRegion('auctionhousehull')           === 'Hull and East Yorkshire'  // see HOUSE_ROOTS URL
 *   inferRegion('savills')                    === null
 *   inferRegion('')                           === null
 *
 * Note on the Hull case: the slug is `auctionhousehull` but the URL is
 * `.../hullandeastyorkshire/...` — the slug under-represents the actual
 * branch coverage. The coder MAY (optionally) prefer to derive region
 * from the URL path slug rather than the prospect slug; the brief allows
 * either. Stick with the slug for v1 — it's deterministic + free.
 *
 * @param {string} slug
 * @returns {string|null}
 */
function inferRegion(slug) {
  throw new Error('inferRegion: not yet implemented (Phase D coder stub)');
}

/**
 * Cheap platform inference from the catalogue-root URL.
 *
 * Returns one of: 'eig', 'bamboo', 'goto', 'auctionhouse-uk', 'iamsold',
 * 'bespoke'. Used for metadata.platform; nice-to-have, not blocking
 * (researcher §2.3 — it's a credibility marker in the persona ("we
 * already integrate with EIG houses")).
 *
 * Rules (in order):
 *   contains 'eigonlineauctions.com' or 'eigpropertyauctions.co.uk' → 'eig'
 *   contains 'bambooauctions.com'                                   → 'bamboo'
 *   contains 'gotoproperties.co.uk'                                 → 'goto'
 *   contains 'auctionhouse.co.uk' (regional branch)                 → 'auctionhouse-uk'
 *   contains 'iamsold.co.uk'                                        → 'iamsold'
 *   else                                                            → 'bespoke'
 *   null/empty input                                                → null
 *
 * @param {string|null} url
 * @returns {string|null}
 */
function inferPlatform(url) {
  throw new Error('inferPlatform: not yet implemented (Phase D coder stub)');
}

// Re-use the lenders importer upsert helpers (they are case-insensitive on
// (source, lower(company_name)) and (prospect_id, lower(email)) — exactly
// what we want here). Importing here keeps the houses importer dependency-
// free of bespoke upsert code; if the lenders importer's helpers ever need
// to diverge, copy them in then.
const { upsertProspect, upsertContact } = require('./import-lenders');

module.exports = {
  importHouses,
  readHouses,
  inferRegion,
  inferPlatform,
  // Re-exported for tester convenience:
  upsertProspect,
  upsertContact,
};

// CLI entry point. Usage:
//   node lib/sales-brain/import-houses.js
//   node lib/sales-brain/import-houses.js --force
//   node lib/sales-brain/import-houses.js --no-contacts          (prospects only)
//   node lib/sales-brain/import-houses.js --houses-path /custom  (override source)
if (require.main === module) {
  const force = process.argv.includes('--force');
  const synthesiseContacts = !process.argv.includes('--no-contacts');
  const pathIdx = process.argv.indexOf('--houses-path');
  const housesPath = pathIdx >= 0 ? process.argv[pathIdx + 1] : undefined;
  importHouses({ force, synthesiseContacts, housesPath })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[import-houses] ${err.message}`);
      process.exit(1);
    });
}
