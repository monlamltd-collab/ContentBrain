// lib/fetch-html.js — shared "Crawlee-first, Firecrawl-bypass" HTML fetcher.
//
// House scraping policy (mirrors AuctionBrain's FIRECRAWL_CF_BYPASS_ONLY):
//   1. Crawlee CheerioCrawler is the default fetcher (free, got-scraping TLS
//      fingerprints get past most sites).
//   2. ONLY when Crawlee is blocked (403 / timeout) do we fall back to
//      Firecrawl's `enhanced` residential proxy (5 credits/page) to punch
//      through the anti-bot wall — used sparingly against a ~1000 credit/month
//      budget shared with AuctionBrain.
//
// A per-run bypass counter caps Firecrawl spend; callers reset it at the start
// of a run (resetBypassBudget()). Consumers: lib/reddit-crawlee.js (subreddit
// pages) and lib/sales-brain/import-brokers.js (broker-site contact discovery).

'use strict';

const cheerio = require('cheerio');

const DEFAULT_MAX_BYPASS = 12; // Firecrawl bypass calls per run (env-tunable)

let bypassCount = 0;

/** Reset the per-run Firecrawl bypass counter. Call at the start of each run. */
function resetBypassBudget() { bypassCount = 0; }

/** Firecrawl bypass calls made since the last reset. */
function getBypassCount() { return bypassCount; }

function bypassEnabled() {
  return (process.env.FIRECRAWL_BYPASS_ENABLED || 'true') !== 'false';
}

function maxBypassPerRun() {
  const n = parseInt(process.env.FIRECRAWL_BYPASS_MAX_PER_RUN, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_MAX_BYPASS;
}

// ── Low-level fetchers (lazy requires so tests can inject mocks) ───────────

async function _crawleeFetchHtml(url, { timeoutSecs, maxRetries }) {
  const { CheerioCrawler, Configuration } = require('crawlee');

  let html = null;
  let failure = null;

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 1,
    maxRequestRetries: maxRetries,
    requestHandlerTimeoutSecs: timeoutSecs,
    async requestHandler({ body }) {
      html = typeof body === 'string' ? body : (body ? body.toString('utf8') : '');
    },
    failedRequestHandler({ request }, err) {
      failure = err || new Error(`request failed: ${request.url}`);
    },
  }, new Configuration({ persistStorage: false }));

  await crawler.run([url]);

  if (html == null) {
    throw new Error(`crawlee fetch failed for ${url}: ${failure ? failure.message : 'no response captured'}`);
  }
  return html;
}

async function _firecrawlFetchHtml(url, { proxy }) {
  const { firecrawlScrape } = require('./firecrawl');
  const data = await firecrawlScrape(url, { formats: ['rawHtml'], proxy, timeoutMs: 60000 });
  const html = (data && (data.rawHtml || data.html)) || '';
  if (!html) throw new Error(`firecrawl bypass returned no HTML for ${url}`);
  return html;
}

/**
 * Fetch a page's HTML, Crawlee-first with a gated Firecrawl-enhanced bypass.
 *
 * @param {string} url
 * @param {object} [opts]
 * @param {string}  [opts.proxy='enhanced']   Firecrawl proxy tier for the bypass.
 * @param {boolean} [opts.allowBypass=true]   Permit the Firecrawl fallback.
 * @param {number}  [opts.timeoutSecs=20]     Crawlee per-request timeout.
 * @param {number}  [opts.maxRetries=1]       Crawlee retries before failing over.
 * @returns {Promise<{ $: object, html: string, via: 'crawlee'|'firecrawl' }>}
 */
async function fetchHtml(url, { proxy = 'enhanced', allowBypass = true, timeoutSecs = 20, maxRetries = 1 } = {}) {
  try {
    const html = await _crawleeFetchHtml(url, { timeoutSecs, maxRetries });
    return { $: cheerio.load(html), html, via: 'crawlee' };
  } catch (crawleeErr) {
    const { isFirecrawlConfigured } = require('./firecrawl');
    if (!allowBypass || !bypassEnabled() || !isFirecrawlConfigured()) throw crawleeErr;
    if (bypassCount >= maxBypassPerRun()) {
      throw new Error(
        `crawlee blocked for ${url} and Firecrawl bypass budget (${maxBypassPerRun()}/run) exhausted: ${crawleeErr.message}`,
      );
    }
    bypassCount++;
    const html = await _firecrawlFetchHtml(url, { proxy });
    return { $: cheerio.load(html), html, via: 'firecrawl' };
  }
}

module.exports = { fetchHtml, resetBypassBudget, getBypassCount };
