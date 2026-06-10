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
// ── Discovery flow ──
//
// 1. PREFERRED: pass `--source-csv <path>` to a CSV pre-downloaded from
//    the FCA bulk extract. The CSV may be either:
//      (a) BARE FRN LIST — single column of FRNs; each is enriched live
//          via fca-fetch.fetchFirmByFrn (requires FCA_AUTH_EMAIL +
//          FCA_AUTH_KEY env vars).
//      (b) RICH BULK EXTRACT — multi-column CSV with firm name +
//          permissions + address pre-populated. Faster, no Connect API
//          calls needed. Header autodetect handles both shapes.
//
// 2. FALLBACK: if `--source-csv` is omitted AND `FCA_AUTH_EMAIL` is set,
//    call `fca-fetch.fetchBulkRegister` to download the extract first.
//    If neither is available, fail with a clear message.
//
// 3. For each candidate row: run the bridging-keyword filter against
//    firm name + trading names → keep matches → upsert.
//
// ── Streaming CSV ──
//
// The bulk extract is documented to grow into the tens of megabytes
// (35k+ firms). Use Node's built-in `readline` over a file stream to
// avoid loading the whole thing into memory. Parsing is line-by-line
// CSV (no nested quotes / embedded newlines — the FCA extract is
// simple enough).
//
// ── Contact synthesis ──
//
// If a `website` was discovered (from the CSV column or the Connect
// `Firm` surface), derive a domain and insert ONE generic-inbox contact
// at confidence_score=50, source='manual'. If no website, skip and stash
// `metadata.website_search_failed = true` so Simon can backfill.
//
// ── Hunter free-tier (opt-in) ──
//
// `useHunterTopN > 0` enables Hunter `domain-search` for the top-N
// firms ranked by BRIDGING-KEYWORD STRENGTH (number of bridging
// keywords matched in firm + trading names; ties broken by firm-name
// length so shorter/more focused names rank higher). Default off
// (FREE-SYNTHETIC path). The Hunter call itself is delegated to
// `lib/enrich.js#enrichDomain` to keep the call shape consistent with
// the Phase B lender enrichment.

const fs = require('fs');
const readline = require('readline');
const path = require('path');

const { supabase } = require('../supabase');
const { assertSource } = require('./constants');
const { fetchFirmByFrn, fetchBulkRegister } = require('./fca-fetch');
const { deriveDomainFromUrl, deriveContactEmail } = require('./derive-domain');

const SOURCE = 'fca-register';

// Firecrawl JSON-extraction schema for broker-website contact discovery
// (Phase E). Named people are preferred over generic inboxes.
const CONTACT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    emails: {
      type: 'array',
      items: { type: 'string' },
      description: 'all contact email addresses found on the page',
    },
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          role: { type: 'string' },
          email: { type: 'string' },
        },
        required: ['name'],
      },
      description: 'named people with roles (directors, brokers, BDMs) and their direct emails where shown',
    },
  },
});

const DEFAULT_FIRECRAWL_TOP_N = 25;

// Firm-name keywords that flag a bridging/short-term/auction-finance
// specialist. Case-insensitive substring match. Order does not matter;
// any one match keeps the row. Curate carefully — adding 'finance'
// here would balloon the keep-set to thousands of unrelated IFA shops.
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
 * @param {string}  [options.sourceCsvPath]
 *   Absolute path to a pre-downloaded FCA CSV. Header is autodetected;
 *   may be a bare FRN list or a rich bulk-extract export.
 * @param {boolean} [options.useFirecrawl=false]   Phase E: scrape broker
 *   websites via Firecrawl for contact emails/people when Hunter found
 *   nothing. Applies to the top firecrawlTopN keyword-ranked firms.
 * @param {number}  [options.firecrawlTopN=25]     cap on Firecrawl scrapes.
 * @param {number}  [options.useHunterTopN=0]      0 = pure synthetic.
 * @returns {Promise<{
 *   prospects: { inserted: number, updated: number, skipped: number },
 *   contacts:  { inserted: number, updated: number, skipped: number },
 *   warnings: string[]
 * }>}
 */
