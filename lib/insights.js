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

// Fetch insights for a single Facebook post
async function fetchPostInsights(fbPostId, token) {
  const metrics = 'post_impressions,post_impressions_unique,post_engaged_users,post_clicks';
  const url = `https://graph.facebook.com/v22.0/${fbPostId}/insights?metric=${metrics}&access_token=${token}`;

  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Insights fetch failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const { data } = await res.json();
  const values = {};
  for (const metric of data || []) {
    const val = metric.values?.[0]?.value || 0;
    values[metric.name] = val;
  }

  return {
    impressions: values.post_impressions || 0,
    reach: values.post_impressions_unique || 0,
    engagements: values.post_engaged_users || 0,
    clicks: values.post_clicks || 0
  };
}

// Fetch video-specific insights
async function fetchVideoInsights(fbPostId, token) {
  const url = `https://graph.facebook.com/v22.0/${fbPostId}?fields=video_insights.metric(total_video_views,total_video_avg_time_watched)&access_token=${token}`;

  const res = await fetch(url);
  if (!res.ok) return { video_views: 0, video_avg_watch_seconds: 0 };

  const { video_insights } = await res.json();
  const values = {};
  for (const metric of video_insights?.data || []) {
    const val = metric.values?.[0]?.value || 0;
    values[metric.name] = val;
  }

  return {
    video_views: values.total_video_views || 0,
    video_avg_watch_seconds: Math.round((values.total_video_avg_time_watched || 0) / 1000)
  };
}

// Fetch and store metrics for all recent published posts
async function collectInsights() {
  // Get posts published in last 14 days that have a Facebook post ID
  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString();
  const { data: posts, error } = await supabase
    .from('posts')
    .select('id, brand, fb_post_id, video_url')
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

      // Get video metrics if applicable
      let videoMetrics = { video_views: 0, video_avg_watch_seconds: 0 };
      if (post.video_url) {
        videoMetrics = await fetchVideoInsights(post.fb_post_id, token);
      }

      // Upsert metrics (one row per post per day)
      const today = new Date().toISOString().split('T')[0];
      await supabase.from('post_metrics').upsert({
        post_id: post.id,
        ...metrics,
        ...videoMetrics,
        fetched_at: today
      }, { onConflict: 'post_id,fetched_at' });

      fetched++;
    } catch (err) {
      console.error(`[Insights] Error for post ${post.id}: ${err.message}`);
    }
  }

  return { fetched, total: posts.length };
}

// Get top performing posts by engagement for a brand
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
