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
// All read functions return arrays on success. Errors are LOGGED to
// console.warn and the function returns an empty result rather than
// throwing — generation must not crash when the closed-loop store is
// momentarily unhappy (e.g. Supabase blip mid-batch). The DEAL HISTORY
// block degrades gracefully to "no block at all".
//
// `insertOutcome` is the one exception — it throws on failure because the
// importer should fail loudly so the row is logged as skipped, not
// silently dropped.

const { supabase } = require('../supabase');

// ── Module-scoped read cache ──────────────────────────────────────────────
// Outbound generation is read-heavy in batch runs (one lookup per contact
// per step); the table is append-only after Simon drops a CSV. A 60-second
// TTL keyed on prospect_id is a good cost/freshness trade-off — Simon never
// imports a CSV mid-batch in practice. Cache miss path is one Supabase
// round-trip; cache hit path is a Map lookup. No invalidation API by design
// (insertOutcome doesn't bust the cache — fresh outcomes show up on the
// next batch).

const TTL_MS = 60 * 1000;
const _cache = new Map(); // key -> { value, expiresAt }

function _cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    _cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function _cacheSet(key, value) {
  _cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

/**
 * Recent funded-deal outcomes linked to a specific prospect, newest first.
 *
 * Cached for 60s per prospect_id to keep batch outbound generation cheap
 * (one call per contact per step would otherwise be a Supabase round-trip
 * per generation attempt). Cache key is `${prospectId}:${limit}` so
 * different limits don't collide.
 *
 * @param {string} prospectId
 * @param {{limit?: number}} [opts]
 * @returns {Promise<Array<object>>}
 */
async function getProspectOutcomes(prospectId, { limit = 2 } = {}) {
  if (!prospectId) return [];
  const cacheKey = `${prospectId}:${limit}`;
  const hit = _cacheGet(cacheKey);
  if (hit !== undefined) return hit;

  try {
    const { data, error } = await supabase
      .from('outbound_outcomes')
      .select('id, prospect_id, contact_id, deal_amount, deal_type, property_location, closed_at, days_to_close, source, claude_fact')
      .eq('prospect_id', prospectId)
      .not('claude_fact', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(limit);
    if (error) {
      console.warn(`[closed-loop/funded-deals] getProspectOutcomes(${prospectId}) failed: ${error.message}`);
      _cacheSet(cacheKey, []);
      return [];
    }
    const rows = data || [];
    _cacheSet(cacheKey, rows);
    return rows;
  } catch (err) {
    console.warn(`[closed-loop/funded-deals] getProspectOutcomes(${prospectId}) threw: ${err.message}`);
    return [];
  }
}

/**
 * Domain-fallback lookup. Two-step: (a) find prospects whose website
 * matches the bare domain, (b) read their outcomes. Used when prospect-id
 * resolution failed but we still want to surface relevant wins (e.g. the
 * recipient is contact@acme.com and Acme has a row but no FK linkage).
 *
 * NOT cached — this path is rare (only fires when getProspectOutcomes
 * returned empty) and the cache key shape would be ambiguous (one domain
 * can match multiple prospects).
 *
 * @param {string} emailDomain  bare domain, e.g. "acme.com"
 * @returns {Promise<Array<object>>}
 */
async function getOutcomesByDomain(emailDomain) {
  if (!emailDomain || typeof emailDomain !== 'string') return [];
  const domain = emailDomain.trim().toLowerCase();
  if (!domain) return [];

  try {
    const { data: prospects, error: pErr } = await supabase
      .from('prospects')
      .select('id')
      .ilike('website', `%${domain}%`);
    if (pErr) {
      console.warn(`[closed-loop/funded-deals] getOutcomesByDomain prospects lookup failed: ${pErr.message}`);
      return [];
    }
    if (!prospects || !prospects.length) return [];

    const ids = prospects.map(p => p.id);
    const { data, error } = await supabase
      .from('outbound_outcomes')
      .select('id, prospect_id, contact_id, deal_amount, deal_type, property_location, closed_at, days_to_close, source, claude_fact')
      .in('prospect_id', ids)
      .not('claude_fact', 'is', null)
      .order('closed_at', { ascending: false })
      .limit(5);
    if (error) {
      console.warn(`[closed-loop/funded-deals] getOutcomesByDomain outcomes lookup failed: ${error.message}`);
      return [];
    }
    return data || [];
  } catch (err) {
    console.warn(`[closed-loop/funded-deals] getOutcomesByDomain(${domain}) threw: ${err.message}`);
    return [];
  }
}

/**
 * Insert a single outcome row. Validates `claude_fact` non-empty and
 * `deal_amount` either null or numeric — both are anti-hallucination
 * guards (a row with an empty fact OR a malformed amount would corrupt
 * later prompt and filter passes).
 *
 * @param {object} row
 * @returns {Promise<{ id: string }>}
 * @throws {Error} on validation failure or Supabase error.
 */
async function insertOutcome(row) {
  if (!row || typeof row !== 'object') {
    throw new Error('insertOutcome: row must be an object');
  }
  const claudeFact = typeof row.claude_fact === 'string' ? row.claude_fact.trim() : '';
  if (!claudeFact) {
    throw new Error('insertOutcome: claude_fact is required and must be a non-empty string');
  }
  if (row.deal_amount !== null && row.deal_amount !== undefined) {
    const n = Number(row.deal_amount);
    if (!Number.isFinite(n)) {
      throw new Error(`insertOutcome: deal_amount must be numeric or null (got ${JSON.stringify(row.deal_amount)})`);
    }
  }
  if (!row.closed_at) {
    throw new Error('insertOutcome: closed_at is required');
  }

  const insertRow = {
    prospect_id:       row.prospect_id ?? null,
    contact_id:        row.contact_id ?? null,
    deal_amount:       row.deal_amount ?? null,
    deal_type:         row.deal_type ?? null,
    property_location: row.property_location ?? null,
    closed_at:         row.closed_at,
    days_to_close:     row.days_to_close ?? null,
    source:            row.source ?? null,
    raw_notes:         row.raw_notes ?? null,
    claude_fact:       claudeFact,
  };

  const { data, error } = await supabase
    .from('outbound_outcomes')
    .insert(insertRow)
    .select('id')
    .single();
  if (error) {
    throw new Error(`insertOutcome failed: ${error.message}`);
  }
  return { id: data.id };
}

module.exports = {
  getProspectOutcomes,
  getOutcomesByDomain,
  insertOutcome,
  // Test hook — lets the test suite reset cache between cases without
  // peeking at module internals.
  _resetCache: () => { _cache.clear(); },
};
