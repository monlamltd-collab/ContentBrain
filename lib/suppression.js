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

/**
 * Is this email suppressed (either directly or by its domain)?
 *
 * @param {string} email
 * @returns {Promise<{
 *   suppressed: boolean,
 *   match: string|null,      // the suppression row's email_or_domain
 *   reason: string|null,     // why it was added
 *   level: 'address'|'domain'|null
 * }>}
 */
async function isSuppressed(email) {
  // TODO(coder):
  //   1. Lowercase + trim the input. Return { suppressed: false, ... } for empty.
  //   2. Extract domain (substring after the last '@').
  //   3. Single Supabase query: WHERE email_or_domain IN (<email>, <domain>).
  //   4. If the row matches the full email, level='address'; else level='domain'.
  //   5. Prefer the address-level row if both exist (more specific reason).
  void email;
  throw new Error('isSuppressed not implemented yet — see TODO(coder)');
}

/**
 * Add an email address OR a whole domain to the suppression list.
 * Idempotent: ON CONFLICT DO NOTHING — re-adding an existing row is a no-op
 * (does NOT overwrite the original `reason`, which would lose audit history).
 *
 * @param {string} emailOrDomain - either a full address or a bare domain.
 *   The caller decides which — e.g. hard bounce passes the email; spam
 *   complaint passes the domain. Both are valid PK values.
 * @param {string} reason - free-form, audit purpose, e.g. 'hard_bounce',
 *   'spam_complaint', 'hostile_reply', 'manual_pipeline_tab', 'import_ms_2026_05'.
 * @returns {Promise<{inserted: boolean, emailOrDomain: string, reason: string}>}
 *   inserted=false means the row already existed.
 */
async function addSuppression(emailOrDomain, reason) {
  // TODO(coder):
  //   1. Validate inputs non-empty. Lowercase + trim the email_or_domain.
  //   2. Insert with ON CONFLICT (email_or_domain) DO NOTHING.
  //   3. Use .select() to detect whether the row was new (inserted=true).
  void emailOrDomain; void reason;
  throw new Error('addSuppression not implemented yet — see TODO(coder)');
}

module.exports = { isSuppressed, addSuppression };
