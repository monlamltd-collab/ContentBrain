require('dotenv').config();

// ── Unsubscribe (Phase B follow-up, GDPR/PECR) ───────────────────────────
//
// UK B2B cold outreach is permitted to corporate subscribers without prior
// consent (PECR reg 21), but the message MUST contain a working
// unsubscribe mechanism — typically the `List-Unsubscribe` header
// (RFC 2369) plus `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
// (RFC 8058) so Gmail/Outlook surface the native one-click control.
//
// Tokens are HMAC-SHA256 over the recipient email + a secret salt. They
// don't expire — once an address opts out, it stays out. Verifying a
// token re-derives the email from the body of the link's `e` param and
// recomputes the HMAC; mismatch = 404 (don't tell the world which emails
// are real).
//
// Required env: UNSUBSCRIBE_SECRET — any long random string. Falls back
// to RESEND_WEBHOOK_SECRET so we don't add another required key for the
// common case.

const crypto = require('crypto');
const { addSuppression } = require('./suppression');

function getSecret() {
  const secret = process.env.UNSUBSCRIBE_SECRET || process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('Set UNSUBSCRIBE_SECRET (or RESEND_WEBHOOK_SECRET as fallback) in .env');
  }
  return secret;
}

function sign(email) {
  const lower = String(email || '').trim().toLowerCase();
  if (!lower) throw new Error('unsubscribe.sign: email is required');
  return crypto.createHmac('sha256', getSecret()).update(lower).digest('hex');
}

/**
 * Build the unsubscribe URL embedded in the email's List-Unsubscribe header
 * and in any "unsubscribe" link inside the body.
 *
 * @param {string} email  recipient address
 * @param {string} baseUrl  public host (e.g. https://content-brain.up.railway.app)
 * @returns {string}  e.g. https://host/u?e=alice%40x.co&t=ab12…
 */
function buildUrl(email, baseUrl) {
  const lower = String(email || '').trim().toLowerCase();
  if (!lower) throw new Error('unsubscribe.buildUrl: email required');
  if (!baseUrl) throw new Error('unsubscribe.buildUrl: baseUrl required');
  const token = sign(lower);
  const u = new URL('/u', baseUrl);
  u.searchParams.set('e', lower);
  u.searchParams.set('t', token);
  return u.toString();
}

/**
 * Verify a (email, token) pair came from us. Constant-time compare to avoid
 * timing leaks.
 *
 * @returns {{ok: boolean, email: string|null}}
 */
function verify(email, token) {
  try {
    const expected = sign(email);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(token || ''), 'hex');
    if (a.length !== b.length) return { ok: false, email: null };
    if (!crypto.timingSafeEqual(a, b)) return { ok: false, email: null };
    return { ok: true, email: String(email).trim().toLowerCase() };
  } catch {
    return { ok: false, email: null };
  }
}

/**
 * Apply an unsubscribe — add the address to the suppression list with reason
 * 'unsubscribe'. Idempotent (addSuppression handles the re-add no-op).
 *
 * @param {string} email
 * @param {string} token
 * @returns {Promise<{ok: boolean, email: string|null, reason?: string}>}
 */
async function applyUnsubscribe(email, token) {
  const v = verify(email, token);
  if (!v.ok) return { ok: false, email: null, reason: 'invalid_token' };
  await addSuppression(v.email, 'unsubscribe');
  return { ok: true, email: v.email };
}

/**
 * Build the List-Unsubscribe header pair for outbound.sendOutbound.
 * Returns a headers object the caller spreads into Resend's `headers` param.
 *
 * @param {string} email  recipient
 * @param {string} baseUrl  public host
 * @param {string} [mailto]  fallback mailto address
 * @returns {{'List-Unsubscribe': string, 'List-Unsubscribe-Post': string}}
 */
function buildHeaders(email, baseUrl, mailto = 'unsubscribe@bridgematch.co.uk') {
  const url = buildUrl(email, baseUrl);
  return {
    // RFC 2369 — at least one URI; both URL and mailto for broad client support.
    'List-Unsubscribe': `<${url}>, <mailto:${mailto}>`,
    // RFC 8058 — opt into Gmail/Outlook one-click.
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

module.exports = { sign, verify, buildUrl, buildHeaders, applyUnsubscribe };
