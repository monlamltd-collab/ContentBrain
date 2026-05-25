require('dotenv').config();

// ── Lender snapshot importer (Phase B) ────────────────────────────────────
//
// Reads the Bridgematch lenders.db SQLite snapshot at
//   C:\Users\User\Documents\GitHub\Bridgematch\lenders.db
// and upserts:
//   - 69 prospects (type='lender', source='bridging-brain')
//   - 96 contacts  (66 BDM + 30 enquiries inboxes after dedup)
//
// Idempotent: re-running with a refreshed snapshot updates metadata but
// does not duplicate rows — `prospects` uses (source, lower(company_name))
// as a unique key and `contacts` uses (prospect_id, lower(email)).
//
// Why sql.js (and not better-sqlite3)? better-sqlite3 needs a native build
// step on Windows; sql.js is pure WASM, runs anywhere Node runs, and we
// only read the file once per import. The performance hit on 69 rows is
// irrelevant — see researcher's note in .ruflo/lender-mapping.md.
//
// Column mapping, normalisation rules, expected counts, and data-quality
// edge cases (stray backticks, NBSP in phones, email-in-phone column) live
// in .ruflo/lender-mapping.md alongside this file. Treat that doc as the
// source of truth — this file implements it.

// TODO(coder): pull in dependencies — sql.js, fs/promises, path,
// plus the supabase client from ../supabase.js. Note: lib/supabase.js
// currently exports only post/brief/lot helpers — coder will add
// upsertProspect(...) and upsertContact(...) wrappers there, then
// require them here.

/**
 * Run the importer end-to-end.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] - When true, re-upsert every row
 *   even if metadata matches (useful for backfilling new metadata keys).
 *   When false (default), an unchanged row is skipped.
 * @returns {Promise<{prospects: {inserted: number, updated: number, skipped: number},
 *                    contacts:  {inserted: number, updated: number, skipped: number},
 *                    warnings: string[]}>}
 *   Counts + any per-row warnings (e.g. "Ascot Bridging: enquiries_phone held
 *   an email — stashed under metadata.enquiries_phone_raw").
 */
async function importLenders({ force = false } = {}) {
  // TODO(coder):
  //   1. Locate the bridging-brain snapshot path (env BRIDGING_BRAIN_DB or
  //      the hard-coded C:\Users\User\Documents\GitHub\Bridgematch\lenders.db).
  //   2. Load with sql.js — `await initSqlJs()`, then `new SQL.Database(buf)`.
  //   3. SELECT name, last_updated, funding_model, enquiries_email,
  //      enquiries_phone, sw_bdm_name, sw_bdm_email, sw_bdm_mobile,
  //      criteria_update_contact FROM lenders WHERE _source='excel';
  //   4. For each row: upsert prospect, then upsert BDM contact (if
  //      sw_bdm_email present), then upsert enquiries contact (unless its
  //      email normalises to the same as the BDM's — see skip rule in
  //      .ruflo/lender-mapping.md §2b).
  //   5. Apply normaliseEmail / normalisePhone per .ruflo/lender-mapping.md §3.
  //   6. Collect warnings; return aggregate counts. Expected: 69 prospects,
  //      96 contacts on a fresh DB.
  void force;
  throw new Error('importLenders not implemented yet — see TODO(coder)');
}

/**
 * Strip a stray non-alphanumeric prefix, replace NBSPs, trim, lowercase.
 * Returns null for empty input.
 *
 * Test cases (from .ruflo/lender-mapping.md):
 *   normaliseEmail('`chris.buckley@asgfinance.co.uk') === 'chris.buckley@asgfinance.co.uk'
 *   normaliseEmail('Foo@Bar.co')                      === 'foo@bar.co'
 *   normaliseEmail('')                                === null
 *   normaliseEmail(null)                              === null
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normaliseEmail(raw) {
  // TODO(coder): trim, replace NBSP (U+00A0) with space, strip leading
  // non-alphanumeric chars, lowercase. Return null for empty.
  void raw;
  throw new Error('normaliseEmail not implemented yet — see TODO(coder)');
}

/**
 * Strip a leading "M: " prefix, replace NBSPs, trim. Returns null if the
 * cleaned value contains any letters (catches the email-in-phone-column
 * edge case in the bridging-brain snapshot — Ascot Bridging row 3).
 *
 * Test cases (from .ruflo/lender-mapping.md):
 *   normalisePhone('M: 07879 855569')                === '07879 855569'
 *   normalisePhone('enquiries@ascotbridging.co.uk')  === null
 *   normalisePhone('07763\xa0206\xa0238')            === '07763 206 238'
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalisePhone(raw) {
  // TODO(coder): trim, strip leading 'M: ', replace NBSP. If result fails
  // /^[\d\s+()\-]+$/ then return null AND have the caller stash the original
  // under prospect.metadata.enquiries_phone_raw.
  void raw;
  throw new Error('normalisePhone not implemented yet — see TODO(coder)');
}

module.exports = { importLenders, normaliseEmail, normalisePhone };

// CLI entry point. Usage:
//   node lib/sales-brain/import-lenders.js
//   node lib/sales-brain/import-lenders.js --force
if (require.main === module) {
  const force = process.argv.includes('--force');
  importLenders({ force })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[import-lenders] ${err.message}`);
      process.exit(1);
    });
}
