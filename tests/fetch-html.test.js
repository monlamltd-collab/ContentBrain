// tests/fetch-html.test.js — Crawlee-first / Firecrawl-bypass policy.
// 'crawlee' and '../lib/firecrawl' are injected into require.cache so no
// crawler spins up and no network is touched.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const FETCH_HTML_PATH = require.resolve('../lib/fetch-html');
const FIRECRAWL_PATH = require.resolve('../lib/firecrawl');
const CRAWLEE_PATH = require.resolve('crawlee');

let state;

function makeCrawleeMock() {
  // CheerioCrawler that calls requestHandler with a body, or failedRequestHandler.
  class CheerioCrawler {
    constructor(opts) { this.opts = opts; }
    async run() {
      state.crawleeRuns++;
      if (state.crawleeFail) {
        await this.opts.failedRequestHandler({ request: { url: 'u' } }, new Error(state.crawleeFail));
      } else {
        await this.opts.requestHandler({ body: state.crawleeBody });
      }
    }
  }
  class Configuration { constructor() {} }
  return { CheerioCrawler, Configuration };
}

function makeFirecrawlMock() {
  return {
    isFirecrawlConfigured: () => state.fcConfigured,
    firecrawlScrape: async (url, opts) => {
      state.fcCalls.push({ url, opts });
      if (state.fcFail) throw new Error(state.fcFail);
      return { rawHtml: state.fcHtml };
    },
  };
}

function loadFresh() {
  for (const p of [FETCH_HTML_PATH, FIRECRAWL_PATH, CRAWLEE_PATH]) delete require.cache[p];
  require.cache[CRAWLEE_PATH] = { id: CRAWLEE_PATH, filename: CRAWLEE_PATH, loaded: true, exports: makeCrawleeMock() };
  require.cache[FIRECRAWL_PATH] = { id: FIRECRAWL_PATH, filename: FIRECRAWL_PATH, loaded: true, exports: makeFirecrawlMock() };
  return require('../lib/fetch-html');
}

beforeEach(() => {
  state = {
    crawleeBody: '<div id="siteTable"><div class="thing"><a class="title">ok</a></div></div>',
    crawleeFail: null,
    crawleeRuns: 0,
    fcConfigured: true,
    fcFail: null,
    fcHtml: '<div id="firecrawl">bypassed</div>',
    fcCalls: [],
  };
  delete process.env.FIRECRAWL_BYPASS_ENABLED;
  delete process.env.FIRECRAWL_BYPASS_MAX_PER_RUN;
});

afterEach(() => {
  for (const p of [FETCH_HTML_PATH, FIRECRAWL_PATH, CRAWLEE_PATH]) delete require.cache[p];
});

test('fetchHtml: Crawlee success → via crawlee, Firecrawl untouched', async () => {
  const { fetchHtml } = loadFresh();
  const { $, via } = await fetchHtml('https://x');
  assert.equal(via, 'crawlee');
  assert.equal($('a.title').text(), 'ok');
  assert.equal(state.fcCalls.length, 0);
});

test('fetchHtml: Crawlee blocked → Firecrawl enhanced bypass used', async () => {
  state.crawleeFail = 'Request blocked - received 403 status code';
  const { fetchHtml, getBypassCount } = loadFresh();
  const { $, via } = await fetchHtml('https://x');
  assert.equal(via, 'firecrawl');
  assert.equal($('#firecrawl').text(), 'bypassed');
  assert.equal(state.fcCalls.length, 1);
  assert.deepEqual(state.fcCalls[0].opts.formats, ['rawHtml']);
  assert.equal(state.fcCalls[0].opts.proxy, 'enhanced');
  assert.equal(getBypassCount(), 1);
});

test('fetchHtml: bypass disabled via env → rethrows Crawlee error, no Firecrawl', async () => {
  state.crawleeFail = '403';
  process.env.FIRECRAWL_BYPASS_ENABLED = 'false';
  const { fetchHtml } = loadFresh();
  await assert.rejects(() => fetchHtml('https://x'), /403/);
  assert.equal(state.fcCalls.length, 0);
});

test('fetchHtml: Firecrawl unconfigured → rethrows Crawlee error', async () => {
  state.crawleeFail = 'timeout';
  state.fcConfigured = false;
  const { fetchHtml } = loadFresh();
  await assert.rejects(() => fetchHtml('https://x'), /timeout/);
  assert.equal(state.fcCalls.length, 0);
});

test('fetchHtml: per-run budget cap stops further bypasses', async () => {
  state.crawleeFail = 'blocked';
  process.env.FIRECRAWL_BYPASS_MAX_PER_RUN = '1';
  const { fetchHtml, getBypassCount, resetBypassBudget } = loadFresh();
  resetBypassBudget();

  await fetchHtml('https://a');                       // 1st bypass OK
  await assert.rejects(() => fetchHtml('https://b'), /budget .*exhausted/); // 2nd over cap
  assert.equal(getBypassCount(), 1);
  assert.equal(state.fcCalls.length, 1);

  resetBypassBudget();
  await fetchHtml('https://c');                        // budget restored
  assert.equal(getBypassCount(), 1);
});
