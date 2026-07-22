// Reddit's public Atom feeds remain available when datacentre requests to
// HTML/JSON are blocked. This is deliberately dependency-light and uses the
// same cheerio parser already shipped by ContentBrain.
const cheerio = require('cheerio');

const USER_AGENT = process.env.REDDIT_USER_AGENT
  || 'web:contentbrain:v1.0 (by /u/contentbrain)';
const MIN_REQUEST_GAP_MS = 1200;
let nextRequestAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanText(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  return $.root().text().replace(/\s+/g, ' ').trim();
}

// Reddit wraps the actual post/comment body in .md and appends attribution,
// voting and link boilerplate outside it. Returning only .md prevents link
// posts from masquerading as useful self-post content.
function cleanEntryContent(html) {
  if (!html) return '';
  const $ = cheerio.load(html);
  const body = $('.md').first();
  return body.length ? body.text().replace(/\s+/g, ' ').trim() : '';
}

function parseFeed(xml) {
  return cheerio.load(xml, { xmlMode: true });
}

function parseListingRss(xml) {
  const $ = parseFeed(xml);
  const rows = [];
  $('entry').each((_, entry) => {
    const node = $(entry);
    const url = node.find('link').first().attr('href') || '';
    if (!/\/comments\/[^/]+\//.test(url)) return;
    rows.push({
      title: node.find('title').first().text().trim(),
      url,
      comment_count: 0,
      selftext: cleanEntryContent(node.find('content').first().text()),
    });
  });
  return rows;
}

function parseThreadRss(xml) {
  const $ = parseFeed(xml);
  const entries = $('entry').toArray();
  if (!entries.length) return { title: '', selftext: '', top_comments: [] };

  const first = $(entries[0]);
  const comments = entries.slice(1).map(entry => {
    const node = $(entry);
    const author = node.find('author name').first().text().trim().toLowerCase();
    if (author.includes('automoderator')) return '';
    return cleanEntryContent(node.find('content').first().text());
  }).filter(Boolean).slice(0, 10);

  return {
    title: first.find('title').first().text().trim(),
    selftext: cleanEntryContent(first.find('content').first().text()),
    top_comments: comments,
  };
}

async function fetchRss(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    const wait = Math.max(0, nextRequestAt - Date.now());
    if (wait) await sleep(wait);
    nextRequestAt = Date.now() + MIN_REQUEST_GAP_MS;

    // Alternate hosts on retry. Reddit occasionally rate-limits one edge
    // hostname while the other remains available.
    const requestUrl = attempt % 2
      ? url.replace('://www.reddit.com', '://old.reddit.com')
      : url;
    let res;
    try {
      res = await fetch(requestUrl, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'application/atom+xml, application/xml;q=0.9, text/xml;q=0.8',
        },
        signal: AbortSignal.timeout(15000),
      });
    } catch (err) {
      lastError = new Error(`Reddit RSS request failed for ${requestUrl}: ${err.message}`);
      if (attempt < 2) await sleep(1500 * (attempt + 1));
      continue;
    }
    if (res.ok) return res.text();

    lastError = new Error(`Reddit RSS ${res.status} for ${requestUrl}`);
    lastError.status = res.status;
    // A 403 can be an edge/datacentre block rather than a private subreddit,
    // so always try the alternate Reddit hostname before classifying it.
    if (res.status !== 403 && res.status !== 429 && res.status < 500) break;
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 10000)
      : 1500 * (attempt + 1));
  }
  throw lastError;
}

async function fetchSubredditRss(subreddit, limit = 10) {
  const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/top/.rss?t=week`;
  return parseListingRss(await fetchRss(url)).slice(0, limit);
}

async function fetchThreadRss(threadUrl) {
  const canonical = String(threadUrl).replace(/[?#].*$/, '').replace(/\/$/, '');
  return parseThreadRss(await fetchRss(`${canonical}/.rss`));
}

module.exports = {
  cleanText,
  cleanEntryContent,
  parseListingRss,
  parseThreadRss,
  fetchRss,
  fetchSubredditRss,
  fetchThreadRss,
};
