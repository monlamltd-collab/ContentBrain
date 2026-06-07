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
    .select('copy_headline, copy_body, template_type, meta')
    .eq('brand', brand)
    .in('status', ['approved', 'published'])
    .gte('created_at', since)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`Get recent published failed: ${error.message}`);
  return data || [];
}

// Recent DRAFT posts for a brand. This is the anti-repetition fix: the
// generator previously deduped only against approved/published posts, so once
// approvals stalled it became blind to the (large) draft backlog and looped on
// the same few angles. Feeding recent draft headlines into the avoid-list
// breaks that loop regardless of approval cadence.
async function getRecentDrafts(brand, limit = 25) {
  const { data, error } = await supabase
    .from('posts')
    .select('copy_headline, copy_body, template_type, meta, created_at')
    .eq('brand', brand)
    .eq('status', 'draft')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Get recent drafts failed: ${error.message}`);
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

// ── LOTS (AuctionBrain inventory — read-only consumer) ──

// Lot fields needed downstream (lot-content.js prompt + LotVideo render).
// Shared by findLotsByArchetype and findLotsBySuperlative.
const LOT_COLS = 'id, house, lot_number, url, address, postcode, price, price_text, prop_type, beds, tenure, sqft, condition, image_url, images, bullets, auction_date, status, score, score_breakdown, opps, risks, deal_type, vacant, est_monthly_rent, est_gross_yield, comparable_price, below_market, epc_rating, flood_risk';

async function getLot(lotId) {
  const { data, error } = await supabase
    .from('lots')
    .select('*')
    .eq('id', lotId)
    .single();
  if (error) throw new Error(`Get lot failed: ${error.message}`);
  return data;
}

/**
 * Find candidate lots for one of the Lot-of-the-Day archetypes.
 * Returns up to `limit` rows ordered by the archetype's primary signal.
 *
 * Defaults reflect actual data shape (May 2026): only ~570 lots have a future
 * auction in any given 14-day window, of which ~17 score ≥6 and ~9 score ≥7.
 * Score floor is set to 6 so the daily rotation has breathing room. Urgent
 * uses a 7-day window with a looser floor since plenty of lots are bidding
 * soon but few are top-scored that close to auction.
 */
async function findLotsByArchetype(archetype, opts = {}) {
  const limit = opts.limit ?? 20;
  const minScore = opts.minScore ?? 6;
  const today = new Date().toISOString().slice(0, 10);
  const horizon14 = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const horizon7 = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let query = supabase
    .from('lots')
    .select(LOT_COLS)
    .not('image_url', 'is', null)
    .neq('image_url', '');

  switch (archetype) {
    case 'best-yield':
      query = query
        .gte('auction_date', today).lte('auction_date', horizon14)
        .gte('score', minScore)
        .gte('est_gross_yield', 8)
        .order('est_gross_yield', { ascending: false });
      break;
    case 'deepest-discount':
      query = query
        .gte('auction_date', today).lte('auction_date', horizon14)
        .gte('score', minScore)
        .not('below_market', 'is', null)
        .gt('below_market', 0)
        .order('below_market', { ascending: false });
      break;
    case 'dev-or-refurb':
      query = query
        .gte('auction_date', today).lte('auction_date', horizon14)
        .gte('score', minScore)
        .or('condition.ilike.%refurb%,condition.ilike.%develop%,deal_type.ilike.%refurb%,deal_type.ilike.%develop%')
        .order('score', { ascending: false });
      break;
    case 'urgent':
      query = query
        .gte('auction_date', today).lte('auction_date', horizon7)
        .gte('score', opts.minScore ?? 5)
        .order('auction_date', { ascending: true });
      break;
    default:
      throw new Error(`Unknown archetype: ${archetype}`);
  }

  const { data, error } = await query.limit(limit);
  if (error) throw new Error(`findLotsByArchetype(${archetype}) failed: ${error.message}`);
  return data || [];
}

/**
 * Definitions for the weekly "X of the week" superlative reels. Each superlative
 * is the single most-extreme lot in the pool of lots auctioning in the next
 * 14 days — keeps every reel actionable (the viewer can still bid on it).
 */
const WEEKLY_SUPERLATIVES = {
  'cheapest-week':         { order: 'price',        ascending: true,  require: q => q.gt('price', 0) },
  'dearest-week':          { order: 'price',        ascending: false, require: q => q.gt('price', 0) },
  'best-deal-week':        { order: 'score',        ascending: false, require: q => q.not('score', 'is', null) },
  'biggest-discount-week': { order: 'below_market', ascending: false, require: q => q.gt('below_market', 0) },
  // score > 0 (not just non-null): ~59% of lots sit at score 0 = "not yet
  // scored", so worst-lot must order over genuinely-scored lots only.
  'worst-lot-week':        { order: 'score',        ascending: true,  require: q => q.gt('score', 0) },
};

/**
 * Find candidate lots for one weekly superlative, ordered most-extreme first.
 * Returns up to `limit` rows so the picker can skip placeholder-image lots and
 * lots featured recently. Same column set and upcoming-auction window as
 * findLotsByArchetype.
 */
async function findLotsBySuperlative(superlative, opts = {}) {
  const def = WEEKLY_SUPERLATIVES[superlative];
  if (!def) throw new Error(`Unknown superlative: ${superlative}`);
  const limit = opts.limit ?? 30;
  const today = new Date().toISOString().slice(0, 10);
  const horizon14 = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  let query = supabase
    .from('lots')
    .select(LOT_COLS)
    .not('image_url', 'is', null)
    .neq('image_url', '')
    .gte('auction_date', today)
    .lte('auction_date', horizon14);
  query = def.require(query);
  query = query.order(def.order, { ascending: def.ascending });

  const { data, error } = await query.limit(limit);
  if (error) throw new Error(`findLotsBySuperlative(${superlative}) failed: ${error.message}`);
  return data || [];
}

/**
 * Has this lot been featured in a post within the last `daysWindow` days?
 * Used by the picker to avoid re-featuring the same lot in close succession.
 */
async function hasFeaturedLot(lotId, daysWindow = 60) {
  const since = new Date(Date.now() - daysWindow * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await supabase
    .from('posts')
    .select('id')
    .gte('created_at', since)
    .filter('meta->>lot_id', 'eq', lotId)
    .limit(1);
  if (error) throw new Error(`hasFeaturedLot failed: ${error.message}`);
  return (data || []).length > 0;
}

/**
 * Pull a spread of real, upcoming lots to use as CONCRETE MATERIAL for generic
 * social generation. The generic engine was starved down to 5 evergreen brand
 * facts and rephrased them forever; real lot data changes daily and anchors
 * posts to specifics (a postcode, a guide price, a yield) instead. Read-only,
 * best-effort — callers degrade gracefully to no material on error.
 *
 * Returns lots with a future auction date and a usable score, newest auctions
 * and strongest scores first, lightly varied so successive runs don't all open
 * with the same lot.
 */
async function getFreshLotsForMaterial(limit = 6) {
  const today = new Date().toISOString().slice(0, 10);
  const horizon = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from('lots')
    .select('address, postcode, prop_type, beds, price, below_market, comparable_price, est_gross_yield, est_monthly_rent, condition, tenure, epc_rating, flood_risk, auction_date, house, score, deal_type')
    .gte('auction_date', today)
    .lte('auction_date', horizon)
    .gte('score', 6)
    .order('score', { ascending: false })
    .limit(limit * 4);
  if (error) throw new Error(`getFreshLotsForMaterial failed: ${error.message}`);
  const rows = data || [];
  // Light shuffle then take `limit` so the same top-scored lots aren't the
  // material on every single run (avoids second-order repetition).
  for (let i = rows.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rows[i], rows[j]] = [rows[j], rows[i]];
  }
  return rows.slice(0, limit);
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
  return await _updateBlogPostStatusWithRetry(client, id, updates);
}

// Defensive update: BM and AB Supabase projects don't always have the same
// columns (e.g. approved_at, updated_at exist on AB but not BM). Try the
// full update first; on PGRST204 ('column not in schema cache'), strip
// the offending column from the update and retry. Repeats up to 3 times
// for the case where multiple columns are missing.
async function _updateBlogPostStatusWithRetry(client, id, updates, attempt = 0) {
  // maybeSingle() returns null (not an error) when 0 rows match — prevents
  // PGRST116 "Cannot coerce to single JSON object" on already-rejected posts.
  const { data, error } = await client
    .from('blog_posts')
    .update(updates)
    .eq('id', id)
    .select()
    .maybeSingle();
  if (!error) return data; // null when 0 rows matched — that's fine

  // PGRST204 = "Could not find the 'X' column of 'blog_posts' in the schema cache"
  if (error.code === 'PGRST204' && attempt < 3) {
    const m = (error.message || '').match(/Could not find the '([^']+)' column/);
    if (m && m[1] && m[1] in updates) {
      const next = { ...updates };
      delete next[m[1]];
      console.warn(`[updateBlogPostStatus] dropping unknown column "${m[1]}" and retrying`);
      return _updateBlogPostStatusWithRetry(client, id, next, attempt + 1);
    }
  }
  throw new Error(`Update blog post status failed: ${error.message}`);
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

/**
 * Returns all published blog posts from both Supabase projects,
 * merged and annotated with brand, for the editorial coverage panel.
 */
async function getPublishedBlogPostsBothBrands() {
  const clients = [
    { client: supabase, brand: 'auctionbrain' },
    ...(supabaseBridgematch ? [{ client: supabaseBridgematch, brand: 'bridgematch' }] : [])
  ];

  const results = await Promise.all(clients.map(async ({ client, brand }) => {
    const { data, error } = await client
      .from('blog_posts')
      .select('id, title, slug, tags, published_at, status, brand, evaluation_score')
      .eq('status', 'published')
      .order('published_at', { ascending: false });
    if (error) {
      console.warn(`[getPublishedBlogPostsBothBrands:${brand}] ${error.message}`);
      return [];
    }
    // Ensure brand field is set even on older rows
    return (data || []).map(p => ({ ...p, brand: p.brand || brand }));
  }));

  return results.flat().sort((a, b) =>
    new Date(b.published_at || 0) - new Date(a.published_at || 0)
  );
}

/**
 * Returns pending (unused) content briefs — for the editorial brief queue panel.
 */
async function getPendingBriefsAll() {
  const { data, error } = await supabase
    .from('content_briefs')
    .select('*')
    .eq('used', false)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getPendingBriefsAll failed: ${error.message}`);
  return data || [];
}

