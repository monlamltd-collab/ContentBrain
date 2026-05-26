'use strict';

// ── PHASE E — Closed loop: template performance roll-up ───────────────────
//
// Aggregates "what's working" signals across the last N days and surfaces
// them in the social-side system prompt (lib/generate.js#getSystemPrompt).
// This is the content-side counterpart to lib/closed-loop/funded-deals.js
// (outbound-side) — both feed the LLM with what to lean into.
//
// Reads from `posts` + `post_metrics` + `replies` (existing tables — no
// new migration). Aggregation happens client-side because Supabase JS
// doesn't expose GROUP BY directly; the dataset (last-30-days of
// published posts for one brand) is small (~hundreds of rows max) so a
// client-side roll-up is cheap and lets us join in replies + metrics
// without a stored procedure.
//
// Noise floor: groups with fewer than 5 published posts are NOT returned
// — below that threshold the signal is too thin to bias generation on.

const { supabase } = require('../supabase');

const MIN_POSTS_FOR_SIGNAL = 5;

/**
 * Per-template performance roll-up over the last `days` days for one brand.
 *
 * @param {'auctionbrain'|'bridgematch'} brand
 * @param {number} [days=30]
 * @returns {Promise<Array<{
 *   template_type: string,
 *   posts_published: number,
 *   total_engagement: number,
 *   replies: number,
 *   reply_rate: number,
 *   top_subject: string | null,
 *   top_cta_pattern: string | null,
 * }>>}  Empty array on error, no data, or all groups below the noise
 *       floor. Sorted DESC by reply_rate so the caller can show the
 *       best-performing template_type first.
 */
async function getTemplatePerformance(brand, days = 30) {
  if (!brand) return [];
  const safeDays = Math.max(1, Number(days) || 30);
  const since = new Date(Date.now() - safeDays * 24 * 60 * 60 * 1000).toISOString();

  try {
    // 1. Pull published posts in window — embed post_metrics so we get
    //    engagements/clicks without a second round-trip. Supabase JS
    //    returns post_metrics as an array (one-to-many in schema; in
    //    practice one row per post per fetch-day).
    const { data: posts, error: pErr } = await supabase
      .from('posts')
      .select('id, brand, track, template_type, copy_headline, meta, status, published_at, post_metrics(engagements, clicks, reach)')
      .eq('brand', brand)
      .eq('status', 'published')
      .gte('published_at', since);
    if (pErr) {
      console.warn(`[closed-loop/template-performance] posts query failed: ${pErr.message}`);
      return [];
    }
    if (!posts || !posts.length) return [];

    // 2. Group by template_type. Posts with no template_type are bucketed
    //    under '(none)' so they don't silently inflate every group.
    const groups = new Map();
    for (const post of posts) {
      const key = post.template_type || '(none)';
      if (!groups.has(key)) {
        groups.set(key, { posts: [], contactIds: new Set() });
      }
      const g = groups.get(key);
      g.posts.push(post);
      const cid = post.meta && post.meta.contact_id;
      if (cid) g.contactIds.add(cid);
    }

    // 3. For outbound groups (or any group with contact_ids), count
    //    replies. Same pattern as lib/dashboard/performance-queries.js —
    //    Supabase JS has no server-side join here so we batch one IN()
    //    query per group with non-empty contact_ids.
    const replyCounts = new Map(); // template_type -> reply count
    for (const [key, g] of groups.entries()) {
      if (!g.contactIds.size) {
        replyCounts.set(key, 0);
        continue;
      }
      const { count, error: rErr } = await supabase
        .from('replies')
        .select('id', { count: 'exact', head: true })
        .in('contact_id', Array.from(g.contactIds));
      if (rErr) {
        console.warn(`[closed-loop/template-performance] replies count for '${key}' failed: ${rErr.message}`);
        replyCounts.set(key, 0);
        continue;
      }
      replyCounts.set(key, count || 0);
    }

    // 4. Roll each group up into the documented shape.
    const out = [];
    for (const [template_type, g] of groups.entries()) {
      const posts_published = g.posts.length;
      if (posts_published < MIN_POSTS_FOR_SIGNAL) continue;

      let total_engagement = 0;
      let total_clicks = 0;
      let topPost = null;
      let topEng = -1;
      for (const post of g.posts) {
        const metricsArr = Array.isArray(post.post_metrics) ? post.post_metrics : [];
        // Multiple metric rows per post (one per fetched day) — take the
        // max engagement as the post's score, sum clicks for CTR signal.
        let postEng = 0;
        for (const m of metricsArr) {
          if ((m.engagements || 0) > postEng) postEng = m.engagements || 0;
          total_clicks += m.clicks || 0;
        }
        total_engagement += postEng;
        if (postEng > topEng) {
          topEng = postEng;
          topPost = post;
        }
      }

      const replies = replyCounts.get(template_type) || 0;
      // For outbound (has contact_ids) use replies/sent semantics; for
      // social (no contact_ids) fall back to engagement/post as the
      // proxy reply-rate so the sort is meaningful across mixed groups.
      const isOutboundGroup = g.contactIds.size > 0;
      const reply_rate = isOutboundGroup
        ? (posts_published > 0 ? Math.min(replies / posts_published, 1) : 0)
        : (posts_published > 0 ? total_engagement / posts_published : 0);

      // top_cta_pattern: most-frequent cta_pattern among the top 3 posts
      // by post-level engagement. Null when no metrics or no cta_pattern.
      const topCta = pickTopCtaPattern(g.posts);

      out.push({
        template_type,
        posts_published,
        total_engagement,
        replies,
        reply_rate,
        top_subject: topPost ? (topPost.copy_headline || null) : null,
        top_cta_pattern: topCta,
      });
    }

    // 5. Sort DESC by reply_rate (best performers first).
    out.sort((a, b) => b.reply_rate - a.reply_rate);
    return out;
  } catch (err) {
    console.warn(`[closed-loop/template-performance] threw: ${err.message}`);
    return [];
  }
}

/**
 * Find the most-frequent cta_pattern among the top 3 posts in the group,
 * ranked by per-post engagement. Returns null when there's no signal.
 */
function pickTopCtaPattern(posts) {
  const ranked = posts
    .map(p => {
      const arr = Array.isArray(p.post_metrics) ? p.post_metrics : [];
      const eng = arr.reduce((max, m) => Math.max(max, m.engagements || 0), 0);
      const cta = (p.meta && p.meta.cta_pattern) || null;
      return { eng, cta };
    })
    .filter(r => r.cta)
    .sort((a, b) => b.eng - a.eng)
    .slice(0, 3);
  if (!ranked.length) return null;
  const counts = new Map();
  for (const r of ranked) counts.set(r.cta, (counts.get(r.cta) || 0) + 1);
  let best = null;
  let bestCount = 0;
  for (const [cta, c] of counts.entries()) {
    if (c > bestCount) { best = cta; bestCount = c; }
  }
  return best;
}

module.exports = { getTemplatePerformance };
