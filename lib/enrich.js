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
// (Simon 2026-05-25).
//
// Required env: HUNTER_API_KEY. The module throws a clear error if the key
// is missing — Phase B accepts "no enrichment in v1" gracefully (the
// importer still runs against the bridging-brain snapshot alone), but any
// caller asking for enrichment must fail fast with a useful message.
//
// Rate limiting: Hunter's free tier rate-limits to ~1 req/sec. Both
// functions enforce a >= 1s gap between calls via a shared module-scoped
// lastCallAt timestamp so a caller that loops doesn't get 429'd.

// Read the API key at call time (see requireKey) so tests that
// `delete process.env.HUNTER_API_KEY` and reload the module observe the
// throw — capturing into a module-load-time const survives the env mutation
// and makes the "missing key" branch untestable.
const HUNTER_BASE_URL = 'https://api.hunter.io/v2';
const MIN_GAP_MS = 1000;

let lastCallAt = 0;

async function rateLimit() {
  const gap = Date.now() - lastCallAt;
  if (gap < MIN_GAP_MS) {
    await new Promise(r => setTimeout(r, MIN_GAP_MS - gap));
  }
  lastCallAt = Date.now();
}

function requireKey() {
  if (!process.env.HUNTER_API_KEY) {
    throw new Error('Set HUNTER_API_KEY in .env');
  }
  return process.env.HUNTER_API_KEY;
}

/**
 * Normalise a domain: strip protocol, leading "www.", trailing slash, lowercase.
 */
function normaliseDomain(raw) {
  if (!raw || typeof raw !== 'string') return '';
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '');
  d = d.replace(/^www\./, '');
  d = d.replace(/\/.*$/, '');
  return d;
}

/**
 * Discover contacts and the canonical website for a domain.
 *
 * @param {string} domain - bare hostname, e.g. 'asgfinance.co.uk'
 * @returns {Promise<{
 *   domain: string,
 *   website: string,
 *   organisation: string|null,
 *   contacts: Array<{
 *     email: string,
 *     name: string|null,
 *     role: string|null,
 *     linkedin: string|null,
 *     confidence: number
 *   }>,
 *   raw: object
 * }>}
 */
async function enrichDomain(domain) {
  const key = requireKey();
  const clean = normaliseDomain(domain);
  if (!clean) throw new Error('enrichDomain: domain is empty');

  await rateLimit();

  const url = `${HUNTER_BASE_URL}/domain-search?domain=${encodeURIComponent(clean)}&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const bodyText = await res.text();

  if (!res.ok) {
    // Strip the api_key from any error echo before logging
    throw new Error(`Hunter domain-search failed for ${clean} (HTTP ${res.status}): ${bodyText.slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Hunter domain-search returned non-JSON for ${clean}: ${bodyText.slice(0, 200)}`);
  }

  const data = parsed && parsed.data ? parsed.data : {};
  const emails = Array.isArray(data.emails) ? data.emails : [];

  const contacts = emails.map(e => {
    const first = e.first_name || '';
    const last = e.last_name || '';
    const fullName = [first, last].filter(Boolean).join(' ').trim() || null;
    return {
      email: e.value || null,
      name: fullName,
      role: e.position || null,
      linkedin: e.linkedin || null,
      confidence: typeof e.confidence === 'number' ? e.confidence : 0,
    };
  }).filter(c => c.email);

  return {
    domain: clean,
    website: `https://${clean}`,
    organisation: data.organization || null,
    contacts,
    raw: parsed,
  };
}

/**
 * Verify deliverability of a single email address.
 *
 * @param {string} email
 * @returns {Promise<{
 *   email: string,
 *   status: 'deliverable'|'risky'|'undeliverable'|'unknown',
 *   score: number,
 *   webmail: boolean,
 *   disposable: boolean,
 *   raw: object
 * }>}
 */
async function enrichEmail(email) {
  const key = requireKey();
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error(`enrichEmail: '${email}' is not a valid email address`);
  }

  await rateLimit();

  const clean = email.trim().toLowerCase();
  const url = `${HUNTER_BASE_URL}/email-verifier?email=${encodeURIComponent(clean)}&api_key=${encodeURIComponent(key)}`;
  const res = await fetch(url);
  const bodyText = await res.text();

  if (!res.ok) {
    throw new Error(`Hunter email-verifier failed for ${clean} (HTTP ${res.status}): ${bodyText.slice(0, 200)}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new Error(`Hunter email-verifier returned non-JSON for ${clean}: ${bodyText.slice(0, 200)}`);
  }

  const data = parsed && parsed.data ? parsed.data : {};
  const rawStatus = (data.status || '').toLowerCase();
  const status = ['deliverable', 'risky', 'undeliverable', 'unknown'].includes(rawStatus)
    ? rawStatus
    : 'unknown';

  return {
    email: clean,
    status,
    score: typeof data.score === 'number' ? data.score : 0,
    webmail: data.webmail === true,
    disposable: data.disposable === true,
    raw: parsed,
  };
}

module.exports = { enrichDomain, enrichEmail, normaliseDomain };