/**
 * Marks a single brief as used/dismissed.
 */
async function dismissBrief(id) {
  const { error } = await supabase
    .from('content_briefs')
    .update({ used: true })
    .eq('id', id);
  if (error) throw new Error(`dismissBrief failed: ${error.message}`);
}

/**
 * Returns titles (and tags) of recent blog posts for a brand — both drafts
 * and published — so callers can detect repeated themes at ingestion time.
 * Queries only the blog client for that brand (AB or BM project).
 */
async function getRecentBlogPostTitles(brand = 'auctionbrain', daysBack = 45) {
  const client = getBlogClient(brand);
  const since = new Date(Date.now() - daysBack * 86400000).toISOString();
  const { data, error } = await client
    .from('blog_posts')
    .select('id, title, tags, status')
    .in('status', ['draft', 'approved', 'published'])
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(60);
  if (error) {
    console.warn(`[getRecentBlogPostTitles:${brand}] ${error.message}`);
    return [];
  }
  return data || [];
}

module.exports = { supabase, supabaseBridgematch, getBlogClient, insertPost, getDraftPosts, getApprovedPosts, updatePostStatus, getPostById, uploadMedia, saveBrief, getPendingBriefs, getPendingBriefsAll, dismissBrief, markBriefsUsed, getRecentApprovedPosts, getRecentRejectedPosts, getRecentPublishedPosts, getRecentDrafts, saveSeed, getUnusedSeeds, markSeedsUsedForSocial, getDraftBlogPosts, updateBlogPostStatus, getBlogPostById, getSourceArticlesForPost, getPublishedPostsForBrand, getPublishedBlogPostsBothBrands, getLot, findLotsByArchetype, findLotsBySuperlative, WEEKLY_SUPERLATIVES, hasFeaturedLot, getFreshLotsForMaterial, getRecentBlogPostTitles };
