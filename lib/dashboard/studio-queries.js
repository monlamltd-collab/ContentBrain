'use strict';

// lib/dashboard/studio-queries.js — data layer for the Studio tab.
// Mirrors the queries/render split used by settings + pipeline tabs.

const fs = require('fs');
const path = require('path');
const { supabase } = require('../supabase');

const VALID_BRANDS = ['auctionbrain', 'bridgematch'];
const VALID_TYPES = ['stat', 'hook', 'list', 'reel'];

const MUSIC_DIR = path.join(__dirname, '..', '..', 'public', 'music');
const MUSIC_EXTS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.aac']);
let musicCache = null;

/**
 * Track filenames in public/music/ — cached for the process lifetime
 * (the folder only changes on deploy).
 */
function getMusicTracks() {
  if (musicCache) return musicCache;
  try {
    musicCache = fs.readdirSync(MUSIC_DIR)
      .filter(f => MUSIC_EXTS.has(path.extname(f).toLowerCase()))
      .sort();
  } catch {
    musicCache = [];
  }
  return musicCache;
}

/**
 * Draft social posts for the Studio grid, server-side filtered.
 * Matches the legacy /api/social/queue behavior (all drafts, newest first)
 * plus optional brand/type filters and free-text search across copy.
 */
async function getStudioPosts({ brand, type, q } = {}) {
  let query = supabase
    .from('posts')
    .select('*')
    .eq('status', 'draft')
    .order('created_at', { ascending: false });

  if (brand && VALID_BRANDS.includes(brand)) query = query.eq('brand', brand);
  if (type && VALID_TYPES.includes(type)) query = query.eq('template_type', type);
  if (q && q.trim()) {
    // Escape PostgREST or-filter specials in the user term.
    const term = q.trim().replace(/[(),%]/g, ' ').slice(0, 80);
    if (term.trim()) {
      query = query.or(`copy_headline.ilike.%${term}%,copy_body.ilike.%${term}%`);
    }
  }

  const { data, error } = await query;
  if (error) throw new Error(`Studio query failed: ${error.message}`);
  return data || [];
}

/** Single post by id (full row incl. meta). */
async function getPostRow(id) {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`Post lookup failed: ${error.message}`);
  return data;
}

/**
 * Read-merge-write a patch into posts.meta (jsonb). Returns the updated row.
 * Setting a key to null deletes it from meta.
 */
async function mergePostMeta(id, patch) {
  const row = await getPostRow(id);
  if (!row) throw new Error(`Post ${id} not found`);
  const meta = { ...(row.meta || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === null || v === undefined) delete meta[k];
    else meta[k] = v;
  }
  const { data, error } = await supabase
    .from('posts')
    .update({ meta })
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(`Meta update failed: ${error.message}`);
  return data;
}

module.exports = {
  getStudioPosts,
  getPostRow,
  mergePostMeta,
  getMusicTracks,
  VALID_BRANDS,
  VALID_TYPES,
  _internals: { MUSIC_DIR },
};
