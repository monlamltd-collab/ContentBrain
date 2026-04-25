require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Primary client — used for social posts, seeds, briefs, AB-Content blog posts
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Optional BridgeMatch-Content client — used only for blog_posts updates
// when the approved/rejected/revised post originated from BM-Content.
// Falls back to the primary client if BM credentials are not configured,
// which preserves existing single-project behaviour.
let supabaseBridgematch = null;
if (process.env.SUPABASE_URL_BRIDGEMATCH && process.env.SUPABASE_SERVICE_KEY_BRIDGEMATCH) {
  supabaseBridgematch = createClient(
    process.env.SUPABASE_URL_BRIDGEMATCH,
    process.env.SUPABASE_SERVICE_KEY_BRIDGEMATCH
  );
  console.log('[supabase] BridgeMatch secondary client configured');
}

/**
 * Returns the Supabase client that owns blog_posts for the given brand.
 * Used only for blog/guide content — social posts always use the primary client.
 */
function getBlogClient(brand) {
  if (brand === 'bridgematch' && supabaseBridgematch) return supabaseBridgematch;
  return supabase;
}

// ── POST OPERATIONS ──

async function insertPost(post) {
  const { data, error } = await supabase
    .from('posts')
    .insert(post)
    .select()
    .single();
  if (error) throw new Error(`Insert post failed: ${error.message}`);
  return data;
}

async function getDraftPosts() {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('status', 'draft')
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Get drafts failed: ${error.message}`);
  return data || [];
}

async function getApprovedPosts() {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('status', 'approved')
    .lte('scheduled_for', new Date().toISOString())
    .order('scheduled_for', { ascending: true });
  if (error) throw new Error(`Get approved failed: ${error.message}`);
  return data || [];
}

async function updatePostStatus(id, status) {
  const updates = { status };
  if (status === 'approved') updates.approved_at = new Date().toISOString();
  if (status === 'published') updates.published_at = new Date().toISOString();

  const { data, error } = await supabase
    .from('posts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`Update status failed: ${error.message}`);
  return data;
}

async function getPostById(id) {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(`Get post failed: ${error.message}`);
  return data;
}

// ── STORAGE OPERATIONS ──

async function uploadMedia(filePath, filename) {
  const fs = require('fs');
  const fileBuffer = fs.readFileSync(filePath);
  const contentType = filename.endsWith('.mp4') ? 'video/mp4' : 'image/png';

  const { error } = await supabase.storage
    .from('content-media')
    .upload(filename, fileBuffer, { contentType, upsert: true });
  if (error) throw new Error(`Upload failed: ${error.message}`);

  const { data } = supabase.storage
    .from('content-media')
    .getPublicUrl(filename);

  return data.publicUrl;
}

// ── LEARNING QUERIES ──

async function getRecentApprovedPosts(brand, limit = 5) {
  const { data, error } = await supabase
    .from('posts')
    .select('copy_headline, copy_body, copy_cta, template_type')
    .eq('brand', brand)
    .in('status', ['approved', 'published'])
    .order('approved_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(`Get approved posts failed: ${error.message}`);
  return data || [];
}

async function getRecentRejectedPosts(brand, limit = 3) {
  const { data, error } = await supabase
    .from('posts')
    .select('copy_headline, copy_body, copy_cta, template_type, rejection_feedback')
    .eq('brand', brand)
    .eq('status', 'rejected')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Get rejected posts failed: ${error.message}`);
  return data || [];
}

async function getRecentPublishedPosts(brand, days = 7) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('posts')
    .select('copy_headline, copy_body, template_type')
    .eq('brand', brand)
    .eq('status', 'published')
    .gte('published_at', since)
    .order('published_at', { ascending: false });
  if (error) throw new Error(`Get recent published failed: ${error.message}`);
  return data || [];
}

// ── CONTENT BRIEFS ──

async function saveBrief(briefData) {
  const record = typeof briefData === 'string'
    ? { message: briefData }
    : {
        message: briefData.full_brief || briefData.message || '',
        topic: briefData.topic || null,
        brand: briefData.brand || null,
        angle: briefData.angle || null,
        data_points: briefData.data_points || null
      };

  const { data, error } = await supabase
    .from('content_briefs')
    .insert(record)
    .select()
    .single();
  if (error) throw new Error(`Save brief failed: ${error.message}`);
  return data;
}

async function getPendingBriefs() {
  const { data, error } = await supabase
    .from('content_briefs')
    .select('*')
    .eq('used', false)
    .order('created_at', { ascending: true });
  if (error) throw new Error(`Get briefs failed: ${error.message}`);
  return data || [];
}

