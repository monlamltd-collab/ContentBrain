// lib/reddit-crawlee.js — Reddit fetchers (Crawlee-first via lib/fetch-html).
//
//   fetchSubredditListingCrawlee(sub) → [{ title, url, comment_count }]
//   fetchThreadCrawlee(url)           → { title, selftext, top_comments[] }
//
// Fetching is delegated to lib/fetch-html: Crawlee CheerioCrawler is primary,
// and Reddit's datacenter-IP 403 wall is punched through with Firecrawl's
// enhanced residential proxy ONLY when Crawlee is blocked (sparing, budgeted).
// old.reddit.com is server-rendered with a decade-stable DOM, so the returned
// HTML is parsed by the pure parsers below regardless of which fetcher served
// it. The parsers take a cheerio root, so tests run on HTML fixtures with no
// network.

'use strict';

const { fetchHtml } = require('./fetch-html');

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

// ── Public fetchers ───────────────────────────────────────────────────────
// Delegate the fetch to lib/fetch-html (Crawlee-first, Firecrawl bypass on
// block), then parse the returned cheerio root.

async function fetchSubredditListingCrawlee(sub, { window = 'week' } = {}) {
  const { $ } = await fetchHtml(`https://old.reddit.com/r/${sub}/top/?t=${window}`);
  return parseListing($);
}

async function fetchThreadCrawlee(threadUrl) {
  const fetchUrl = threadUrl.replace('https://www.reddit.com', 'https://old.reddit.com');
  const { $ } = await fetchHtml(fetchUrl);
  return parseThread($);
}

module.exports = {
  fetchSubredditListingCrawlee,
  fetchThreadCrawlee,
  parseListing,
  parseThread,
};
