'use strict';

// Loads the last-30-days dedup_key set from the publish log (public.posts in
// the Auction.Bridgematch Supabase project) and hands it to processGeneration.
//
// Requires the dedup_key column from migrations/020-posts-dedup-key.sql
// (NOT applied automatically — see README).
//
// Inside ContentBrain, pass the shared client:
//   const { supabase } = require('../../lib/supabase');
//   const { loadPublishedDedupKeys } = require('./publishLog');
//   const { processGeneration } = require('./adAssembler');
//
//   const publishedKeys = await loadPublishedDedupKeys(supabase);
//   const result = processGeneration(gen, publishedKeys);
//
// createSupabaseClient() exists for running this module standalone.

const DEFAULT_WINDOW_DAYS = 30;
const PAGE_SIZE = 1000;

// Standalone fallback only — ContentBrain code should pass lib/supabase's
// shared client instead. Lazy require so adAssembler tests run dep-free.
function createSupabaseClient(url, key) {
  const { createClient } = require('@supabase/supabase-js');
  const resolvedUrl = url || process.env.SUPABASE_URL;
  const resolvedKey = key || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!resolvedUrl || !resolvedKey) {
    throw new Error('SUPABASE_URL plus SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY are required (server-side only)');
  }
  return createClient(resolvedUrl, resolvedKey, { auth: { persistSession: false } });
}

/**
 * Returns a Set of dedup_key strings seen in the publish log within the window.
 *
 * Window semantics:
 *   - published rows: published_at >= cutoff
 *   - includePending (default true): also rows not yet published (drafts /
 *     approved / scheduled, i.e. status != 'rejected' with no published_at)
 *     created within the window — prevents two identical creatives sitting
 *     in the approval queue at once.
 */
async function loadPublishedDedupKeys(supabase, options = {}) {
  const {
    brand = 'auctionbrain',
    windowDays = DEFAULT_WINDOW_DAYS,
    includePending = true,
  } = options;

  const cutoff = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();
  const keys = new Set();

  for (let from = 0; ; from += PAGE_SIZE) {
    let query = supabase
      .from('posts')
      .select('dedup_key')
      .eq('brand', brand)
      .not('dedup_key', 'is', null)
      .neq('status', 'rejected')
      .range(from, from + PAGE_SIZE - 1);

    query = includePending
      ? query.or(`published_at.gte.${cutoff},and(published_at.is.null,created_at.gte.${cutoff})`)
      : query.gte('published_at', cutoff);

    const { data, error } = await query;
    if (error) {
      throw new Error(`publish log load failed: ${error.message}`);
    }
    for (const row of data) {
      if (row.dedup_key) keys.add(row.dedup_key);
    }
    if (data.length < PAGE_SIZE) break;
  }

  return keys;
}

module.exports = {
  createSupabaseClient,
  loadPublishedDedupKeys,
  DEFAULT_WINDOW_DAYS,
};