async function importBrokers({
  force = false,
  sourceCsvPath,
  useFirecrawl = false,
  firecrawlTopN = DEFAULT_FIRECRAWL_TOP_N,
  useHunterTopN = 0,
} = {}) {
  void force;
  assertSource(SOURCE);

  let csvPath = sourceCsvPath;
  if (!csvPath) {
    if (process.env.FCA_AUTH_EMAIL) {
      console.log('[import-brokers] no --source-csv; attempting fetchBulkRegister()');
      csvPath = await fetchBulkRegister();
    } else {
      throw new Error(
        'No CSV source. Download the FCA bulk extract via your FCA Connect ' +
        'account and pass --source-csv <path>, OR set FCA_AUTH_EMAIL + ' +
        'FCA_AUTH_KEY in .env and supply FCA_BULK_EXTRACT_URL. ' +
        'Register for a free key at https://register.fca.org.uk/Re/.'
      );
    }
  }

  console.log(`[import-brokers] reading CSV: ${csvPath}`);
  const rows = await readBrokerCsv(csvPath);
  console.log(`[import-brokers] loaded ${rows.length} CSV rows`);

  const result = {
    prospects: { inserted: 0, updated: 0, skipped: 0 },
    contacts:  { inserted: 0, updated: 0, skipped: 0 },
    warnings: [],
  };

  // ── Pass 1: build firm records, applying the bridging filter ──
  const matched = [];
  for (const row of rows) {
    let firm = row;
    if (!row.firm_name && row.frn) {
      // BARE FRN CSV — enrich via Connect API.
      try {
        firm = await fetchFirmByFrn(row.frn);
      } catch (err) {
        const w = `[import-brokers] skip FRN ${row.frn}: ${err.message}`;
        console.warn(w);
        result.warnings.push(w);
        result.prospects.skipped++;
        continue;
      }
    }

    const evidence = matchBridgingKeywords(firm);
    if (!evidence) {
      result.prospects.skipped++;
      continue;
    }
    matched.push({ firm, evidence });
  }
  console.log(`[import-brokers] ${matched.length} firms matched bridging-keyword filter`);

  // ── Rank by bridging-keyword strength for top-N enrichment passes ──
  // (shared by Hunter and Firecrawl — strongest matches enriched first)
  if (useHunterTopN > 0 || useFirecrawl) {
    matched.sort(keywordStrengthComparator);
  }

  // ── Pass 2: upsert prospects + synth contacts ──
  for (let i = 0; i < matched.length; i++) {
    const { firm, evidence } = matched[i];
    const prospectRow = buildProspect(firm, evidence);

    let prospectId;
    try {
      const r = await upsertProspect(prospectRow);
      prospectId = r.id;
      if (r.inserted) result.prospects.inserted++;
      else result.prospects.updated++;
    } catch (err) {
      const w = `[import-brokers] skip prospect ${prospectRow.company_name}: ${err.message}`;
      console.warn(w);
      result.warnings.push(w);
      result.prospects.skipped++;
      continue;
    }

    // Per-firm count of real (non-synthetic) contacts found — Firecrawl
    // only runs when Hunter produced nothing for this firm.
    let firmContactsAdded = 0;

    // Hunter enrichment (opt-in, top-N only).
    if (useHunterTopN > 0 && i < useHunterTopN && prospectRow.website) {
      try {
        const enrich = require('../enrich');
        if (typeof enrich.enrichDomain === 'function') {
          const enriched = await enrich.enrichDomain(prospectRow.website);
          if (enriched && Array.isArray(enriched.contacts)) {
            for (const c of enriched.contacts.slice(0, 3)) {
              const contact = {
                prospect_id: prospectId,
                name: c.name || null,
                role: c.role || 'Decision maker',
                email: (c.email || '').toLowerCase(),
                linkedin_url: c.linkedin_url || null,
                confidence_score: typeof c.confidence === 'number' ? c.confidence : 70,
                source: 'hunter',
              };
              if (!contact.email) continue;
              try {
                const r = await upsertContact(contact);
                if (r.inserted) result.contacts.inserted++;
                else result.contacts.updated++;
                firmContactsAdded++;
              } catch (err) {
                const w = `[import-brokers] skip Hunter contact ${contact.email}: ${err.message}`;
                console.warn(w);
                result.warnings.push(w);
                result.contacts.skipped++;
              }
            }
          }
        }
      } catch (err) {
        const w = `[import-brokers] Hunter enrichment failed for ${prospectRow.company_name}: ${err.message}`;
        console.warn(w);
        result.warnings.push(w);
      }
    }

    // Firecrawl enrichment (Phase E, opt-in) — scrape the broker's website
    // for contact emails / named people when Hunter found nothing. Top-N
    // keyword-ranked firms with a website only; per-firm failures warn and
    // continue (mirror the Hunter block).
    if (useFirecrawl && i < firecrawlTopN && prospectRow.website && firmContactsAdded === 0) {
      try {
        const { firecrawlScrape, isFirecrawlConfigured } = require('../firecrawl');
        if (!isFirecrawlConfigured()) {
          if (i === 0) result.warnings.push('[import-brokers] --firecrawl set but FIRECRAWL_API_KEY missing — skipping enrichment');
        } else {
          const data = await firecrawlScrape(`https://${prospectRow.website}`, {
            formats: [{
              type: 'json',
              schema: CONTACT_SCHEMA,
              prompt: 'Find contact email addresses and named people (name, role, direct email) for this UK finance broker. Look in headers, footers, contact and team/about pages content.',
            }],
            timeoutMs: 45000,
          });
          const found = (data && data.json) || {};
          const candidates = [];
          // Named people with direct emails first (confidence 70)
          for (const p of (found.people || [])) {
            if (p && p.email && /@/.test(p.email)) {
              candidates.push({ name: p.name || null, role: p.role || 'Decision maker', email: p.email.toLowerCase(), confidence: 70 });
            }
          }
          // Then generic inbox addresses (confidence 60), deduped
          for (const e of (found.emails || [])) {
            const email = String(e || '').toLowerCase();
            if (/@/.test(email) && !candidates.some(c => c.email === email)) {
              candidates.push({ name: null, role: 'Generic inbox', email, confidence: 60 });
            }
          }
          for (const c of candidates.slice(0, 3)) {
            const contact = {
              prospect_id: prospectId,
              name: c.name,
              role: c.role,
              email: c.email,
              linkedin_url: null,
              confidence_score: c.confidence,
              source: 'firecrawl',
            };
            try {
              const r = await upsertContact(contact);
              if (r.inserted) result.contacts.inserted++;
              else result.contacts.updated++;
              firmContactsAdded++;
            } catch (err) {
              const w = `[import-brokers] skip Firecrawl contact ${contact.email}: ${err.message}`;
              console.warn(w);
              result.warnings.push(w);
              result.contacts.skipped++;
            }
          }
        }
      } catch (err) {
        const w = `[import-brokers] Firecrawl enrichment failed for ${prospectRow.company_name}: ${err.message}`;
        console.warn(w);
        result.warnings.push(w);
      }
    }

    // FREE-SYNTHETIC fallback: always attempt one info@ if domain present.
    if (prospectRow.website) {
      const email = deriveContactEmail({ domain: prospectRow.website, prefix: 'info' });
      if (email) {
        const contact = {
          prospect_id: prospectId,
          name: null,
          role: 'Generic inbox',
          email,
          linkedin_url: null,
          confidence_score: 50,
          source: 'manual',
        };
        try {
          const r = await upsertContact(contact);
          if (r.inserted) result.contacts.inserted++;
          else result.contacts.updated++;
        } catch (err) {
          const w = `[import-brokers] skip synth contact ${email} (${prospectRow.company_name}): ${err.message}`;
          console.warn(w);
          result.warnings.push(w);
          result.contacts.skipped++;
        }
      }
    } else {
      const w = `[import-brokers] no website for ${prospectRow.company_name} — contact undiscoverable`;
      console.log(w);
      result.warnings.push(w);
      result.contacts.skipped++;
    }
  }

  console.log(`[import-brokers] done. prospects ${JSON.stringify(result.prospects)} contacts ${JSON.stringify(result.contacts)} warnings=${result.warnings.length}`);
  return result;
}

