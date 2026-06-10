// lib/reddit-scraper.js — Firecrawl-backed Reddit scraper.
//
// Scrapes top weekly threads from property/broker/bridging/solicitor
// subreddits and inserts them into the BM project's scraped_articles table
// following the EXACT conventions lib/reddit-briefs.js reads:
//   - title prefix:  "[Reddit r/<sub>] <thread title>"   (extractSubreddit regex)
//   - content:       selftext + "• <comment>" bullet lines (scoreThread's
//                     comment-count proxy counts /^•\s/gm lines)
//   - url:           canonical www.reddit.com thread URL  (%reddit.com% filter
//                     + dedup key in promoteRedditThreadsToBriefs)
//
// After inserting, it calls promoteRedditThreadsToBriefs() so high-value
// threads land in content_briefs immediately (promotion is idempotent —
// the existing 06:30 promotion cron staying in place is harmless).

require('dotenv').config();
const { firecrawlScrape, isFirecrawlConfigured } = require('./firecrawl');
const { supabaseBridgematch } = require('./supabase');
const { getRedditSubreddits } = require('./runtime-config');

const DEFAULT_SUBREDDITS = [
  'PropertyInvestingUK',
  'HousingUK',
  'UKProperty',
  'Mortgageadviceuk',
  'bridging',
  'LegalAdviceUK',
];

const MAX_THREADS_PER_SUB = 5;   // per run
const LISTING_WINDOW = 'week';   // old.reddit.com/r/<sub>/top/?t=week
const MAX_COMMENTS = 8;          // bullet lines per article (engagement proxy)

// JSON-extraction schemas for Firecrawl. old.reddit.com is server-rendered —
// stable for extraction, no JS render cost.
const LISTING_SCHEMA = {
  type: 'object',
  properties: {
    threads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          url: { type: 'string', description: 'full permalink to the thread comments page' },
          comment_count: { type: 'number' },
        },
        required: ['title', 'url'],
      },
    },
  },
  required: ['threads'],
};

const THREAD_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    selftext: { type: 'string', description: 'the original post body text, empty string if link-only' },
    top_comments: {
      type: 'array',
      items: { type: 'string' },
      description: `up to ${MAX_COMMENTS} of the highest-voted top-level comments, text only`,
    },
  },
  required: ['title'],
};

/**
 * Canonicalise any reddit thread URL to https://www.reddit.com/r/<sub>/comments/<id>/
 * (strip query strings, old.→www., trailing junk) so dedup keys are stable.
 * Returns null when the URL isn't a thread permalink.
 */
function canonicalThreadUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/reddit\.com(\/r\/[^/]+\/comments\/[a-z0-9]+)/i);
  if (!m) return null;
  return `https://www.reddit.com${m[1]}/`;
}

/**
 * PURE — build a scraped_articles row from a fetched thread, matching
 * reddit-briefs.js conventions exactly.
 */
function buildArticleRow(sub, thread) {
  const comments = (thread.top_comments || [])
    .filter(c => typeof c === 'string' && c.trim())
    .slice(0, MAX_COMMENTS)
    .map(c => `• ${c.trim().slice(0, 280)}`);

  const selftext = (thread.selftext || '').trim().slice(0, 1200);
  const content = [selftext, comments.join('\n')].filter(Boolean).join('\n\n');

  return {
    url: thread.url,
    title: `[Reddit r/${sub}] ${(thread.title || '').trim()}`,
    content,
    scraped_at: new Date().toISOString(),
  };
}

// ── Fetchers — Firecrawl primary, Crawlee fallback ────────────────────────
// Firecrawl is the house scraping mechanism, but when it's unconfigured or
// errors (e.g. insufficient credits until a monthly refresh), fall back to
// Crawlee CheerioCrawler parsing of server-rendered old.reddit.com
// (lib/reddit-crawlee.js — same return shapes). Resumes Firecrawl
// automatically once it works again; no flag flip needed.

async function _firecrawlListing(sub) {
  const data = await firecrawlScrape(
    `https://old.reddit.com/r/${sub}/top/?t=${LISTING_WINDOW}`,
    {
      formats: [{
        type: 'json',
        schema: LISTING_SCHEMA,
        prompt: 'Extract the list of threads on this subreddit listing page: title, full permalink URL to the comments page, and comment count.',
      }],
    }
  );
  return (data.json && data.json.threads) || [];
}

async function _firecrawlThread(fetchUrl) {
  const data = await firecrawlScrape(fetchUrl, {
    formats: [{
      type: 'json',
      schema: THREAD_SCHEMA,
      prompt: `Extract this Reddit thread: the post title, the original post body text (selftext), and up to ${MAX_COMMENTS} of the highest-voted top-level comments (text only, no usernames).`,
    }],
  });
  return data.json || null;
}

