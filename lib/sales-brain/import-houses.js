'use strict';

require('dotenv').config();

// ── Auction-house importer (Phase D) ──────────────────────────────────────
//
// Reads `HOUSE_DISPLAY_NAMES` + `HOUSE_ROOTS` from the Auction repo at
//   C:\Users\User\Documents\GitHub\Auction\lib\houses.js
// and upserts:
//   - ~218 prospects (type='auction_house', source='auction-brain')
//   - 1 synthesised generic-inbox contact per prospect WHERE a non-platform
//     domain is derivable.
//
// Idempotent: re-running upserts on the same (source, lower(company_name))
// unique index used by import-lenders.js. Contacts upsert on
// (prospect_id, lower(email)).
//
// How we read houses.js: dynamic ESM import via Node 20's
// `await import('file://...')`. The Auction repo is ESM; ContentBrain is
// CJS. Smoke-tested 2026-05-25 — `HOUSE_DISPLAY_NAMES` and `HOUSE_ROOTS`
// load cleanly with no side-effects from `./config.js`. If this path
// breaks (e.g. config.js gets a runtime import that errors on Windows
// paths), fall back to a regex-parse of the source file.
//
// FREE-SYNTHETIC contact synthesis: per Simon's call (Phase D §5.1 alt
// (c)), no Hunter calls in v1. Each non-platform-hosted house gets ONE
// synthetic `info@<domain>` contact at confidence_score=50.

const path = require('path');
const { pathToFileURL } = require('url');
const { supabase } = require('../supabase');
const { assertSource } = require('./constants');
const {
  deriveDomainFromUrl,
  deriveContactEmail,
  isPlatformHost,
  slugToRegion,
} = require('./derive-domain');

const DEFAULT_HOUSES_PATH = 'C:\\Users\\User\\Documents\\GitHub\\Auction\\lib\\houses.js';
const SOURCE = 'auction-brain';

/**
 * Run the auction-house importer end-to-end.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false]
 * @param {string}  [options.housesPath]
 * @param {boolean} [options.synthesiseContacts=true]
 * @returns {Promise<{
 *   prospects: { inserted: number, updated: number, skipped: number },
 *   contacts:  { inserted: number, updated: number, skipped: number },
 *   warnings: string[]
 * }>}
 */
async function importHouses({ force = false, housesPath, synthesiseContacts = true } = {}) {
  void force; // reserved for future "re-upsert even if metadata matches" mode
  assertSource(SOURCE);

  const resolvedPath = housesPath || DEFAULT_HOUSES_PATH;
  console.log(`[import-houses] reading houses module: ${resolvedPath}`);

  let houses;
  try {
    houses = await readHouses(resolvedPath);
  } catch (err) {
    throw new Error(`Cannot read houses.js at ${resolvedPath}: ${err.message}`);
  }
  const slugs = Object.keys(houses.HOUSE_DISPLAY_NAMES);
  console.log(`[import-houses] loaded ${slugs.length} display names, ${Object.keys(houses.HOUSE_ROOTS).length} roots`);

  const result = {
    prospects: { inserted: 0, updated: 0, skipped: 0 },
    contacts:  { inserted: 0, updated: 0, skipped: 0 },
    warnings: [],
  };

  for (const slug of slugs) {
    const displayName = (houses.HOUSE_DISPLAY_NAMES[slug] || '').trim();
    if (!displayName) {
      const w = `[import-houses] skip slug=${slug}: empty display name`;
      console.warn(w);
      result.warnings.push(w);
      result.prospects.skipped++;
      continue;
    }

    const catalogueRoot = houses.HOUSE_ROOTS[slug] || null;
    const derivedDomain = catalogueRoot ? deriveDomainFromUrl(catalogueRoot) : null;
    const platform = inferPlatform(catalogueRoot);
    const region = inferRegion(slug);

    const metadata = {
      slug,
      display_name: displayName,
      catalogue_root_url: catalogueRoot,
      region,
      platform,
      active: !!catalogueRoot,
      imported_at: new Date().toISOString(),
    };

    const prospect = {
      type: 'auction_house',
      company_name: displayName,
      website: derivedDomain && !isPlatformHost(derivedDomain) ? derivedDomain : null,
      source: SOURCE,
      metadata,
    };

    let prospectId;
    try {
      const r = await upsertProspect(prospect);
      prospectId = r.id;
      if (r.inserted) result.prospects.inserted++;
      else result.prospects.updated++;
    } catch (err) {
      const w = `[import-houses] skip prospect ${displayName}: ${err.message}`;
      console.warn(w);
      result.warnings.push(w);
      result.prospects.skipped++;
      continue;
    }

    // Contact synthesis — only when we have a non-platform domain.
    if (!synthesiseContacts) continue;

    if (!derivedDomain) {
      const w = `[import-houses] skip contact ${displayName}: no catalogue URL — domain undiscoverable`;
      console.log(w);
      result.warnings.push(w);
      result.contacts.skipped++;
      continue;
    }

    if (isPlatformHost(derivedDomain)) {
      const w = `[import-houses] skip contact ${displayName}: platform-hosted (${derivedDomain}) — synthesised email would land at the platform`;
      console.log(w);
      result.warnings.push(w);
      result.contacts.skipped++;
      continue;
    }

    const email = deriveContactEmail({ domain: derivedDomain, prefix: 'info' });
    if (!email) {
      const w = `[import-houses] skip contact ${displayName}: deriveContactEmail returned null for domain=${derivedDomain}`;
      console.warn(w);
      result.warnings.push(w);
      result.contacts.skipped++;
      continue;
    }

    const contact = {
      prospect_id: prospectId,
      name: null,
      role: 'Generic inbox',
      email,
      linkedin_url: null,
      confidence_score: 50,
      source: 'manual', // synthesised — not from a Hunter result
    };

    try {
      const r = await upsertContact(contact);
      if (r.inserted) result.contacts.inserted++;
      else result.contacts.updated++;
    } catch (err) {
      const w = `[import-houses] skip contact ${email} (${displayName}): ${err.message}`;
      console.warn(w);
      result.warnings.push(w);
      result.contacts.skipped++;
    }
  }

  console.log(`[import-houses] done. prospects ${JSON.stringify(result.prospects)} contacts ${JSON.stringify(result.contacts)} warnings=${result.warnings.length}`);
  return result;
}

