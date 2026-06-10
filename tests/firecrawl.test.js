// lib/firecrawl.js — thin v2 client. global.fetch stubbed; no network.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const FIRECRAWL_PATH = require.resolve('../lib/firecrawl');

let fetchCalls;
let fetchResponse;
const realFetch = global.fetch;

function loadFresh() {
  delete require.cache[FIRECRAWL_PATH];
  return require('../lib/firecrawl');
}

beforeEach(() => {
  fetchCalls = [];
  fetchResponse = {
    ok: true,
    json: async () => ({ success: true, data: { markdown: '# hi', json: { a: 1 } } }),
  };
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    return fetchResponse;
  };
  process.env.FIRECRAWL_API_KEY = 'fc-test-key';
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.FIRECRAWL_API_KEY;
});

test('isFirecrawlConfigured: true with key, false without', () => {
  const { isFirecrawlConfigured } = loadFresh();
  assert.equal(isFirecrawlConfigured(), true);
  delete process.env.FIRECRAWL_API_KEY;
  assert.equal(isFirecrawlConfigured(), false);
});

test('firecrawlScrape: posts url + formats with bearer auth, returns data', async () => {
  const { firecrawlScrape } = loadFresh();
  const data = await firecrawlScrape('https://example.com', { formats: ['markdown'] });
  assert.equal(data.markdown, '# hi');
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /api\.firecrawl\.dev\/v2\/scrape/);
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.url, 'https://example.com');
  assert.deepEqual(body.formats, ['markdown']);
  assert.equal(fetchCalls[0].opts.headers.Authorization, 'Bearer fc-test-key');
});

test('firecrawlScrape: json-extraction format passes through', async () => {
  const { firecrawlScrape } = loadFresh();
  const schema = { type: 'object', properties: { title: { type: 'string' } } };
  await firecrawlScrape('https://example.com', { formats: [{ type: 'json', schema }] });
  const body = JSON.parse(fetchCalls[0].opts.body);
  assert.equal(body.formats[0].type, 'json');
  assert.deepEqual(body.formats[0].schema, schema);
});

test('firecrawlScrape: throws when key unset', async () => {
  delete process.env.FIRECRAWL_API_KEY;
  const { firecrawlScrape } = loadFresh();
  await assert.rejects(() => firecrawlScrape('https://example.com'), /FIRECRAWL_API_KEY not set/);
  assert.equal(fetchCalls.length, 0);
});

test('firecrawlScrape: non-OK response throws with status + body slice', async () => {
  fetchResponse = { ok: false, status: 402, text: async () => 'payment required' };
  const { firecrawlScrape } = loadFresh();
  await assert.rejects(() => firecrawlScrape('https://example.com'), /Firecrawl 402.*payment required/);
});

test('firecrawlScrape: success=false payload throws', async () => {
  fetchResponse = { ok: true, json: async () => ({ success: false, error: 'blocked' }) };
  const { firecrawlScrape } = loadFresh();
  await assert.rejects(() => firecrawlScrape('https://example.com'), /success=false/);
});
