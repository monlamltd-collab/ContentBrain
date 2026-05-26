'use strict';

require('dotenv').config();

// ── Broker importer (Phase D) ─────────────────────────────────────────────
//
// Discovers FCA-authorised bridging brokers and upserts them as:
//   - prospects (type='broker', source='fca-register')
//   - 0..1 synthesised generic-inbox contacts per broker via the FREE
//     SYNTHETIC path (Simon's call — .ruflo/phase-d-design.md §5.1 alt
//     (c) + FREE-SYNTHETIC note in the architect's hand-off).
//
// ── Discovery strategy (architect's choice given §5.5 + ops findings) ─────
//
// The researcher mapped three discovery paths (§1.3); the architect's
// ops probe on 2026-05-25 confirmed:
//   - The FCA public bulk extract servlet returns 401 to anonymous GET —
//     gated behind an FCA account, not a hot path.
//   - The Connect Register API (V0.1) requires an `X-Auth-Email` +
//     `X-Auth-Key` pair (free registration via register.fca.org.uk/Re/,
//     1-2 working days), and is FRN-keyed — no "list firms with permission
//     X" endpoint.
//
// So the importer's discovery flow is:
//
//   1. If `options.sourceCsvPath` is provided, read it as a CSV (one FRN
//      per row, headers tolerated). This is the PREFERRED path — it
//      decouples the network call from the importer and lets Simon download
//      a fresh bulk extract offline (via his FCA Connect account) and feed
//      the importer a static file. Tests use this path too.
//
//   2. Else fall back to a Firecrawl-seeded FRN enumeration: pass a
//      small set of bridging-keyword search terms (`bridg`, `short-term`,
//      `auction finance`, `development finance`) to Firecrawl `/v2/search`,
//      let it return matching firm pages (or scrape register.fca.org.uk's
//      public search results), extract FRNs, then enrich each via
//      fca-fetch.fetchFirmByFrn(). Slow, costs a handful of Firecrawl
//      credits, but works without an FCA account.
//
//   3. For each FRN obtained: call fetchFirmByFrn(frn) → flatten the
//      Connect API envelope → run the firm-name keyword filter (§1.2 in
//      design) → keep matches → upsert.
//
// The coder implements path (1) FIRST and stubs out path (2) until Phase
// E. Phase D ships with whatever bulk-extract subset Simon hands us. Per
// the FREE-SYNTHETIC budget cap, we MAY use up to 50 Hunter free-tier
// `domain-search` calls on the highest-value brokers in the imported set
// (see contact-enrichment note below); everything else stays synthetic.
//
// ── Field mapping → prospects row shape ──────────────────────────────────
//
//   type:          'broker'
//   company_name:  firm.Organisation_Name (verbatim from FCA — strip
//                  trailing ' LIMITED' / ' LTD' / ' LLP' is OPTIONAL; v1
//                  keeps as-is for compliance traceability)
//   website:       null on import — populated later by the Firecrawl-
//                  Google-lookup-or-FCA-trading-names step (see Stage 1
//                  enrichment, design §1.5)
//   source:        'fca-register'                    (already in VALID_SOURCES)
//   metadata: {
//     frn:                            firm.FRN,                                    (string, 6-digit)
//     permission_codes:               firm.Permissions[].activity_name,            (array of strings)
//     principal_office_postcode:      firm.Address.postcode,                       (string|null)
//     firm_name_normalised:           lower(strip-suffix(company_name)),           (for dedup)
//     trading_names:                  firm.Names[],                                (array of strings)
//     company_status:                 firm.Status,                                 ('Authorised' | ...)
//     bridging_evidence: {
//       source:                       'firm_name_keyword',                         (v1 — only path)
//       keywords:                     ['bridg', ...],                              (matched terms)
//     },
//     fca_last_synced:                ISO timestamp,
//   }
//
// ── Contact synthesis (FREE-SYNTHETIC + bounded Hunter free tier) ────────
//
// Per Simon's decision:
//
//   - If `prospects.website` was discovered (via FCA Trading Names /
//     Firecrawl-seeded Google lookup — see Stage 1), insert ONE
//     `contacts` row with email = deriveContactEmail({ domain, prefix:'info' }),
//     name = NULL, role = 'Generic inbox', confidence_score = 50,
//     source = 'manual'.
//
//   - If `prospects.website` is null after discovery, SKIP — there's
//     nothing to synthesise against. Surface in `metadata.website_search_failed`
//     and Simon backfills via the dashboard.
//
//   - Hunter free-tier budget (75 calls/month, Phase B used ~0): the
//     architect MAY enable Hunter `domain-search` enrichment on a small
//     priority subset (e.g. top 50 brokers by some "priority" heuristic
//     — by company-name length proxy or first-50-imported), capped at
//     50 calls. Off by default; opt-in via `options.useHunterTopN: 50`.
//     v1 ships with `useHunterTopN: 0` per the FREE-SYNTHETIC budget cap.
//
// ── Idempotency ──────────────────────────────────────────────────────────
//
// Same as the lenders importer: prospects upsert on
// `uq_prospects_source_company` (source, lower(company_name)), contacts
// upsert on (prospect_id, lower(email)).

