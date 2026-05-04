const { supabase, supabaseBridgematch } = require('./supabase');

// Question-shaped openers — strongest editorial signal
const QUESTION_PREFIXES = /^(?:how|what|why|when|where|can|should|is|does|do|anyone|advice|help|need|recommend|seeking)\b/i;

/**
 * Score a scraped Reddit thread by editorial value. Higher = more useful
 * to answer with a blog post. Heuristic only — we don't store Reddit's
 * own score / comment_count in the DB, so we infer from saved content.
 */
function scoreThread(article) {
  const title = (article.title || '').replace(/^\[Reddit r\/[^\]]+\]\s*/, '').trim();
  const content = article.content || '';
  let score = 0;

  if (title.endsWith('?')) score += 5;
  if (QUESTION_PREFIXES.test(title)) score += 5;

  // Comment count — buildContent() in BM/lib/reddit.js writes top comments
  // as bullet lines starting with "• ". We use that as a comment-count proxy.
  const commentLines = (content.match(/^•\s/gm) || []).length;
  score += Math.min(commentLines, 10);

  if (content.length > 800) score += 2;
  if (content.length > 1500) score += 2;

  return { score, commentCount: commentLines, cleanTitle: title };
}

function extractSubreddit(article) {
  const m = (article.title || '').match(/^\[Reddit r\/([^\]]+)\]/);
  return m ? m[1] : 'unknown';
}

function inferBrand(subreddit) {
  // r/bridging is unambiguously BridgeMatch territory.
  // r/PropertyInvestingUK overlaps both — default to bridgematch since
  // that's where the Reddit reader currently runs. Manual editing in
  // the dashboard can flip this if the brief is more auction-flavoured.
  if (/^bridging$/i.test(subreddit)) return 'bridgematch';
  if (/^auction/i.test(subreddit)) return 'auctionbrain';
  return 'bridgematch';
}

/**
 * Find recent high-value Reddit threads and queue them as content_briefs.
 * Best-effort: returns a count of newly promoted briefs. Skips threads
 * whose URL is already referenced in any existing brief (dedup via
 * message ILIKE — no schema changes needed).
 */
async function promoteRedditThreadsToBriefs(opts = {}) {
  const daysBack = opts.daysBack || 7;
  const maxBriefs = opts.maxBriefs || 3;
  const minScore = opts.minScore || 8;

  if (!supabaseBridgematch) {
    console.log('[reddit-briefs] BM Supabase not configured — skipping');
    return { promoted: 0, evaluated: 0, reason: 'no_bm_client' };
  }

  const since = new Date(Date.now() - daysBack * 86400000).toISOString();
  const { data: threads, error } = await supabaseBridgematch
    .from('scraped_articles')
    .select('url, title, content, scraped_at')
    .like('url', '%reddit.com%')
    .gte('scraped_at', since)
    .order('scraped_at', { ascending: false })
    .limit(50);

  if (error) {
    console.warn('[reddit-briefs] Fetch from BM failed:', error.message);
    return { promoted: 0, evaluated: 0, reason: 'fetch_failed' };
  }
  if (!threads?.length) {
    return { promoted: 0, evaluated: 0, reason: 'no_threads' };
  }

  const ranked = threads
    .map(t => ({ ...t, ...scoreThread(t) }))
    .filter(t => t.score >= minScore)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) {
    return { promoted: 0, evaluated: threads.length, reason: 'all_below_threshold' };
  }

  let promoted = 0;

  for (const thread of ranked) {
    if (promoted >= maxBriefs) break;

    // Dedup — skip if any existing brief mentions this URL anywhere
    const { data: existing } = await supabase
      .from('content_briefs')
      .select('id')
      .ilike('message', `%${thread.url}%`)
      .limit(1);

    if (existing?.length) continue;

    const subreddit = extractSubreddit(thread);
    const brand = inferBrand(subreddit);

    const message = `Reddit thread on r/${subreddit} with ${thread.commentCount} top comments — investors are asking this exact question. Long-tail ranking opportunity if we answer it directly.

Source: ${thread.url}

Original title: ${thread.cleanTitle}

Excerpt + top comments:
${(thread.content || '').slice(0, 800)}`;

    const { error: insertErr } = await supabase
      .from('content_briefs')
      .insert({
        message,
        topic: thread.cleanTitle.slice(0, 200),
        brand,
        angle: 'Answer the Reddit question with broker expertise. Match what real investors are asking — write to rank for that long-tail query.',
        used: false
      });

    if (insertErr) {
      console.warn('[reddit-briefs] Insert failed:', insertErr.message);
      continue;
    }

    promoted++;
    console.log(`[reddit-briefs] +brief (${brand}, score ${thread.score}): "${thread.cleanTitle.slice(0, 60)}"`);
  }

  return { promoted, evaluated: threads.length, reason: 'ok' };
}

module.exports = { promoteRedditThreadsToBriefs, scoreThread };
