require('dotenv').config();

// ── Hunter.io contact enrichment (Phase B) ────────────────────────────────
//
// Wraps two Hunter.io endpoints:
//   - Domain Search:  given a domain, returns the company's known emails
//                     (used to backfill prospects.website from a BDM email
//                     domain AND to discover additional contacts beyond
//                     the bridging-brain snapshot).
//   - Email Verifier: given an email, returns deliverability status
//                     (used to set contacts.verified_at and to suppress
//                     undeliverable addresses before they get sent).
//
// Why Hunter (not Apollo)? Decision logged in .ruflo/phase-b-context.md
// (Simon 2026-05-25). Apollo has richer firmographics but a much higher
// per-lookup cost; Hunter's domain-search + verifier covers v1's needs
// at ~£0.04 / contact.
//
// Required env: HUNTER_API_KEY. The module must throw a clear error if
// the key is missing — Phase B accepts "no enrichment in v1" gracefully
// (the importer still runs against the bridging-brain snapshot alone),
// but any caller asking for enrichment must fail fast with a useful
// message rather than emit a malformed Hunter request.

const HUNTER_API_KEY = process.env.HUNTER_API_KEY;
const HUNTER_BASE_URL = 'https://api.hunter.io/v2';

/**
 * Discover contacts and (implicitly) the canonical website for a domain.
 *
 * @param {string} domain - Bare hostname, e.g. 'asgfinance.co.uk'. The
 *   wrapper normalises (strips https://, trailing slash, www.).
 * @returns {Promise<{
 *   domain: string,
 *   website: string,              // 'https://<domain>'
 *   organisation: string|null,    // Hunter's `organization`
 *   contacts: Array<{
 *     email: string,
 *     first_name: string|null,
 *     last_name: string|null,
 *     position: string|null,      // role text
 *     linkedin: string|null,
 *     confidence: number          // 0-100, Hunter's `confidence`
 *   }>,
 *   raw: object                   // full Hunter response for audit / future fields
 * }>}
 * @throws {Error} if HUNTER_API_KEY is unset, the domain is empty, or Hunter
 *   returns a non-2xx response.
 */
async function enrichDomain(domain) {
  // TODO(coder):
  //   1. Validate HUNTER_API_KEY is set; throw a clear error if not.
  //   2. Normalise the domain: strip protocol, leading 'www.', trailing '/'.
  //   3. GET ${HUNTER_BASE_URL}/domain-search?domain=<domain>&api_key=...
  //   4. Map response.data.emails[] -> contacts[] shape above.
  //   5. Surface website as `https://${domain}` — Hunter sometimes returns
  //      a different canonical, but the BDM-email-domain is what we trust.
  //   6. Handle 429 / 5xx with a single retry + exponential backoff.
  void domain;
  void HUNTER_API_KEY;
  void HUNTER_BASE_URL;
  throw new Error('enrichDomain not implemented yet — see TODO(coder)');
}

/**
 * Verify deliverability of a single email address.
 *
 * @param {string} email
 * @returns {Promise<{
 *   email: string,
 *   status: 'deliverable'|'risky'|'undeliverable'|'unknown',
 *   score: number,        // 0-100
 *   webmail: boolean,
 *   disposable: boolean,
 *   raw: object
 * }>}
 * @throws {Error} if HUNTER_API_KEY is unset or the email is malformed.
 */
async function enrichEmail(email) {
  // TODO(coder):
  //   1. Validate HUNTER_API_KEY set; basic email shape check (contains '@').
  //   2. GET ${HUNTER_BASE_URL}/email-verifier?email=<email>&api_key=...
  //   3. Map response.data.status (deliverable/risky/undeliverable/unknown).
  //   4. Return shape above. Callers gate Resend sends on status !== 'undeliverable'.
  void email;
  throw new Error('enrichEmail not implemented yet — see TODO(coder)');
}

module.exports = { enrichDomain, enrichEmail };