async function fetchSubredditListing(sub) {
  let threads;
  if (isFirecrawlConfigured()) {
    try {
      threads = await _firecrawlListing(sub);
    } catch (err) {
      console.warn(`[reddit-scraper] Firecrawl listing failed for r/${sub} (${err.message.slice(0, 120)}) — falling back to Crawlee`);
    }
  }
  if (!threads) {
    const { fetchSubredditListingCrawlee } = require('./reddit-crawlee');
    threads = await fetchSubredditListingCrawlee(sub, { window: LISTING_WINDOW });
  }
  return threads
    .map(t => ({ ...t, url: canonicalThreadUrl(t.url) }))
    .filter(t => t.url && t.title)
    .slice(0, MAX_THREADS_PER_SUB);
}

async function fetchThread(threadUrl) {
  // old.reddit renders comments server-side — swap www. for old. for the fetch
  const fetchUrl = threadUrl.replace('https://www.reddit.com', 'https://old.reddit.com');
  if (isFirecrawlConfigured()) {
    try {
      return await _firecrawlThread(fetchUrl);
    } catch (err) {
      console.warn(`[reddit-scraper] Firecrawl thread failed for ${threadUrl} (${err.message.slice(0, 120)}) — falling back to Crawlee`);
    }
  }
  const { fetchThreadCrawlee } = require('./reddit-crawlee');
  return fetchThreadCrawlee(threadUrl);
}

/**
 * Orchestrator. Per-sub and per-thread failures are isolated — one banned
 * or private sub never sinks the run.
 * @returns {{ subs:number, listed:number, fetched:number, inserted:number,
 *             skipped:number, promoted:number, errors:string[], reason?:string }}
 */
async function runRedditScrape() {
  const result = { subs: 0, listed: 0, fetched: 0, inserted: 0, skipped: 0, promoted: 0, errors: [] };

  if (!supabaseBridgematch) {
    console.log('[reddit-scraper] BM Supabase not configured — skipping');
    return { ...result, reason: 'no_bm_client' };
  }
  // No Firecrawl guard — fetchers fall back to Crawlee when Firecrawl is
  // unconfigured or failing (e.g. out of credits), so the run proceeds.
  if (!isFirecrawlConfigured()) {
    console.log('[reddit-scraper] FIRECRAWL_API_KEY not set — using Crawlee for this run');
  }

  const subs = (await getRedditSubreddits().catch(() => null)) || DEFAULT_SUBREDDITS;
  result.subs = subs.length;

  // 1. Gather listings across all subs (per-sub failure isolation)
  const candidates = [];
  for (const sub of subs) {
    try {
      const threads = await fetchSubredditListing(sub);
      result.listed += threads.length;
      for (const t of threads) candidates.push({ sub, ...t });
    } catch (err) {
      result.errors.push(`listing r/${sub}: ${err.message}`);
      console.warn(`[reddit-scraper] listing failed for r/${sub}: ${err.message}`);
    }
  }
  if (!candidates.length) return { ...result, reason: 'no_threads' };

  // 2. One batched dedup query against existing scraped_articles
  let existingUrls = new Set();
  try {
    const { data, error } = await supabaseBridgematch
      .from('scraped_articles')
      .select('url')
      .in('url', candidates.map(c => c.url));
    if (error) throw new Error(error.message);
    existingUrls = new Set((data || []).map(r => r.url));
  } catch (err) {
    result.errors.push(`dedup query: ${err.message}`);
    console.warn(`[reddit-scraper] dedup query failed (treating all as new): ${err.message}`);
  }

  // 3. Fetch + insert new threads (per-thread failure isolation)
  for (const cand of candidates) {
    if (existingUrls.has(cand.url)) { result.skipped++; continue; }
    try {
      const thread = await fetchThread(cand.url);
      if (!thread || !thread.title) { result.errors.push(`thread ${cand.url}: empty extraction`); continue; }
      result.fetched++;

      const row = buildArticleRow(cand.sub, { ...thread, url: cand.url });
      const { error } = await supabaseBridgematch.from('scraped_articles').insert(row);
      if (error) throw new Error(error.message);
      result.inserted++;
      console.log(`[reddit-scraper] +article (r/${cand.sub}): "${thread.title.slice(0, 60)}"`);
    } catch (err) {
      result.errors.push(`thread ${cand.url}: ${err.message}`);
      console.warn(`[reddit-scraper] thread failed ${cand.url}: ${err.message}`);
    }
  }

  // 4. Promote — idempotent (URL-ILIKE dedup against content_briefs)
  if (result.inserted > 0) {
    try {
      const { promoteRedditThreadsToBriefs } = require('./reddit-briefs');
      const promo = await promoteRedditThreadsToBriefs();
      result.promoted = promo.promoted || 0;
    } catch (err) {
      result.errors.push(`promotion: ${err.message}`);
      console.warn(`[reddit-scraper] promotion failed: ${err.message}`);
    }
  }

  console.log(`[reddit-scraper] done: ${JSON.stringify(result)}`);
  return result;
}

module.exports = {
  runRedditScrape,
  buildArticleRow,
  canonicalThreadUrl,
  DEFAULT_SUBREDDITS,
};
