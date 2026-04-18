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

// ── CONTENT BRIEFS ──

async function saveBrief(message) {
  const { data, error } = await supabase
    .from('content_briefs')
    .insert({ message })
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

module.exports = { supabase, insertPost, getDraftPosts, getApprovedPosts, updatePostStatus, getPostById, uploadMedia, saveBrief, getPendingBriefs, markBriefsUsed };
