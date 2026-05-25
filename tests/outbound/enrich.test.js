// Hunter.io enrichment wrapper — mock global.fetch, assert URL/key plumbing,
// rate-limit gap, missing-key error, and document 429 behaviour (no retry).

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ENRICH_PATH = require.resolve('../../lib/enrich');

// Each test sets/clears env and reloads the module so HUNTER_API_KEY is
// captured fresh. (enrich.js reads process.env.HUNTER_API_KEY at module load.)

const realFetch = global.fetch;
let fetchCalls = [];

function makeFetch(response) {
  return async function (url, opts) {
    fetchCalls.push({ url, opts, at: Date.now() });
    return response();
  };
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  const text = JSON.stringify(body);
  return {
    ok,
    status,
    text: async () => text,
  };
}

function loadEnrichFresh() {
  delete require.cache[ENRICH_PATH];
  return require('../../lib/enrich');
}

beforeEach(() => {
  fetchCalls = [];
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.HUNTER_API_KEY;
});

// ── Missing key ──────────────────────────────────────────────────────────

test('enrichDomain: throws "Set HUNTER_API_KEY" when env missing', async () => {
  delete process.env.HUNTER_API_KEY;
  const { enrichDomain } = loadEnrichFresh();
  await assert.rejects(
    () => enrichDomain('asgfinance.co.uk'),
    /Set HUNTER_API_KEY/,
  );
});

test('enrichEmail: throws "Set HUNTER_API_KEY" when env missing', async () => {
  delete process.env.HUNTER_API_KEY;
  const { enrichEmail } = loadEnrichFresh();
  await assert.rejects(
    () => enrichEmail('person@example.co.uk'),
    /Set HUNTER_API_KEY/,
  );
});

// ── URL construction + key passed correctly ──────────────────────────────

test('enrichDomain: builds domain-search URL with key and encoded domain', async () => {
  process.env.HUNTER_API_KEY = 'TEST_KEY_123';
  const { enrichDomain } = loadEnrichFresh();
  global.fetch = makeFetch(() => jsonResponse({ data: { domain: 'asgfinance.co.uk', emails: [] } }));

  await enrichDomain('AsgFinance.co.uk');

  assert.equal(fetchCalls.length, 1);
  const url = fetchCalls[0].url;
  assert.match(url, /api\.hunter\.io\/v2\/domain-search/);
  assert.match(url, /domain=asgfinance\.co\.uk/);
  assert.match(url, /api_key=TEST_KEY_123/);
});

test('enrichEmail: builds email-verifier URL with key and encoded email', async () => {
  process.env.HUNTER_API_KEY = 'TEST_KEY_456';
  const { enrichEmail } = loadEnrichFresh();
  global.fetch = makeFetch(() => jsonResponse({ data: { status: 'deliverable', score: 92 } }));

  await enrichEmail('Person@Example.co.uk');

  assert.equal(fetchCalls.length, 1);
  const url = fetchCalls[0].url;
  assert.match(url, /api\.hunter\.io\/v2\/email-verifier/);
  assert.match(url, /email=person%40example\.co\.uk/);
  assert.match(url, /api_key=TEST_KEY_456/);
});

test('enrichDomain: normalises domain (strips protocol + www + trailing slash)', async () => {
  process.env.HUNTER_API_KEY = 'KEY';
  const { enrichDomain } = loadEnrichFresh();
  global.fetch = makeFetch(() => jsonResponse({ data: { emails: [] } }));

  await enrichDomain('https://www.asgfinance.co.uk/about');
  assert.match(fetchCalls[0].url, /domain=asgfinance\.co\.uk(&|$)/);
});

// ── Response parsing ─────────────────────────────────────────────────────

test('enrichDomain: parses contacts from a populated response', async () => {
  process.env.HUNTER_API_KEY = 'KEY';
  const { enrichDomain } = loadEnrichFresh();
  global.fetch = makeFetch(() => jsonResponse({
    data: {
      domain: 'asgfinance.co.uk',
      organization: 'ASG Finance',
      emails: [
        { value: 'chris.buckley@asgfinance.co.uk', first_name: 'Chris', last_name: 'Buckley', position: 'BDM', confidence: 95, linkedin: 'linkedin.com/in/chrisbuckley' },
        { value: 'enquiries@asgfinance.co.uk', confidence: 70 },
      ],
    },
  }));

  const res = await enrichDomain('asgfinance.co.uk');
  assert.equal(res.domain, 'asgfinance.co.uk');
  assert.equal(res.website, 'https://asgfinance.co.uk');
  assert.equal(res.organisation, 'ASG Finance');
  assert.equal(res.contacts.length, 2);
  assert.equal(res.contacts[0].name, 'Chris Buckley');
  assert.equal(res.contacts[0].confidence, 95);
});

test('enrichEmail: parses status/score from a populated response', async () => {
  process.env.HUNTER_API_KEY = 'KEY';
  const { enrichEmail } = loadEnrichFresh();
  global.fetch = makeFetch(() => jsonResponse({
    data: { status: 'deliverable', score: 92, webmail: false, disposable: false },
  }));

  const res = await enrichEmail('person@example.co.uk');
  assert.equal(res.status, 'deliverable');
  assert.equal(res.score, 92);
  assert.equal(res.webmail, false);
  assert.equal(res.disposable, false);
});

// ── Rate limiting ────────────────────────────────────────────────────────

test('rate limit: enforces >= 1s gap between sequential calls', async () => {
  process.env.HUNTER_API_KEY = 'KEY';
  const { enrichEmail } = loadEnrichFresh();
  global.fetch = makeFetch(() => jsonResponse({ data: { status: 'deliverable', score: 90 } }));

  const t0 = Date.now();
  await enrichEmail('a@x.co');
  await enrichEmail('b@x.co');
  const elapsed = Date.now() - t0;
  assert.ok(elapsed >= 1000, `expected >= 1000ms between sequential calls, got ${elapsed}ms`);
});

// ── 429 behaviour — DOCUMENTS coder limitation (no retry) ────────────────

test('429 response: surfaces error to caller (no automatic retry — KNOWN LIMITATION)', async () => {
  process.env.HUNTER_API_KEY = 'KEY';
  const { enrichEmail } = loadEnrichFresh();
  let calls = 0;
  global.fetch = async function (url) {
    calls++;
    return { ok: false, status: 429, text: async () => '{"errors":[{"code":429,"details":"Too many requests"}]}' };
  };

  await assert.rejects(
    () => enrichEmail('a@x.co'),
    /HTTP 429/,
    '429 must surface as an Error — no silent swallow',
  );
  assert.equal(calls, 1, 'documenting current behaviour: 429 is NOT retried');
});

// ── Invalid input ────────────────────────────────────────────────────────

test('enrichEmail: rejects malformed email', async () => {
  process.env.HUNTER_API_KEY = 'KEY';
  const { enrichEmail } = loadEnrichFresh();
  await assert.rejects(() => enrichEmail('not-an-email'), /not a valid email/);
});

test('enrichDomain: rejects empty domain', async () => {
  process.env.HUNTER_API_KEY = 'KEY';
  const { enrichDomain } = loadEnrichFresh();
  await assert.rejects(() => enrichDomain(''), /domain is empty/);
});
