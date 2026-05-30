require('dotenv').config();

// ── Suppression list (Phase B) ────────────────────────────────────────────
//
// Thin CRUD wrapper around the `suppression` table (migration 012). Every
// outbound send must call `isSuppressed(email)` first — a hit blocks the
// send and logs the reason. New suppressions arrive from:
//   - Resend webhook events (hard bounce → email; spam complaint → domain)
//   - Telegram hostile/complaint reply handling (Phase C)
//   - Manual additions via the dashboard Pipeline tab
//   - One-time historical imports (Mortgage-Style etc.)
//
// `email_or_domain` is the PK. Matching is two-pass:
//   1. exact match on the full email address
//   2. exact match on the domain (the @-suffix)
// A row that's "x.co" suppresses every address at that domain; a row that's
// "noisy@x.co" suppresses just one address. This module owns the matching
// logic so callers never roll their own.
//
// Cache: the whole suppression set is held in module scope with a 5-minute
// TTL. Outbound sends call isSuppressed before every Resend POST and a
// per-send Supabase round-trip would dominate latency; the cache makes
// the hot path a single Set.has() lookup.

const { supabase } = require('./supabase');
const { assertSuppressionReason } = require('./sales-brain/constants');

const TTL_MS = 5 * 60 * 1000;
let cache = null;            // { entries: Map<email_or_domain, reason>, fetchedAt: number }

async function loadCache() {
  if (cache && (Date.now() - cache.fetchedAt) < TTL_MS) return cache;

  const { data, error } = await supabase
    .from('suppression')
    .select('email_or_domain, reason');
  if (error) {
    // Don't poison the cache on a transient error — let the next call retry.
    throw new Error(`Suppression cache load failed: ${error.message}`);
  }

  const entries = new Map();
  for (const row of data || []) {
    if (row && row.email_or_domain) {
      entries.set(row.email_or_domain.toLowerCase(), row.reason || 'unknown');
    }
  }
  cache = { entries, fetchedAt: Date.now() };
  return cache;
}

// Force the next isSuppressed/addSuppression/removeSuppression call to refetch.
// Useful after a webhook write so a freshly-added bounce blocks the immediate
// next send. The Settings tab `removeSuppression` path also calls this so a
// freshly-removed row stops being treated as suppressed within the same
// 5-minute window (otherwise the in-memory Set would false-positive).
function invalidateCache() {
  cache = null;
}

/**
 * Is this email suppressed (either directly or by its domain)?
 *
 * @param {string} email
 * @returns {Promise<{
 *   suppressed: boolean,
 *   match: string|null,
 *   reason: string|null,
 *   level: 'address'|'domain'|null
 * }>}
 */
async function isSuppressed(email) {
  if (!email || typeof email !== 'string') {
    return { suppressed: false, match: null, reason: null, level: null };
  }
  const lower = email.trim().toLowerCase();
  if (!lower) {
    return { suppressed: false, match: null, reason: null, level: null };
  }

  const { entries } = await loadCache();

  // Address-level match wins — most specific reason.
  if (entries.has(lower)) {
    return { suppressed: true, match: lower, reason: entries.get(lower), level: 'address' };
  }

  // Domain-level match — substring after the last '@'.
  const at = lower.lastIndexOf('@');
  if (at > -1 && at < lower.length - 1) {
    const domain = lower.slice(at + 1);
    if (entries.has(domain)) {
      return { suppressed: true, match: domain, reason: entries.get(domain), level: 'domain' };
    }
  }

  return { suppressed: false, match: null, reason: null, level: null };
}

/**
 * Add an email address OR a whole domain to the suppression list.
 * Idempotent: ON CONFLICT DO NOTHING — re-adding an existing row is a no-op
 * (does NOT overwrite the original `reason`, which would lose audit history).
 *
 * @param {string} emailOrDomain
 * @param {string} reason - must match VALID_SUPPRESSION_REASONS
 * @returns {Promise<{inserted: boolean, emailOrDomain: string, reason: string}>}
 */
async function addSuppression(emailOrDomain, reason) {
  if (!emailOrDomain || typeof emailOrDomain !== 'string') {
    throw new Error('addSuppression: emailOrDomain is required');
  }
  assertSuppressionReason(reason);

  const key = emailOrDomain.trim().toLowerCase();
  if (!key) throw new Error('addSuppression: emailOrDomain is empty after trim');

  // Read first to know whether the row already exists (so we can return a
  // truthful `inserted` flag without UNIQUE_VIOLATION-noise in the logs).
  const { data: existing, error: readErr } = await supabase
    .from('suppression')
    .select('email_or_domain')
    .eq('email_or_domain', key)
    .maybeSingle();
  if (readErr) {
    throw new Error(`addSuppression read failed for ${key}: ${readErr.message}`);
  }

  if (existing) {
    console.log(`[suppression] ${key} already suppressed — leaving original reason intact`);
    return { inserted: false, emailOrDomain: key, reason };
  }

  const { error: insErr } = await supabase
    .from('suppression')
    .insert({ email_or_domain: key, reason });
  if (insErr) {
    // 23505 = unique_violation. Race condition: someone added it between our
    // read and write. Treat as no-op, not an error.
    if (insErr.code === '23505') {
      console.log(`[suppression] ${key} race-inserted by another writer — no-op`);
      return { inserted: false, emailOrDomain: key, reason };
    }
    throw new Error(`addSuppression insert failed for ${key}: ${insErr.message}`);
  }

  // Bust the cache so the next isSuppressed() picks up the new entry.
  // (addSuppression is the canonical write surface — webhooks, Telegram
  // hostile-reply paths and the Pipeline tab's "Wrong contact" button all
  // funnel through here. The Settings tab's manual-add form does too.)
  invalidateCache();
  console.log(`[suppression] added ${key} (${reason})`);
  return { inserted: true, emailOrDomain: key, reason };
}

/**
 * Hard-DELETE an email address or domain from the suppression list. Phase F-2
 * Settings tab adds this so Simon can reverse a fat-fingered manual add or
 * lift a historical bounce that's since been resolved.
 *
 * Soft-delete was considered and rejected (see design doc §6.1): the
 * `suppression` table is small + the Telegram receipt convention covers the
 * audit case without a schema change. Caller is expected to fire a
 * `sendNotification` after a successful remove so the paper trail lives in
 * the same channel as every other compliance-sensitive event.
 *
 * @param {string} emailOrDomain
 * @returns {Promise<{removed: boolean, emailOrDomain: string}>}
 *   `removed: false` means the key was not present — treat as a no-op, not
 *   an error. `removed: true` means at least one row was deleted.
 */
async function removeSuppression(emailOrDomain) {
  if (!emailOrDomain || typeof emailOrDomain !== 'string') {
    throw new Error('removeSuppression: emailOrDomain is required');
  }
  const key = emailOrDomain.trim().toLowerCase();
  if (!key) throw new Error('removeSuppression: emailOrDomain is empty after trim');

  const { data, error } = await supabase
    .from('suppression')
    .delete()
    .eq('email_or_domain', key)
    .select('email_or_domain');
  if (error) {
    throw new Error(`removeSuppression failed for ${key}: ${error.message}`);
  }

  // Always bust the cache — even on a no-op, the cache may hold a stale
  // entry from a previous TTL window. Cheap; the next read repopulates.
  invalidateCache();
  const removed = Array.isArray(data) && data.length > 0;
  console.log(`[suppression] ${key} ${removed ? 'removed' : 'not present — no-op'}`);
  return { removed, emailOrDomain: key };
}

module.exports = { isSuppressed, addSuppression, removeSuppression, invalidateCache };
