// lib/reddit-crawlee.js — Crawlee-backed Reddit fetchers (Firecrawl fallback).
//
// Used by lib/reddit-scraper.js whenever Firecrawl is unconfigured or errors
// (e.g. insufficient credits). Returns the EXACT same shapes as the Firecrawl
// JSON-extraction path so the scraper's downstream logic is identical:
//   fetchSubredditListingCrawlee(sub) → [{ title, url, comment_count }]
//   fetchThreadCrawlee(url)           → { title, selftext, top_comments[] }
//
// old.reddit.com is server-rendered with a DOM structure that has been
// stable for a decade — CheerioCrawler (no browser) parses it directly.
// got-scraping's browser-like TLS/header fingerprints get past Reddit's
// datacenter-IP blocking far more reliably than a naked fetch.
//
// The parse functions are pure (take a cheerio root) so tests run on HTML
// fixtures with no network.

'use strict';

const { CheerioCrawler, Configuration } = require('crawlee');

const MAX_COMMENTS = 8; // mirror reddit-scraper's bullet cap

// ── Pure parsers ──────────────────────────────────────────────────────────

/**
 * Parse a subreddit /top listing page.
 * @param {*} $  cheerio root of the listing HTML
 * @returns {Array<{title: string, url: string, comment_count: number}>}
 */
function parseListing($) {
  const threads = [];
  $('#siteTable .thing').each((_, el) => {
    const $el = $(el);
    if ($el.hasClass('promoted')) return; // skip ads
    const permalink = $el.attr('data-permalink');
    const title = $el.find('a.title').first().text().trim();
    if (!permalink || !title) return;
    const commentCount = Number($el.attr('data-comments-count'));
    threads.push({
      title,
      url: `https://www.reddit.com${permalink}`,
      comment_count: Number.isFinite(commentCount) ? commentCount : 0,
    });
  });
  return threads;
}

/**
 * Parse a thread (comments) page.
 * @param {*} $  cheerio root of the thread HTML
 * @returns {{title: string, selftext: string, top_comments: string[]}|null}
 */
function parseThread($) {
  const $post = $('#siteTable .thing').first();
  const title = $post.find('a.title').first().text().trim()
    || $('title').text().replace(/ : [^:]+$/, '').trim();
  if (!title) return null;

  const selftext = $post.find('.expando .usertext-body .md').first().text().trim();

  // Top-level comments only (direct children of the comment area's listing),
  // in page order — old.reddit sorts by best by default.
  const top_comments = [];
  $('.commentarea > .sitetable > .thing.comment').each((_, el) => {
    if (top_comments.length >= MAX_COMMENTS) return;
    const text = $(el).find('> .entry .usertext-body .md').first().text().trim();
    if (text) top_comments.push(text);
  });

  return { title, selftext, top_comments };
}

// ── Crawlee fetch ─────────────────────────────────────────────────────────

/**
 * Fetch one URL with CheerioCrawler and return its cheerio root.
 * One short-lived crawler per call — volume is ~36 pages/day, so the
 * spin-up cost is irrelevant and state never leaks between calls.
 * Storage persistence is disabled (no ./storage writes on Railway).
 */
async function crawleeGet(url) {
  let captured = null;
  let failure = null;

  const crawler = new CheerioCrawler({
    maxRequestsPerCrawl: 1,
    maxRequestRetries: 2,
    requestHandlerTimeoutSecs: 45,
    async requestHandler({ $ }) {
      captured = $;
    },
    failedRequestHandler({ request }, err) {
      failure = err || new Error(`request failed: ${request.url}`);
    },
  }, new Configuration({ persistStorage: false }));

  await crawler.run([url]);

  if (!captured) {
    throw new Error(`crawlee fetch failed for ${url}: ${failure ? failure.message : 'no response captured'}`);
  }
  return captured;
}

// ── Public fetchers (Firecrawl-shape compatible) ─────────────────────────

async function fetchSubredditListingCrawlee(sub, { window = 'week' } = {}) {
  const $ = await crawleeGet(`https://old.reddit.com/r/${sub}/top/?t=${window}`);
  return parseListing($);
}

async function fetchThreadCrawlee(threadUrl) {
  const fetchUrl = threadUrl.replace('https://www.reddit.com', 'https://old.reddit.com');
  const $ = await crawleeGet(fetchUrl);
  return parseThread($);
}

module.exports = {
  fetchSubredditListingCrawlee,
  fetchThreadCrawlee,
  parseListing,
  parseThread,
};
