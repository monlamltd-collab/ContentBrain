// Phase G-4 — nightly breakout learner.
//
// Computes engagement Z-scores for recently-published social posts against
// a rolling BREAKOUT_BASELINE_DAYS same-mode baseline. Writes
// posts.meta.breakout_score and posts.meta.breakout_detected_at back to
// posts. Emits a Telegram alert (alertOnce — 24h lockout per post) when a
// new score >= BREAKOUT_ALERT_THRESHOLD lands.
//
// Cron: 08:00 UTC daily, in server.js, AFTER 06:00 UTC Make reconcile +
// 06:30 UTC audience snapshot (so today's metrics are fresh), and BEFORE
// the 09:00 BST publish cron (so isBreakoutActive() picks up the new
// signal).
//
// Idempotent. Re-running the same day:
//   - Recomputes scores (allowed — drift correction)
//   - DOES NOT re-fire Telegram for posts where meta.breakout_detected_at
//     is already set (first-detection lockout)
//
// Engagement source: post_metrics.engagements (latest fetched_at per post).
// NOT posts.meta.fb_engagement (read-only legacy key, never written).
//
// See .ruflo/phase-g4-design.md §1.

'use strict';

const { supabase } = require('../supabase');
const {
  BREAKOUT_THRESHOLD,
  BREAKOUT_ALERT_THRESHOLD,
  BREAKOUT_BASELINE_DAYS,
  BREAKOUT_MIN_BASELINE_POSTS,
  SOCIAL_TRACK,
  SOCIAL_BRAND,
} = require('./constants');
const { alertOnce } = require('./telegram-throttle');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Compute the engagement Z-score for one post against its same-mode
 * baseline. Pure — no I/O. Returned shape stays the same regardless of
 * whether the score could be computed (callers branch on `score === null`).
 *
 * @param {{engagements?: number}} post
 * @param {Array<{engagements?: number}>} baselinePosts
 * @returns {{score: number|null, baseline_n: number, baseline_mean: number|null, baseline_stddev: number|null}}
 */
function computeBreakoutScore(post, baselinePosts) {
  const baseline = Array.isArray(baselinePosts) ? baselinePosts : [];
  const n = baseline.length;
  if (n < BREAKOUT_MIN_BASELINE_POSTS) {
    return { score: null, baseline_n: n, baseline_mean: null, baseline_stddev: null };
  }
  // Defensive numeric coercion: strings, null, undefined, NaN all → 0. We
  // must NOT use `p.engagements || 0` because a truthy non-numeric (e.g.
  // 'banana') would propagate NaN through the reduce.
  const engagements = baseline.map((p) => {
    const n2 = Number(p && p.engagements);
    return Number.isFinite(n2) ? n2 : 0;
  });
  const mean = engagements.reduce((a, b) => a + b, 0) / n;
  const variance = engagements.reduce((s, e) => s + (e - mean) ** 2, 0) / n;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) {
    // Every baseline post has identical engagement — Z-score is undefined.
    // Distinguish from "not enough history" by returning baseline_stddev=0.
    return { score: null, baseline_n: n, baseline_mean: mean, baseline_stddev: 0 };
  }
  const myEngRaw = Number(post && post.engagements);
  const myEng = Number.isFinite(myEngRaw) ? myEngRaw : 0;
  return {
    score: (myEng - mean) / stddev,
    baseline_n: n,
    baseline_mean: mean,
    baseline_stddev: stddev,
  };
}

/**
 * Pull candidate social posts (published 1-14d ago) and compute a breakout
 * score for each. Writes meta.breakout_score back to every candidate (even
 * when null) and meta.breakout_detected_at when the score first crosses
 * BREAKOUT_THRESHOLD. Fires alertOnce per post when the score also crosses
 * BREAKOUT_ALERT_THRESHOLD and the detected-at was set this run.
 *
 * @returns {Promise<{scanned: number, scored: number, breakouts: number, alerted: number}>}
 */