/**
 * Read `HOUSE_DISPLAY_NAMES` + `HOUSE_ROOTS` from the Auction repo via
 * dynamic ESM import. Node 20+ supports `await import('file://...')`
 * from CJS code.
 *
 * @param {string} [housesPath]
 * @returns {Promise<{
 *   HOUSE_DISPLAY_NAMES: Record<string,string>,
 *   HOUSE_ROOTS:         Record<string,string>
 * }>}
 */
async function readHouses(housesPath = DEFAULT_HOUSES_PATH) {
  const abs = path.resolve(housesPath);
  const url = pathToFileURL(abs).href;
  const mod = await import(url);
  if (!mod.HOUSE_DISPLAY_NAMES || typeof mod.HOUSE_DISPLAY_NAMES !== 'object') {
    throw new Error('houses.js did not export HOUSE_DISPLAY_NAMES');
  }
  if (!mod.HOUSE_ROOTS || typeof mod.HOUSE_ROOTS !== 'object') {
    throw new Error('houses.js did not export HOUSE_ROOTS');
  }
  return {
    HOUSE_DISPLAY_NAMES: mod.HOUSE_DISPLAY_NAMES,
    HOUSE_ROOTS: mod.HOUSE_ROOTS,
  };
}

/**
 * Auto-derive `metadata.region` from an auction-house slug. Delegates to
 * the shared `slugToRegion` table in derive-domain.js so brokers and
 * other callers can reuse the same mapping.
 *
 * @param {string} slug
 * @returns {string|null}
 */
function inferRegion(slug) {
  return slugToRegion(slug);
}

/**
 * Cheap platform inference from the catalogue-root URL.
 *
 * @param {string|null} url
 * @returns {string|null}
 */
function inferPlatform(url) {
  if (!url || typeof url !== 'string') return null;
  const u = url.toLowerCase();
  if (u.includes('eigonlineauctions.com') || u.includes('eigpropertyauctions.co.uk')) return 'eig';
  if (u.includes('bambooauctions.com')) return 'bamboo';
  if (u.includes('gotoproperties.co.uk')) return 'goto';
  if (u.includes('auctionhouse.co.uk')) return 'auctionhouse-uk';
  if (u.includes('iamsold.co.uk')) return 'iamsold';
  return 'bespoke';
}

// Re-use the lenders importer upsert helpers — identical idempotency
// guarantees. If they ever need to diverge, copy them in then.
const { upsertProspect, upsertContact } = require('./import-lenders');

module.exports = {
  importHouses,
  readHouses,
  inferRegion,
  inferPlatform,
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
