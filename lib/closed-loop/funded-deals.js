'use strict';

// ── PHASE E — Closed loop: funded-deal lookup ─────────────────────────────
//
// Reads from `outbound_outcomes` (migration 017). Used by
// lib/generate-outbound.js#buildUserPrompt to inject a DEAL HISTORY block
// when we have prospect-linked wins to quote, and by
// scripts/import-outbound-outcomes.mjs to ingest fresh rows from a CSV
// drop.
//
// Anti-hallucination contract: NONE of these functions sanitise
// `claude_fact` — they pass it through verbatim. The CSV importer is the
// single sanitisation chokepoint (it enforces `claude_fact` non-empty);
// every downstream caller trusts that contract.
//
// All functions return arrays or counts on success. Errors are LOGGED to
// console.warn and the function returns an empty result rather than
// throwing — generation must not crash when the closed-loop store is
// momentarily unhappy (e.g. Supabase blip mid-batch). The DEAL HISTORY
// block degrades gracefully to "no block at all".
//
// NO BODIES YET — architect stub for the Phase E coder. Each function
// signature + JSDoc nails down the contract; the coder fills in the
// Supabase queries against the schema in migration 017.

const { supabase } = require('../supabase');

/**
 * Recent funded-deal outcomes linked to a specific prospect, newest first.
 *
 * The hot path: called once per outbound generation when
 * `prospect.id` is non-null. Result rows are injected into the DEAL
 * HISTORY block of the user prompt (lib/generate-outbound.js). The
 * limit is intentionally tight (default 2) — the prompt block is meant
 * to be a tight handful of facts, not a CRM dump.
 *
 * @param {string} prospectId - uuid of the prospect row
 * @param {object} [opts]
 * @param {number} [opts.limit=2] - max rows to return (newest by closed_at)
 * @returns {Promise<Array<{
 *   id: string,
 *   prospect_id: string,
 *   contact_id: string | null,
 *   deal_amount: number | null,
 *   deal_type: string | null,
 *   property_location: string | null,
 *   closed_at: string,
 *   days_to_close: number | null,
 *   source: string | null,
 *   claude_fact: string,
 * }>>}
 *   Empty array when prospectId is falsy, the query errors, or no rows
 *   match — caller branches on `.length` to decide whether to render
 *   the DEAL HISTORY block.
 */
async function getProspectOutcomes(prospectId, { limit = 2 } = {}) {
  // BODY DELIBERATELY OMITTED — coder implements against migration 017.
  // Expected behaviour:
  //   1. Guard: if !prospectId return [].
  //   2. supabase.from('outbound_outcomes').select(...).eq('prospect_id', prospectId)
  //      .not('claude_fact', 'is', null).order('closed_at', { ascending: false }).limit(limit)
  //   3. On error → console.warn('[closed-loop/funded-deals] ...') and return [].
  //   4. Return data || [].
  throw new Error('getProspectOutcomes: not implemented (Phase E coder stub)');
}

/**
 * Domain-fallback lookup for outcomes when prospect_id matching missed.
 *
 * Joins through prospects.website matched on the email domain. Used by
 * the importer's idempotency check + by future "unknown prospect but we
 * know they're @acme.com" prompt paths. Slower than getProspectOutcomes
 * — uses a website ilike match rather than a uuid FK — so only call
 * after the prospect-id lookup returns empty.
 *
 * @param {string} emailDomain - the bare domain, e.g. "acme.com" (no @,
 *   no protocol). Caller is expected to have already stripped leading
 *   dots and lowercased; this function performs an ilike '%domain' match
 *   against prospects.website.
 * @returns {Promise<Array<object>>} same row shape as getProspectOutcomes.
 *   Empty array on error/no-match.
 */
async function getOutcomesByDomain(emailDomain) {
  // BODY DELIBERATELY OMITTED — coder implements.
  // Expected behaviour:
  //   1. Guard: if !emailDomain return [].
  //   2. Two-step: (a) supabase.from('prospects').select('id').ilike('website', `%${emailDomain}%`)
  //                (b) if no rows → [], else select outbound_outcomes where prospect_id in (...).
  //   3. Order by closed_at DESC, limit 5 (looser than prospect-direct).
  //   4. console.warn + [] on error.
  throw new Error('getOutcomesByDomain: not implemented (Phase E coder stub)');
}

/**
 * Insert a single outcome row. Used by scripts/import-outbound-outcomes.mjs.
 *
 * Idempotency is the CALLER'S responsibility — the importer pre-checks
 * (prospect_id, closed_at, deal_amount) before invoking this. This
 * function does no dedupe; it's a straight INSERT.
 *
 * @param {object} row
 * @param {string | null} row.prospect_id - uuid, nullable
 * @param {string | null} row.contact_id  - uuid, nullable
 * @param {number | null} row.deal_amount
 * @param {string | null} row.deal_type
 * @param {string | null} row.property_location
 * @param {string} row.closed_at - ISO timestamptz
 * @param {number | null} row.days_to_close
 * @param {string} row.source - 'manual-csv' for the importer
 * @param {string | null} row.raw_notes
 * @param {string} row.claude_fact - REQUIRED non-empty; the only string
 *   the model ever sees from this row.
 * @returns {Promise<{ id: string }>} the inserted row's id.
 * @throws {Error} on Supabase error or claude_fact validation failure.
 */
async function insertOutcome(row) {
  // BODY DELIBERATELY OMITTED — coder implements.
  // Expected behaviour:
  //   1. Validate row.claude_fact is a non-empty trimmed string — throw if not.
  //   2. supabase.from('outbound_outcomes').insert(row).select('id').single()
  //   3. On error → throw new Error(`insertOutcome failed: ${error.message}`).
  //   4. Return { id: data.id }.
  throw new Error('insertOutcome: not implemented (Phase E coder stub)');
}

module.exports = {
  getProspectOutcomes,
  getOutcomesByDomain,
  insertOutcome,
};