async function runBreakoutLearner() {
  const now = new Date();
  // Candidate window: posts published between (now - 14d) and (now - 1d).
  // The 1-day gap lets engagement metrics stabilise (FB has a publish-lag).
  const candFrom = new Date(now.getTime() - BREAKOUT_BASELINE_DAYS * DAY_MS).toISOString();
  const candTo = new Date(now.getTime() - DAY_MS).toISOString();

  // 1. Fetch candidates — social, monet OR traffic (split by mode below).
  const { data: candidates, error: candErr } = await supabase
    .from('posts')
    .select('id, published_at, template_type, meta, brand')
    .eq('track', SOCIAL_TRACK)
    .gte('published_at', candFrom)
    .lte('published_at', candTo);
  if (candErr) throw new Error(`runBreakoutLearner candidates fetch failed: ${candErr.message}`);

  const result = { scanned: 0, scored: 0, breakouts: 0, alerted: 0 };
  if (!candidates || candidates.length === 0) {
    console.log(`[learner] no candidates in window ${candFrom}..${candTo}`);
    return result;
  }

  for (const cand of candidates) {
    result.scanned += 1;
    const mode = cand.meta && cand.meta.social_mode;
    if (mode !== 'monet' && mode !== 'traffic') continue;

    // 2. Latest engagement for this candidate.
    // eslint-disable-next-line no-await-in-loop
    const candEng = await _latestEngagement(cand.id);
    if (candEng == null) continue;

    // 3. Baseline cohort: same brand + same mode, published in the 14d
    //    window before this candidate, excluding the candidate itself.
    const baseFrom = new Date(new Date(cand.published_at).getTime() - BREAKOUT_BASELINE_DAYS * DAY_MS).toISOString();
    // eslint-disable-next-line no-await-in-loop
    const baselinePosts = await _baselineEngagements({
      brand: cand.brand || SOCIAL_BRAND,
      mode,
      from: baseFrom,
      to: cand.published_at,
      excludeId: cand.id,
    });

    // 4. Compute score.
    const out = computeBreakoutScore({ engagements: candEng }, baselinePosts);
    result.scored += 1;

    // 5. Persist meta.breakout_score + breakout_baseline_n always.
    const prevMeta = cand.meta || {};
    const newMeta = {
      ...prevMeta,
      breakout_score: out.score,
      breakout_baseline_n: out.baseline_n,
    };

    // 6. Set breakout_detected_at ONLY when crossing threshold for the
    //    first time (idempotency — re-runs do not re-mark).
    let detectedThisRun = false;
    if (
      out.score != null
      && out.score >= BREAKOUT_THRESHOLD
      && !prevMeta.breakout_detected_at
    ) {
      newMeta.breakout_detected_at = now.toISOString();
      detectedThisRun = true;
      result.breakouts += 1;
    }

    // eslint-disable-next-line no-await-in-loop
    const { error: upErr } = await supabase
      .from('posts')
      .update({ meta: newMeta })
      .eq('id', cand.id);
    if (upErr) {
      console.warn(`[learner] failed to write meta for post ${cand.id}: ${upErr.message}`);
      continue;
    }

    // 7. Alert when score >= ALERT_THRESHOLD AND we set detected_at THIS
    //    run (so re-runs never re-alert). alertOnce gives belt-and-braces.
    if (
      out.score != null
      && out.score >= BREAKOUT_ALERT_THRESHOLD
      && detectedThisRun
    ) {
      const niche = (newMeta.niche_tag || 'no-tag');
      const type = cand.template_type || 'unknown';
      // eslint-disable-next-line no-await-in-loop
      const fired = await alertOnce('breakout-detected', cand.id, () => (
        `\u{1F680} <b>EXCEPTIONAL breakout</b> post ${cand.id} (${niche}, ${type}) `
        + `Z=${out.score.toFixed(2)} — niche will amplify in next 48h`
      ));
      if (fired && fired.fired) result.alerted += 1;
    } else if (detectedThisRun) {
      // Standard breakout (threshold reached but not "exceptional") — log
      // only; no Telegram. Z=2.5..3.0 fires often enough that alerting
      // each one would dull the signal.
      const niche = (newMeta.niche_tag || 'no-tag');
      const type = cand.template_type || 'unknown';
      console.log(
        `[learner] breakout post ${cand.id} (${niche}, ${type}) Z=${out.score.toFixed(2)} `
        + `— niche will amplify in next 48h`
      );
    }
  }

  console.log(`[learner] scanned=${result.scanned} scored=${result.scored} breakouts=${result.breakouts} alerted=${result.alerted}`);
  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Return the most recent post_metrics.engagements value for a post, or null
 * when no row exists. Defensive against the engagements column being null.
 *
 * @param {string} postId
 * @returns {Promise<number|null>}
 */
async function _latestEngagement(postId) {
  const { data, error } = await supabase
    .from('post_metrics')
    .select('engagements, fetched_at')
    .eq('post_id', postId)
    .order('fetched_at', { ascending: false })
    .limit(1);
  if (error) {
    // post_metrics may not exist on some environments — return null rather
    // than throwing so the cron logs but continues.
    console.warn(`[learner] _latestEngagement(${postId}) failed: ${error.message}`);
    return null;
  }
  if (!data || data.length === 0) return null;
  const eng = Number(data[0].engagements);
  return Number.isFinite(eng) ? eng : null;
}

/**
 * Fetch latest-per-post engagements for the baseline cohort.
 *
 * @param {{brand: string, mode: string, from: string, to: string, excludeId: string}} args
 * @returns {Promise<Array<{post_id: string, engagements: number}>>}
 */
async function _baselineEngagements({ brand, mode, from, to, excludeId }) {
  const { data: peers, error: peersErr } = await supabase
    .from('posts')
    .select('id, meta, brand')
    .eq('track', SOCIAL_TRACK)
    .eq('brand', brand)
    .gte('published_at', from)
    .lt('published_at', to)
    .neq('id', excludeId);
  if (peersErr) throw new Error(`runBreakoutLearner baseline peers failed: ${peersErr.message}`);

  const filtered = (peers || []).filter((p) => p.meta && p.meta.social_mode === mode);
  if (filtered.length === 0) return [];

  const out = [];
  for (const peer of filtered) {
    // eslint-disable-next-line no-await-in-loop
    const eng = await _latestEngagement(peer.id);
    if (eng != null) out.push({ post_id: peer.id, engagements: eng });
  }
  return out;
}

module.exports = {
  runBreakoutLearner,
  computeBreakoutScore,
};

// CLI entry — manual one-shot:  node lib/social-engine/learner.js
if (require.main === module) {
  (async () => {
    try {
      const r = await runBreakoutLearner();
      console.log(`[learner cli] ${JSON.stringify(r, null, 2)}`);
    } catch (err) {
      console.error(`[learner cli] error: ${err.message}`);
      process.exit(1);
    }
  })();
}