/**
 * Rank comparator: more bridging keywords matched first; ties broken by
 * firm-name length (shorter/more focused names rank higher).
 */
function keywordStrengthComparator(a, b) {
  const ka = a.evidence.matched.length;
  const kb = b.evidence.matched.length;
  if (kb !== ka) return kb - ka;
  const la = (a.firm.firm_name || '').length;
  const lb = (b.firm.firm_name || '').length;
  return la - lb;
}

/**
 * Stream a CSV file via readline. Header is autodetected:
 *   - Single column with FRN-only → returns [{ frn: '122702' }, ...].
 *   - Multi-column rich extract → returns [{ frn, firm_name,
 *     permissions, website, postcode, status, trading_names, ... }].
 *
 * Tolerant of BOM, empty lines, and trailing whitespace.
 *
 * @param {string} csvPath
 * @returns {Promise<Array<object>>}
 */
async function readBrokerCsv(csvPath) {
  if (!csvPath) throw new Error('readBrokerCsv: csvPath is required');
  const stream = fs.createReadStream(csvPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const rows = [];
  let header = null;
  let lineNo = 0;

  for await (const rawLine of rl) {
    lineNo++;
    let line = rawLine;
    if (lineNo === 1 && line.charCodeAt(0) === 0xFEFF) line = line.slice(1); // strip BOM
    line = line.trim();
    if (!line) continue;

    const cells = parseCsvLine(line);

    if (header == null) {
      const looksLikeHeader = cells.some(c => /^(frn|firm.?name|permission|trading|status|website|postcode|name)$/i.test(c.trim()));
      if (looksLikeHeader) {
        header = cells.map(c => normaliseHeader(c));
        continue;
      }
      // Single-column FRN-only file with no header — treat first row as data.
      header = ['frn'];
    }

    const obj = {};
    for (let i = 0; i < header.length; i++) {
      const key = header[i];
      if (!key) continue;
      const val = (cells[i] || '').trim();
      if (key === 'permissions' || key === 'trading_names') {
        obj[key] = val ? val.split(/[|;]/).map(s => s.trim()).filter(Boolean) : [];
      } else {
        obj[key] = val || null;
      }
    }
    // Normalise common alt-keys
    if (!obj.firm_name && obj.organisation_name) obj.firm_name = obj.organisation_name;
    if (!obj.firm_name && obj.name) obj.firm_name = obj.name;
    rows.push(obj);
  }

  return rows;
}

function normaliseHeader(raw) {
  const k = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  // Map a few common aliases.
  if (k === 'firm_reference_number') return 'frn';
  if (k === 'firm_name' || k === 'organisation_name' || k === 'name') return 'firm_name';
  if (k === 'current_authorisation_status' || k === 'status') return 'status';
  if (k === 'permission' || k === 'permissions' || k === 'regulated_activities') return 'permissions';
  if (k === 'trading_names' || k === 'current_trading_name') return 'trading_names';
  if (k === 'website' || k === 'firm_website') return 'website';
  if (k === 'postcode' || k === 'principal_office_postcode') return 'postcode';
  return k;
}

/**
 * Parse a single CSV line. Handles quoted cells with embedded commas.
 * Does NOT handle embedded newlines (FCA extract is single-line per row).
 */
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/**
 * Backwards-compatible bare-FRN reader. Tolerates BOM, header row, and
 * extra columns (only the first is used). Used by older tests.
 */
async function readFrnCsv(csvPath) {
  const rows = await readBrokerCsv(csvPath);
  return rows.map(r => r.frn).filter(Boolean);
}

/**
 * Apply the bridging-keyword filter to a firm's name + trading names.
 * Returns evidence object with matched keywords, or null if no match.
 *
 * @param {object} firm  Flattened firm record.
 * @returns {{ matched: string[], source: string } | null}
 */
function matchBridgingKeywords(firm) {
  if (!firm) return null;
  const name = (firm.firm_name || firm.Organisation_Name || '').toLowerCase();
  const tradingNames = firm.trading_names || firm.Names || [];
  const nameMatches = BRIDGING_KEYWORDS.filter(kw => name.includes(kw));

  if (nameMatches.length > 0) {
    return { matched: nameMatches, source: 'firm_name_keyword' };
  }

  for (const tn of tradingNames) {
    const tnLower = String(tn || '').toLowerCase();
    const tnMatches = BRIDGING_KEYWORDS.filter(kw => tnLower.includes(kw));
    if (tnMatches.length > 0) {
      return { matched: tnMatches, source: 'trading_name_keyword' };
    }
  }

  // Permission-based fallback — if the firm holds a regulated-mortgage
  // permission AND its name OR trading names mention bridging context,
  // we'd already have matched above. Permission alone is too broad
  // (5,000+ firms hold mortgage permission); don't keep on that signal.

  return null;
}

/**
 * Map a flattened firm record into the prospects row shape.
 * Pure function — no DB or network IO.
 *
 * @param {object} firm
 * @param {{ matched: string[], source: string }} bridgingEvidence
 * @returns {object}
 */
function buildProspect(firm, bridgingEvidence) {
  const companyName = (firm.firm_name || firm.Organisation_Name || '').trim();
  const status = firm.status || firm.Status || null;
  const permissions = firm.permissions || [];
  const tradingNames = firm.trading_names || [];
  const websiteRaw = firm.website || (firm.principal_office_address && firm.principal_office_address.website) || null;
  const website = websiteRaw ? deriveDomainFromUrl(websiteRaw) : null;
  const postcode = firm.postcode
    || (firm.principal_office_address && firm.principal_office_address.postcode)
    || null;

  return {
    type: 'broker',
    company_name: companyName,
    website,
    source: SOURCE,
    metadata: {
      frn: firm.frn ? String(firm.frn) : null,
      firm_name_normalised: companyName.toLowerCase().replace(/\s+(limited|ltd|llp|plc)\.?$/, '').trim(),
      permission_codes: Array.isArray(permissions) ? permissions : [],
      principal_office_postcode: postcode,
      trading_names: Array.isArray(tradingNames) ? tradingNames : [],
      company_status: status,
      bridging_evidence: bridgingEvidence,
      fca_last_synced: new Date().toISOString(),
      ...(website ? {} : { website_search_failed: true }),
    },
  };
}

// Re-use the lenders importer upsert helpers — identical idempotency
// guarantees. If they ever need to diverge, copy them in then.
const { upsertProspect, upsertContact } = require('./import-lenders');

module.exports = {
  importBrokers,
  readBrokerCsv,
  readFrnCsv,
  matchBridgingKeywords,
  buildProspect,
  BRIDGING_KEYWORDS,
  upsertProspect,
  upsertContact,
};

// CLI entry point. Usage:
//   node lib/sales-brain/import-brokers.js --source-csv ./data/fca.csv
//   node lib/sales-brain/import-brokers.js --source-csv ./data/fca.csv --force
//   node lib/sales-brain/import-brokers.js --source-csv ./data/fca.csv --hunter-top 50
//   node lib/sales-brain/import-brokers.js --source-csv ./data/fca.csv --firecrawl --firecrawl-top 25
if (require.main === module) {
  const force = process.argv.includes('--force');
  const useFirecrawl = process.argv.includes('--firecrawl');
  const csvIdx = process.argv.indexOf('--source-csv');
  const csvIdxAlt = process.argv.indexOf('--csv');
  const idx = csvIdx >= 0 ? csvIdx : csvIdxAlt;
  const sourceCsvPath = idx >= 0 ? path.resolve(process.argv[idx + 1]) : undefined;
  const hunterIdx = process.argv.indexOf('--hunter-top');
  const useHunterTopN = hunterIdx >= 0 ? parseInt(process.argv[hunterIdx + 1], 10) || 0 : 0;
  const fcIdx = process.argv.indexOf('--firecrawl-top');
  const firecrawlTopN = fcIdx >= 0 ? parseInt(process.argv[fcIdx + 1], 10) || DEFAULT_FIRECRAWL_TOP_N : DEFAULT_FIRECRAWL_TOP_N;
  importBrokers({ force, sourceCsvPath, useFirecrawl, firecrawlTopN, useHunterTopN })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[import-brokers] ${err.message}`);
      process.exit(1);
    });
}
