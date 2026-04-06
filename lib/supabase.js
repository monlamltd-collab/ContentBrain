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

module.exports = { supabase, insertPost, getDraftPosts, getApprovedPosts, updatePostStatus, getPostById };