const { supabase } = require('../supabase');
const { assertSource } = require('./constants');
const { fetchFirmByFrn } = require('./fca-fetch');
const { deriveDomainFromUrl, deriveContactEmail } = require('./derive-domain');

const SOURCE = 'fca-register';

// Firm-name keywords that flag a bridging/short-term/auction-finance
// specialist. Case-insensitive substring match. Order does not matter;
// any one match is enough to keep the row. Curate carefully — adding
// 'finance' here would balloon the keep-set to thousands of unrelated
// IFA shops.
const BRIDGING_KEYWORDS = Object.freeze([
  'bridg',
  'short-term',
  'short term',
  'auction finance',
  'development finance',
  'specialist lend',
  'specialist finance',
]);

/**
 * Run the broker importer end-to-end.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false]
 *   Re-upsert every row even if metadata matches.
 * @param {string}  [options.sourceCsvPath]
 *   PREFERRED path. Absolute path to a CSV file containing FRNs (one per
 *   row; first-line header tolerated). Each FRN is enriched via the
 *   Connect API and filtered by firm-name keyword. When omitted, the
 *   importer falls back to Firecrawl-seeded discovery (currently STUB).
 * @param {boolean} [options.useFirecrawl=false]
 *   Enable the Firecrawl-seeded FRN discovery path. STUB in v1; default
 *   off. Coder wires this when the FCA bulk extract proves unobtainable
 *   AND Simon greenlights the Firecrawl credit spend.
 * @param {number}  [options.useHunterTopN=0]
 *   How many of the top-priority brokers to enrich via Hunter free-tier
 *   `domain-search`. 0 = pure synthetic. 50 = Simon's documented free-
 *   tier cap. Anything higher must be approved (Phase D budget rule).
 * @returns {Promise<{
 *   prospects: { inserted: number, updated: number, skipped: number },
 *   contacts:  { inserted: number, updated: number, skipped: number },
 *   warnings: string[]
 * }>}
 *   Counts + per-row warnings.
 */
async function importBrokers({
  force = false,
  sourceCsvPath,
  useFirecrawl = false,
  useHunterTopN = 0,
} = {}) {
  void force;
  void sourceCsvPath;
  void useFirecrawl;
  void useHunterTopN;
  assertSource(SOURCE);
  throw new Error('importBrokers: not yet implemented (Phase D coder stub)');
}

