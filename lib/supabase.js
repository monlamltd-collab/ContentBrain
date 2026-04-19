require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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

module.exports = { supabase, insertPost, getDraftPosts, getApprovedPosts, updatePostStatus, getPostById, uploadMedia, saveBrief, getPendingBriefs, markBriefsUsed, getRecentApprovedPosts, getRecentRejectedPosts, getRecentPublishedPosts, saveSeed, getUnusedSeeds, markSeedsUsedForSocial };