async function markBriefsUsed(ids) {
  const { error } = await supabase
    .from('content_briefs')
    .update({ used: true })
    .in('id', ids);
  if (error) throw new Error(`Mark briefs used failed: ${error.message}`);
}

// ── CONTENT SEEDS ──

async function saveSeed(seedData) {
  const { data, error } = await supabase
    .from('content_seeds')
    .insert(seedData)
    .select()
    .single();
  if (error) throw new Error(`Save seed failed: ${error.message}`);
  return data;
}

async function getUnusedSeeds(brand, limit = 5) {
  let query = supabase
    .from('content_seeds')
    .select('*')
    .eq('used_for_social', false)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (brand) {
    query = query.or(`brand.eq.${brand},brand.is.null`);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Get unused seeds failed: ${error.message}`);
  return data || [];
}

async function markSeedsUsedForSocial(ids) {
  const { error } = await supabase
    .from('content_seeds')
    .update({ used_for_social: true })
    .in('id', ids);
  if (error) throw new Error(`Mark seeds used failed: ${error.message}`);
}

// ── BLOG POSTS (from blog generators) ──

/**
 * Returns draft blog posts from BOTH Supabase projects (primary = AuctionBrain,
 * secondary = BridgeMatch when configured). Each row carries its own `brand`
 * field so callers can tell them apart. Sorted newest-first across both.
 */
async function getDraftBlogPosts() {
  const clients = [
    { client: supabase, source: 'primary' },
    ...(supabaseBridgematch ? [{ client: supabaseBridgematch, source: 'bridgematch' }] : [])
  ];

  const results = await Promise.all(clients.map(async ({ client, source }) => {
    const { data, error } = await client
      .from('blog_posts')
      .select('*')
      .eq('status', 'draft')
      .order('created_at', { ascending: false });
    if (error) {
      console.warn(`[getDraftBlogPosts:${source}] ${error.message}`);
      return [];
    }
    return data || [];
  }));

  const merged = results.flat();
  // Sort merged list newest-first by created_at
  merged.sort((a, b) => {
    const aT = a.created_at ? new Date(a.created_at).getTime() : 0;
    const bT = b.created_at ? new Date(b.created_at).getTime() : 0;
    return bT - aT;
  });
  return merged;
}

async function updateBlogPostStatus(id, status, extras = {}, brand = 'auctionbrain') {
  const updates = { status, ...extras };
  if (status === 'approved') updates.approved_at = new Date().toISOString();
  if (status === 'published') updates.published_at = new Date().toISOString();

  const client = getBlogClient(brand);
  const { data, error } = await client
    .from('blog_posts')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`Update blog post status failed: ${error.message}`);
  return data;
}

async function getBlogPostById(id, brand = 'auctionbrain') {
  const client = getBlogClient(brand);
  const { data, error } = await client
    .from('blog_posts')
    .select('*')
    .eq('id', id)
    .single();
  if (error) throw new Error(`Get blog post failed: ${error.message}`);
  return data;
}

/**
 * Returns the scraped articles that fed into a given blog/guide post.
 * Both content engines mark articles via scraped_articles.used_in_post = post.id
 * after savePost(). Older posts (pre that linkage) will return [].
 */
async function getSourceArticlesForPost(postId, brand = 'auctionbrain') {
  const client = getBlogClient(brand);
  const { data, error } = await client
    .from('scraped_articles')
    .select('title, url, content')
    .eq('used_in_post', postId);
  if (error) {
    console.warn(`[getSourceArticlesForPost] ${error.message}`);
    return [];
  }
  return data || [];
}

/**
 * Returns published posts for the given brand — used as internal-link
 * candidates when the LLM revises a draft.
 */
async function getPublishedPostsForBrand(brand = 'auctionbrain', limit = 30) {
  const client = getBlogClient(brand);
  const { data, error } = await client
    .from('blog_posts')
    .select('title, slug, summary, tags, cluster')
    .eq('status', 'published')
    .eq('brand', brand)
    .order('published_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.warn(`[getPublishedPostsForBrand] ${error.message}`);
    return [];
  }
  return data || [];
}

module.exports = { supabase, supabaseBridgematch, getBlogClient, insertPost, getDraftPosts, getApprovedPosts, updatePostStatus, getPostById, uploadMedia, saveBrief, getPendingBriefs, markBriefsUsed, getRecentApprovedPosts, getRecentRejectedPosts, getRecentPublishedPosts, saveSeed, getUnusedSeeds, markSeedsUsedForSocial, getDraftBlogPosts, updateBlogPostStatus, getBlogPostById, getSourceArticlesForPost, getPublishedPostsForBrand };
