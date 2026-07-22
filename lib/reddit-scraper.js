// lib/reddit-scraper.js — Reddit scraper: OAuth API first, Crawlee + Firecrawl-bypass fallback.
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
const { isRedditApiConfigured, fetchSubredditListingApi, fetchThreadApi } = require('./reddit-api');
const { fetchSubredditListingCrawlee, fetchThreadCrawlee } = require('./reddit-crawlee');
const { fetchSubredditRss, fetchThreadRss } = require('./reddit-rss');
const { resetBypassBudget } = require('./fetch-html');
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

// ── Fetchers — OAuth first, public Atom RSS second, browser fallback last ──
// When REDDIT_CLIENT_ID/SECRET are set the official OAuth JSON API is used
// (free, 100% recall, not IP-blocked from Railway). Otherwise — or if an API
// call fails — fall back to Crawlee-first scraping with the Firecrawl-enhanced
// bypass for 403-blocked pages (lib/fetch-html, budget-capped).

async function fetchSubredditListing(sub) {
  let threads;
  let provider;
  if (isRedditApiConfigured()) {
    try {
      threads = await fetchSubredditListingApi(sub, { window: LISTING_WINDOW });
      provider = 'oauth';
    } catch (err) {
      console.warn(`[reddit-scraper] Reddit API listing failed for r/${sub} (${err.message.slice(0, 120)}) — trying RSS`);
    }
  }
  if (!Array.isArray(threads)) {
    try {
      threads = await fetchSubredditRss(sub, MAX_THREADS_PER_SUB);
      provider = 'rss';
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        // Private/banned/unsupported communities should be a clean skip, not
        // a Firecrawl call that is guaranteed to return its own Reddit 403.
        console.warn(`[reddit-scraper] Reddit RSS unavailable for r/${sub} (${err.status}) — skipping subreddit`);
        threads = [];
        provider = 'rss';
      } else {
        console.warn(`[reddit-scraper] Reddit RSS listing failed for r/${sub} (${err.message.slice(0, 120)}) — trying browser fallback`);
      }
    }
  }
  if (!Array.isArray(threads)) {
    threads = await fetchSubredditListingCrawlee(sub, { window: LISTING_WINDOW });
    provider = 'crawlee';
  }
  if (!Array.isArray(threads)) throw new Error('listing provider returned a non-array response');
  const cleaned = threads
    .map(t => ({ ...t, url: canonicalThreadUrl(t.url), _listingProvider: provider }))
    .filter(t => t.url && t.title)
    .slice(0, MAX_THREADS_PER_SUB);
  Object.defineProperty(cleaned, 'provider', { value: provider, enumerable: false });
  return cleaned;
}

async function fetchThread(threadUrl, listingFallback = null) {
  let apiError = null;
  let rssError = null;
  if (isRedditApiConfigured()) {
    try {
      const thread = await fetchThreadApi(threadUrl);
      if (!thread || !thread.title) {
        throw new Error('Reddit API returned an empty thread extraction');
      }
      Object.defineProperty(thread, 'provider', { value: 'oauth', enumerable: false });
      return thread;
    } catch (err) {
      apiError = err;
      console.warn(`[reddit-scraper] Reddit API thread failed for ${threadUrl} (${err.message.slice(0, 120)}) — trying RSS`);
    }
  }
  // The Atom listing already contains the full self-post body. Prefer it to
  // another anonymous Reddit request: this keeps the no-OAuth path to one
  // request per subreddit and avoids Reddit's burst rate limits. OAuth users
  // still receive comments through the richer API path above.
  if (listingFallback?.selftext) {
    const thread = {
      title: listingFallback.title,
      selftext: listingFallback.selftext,
      top_comments: [],
    };
    Object.defineProperty(thread, 'provider', { value: listingFallback._listingProvider || 'rss', enumerable: false });
    return thread;
  }
  try {
    const thread = await fetchThreadRss(threadUrl);
    if (!thread || !thread.title || (!thread.selftext && !thread.top_comments?.length)) {
      throw new Error('Reddit RSS returned an empty thread extraction');
    }
    Object.defineProperty(thread, 'provider', { value: 'rss', enumerable: false });
    return thread;
  } catch (err) {
    rssError = err;
    console.warn(`[reddit-scraper] Reddit RSS thread failed for ${threadUrl} (${err.message.slice(0, 120)}) — trying browser fallback`);
  }
  // fetchThreadCrawlee swaps www.→old. internally (old.reddit renders SSR).
  try {
    const thread = await fetchThreadCrawlee(threadUrl);
    if (!thread || !thread.title) throw new Error('Crawlee returned an empty thread extraction');
    Object.defineProperty(thread, 'provider', { value: 'crawlee', enumerable: false });
    return thread;
  } catch (fallbackError) {
    if (apiError) {
      throw new Error(`Reddit API failed (${apiError.message}); RSS failed (${rssError.message}); browser fallback failed (${fallbackError.message})`);
    }
    throw new Error(`Reddit RSS failed (${rssError.message}); browser fallback failed (${fallbackError.message})`);
  }
}

