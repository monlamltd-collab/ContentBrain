'use strict';

// ── Domain + synthetic-contact helpers (Phase D) ──────────────────────────
//
// Pure functions used by both import-houses.js and import-brokers.js to:
//   1. Reduce a catalogue-root URL (e.g. "https://www.pugh-auctions.com/lots?x=1")
//      to an apex/registrable domain ("pugh-auctions.com") suitable for use
//      in a synthesised contact email.
//   2. Synthesise an `info@<domain>` (or other-prefix) contact address when
//      no email is otherwise discoverable. Phase D's FREE-SYNTHETIC path
//      (per Simon's decision, .ruflo/phase-d-design.md §5.1 alt (c)) leans
//      on this hard — most auction houses and many brokers will only have
//      a synthetic generic-inbox contact at import time.
//
// Kept tiny + pure so it's trivially testable and re-usable. NO network
// calls. NO Hunter calls. NO DB writes. Caller is responsible for any
// downstream verification (Hunter `email-verifier` etc.) if/when budget
// allows.
//
// House style: keep the file under ~150 lines and zero dependencies.

/**
 * Reduce a URL (or bare host) to its apex/registrable domain.
 *
 * The Auction repo's `HOUSE_ROOTS` values are full URLs (often with `www.`,
 * subdomain platforms like `pugh.eigonlineauctions.com`, query strings,
 * deep paths). We want the *sender domain* a real email would land at —
 * the public-facing brand host.
 *
 * Rules (in order):
 *   1. If the input is empty / non-string, return null.
 *   2. Parse as URL; if that fails, treat the raw value as a hostname.
 *   3. Lowercase. Strip a leading `www.` if present.
 *   4. Strip port if present.
 *   5. For known multi-tenant auction platforms (eigonlineauctions.com,
 *      bambooauctions.com, sequenceuk.com), the *house's own* domain is
 *      the subdomain — return the first label + the platform host? NO.
 *      Better: leave platform-hosted URLs alone and let the caller decide
 *      whether the house has a real domain (handled in import-houses.js).
 *      For now, return whatever's left after rules 1-4. Caller checks if
 *      the result matches a known platform suffix and either keeps it or
 *      drops it.
 *
 * Test cases (for the coder to lock in):
 *   deriveDomainFromUrl('https://www.pugh-auctions.com/lots')            === 'pugh-auctions.com'
 *   deriveDomainFromUrl('http://allsop.co.uk:80/path/')                  === 'allsop.co.uk'
 *   deriveDomainFromUrl('pugh.eigonlineauctions.com')                    === 'pugh.eigonlineauctions.com'
 *   deriveDomainFromUrl('https://WWW.Brown.co.uk/Path?x=1')              === 'brown.co.uk'
 *   deriveDomainFromUrl('')                                              === null
 *   deriveDomainFromUrl(null)                                            === null
 *
 * @param {string|null|undefined} url
 * @returns {string|null}
 */
function deriveDomainFromUrl(url) {
  throw new Error('deriveDomainFromUrl: not yet implemented (Phase D coder stub)');
}

/**
 * Build a synthesised contact email of the form `<prefix>@<domain>`.
 *
 * Used as the free-synthetic-path contact (Simon's call, .ruflo/phase-d-design.md
 * §5.1): when no Hunter call has been made or no real email is known, we
 * still want an `info@<domain>` row in `contacts` so the sequence engine
 * has SOMETHING to send to. The caller flags these with low
 * `confidence_score` (e.g. 40-50) so the Telegram approval step is the
 * gate that catches a bad address.
 *
 * Default prefix is `info`. For auction houses the import-houses caller
 * may iterate over the common patterns (`info`, `auctions`, `enquiries`,
 * `hello`) and let Simon pick during approval; for v1 just emit one.
 *
 * Rules:
 *   1. If domain is empty / non-string, return null.
 *   2. Lowercase domain. Strip a leading `@` if accidentally passed.
 *   3. Return `<prefix>@<domain>`. No validation beyond non-emptiness —
 *      the caller decides whether to push it through Hunter verify.
 *
 * Test cases:
 *   deriveContactEmail({ domain: 'pugh-auctions.com' })                   === 'info@pugh-auctions.com'
 *   deriveContactEmail({ domain: 'Allsop.co.uk', prefix: 'auctions' })    === 'auctions@allsop.co.uk'
 *   deriveContactEmail({ domain: '@brown.co.uk' })                        === 'info@brown.co.uk'
 *   deriveContactEmail({ domain: '' })                                    === null
 *   deriveContactEmail({ domain: null })                                  === null
 *
 * @param {object} opts
 * @param {string} opts.domain   e.g. 'pugh-auctions.com'
 * @param {string} [opts.prefix='info']  local-part prefix
 * @returns {string|null}
 */
function deriveContactEmail({ domain, prefix = 'info' } = {}) {
  throw new Error('deriveContactEmail: not yet implemented (Phase D coder stub)');
}

/**
 * Known multi-tenant auction platforms whose hostname is the *platform*,
 * not the *house brand*. Exposed for import-houses.js to decide whether
 * to use the platform-hosted URL's domain for a synthetic `info@` (no —
 * `info@eigonlineauctions.com` would land at the platform, not the house)
 * or to fall back to NULL (yes — flag the house for manual domain entry).
 *
 * Kept as a Set for cheap membership checks. Extendable; add new platform
 * suffixes here as they appear in HOUSE_ROOTS.
 */
const PLATFORM_HOSTS = Object.freeze(new Set([
  'eigonlineauctions.com',
  'eigpropertyauctions.co.uk',
  'bambooauctions.com',
  'gotoproperties.co.uk',
  'iamsold.co.uk',
  'sdlauctions.co.uk', // SDL hosts a few small houses too
]));

/**
 * Returns true if the given host is a multi-tenant auction platform (per
 * PLATFORM_HOSTS). Match is by suffix — `pugh.eigonlineauctions.com`
 * returns true.
 *
 * @param {string|null|undefined} host
 * @returns {boolean}
 */
function isPlatformHost(host) {
  throw new Error('isPlatformHost: not yet implemented (Phase D coder stub)');
}

module.exports = {
  deriveDomainFromUrl,
  deriveContactEmail,
  isPlatformHost,
  PLATFORM_HOSTS,
};
