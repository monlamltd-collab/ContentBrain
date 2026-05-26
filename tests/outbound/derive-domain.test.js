// Pure-function tests for lib/sales-brain/derive-domain.
// No mocks needed.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveDomainFromUrl,
  deriveContactEmail,
  isPlatformHost,
  slugToRegion,
} = require('../../lib/sales-brain/derive-domain');

test('deriveDomainFromUrl strips protocol, www, path, port', () => {
  assert.equal(deriveDomainFromUrl('https://www.pugh-auctions.com/lots'), 'pugh-auctions.com');
  assert.equal(deriveDomainFromUrl('http://allsop.co.uk:80/path/'), 'allsop.co.uk');
  assert.equal(deriveDomainFromUrl('pugh.eigonlineauctions.com'), 'pugh.eigonlineauctions.com');
  assert.equal(deriveDomainFromUrl('https://WWW.Brown.co.uk/Path?x=1'), 'brown.co.uk');
});

test('deriveDomainFromUrl returns null for empty / non-string', () => {
  assert.equal(deriveDomainFromUrl(''), null);
  assert.equal(deriveDomainFromUrl(null), null);
  assert.equal(deriveDomainFromUrl(undefined), null);
  assert.equal(deriveDomainFromUrl(42), null);
});

test('deriveDomainFromUrl strips fragment and query', () => {
  assert.equal(deriveDomainFromUrl('https://example.co.uk/path#frag'), 'example.co.uk');
  assert.equal(deriveDomainFromUrl('https://example.co.uk?x=1#y'), 'example.co.uk');
});

test('deriveContactEmail builds info@<domain> by default', () => {
  assert.equal(deriveContactEmail({ domain: 'pugh-auctions.com' }), 'info@pugh-auctions.com');
});

test('deriveContactEmail honours prefix override', () => {
  assert.equal(
    deriveContactEmail({ domain: 'Allsop.co.uk', prefix: 'auctions' }),
    'auctions@allsop.co.uk'
  );
});

test('deriveContactEmail strips leading @ on domain', () => {
  assert.equal(deriveContactEmail({ domain: '@brown.co.uk' }), 'info@brown.co.uk');
});

test('deriveContactEmail rejects empty / TLD-less domains', () => {
  assert.equal(deriveContactEmail({ domain: '' }), null);
  assert.equal(deriveContactEmail({ domain: null }), null);
  assert.equal(deriveContactEmail({ domain: 'noDot' }), null,
    'domain without a TLD should not yield an email');
});

test('isPlatformHost matches by suffix', () => {
  assert.equal(isPlatformHost('eigonlineauctions.com'), true);
  assert.equal(isPlatformHost('pugh.eigonlineauctions.com'), true);
  assert.equal(isPlatformHost('savills.co.uk'), false);
  assert.equal(isPlatformHost(null), false);
  assert.equal(isPlatformHost(''), false);
});

test('slugToRegion maps known auctionhouse prefixes', () => {
  assert.equal(slugToRegion('auctionhousenorthwest'), 'North West');
  assert.equal(slugToRegion('auctionhouseeastanglia'), 'East Anglia');
  assert.equal(slugToRegion('auctionhouselondon'), 'London');
  assert.equal(slugToRegion('AUCTIONHOUSEHULL'), 'Hull and East Yorkshire');
});

test('slugToRegion returns null for non-regional slugs', () => {
  assert.equal(slugToRegion('savills'), null);
  assert.equal(slugToRegion('allsop'), null);
  assert.equal(slugToRegion(''), null);
  assert.equal(slugToRegion(null), null);
});
