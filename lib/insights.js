require('dotenv').config();
const { supabase } = require('./supabase');

// Per-brand Facebook credentials
const FB_PAGES = {
  auctionbrain: { id: process.env.FB_PAGE_ID, token: process.env.FB_PAGE_ACCESS_TOKEN },
  bridgematch: { id: process.env.FB_BRIDGEMATCH_PAGE_ID, token: process.env.FB_BRIDGEMATCH_PAGE_TOKEN }
};

function getToken(brand) {
  const page = FB_PAGES[brand] || FB_PAGES.auctionbrain;
  return page?.token || null;
}

// Fetch insights for a single Facebook post.
// Note: Facebook deprecated `post_impressions` and `post_engaged_users` (entire-API removal,
// not just renamed — no replacement). The remaining valid post-level metrics are:
//   post_impressions_unique         → reach (unique users who saw the post)
//   post_clicks                     → all clicks on the post
//   post_video_views                → video plays (was on /video_insights sub-edge in old code)
//   post_video_avg_time_watched     → avg watch ms (we convert to seconds)
//   post_reactions_by_type_total    → {like:N, love:N, ...}; we sum for engagements
async function fetchPostInsights(fbPostId, token) {
  const metrics = [
    'post_impressions_unique',
    'post_clicks',
    'post_video_views',
    'post_video_avg_time_watched',
    'post_reactions_by_type_total'
  ].join(',');
  const url = `https://graph.facebook.com/v22.0/${fbPostId}/insights?metric=${metrics}&access_token=${token}`;

  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Insights fetch failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const { data } = await res.json();
  const values = {};
  for (const metric of data || []) {
    const val = metric.values?.[0]?.value ?? 0;
    values[metric.name] = val;
  }

  const reactionMap = values.post_reactions_by_type_total || {};
  const engagements = typeof reactionMap === 'object' && !Array.isArray(reactionMap)
    ? Object.values(reactionMap).reduce((sum, n) => sum + (Number(n) || 0), 0)
    : 0;

  const avgWatchMs = values.post_video_avg_time_watched || 0;

  return {
    impressions: 0,
    reach: values.post_impressions_unique || 0,
    engagements,
    clicks: values.post_clicks || 0,
    video_views: values.post_video_views || 0,
    video_avg_watch_seconds: Math.round(avgWatchMs / 1000)
  };
}

async function collectInsights() {
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: posts, error } = await supabase
    .from('posts')
    .select('id, brand, fb_post_id')
    .eq('status', 'published')
    .not('fb_post_id', 'is', null)
    .gte('published_at', since);

  if (error) throw new Error(`Fetch posts for insights failed: ${error.message}`);
  if (!posts?.length) return { fetched: 0 };

  let fetched = 0;
  for (const post of posts) {
    const token = getToken(post.brand);
    if (!token) continue;

    try {
      const metrics = await fetchPostInsights(post.fb_post_id, token);
      const today = new Date().toISOString().split('T')[0];
      await supabase.from('post_metrics').upsert({
        post_id: post.id,
        ...metrics,
        fetched_at: today
      }, { onConflict: 'post_id,fetched_at' });
      fetched++;
    } catch (err) {
      console.error(`[Insights] Error for post ${post.id}: ${err.message}`);
    }
  }

  return { fetched, total: posts.length };
}

async function getTopPerformingPosts(brand, limit = 5) {
  const { data, error } = await supabase
    .from('post_metrics')
    .select(`
      reach, impressions, engagements, clicks, video_views,
      posts!inner(id, brand, copy_headline, copy_body, copy_cta, template_type)
    `)
    .eq('posts.brand', brand)
    .order('engagements', { ascending: false })
    .limit(limit);

  if (error) throw new Error(`Get top posts failed: ${error.message}`);
  return (data || []).map(m => ({
    ...m.posts,
    reach: m.reach,
    engagements: m.engagements,
    clicks: m.clicks,
    video_views: m.video_views
  }));
}

module.exports = { collectInsights, getTopPerformingPosts, fetchPostInsights };