/**
 * Orchestrator. Per-sub and per-thread failures are isolated — one banned
 * or private sub never sinks the run.
 * @returns {{ subs:number, listed:number, fetched:number, inserted:number,
 *             skipped:number, promoted:number, errors:string[], reason?:string }}
 */
async function runRedditScrape() {
  const usedProviders = new Set();
  const result = {
    source: 'none',
    subs: 0, listed: 0, fetched: 0, inserted: 0, skipped: 0, promoted: 0, errors: [],
  };

  if (!supabaseBridgematch) {
    console.log('[reddit-scraper] BM Supabase not configured — skipping');
    return { ...result, reason: 'no_bm_client' };
  }
  // Crawlee-first; reset the per-run Firecrawl bypass budget so a single run
  // can't blow the shared monthly credit cap (lib/fetch-html).
  resetBypassBudget();

  const subs = (await getRedditSubreddits().catch(() => null)) || DEFAULT_SUBREDDITS;
  result.subs = subs.length;

  // 1. Gather listings across all subs (per-sub failure isolation)
  const candidatesByUrl = new Map();
  for (const sub of subs) {
    try {
      const threads = await fetchSubredditListing(sub);
      if (threads.provider) usedProviders.add(threads.provider);
      result.listed += threads.length;
      for (const t of threads) {
        if (!candidatesByUrl.has(t.url)) candidatesByUrl.set(t.url, { sub, ...t });
      }
    } catch (err) {
      result.errors.push(`listing r/${sub}: ${err.message}`);
      console.warn(`[reddit-scraper] listing failed for r/${sub}: ${err.message}`);
    }
  }
  const candidates = [...candidatesByUrl.values()];
  if (!candidates.length) {
    result.source = usedProviders.size === 1 ? [...usedProviders][0] : (usedProviders.size ? 'mixed' : 'none');
    return { ...result, reason: 'no_threads' };
  }

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
      const thread = await fetchThread(cand.url, cand);
      if (thread.provider) usedProviders.add(thread.provider);
      result.fetched++;

      const row = buildArticleRow(cand.sub, { ...thread, url: cand.url });
      const { error } = await supabaseBridgematch.from('scraped_articles').insert(row);
      if (error) throw new Error(error.message);
      result.inserted++;
      existingUrls.add(cand.url);
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

  result.source = usedProviders.size === 1 ? [...usedProviders][0] : (usedProviders.size ? 'mixed' : 'none');
  console.log(`[reddit-scraper] done: ${JSON.stringify(result)}`);
  return result;
}

module.exports = {
  runRedditScrape,
  buildArticleRow,
  canonicalThreadUrl,
  DEFAULT_SUBREDDITS,
};
