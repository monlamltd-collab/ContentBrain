'use strict';

// ── PHASE E — Closed loop: template performance roll-up ───────────────────
//
// Aggregates "what's working" signals across the last N days and surfaces
// them in the social-side system prompt (lib/generate.js#getSystemPrompt).
// This is the content-side counterpart to lib/closed-loop/funded-deals.js
// (outbound-side) — both feed the LLM with what to lean into.
//
// Reads from `posts` + `post_metrics` + `replies` (existing tables — no
// new migration). For sub-template-type breakdowns where we don't have
// click-through data yet, falls back to engagement count alone.
//
// NO BODIES YET — architect stub for the Phase E coder. The shape below
// is what generate.js#getSystemPrompt is wired to consume; the coder
// builds the Supabase queries against the existing schema.

const { supabase } = require('../supabase');

/**
 * Per-template performance roll-up over the last `days` days for one brand.
 *
 * Surfaced in lib/generate.js#getSystemPrompt as a TEMPLATE PERFORMANCE
 * block when at least one template_type has >5 published posts — below
 * that threshold the signal is too noisy to bias generation on.
 *
 * Caller MUST handle a null/empty return gracefully (no data yet for a
 * fresh brand) — getSystemPrompt branches on the threshold before
 * including the block at all.
 *
 * @param {'auctionbrain'|'bridgematch'} brand
 * @param {number} [days=30]  - look-back window in days
 * @returns {Promise<Array<{
 *   template_type:    string,
 *   posts_published:  number,
 *   total_engagement: number,
 *   replies:          number,
 *   reply_rate:       number,   // 0..1; replies / posts_published (or sent for outbound)
 *   top_subject:      string | null,   // highest-engagement subject/headline in this template_type
 *   top_cta_pattern:  string | null,   // most-clicked cta_pattern label, or null when no click data
 * }>>}
 *   One row per template_type. Sorted DESC by total_engagement so the
 *   prompt sees the best-performing template first. Empty array means
 *   "no useful signal" and the caller should omit the prompt block.
 */
async function getTemplatePerformance(brand, days = 30) {
  // BODY DELIBERATELY OMITTED — coder implements against the existing
  // posts + post_metrics + replies tables.
  //
  // Expected behaviour:
  //   1. since = now() - days * 86400 * 1000.
  //   2. Fetch posts WHERE brand=$1 AND status='published' AND published_at>=since.
  //      Hydrate post_metrics via select('*, post_metrics(*)') — Supabase JS
  //      embeds the joined rows; null when no metrics yet.
  //   3. Group client-side by template_type. For each group:
  //        - posts_published = group.length
  //        - total_engagement = sum(metrics.engagements ?? 0)
  //        - replies = COUNT of replies where post.meta.contact_id ∈ contact_ids
  //          (separate query; same pattern as lib/dashboard/performance-queries.js)
  //        - reply_rate = replies / posts_published (cap at 1.0)
  //        - top_subject = headline of the highest-engagement post in group
  //        - top_cta_pattern = most-frequent meta.cta_pattern among the top-3
  //          posts by clicks (or null if no post_metrics or no cta_pattern set).
  //   4. Drop any group with posts_published < 1 (defensive).
  //   5. Sort DESC by total_engagement. Return.
  //   6. On Supabase error → console.warn + return [].
  throw new Error('getTemplatePerformance: not implemented (Phase E coder stub)');
}

module.exports = { getTemplatePerformance };
