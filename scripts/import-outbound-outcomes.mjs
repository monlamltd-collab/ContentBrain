#!/usr/bin/env node
// ── PHASE E — CSV → outbound_outcomes importer ────────────────────────────
//
// Usage: node scripts/import-outbound-outcomes.mjs ./outcomes.csv
//
// Reads a CSV of funded-deal facts and inserts rows into the
// outbound_outcomes table (migration 017). Designed for Simon to drop a
// hand-curated CSV every so often; Stripe-webhook + BridgeMatch
// deal-events ingestion is deferred to Phase F.
//
// CSV columns:
//   REQUIRED:
//     prospect_company    Free-text company name. Matched case-insensitive
//                         against prospects.company_name. Rows that don't
//                         match are SKIPPED with a console warning (we
//                         could log them as prospect_id=NULL rows, but
//                         that's a noisier default — the importer chooses
//                         strictness, the design doc punts on it).
//     deal_amount         numeric. Empty = NULL.
//     deal_type           free text (e.g. 'auction-purchase').
//     closed_at           ISO date or datetime. Validated with new Date().
//     claude_fact         REQUIRED non-empty. The only string the model
//                         ever sees from this row. Anti-hallucination
//                         contract — see .ruflo/phase-e-design.md §1.5.
//
//   OPTIONAL:
//     contact_email        - matched against contacts.email; resolves contact_id.
//     property_location    - free text.
//     days_to_close        - int.
//     raw_notes            - free text; never shown to the model.
//
// Idempotency: before inserting a row the script checks for an existing
// outcome with the same (prospect_id, closed_at, deal_amount). Duplicates
// are skipped with a console.log line. Re-running the importer on the
// same CSV is safe.
//
// .mjs (not .js) so we can use top-level await + streaming CSV parsing
// via `csv-parser` (already a dep — see lib/sales-brain/import-houses.js).
//
// NO BODIES YET — architect stub for the Phase E coder.

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Parse one CSV row into the shape expected by insertOutcome().
 *
 * @param {object} csvRow - raw object from csv-parser (string-valued).
 * @param {number} lineNo - 1-indexed line number for error messages.
 * @returns {{
 *   prospect_company: string,
 *   contact_email: string | null,
 *   deal_amount: number | null,
 *   deal_type: string | null,
 *   property_location: string | null,
 *   closed_at: string,
 *   days_to_close: number | null,
 *   raw_notes: string | null,
 *   claude_fact: string,
 * }}
 * @throws {Error} when a required column is missing/empty or a numeric
 *   field doesn't parse — caller logs and skips the row.
 */
function validateRow(csvRow, lineNo) {
  // BODY DELIBERATELY OMITTED — coder implements.
  // Expected behaviour:
  //   1. prospect_company: throw if empty after trim.
  //   2. claude_fact: throw if empty after trim.
  //   3. closed_at: parse with new Date(); throw on isNaN(.getTime()).
  //   4. deal_amount: empty → null; else Number(); throw on NaN.
  //   5. days_to_close: empty → null; else parseInt(); throw on NaN.
  //   6. All other strings: trim, '' → null.
  //   7. Return the normalised row. Caller resolves prospect_id +
  //      contact_id via Supabase lookups separately.
  throw new Error(`validateRow line ${lineNo}: not implemented (Phase E coder stub)`);
}

/**
 * Resolve a CSV row's prospect_company → prospects.id (case-insensitive
 * exact match on company_name; trigram fuzzy is a Phase F refinement
 * per the design doc — strict first).
 *
 * @param {object} supabase - the @supabase/supabase-js client
 * @param {string} companyName
 * @returns {Promise<string | null>} prospect_id, or null when no match.
 */
async function resolveProspectId(supabase, companyName) {
  // BODY DELIBERATELY OMITTED.
  // Expected behaviour:
  //   1. supabase.from('prospects').select('id').ilike('company_name', companyName).maybeSingle()
  //   2. Return data?.id ?? null.
  //   3. console.warn on error and return null.
  throw new Error('resolveProspectId: not implemented (Phase E coder stub)');
}

/**
 * Resolve a CSV row's contact_email → contacts.id. Optional — null is
 * fine, outbound_outcomes.contact_id is nullable.
 *
 * @param {object} supabase
 * @param {string | null} email
 * @returns {Promise<string | null>}
 */
async function resolveContactId(supabase, email) {
  // BODY DELIBERATELY OMITTED.
  // Expected behaviour:
  //   1. If !email return null.
  //   2. supabase.from('contacts').select('id').ilike('email', email).maybeSingle()
  //   3. Return data?.id ?? null. console.warn on error and return null.
  throw new Error('resolveContactId: not implemented (Phase E coder stub)');
}

/**
 * Idempotency check: does an outcome row with this (prospect_id,
 * closed_at, deal_amount) tuple already exist?
 *
 * @returns {Promise<boolean>}
 */
async function outcomeExists(supabase, prospectId, closedAt, dealAmount) {
  // BODY DELIBERATELY OMITTED.
  // Expected behaviour:
  //   1. If !prospectId return false (NULL-prospect rows aren't dedup-keyed).
  //   2. supabase.from('outbound_outcomes').select('id')
  //        .eq('prospect_id', prospectId)
  //        .eq('closed_at', closedAt)
  //        .eq('deal_amount', dealAmount)  // null match works via .is when amount is null
  //        .maybeSingle()
  //   3. Return !!data.
  throw new Error('outcomeExists: not implemented (Phase E coder stub)');
}

/**
 * Main entry point. Streams the CSV, validates each row, looks up FKs,
 * dedupes, and inserts. Prints a one-line summary at the end.
 *
 * @param {string} csvPath - absolute or cwd-relative path to the CSV.
 * @returns {Promise<{
 *   total: number,
 *   inserted: number,
 *   skipped_no_prospect: number,
 *   skipped_duplicate: number,
 *   skipped_invalid: number,
 * }>}
 */
async function importOutcomes(csvPath) {
  // BODY DELIBERATELY OMITTED — coder implements.
  // Expected behaviour:
  //   1. Resolve csvPath. existsSync guard.
  //   2. Lazy-import { supabase } from '../lib/supabase.js' and
  //      { insertOutcome } from '../lib/closed-loop/funded-deals.js'.
  //   3. Stream the CSV with `csv-parser` (already a dep — see
  //      lib/sales-brain/import-houses.js for the exact pattern).
  //   4. For each row:
  //        - validateRow → on throw, increment skipped_invalid, log, continue.
  //        - resolveProspectId → if null, increment skipped_no_prospect,
  //          log "[importer] no prospect for '$company' — skipping" and continue.
  //        - resolveContactId (optional).
  //        - outcomeExists → if true, increment skipped_duplicate, log, continue.
  //        - insertOutcome with source='manual-csv'.
  //   5. Print a final one-line summary: "Imported X, skipped Y (no prospect),
  //      Z (duplicate), W (invalid) of N rows."
  //   6. Return the counts object.
  throw new Error('importOutcomes: not implemented (Phase E coder stub)');
}

// CLI entry — only runs when invoked directly, not when imported for tests.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('import-outbound-outcomes.mjs')) {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node scripts/import-outbound-outcomes.mjs <path-to-csv>');
    process.exit(1);
  }
  importOutcomes(csvPath)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[importer] fatal: ${err.message}`);
      process.exit(1);
    });
}

export { importOutcomes, validateRow, resolveProspectId, resolveContactId, outcomeExists };
