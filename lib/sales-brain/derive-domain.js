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
//   3. Map an auction-house slug prefix (e.g. `auctionhousenorthwest`) to a
//      UK region string ("North West") for `metadata.region`. Free,
//      deterministic, slug-only — no URL fetch.
//
// Kept tiny + pure so it's trivially testable and re-usable. NO network
// calls. NO Hunter calls. NO DB writes. Caller is responsible for any
// downstream verification (Hunter `email-verifier` etc.) if/when budget
// allows.
//
// House style: keep the file under ~200 lines and zero dependencies.

/**
 * Reduce a URL (or bare host) to its apex/registrable domain.
 *
 * Rules (in order):
 *   1. If the input is empty / non-string, return null.
 *   2. Strip protocol (http://, https://) if present.
 *   3. Drop everything from the first `/`, `?` or `#` (path, query, fragment).
 *   4. Drop user-info segments (anything before an `@`).
 *   5. Drop port (`:8080`).
 *   6. Lowercase, then strip a leading `www.` if present.
 *
 * Test cases:
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
  if (url == null) return null;
  if (typeof url !== 'string') return null;
  let s = url.trim();
  if (!s) return null;

  // Strip protocol.
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');

  // Drop user-info segment (rare but possible).
  const atIdx = s.indexOf('@');
  if (atIdx >= 0) s = s.slice(atIdx + 1);

  // Drop path / query / fragment.
  s = s.split('/')[0].split('?')[0].split('#')[0];

  // Drop port.
  s = s.split(':')[0];

  // Lowercase + strip leading www.
  s = s.toLowerCase();
  if (s.startsWith('www.')) s = s.slice(4);

  if (!s) return null;
  return s;
}

/**
 * Build a synthesised contact email of the form `<prefix>@<domain>`.
 *
 * Default prefix is `info`. For auction houses the import-houses caller
 * may iterate over the common patterns (`info`, `auctions`, `enquiries`,
 * `hello`) and let Simon pick during approval; for v1 just emit one.
 *
 * Rules:
 *   1. If domain is empty / non-string, return null.
 *   2. Lowercase domain. Strip a leading `@` if accidentally passed.
 *   3. Validate the domain has at least one `.` (a TLD). Otherwise null.
 *   4. Return `<prefix>@<domain>`.
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
  if (domain == null) return null;
  if (typeof domain !== 'string') return null;
  let d = domain.trim().toLowerCase();
  if (!d) return null;
  if (d.startsWith('@')) d = d.slice(1);
  if (!d) return null;
  // Must contain a TLD (at least one '.').
  if (!d.includes('.')) return null;
  const p = (prefix == null ? 'info' : String(prefix)).trim().toLowerCase() || 'info';
  return `${p}@${d}`;
}

/**
 * Known multi-tenant auction platforms whose hostname is the *platform*,
 * not the *house brand*. Exposed for import-houses.js to decide whether
 * to use the platform-hosted URL's domain for a synthetic `info@` (no —
 * `info@eigonlineauctions.com` would land at the platform, not the house)
 * or to fall back to NULL (yes — flag the house for manual domain entry).
 */
const PLATFORM_HOSTS = Object.freeze(new Set([
  'eigonlineauctions.com',
  'eigpropertyauctions.co.uk',
  'bambooauctions.com',
  'gotoproperties.co.uk',
  'iamsold.co.uk',
  'sdlauctions.co.uk',
]));

/**
 * Returns true if the given host is (or is a subdomain of) a known
 * multi-tenant auction platform. Match is by suffix —
 * `pugh.eigonlineauctions.com` returns true.
 *
 * @param {string|null|undefined} host
 * @returns {boolean}
 */
function isPlatformHost(host) {
  if (!host || typeof host !== 'string') return false;
  const h = host.toLowerCase();
  for (const p of PLATFORM_HOSTS) {
    if (h === p || h.endsWith('.' + p)) return true;
  }
  return false;
}

// ── slug → UK region mapping ──────────────────────────────────────────────
//
// Auction House UK runs regional branches whose slugs share the
// `auctionhouse` prefix — e.g. `auctionhousenorthwest`, `auctionhousehull`.
// For these slugs, return the humanised region. For every other slug,
// return null (national or undefined region).
//
// Researcher §3 mapping sketch + the actual Auction repo slugs.

const SLUG_REGION_TABLE = Object.freeze({
  // Auction House UK regional branches
  auctionhouselondon: 'London',
  auctionhousenorthwest: 'North West',
  auctionhousenortheast: 'North East',
  auctionhouseyorkshire: 'Yorkshire',
  auctionhousewestyorkshire: 'West Yorkshire',
  auctionhouseeastanglia: 'East Anglia',
  auctionhousehull: 'Hull and East Yorkshire',
  auctionhouselincolnshire: 'Lincolnshire',
  auctionhousemanchester: 'Manchester',
  auctionhouseliverpool: 'Merseyside',
  auctionhousescotland: 'Scotland',
  auctionhousewales: 'Wales',
  auctionhousecumbria: 'Cumbria',
  auctionhousedevoncornwall: 'Devon and Cornwall',
  auctionhousekent: 'Kent',
  auctionhousesouthwest: 'South West',
  auctionhousesoutheast: 'South East',
  auctionhousemidlands: 'Midlands',
  auctionhousewestmidlands: 'West Midlands',
  auctionhouseeastmidlands: 'East Midlands',
  auctionhousebirmingham: 'Birmingham',
  auctionhousehertsandessex: 'Hertfordshire and Essex',
  auctionhousecheshire: 'Cheshire',
  auctionhousenorthern: 'Northern England',
});

/**
 * Map an auction-house slug to a UK region string. Returns null for slugs
 * that don't carry a regional signal in the slug itself.
 *
 * Test cases:
 *   slugToRegion('auctionhousenorthwest')      === 'North West'
 *   slugToRegion('auctionhouseeastanglia')     === 'East Anglia'
 *   slugToRegion('auctionhousehull')           === 'Hull and East Yorkshire'
 *   slugToRegion('savills')                    === null
 *   slugToRegion('')                           === null
 *
 * @param {string|null|undefined} slug
 * @returns {string|null}
 */
function slugToRegion(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const s = slug.trim().toLowerCase();
  if (!s) return null;
  if (Object.prototype.hasOwnProperty.call(SLUG_REGION_TABLE, s)) {
    return SLUG_REGION_TABLE[s];
  }
  return null;
}

module.exports = {
  deriveDomainFromUrl,
  deriveContactEmail,
  isPlatformHost,
  slugToRegion,
  PLATFORM_HOSTS,
  SLUG_REGION_TABLE,
};