/**
 * Read a CSV of FRNs from disk. Tolerant of:
 *   - Optional header row (skipped if first row contains the literal "FRN"
 *     or "frn" case-insensitively).
 *   - BOM (UTF-8 byte-order mark — Excel exports it).
 *   - Trailing whitespace / blank lines.
 *   - Quoted vs unquoted cells (FRNs are integers — no commas).
 *
 * Only the FIRST column is read; extra columns are ignored so a wider
 * bulk-extract export (Firm Name, Permissions, etc.) still works.
 *
 * Test cases:
 *   readFrnCsv('frn\n122702\n308077\n')                     → ['122702', '308077']
 *   readFrnCsv('﻿122702\n308077\n')                    → ['122702', '308077']
 *   readFrnCsv('122702, Acme Bridging Ltd\n308077, BLF\n')  → ['122702', '308077']
 *
 * @param {string} csvPath  Absolute path to the CSV file.
 * @returns {Promise<string[]>} Array of FRN strings.
 * @throws  {Error}              File read or parse failure.
 */
async function readFrnCsv(csvPath) {
  throw new Error('readFrnCsv: not yet implemented (Phase D coder stub)');
}

/**
 * Apply the bridging-keyword filter to a firm's name + trading names.
 *
 * Returns an object with the matched keyword(s) for `metadata.bridging_evidence`,
 * or null if no match (caller drops the row).
 *
 * Match is case-insensitive substring. We check ALL of:
 *   - firm.Organisation_Name
 *   - firm.Names[].Trading_Name (or whatever shape Connect returns)
 *
 * Test cases:
 *   matchBridgingKeywords({ Organisation_Name: 'Acme Bridging Ltd' })
 *     → { matched: ['bridg'], source: 'firm_name_keyword' }
 *   matchBridgingKeywords({ Organisation_Name: 'Acme IFA Ltd',
 *                            Names: [{Trading_Name: 'Acme Short-Term Finance'}] })
 *     → { matched: ['short-term'], source: 'trading_name_keyword' }
 *   matchBridgingKeywords({ Organisation_Name: 'Acme Mortgages Ltd' })
 *     → null
 *
 * @param {object} firm   Flattened Connect API record (see fca-fetch).
 * @returns {{ matched: string[], source: string } | null}
 */
function matchBridgingKeywords(firm) {
  throw new Error('matchBridgingKeywords: not yet implemented (Phase D coder stub)');
}

/**
 * Map a flattened Connect API firm record into the `prospects` row shape
 * documented in the header comment. Pure function — no DB / network IO.
 *
 * @param {object} firm  Flattened Connect record.
 * @param {{ matched: string[], source: string }} bridgingEvidence
 *   The keyword-match result that admitted this firm.
 * @returns {object}  A prospect row ready for upsertProspect().
 */
function buildProspect(firm, bridgingEvidence) {
  throw new Error('buildProspect: not yet implemented (Phase D coder stub)');
}

// Re-use the lenders importer upsert helpers — identical idempotency
// guarantees. See the import-houses.js note for the same rationale.
const { upsertProspect, upsertContact } = require('./import-lenders');

module.exports = {
  importBrokers,
  readFrnCsv,
  matchBridgingKeywords,
  buildProspect,
  BRIDGING_KEYWORDS,
  upsertProspect,
  upsertContact,
};

// CLI entry point. Usage:
//   node lib/sales-brain/import-brokers.js                                  (Firecrawl fallback — STUB)
//   node lib/sales-brain/import-brokers.js --csv ./data/fca-frns.csv        (CSV path)
//   node lib/sales-brain/import-brokers.js --csv ./data/fca-frns.csv --force
//   node lib/sales-brain/import-brokers.js --hunter-top 50                  (enable Hunter free-tier on top 50)
if (require.main === module) {
  const force = process.argv.includes('--force');
  const useFirecrawl = process.argv.includes('--firecrawl');
  const csvIdx = process.argv.indexOf('--csv');
  const sourceCsvPath = csvIdx >= 0 ? process.argv[csvIdx + 1] : undefined;
  const hunterIdx = process.argv.indexOf('--hunter-top');
  const useHunterTopN = hunterIdx >= 0 ? parseInt(process.argv[hunterIdx + 1], 10) || 0 : 0;
  importBrokers({ force, sourceCsvPath, useFirecrawl, useHunterTopN })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[import-brokers] ${err.message}`);
      process.exit(1);
    });
}
