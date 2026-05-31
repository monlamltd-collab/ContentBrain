'use strict';

// ── Performance tab query helpers (Phase D) ───────────────────────────────
//
// Backs the /api/dashboard/performance/metrics endpoint. Pulls:
//   - Content engagement (posts published, FB reach + engagement, top-3)
//   - Outbound conversion per track (prospects / contacts / sequences /
//     sent / opens / replies / interested / meetings)
//
// SQL sketches and per-track funnel rules: .ruflo/phase-d-design.md §4.4.
//
// Volumes are tiny — 28 queries per page-load, each sub-millisecond. No
// caching needed at current scale. If this ever changes (10k+ posts),
// add a 60s in-memory cache keyed on (windowDays, now-rounded-to-minute).
//
// All queries take `from` (lower-bound ISO timestamp). `all` window
// passes `1970-01-01T00:00:00.000Z`.

const { supabase } = require('../supabase');
const {
  BREAKOUT_THRESHOLD,
  SOCIAL_BRAND,
  SOCIAL_TRACK,
} = require('../social-engine/constants');

const TRACKS = Object.freeze(['lender', 'broker', 'auction_house']);

// Weekly review window — fixed 7d (last 7 calendar days). Independent of
// the user-selected windowDays (which controls the rest of the Performance
// tab) because the weekly review is conceptually a "this week" rollup.
const WEEKLY_REVIEW_DAYS = 7;

/**
 * Compute the lower-bound timestamp for a window length.
 *
 * @param {number|'all'} windowDays
 * @returns {string} ISO timestamp
 */
function windowStart(windowDays) {
  if (windowDays === 'all' || windowDays === Infinity) {
    return new Date('1970-01-01T00:00:00.000Z').toISOString();
  }
  const days = Number(windowDays);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`windowStart: invalid windowDays=${windowDays}`);
  }
  return new Date(Date.now() - days * 86400 * 1000).toISOString();
}

/**
 * Fetch the full metrics shape for the Performance tab.
 *
 * @param {object} [opts]
 * @param {number|'all'} [opts.windowDays=7]
 * @returns {Promise<object>}
 */
async function getMetrics({ windowDays = 7 } = {}) {
  const from = windowStart(windowDays);
  const to = new Date().toISOString();

  const content = await getContentMetrics(from);
  const outbound = {};
  for (const track of TRACKS) {
    outbound[track] = await getOutboundMetricsForTrack(track, from);
  }
  // Phase G-4 — weekly review block. Always included (not gated on
  // windowDays). Its own internal window is fixed at WEEKLY_REVIEW_DAYS
  // since "weekly review" is conceptually a same-name rollup.
  const weeklyFrom = windowStart(WEEKLY_REVIEW_DAYS);
  const weekly_review = await getWeeklyReview(weeklyFrom);

  return {
    window: { days: windowDays, from, to },
    content,
    outbound,
    weekly_review,
  };
}

/**
 * Content engagement block. Posts with track='social' + status='published'
 * in the window, plus FB reach + engagement totals + top-3 by engagement.
 */
async function getContentMetrics(from) {
  const out = {
    posts_count: 0,
    fb_reach: null,
    fb_engagement: null,
    recent_top3: [],
  };

  // posts_count
  const { count: postsCount, error: errCount } = await supabase
    .from('posts')
    .select('id', { count: 'exact', head: true })
    .eq('track', 'social')
    .eq('status', 'published')
    .gte('published_at', from);
  if (errCount) throw new Error(`getContentMetrics posts_count failed: ${errCount.message}`);
  out.posts_count = postsCount || 0;

  // fb_reach / fb_engagement aggregation — Supabase JS doesn't expose
  // server-side SUM, so we fetch the meta column and tally client-side.
  // Posts in the window are at most a few hundred — cheap.
  const { data: pubRows, error: errRows } = await supabase
    .from('posts')
    .select('id, copy_headline, meta')
    .eq('track', 'social')
    .eq('status', 'published')
    .gte('published_at', from);
  if (errRows) throw new Error(`getContentMetrics rows failed: ${errRows.message}`);

  let reach = null;
  let engagement = null;
  const candidates = [];
  for (const r of pubRows || []) {
    const meta = r.meta || {};
    if (meta.fb_reach != null) {
      reach = (reach || 0) + Number(meta.fb_reach || 0);
    }
    if (meta.fb_engagement != null) {
      engagement = (engagement || 0) + Number(meta.fb_engagement || 0);
      candidates.push({
        id: r.id,
        copy_headline: r.copy_headline,
        engagement: Number(meta.fb_engagement || 0),
      });
    }
  }
  out.fb_reach = reach;
  out.fb_engagement = engagement;
  candidates.sort((a, b) => b.engagement - a.engagement);
  out.recent_top3 = candidates.slice(0, 3);

  return out;
}

/**
 * 8-metric funnel for one outbound track.
 */
async function getOutboundMetricsForTrack(track, from) {
  const out = {
    prospects: 0,
    contacts: 0,
    sequences_active: 0,
    sent: 0,
    opens: 0,
    replies: 0,
    interested: 0,
    meetings: 0,
  };

  // prospects
  const { count: cProspects, error: e1 } = await supabase
    .from('prospects')
    .select('id', { count: 'exact', head: true })
    .eq('type', track)
    .gte('created_at', from);
  if (e1) throw new Error(`prospects count failed (${track}): ${e1.message}`);
  out.prospects = cProspects || 0;

  // contacts — join via prospect_id; we need IDs of in-type prospects.
  // To avoid an explicit join, fetch prospect ids first (small set).
  const { data: pIds, error: e2 } = await supabase
    .from('prospects')
    .select('id')
    .eq('type', track);
  if (e2) throw new Error(`prospect ids failed (${track}): ${e2.message}`);
  const ids = (pIds || []).map(r => r.id);

  if (ids.length > 0) {
    const { count: cContacts, error: e3 } = await supabase
      .from('contacts')
      .select('id', { count: 'exact', head: true })
      .in('prospect_id', ids)
      .gte('created_at', from);
    if (e3) throw new Error(`contacts count failed (${track}): ${e3.message}`);
    out.contacts = cContacts || 0;
  }

  // sequences_active (track-keyed)
  const { count: cSeqs, error: e4 } = await supabase
    .from('sequences')
    .select('id', { count: 'exact', head: true })
    .eq('track', track)
    .gte('created_at', from);
  if (e4 && !/relation .* does not exist/i.test(e4.message || '')) {
    throw new Error(`sequences count failed (${track}): ${e4.message}`);
  }
  out.sequences_active = cSeqs || 0;

  // sent — outbound posts with this track in meta.track, status=published.
  // Posts are written with meta.track={'lender'|'broker'|'auction_house'}.
  // We can't filter inside meta jsonb count-only easily; fetch matching
  // ids cheaply.
  const { data: sentRows, error: e5 } = await supabase
    .from('posts')
    .select('id, meta')
    .eq('track', 'outbound')
    .eq('status', 'published')
    .gte('published_at', from);
  if (e5) throw new Error(`sent rows failed (${track}): ${e5.message}`);
  const trackRows = (sentRows || []).filter(r => (r.meta || {}).track === track);
  out.sent = trackRows.length;
  out.opens = trackRows.filter(r => Number(((r.meta) || {}).opens || 0) > 0).length;

  // replies + interested — joined via contacts→prospects on type
  if (ids.length > 0) {
    // contacts of those prospects
    const { data: contactRows, error: e6 } = await supabase
      .from('contacts')
      .select('id')
      .in('prospect_id', ids);
    if (e6) throw new Error(`contact ids failed (${track}): ${e6.message}`);
    const contactIds = (contactRows || []).map(r => r.id);

    if (contactIds.length > 0) {
      const { count: cReplies, error: e7 } = await supabase
        .from('replies')
        .select('id', { count: 'exact', head: true })
        .in('contact_id', contactIds)
        .gte('created_at', from);
      if (e7 && !/relation .* does not exist/i.test(e7.message || '')) {
        throw new Error(`replies count failed (${track}): ${e7.message}`);
      }
      out.replies = cReplies || 0;

      const { count: cInterested, error: e8 } = await supabase
        .from('replies')
        .select('id', { count: 'exact', head: true })
        .in('contact_id', contactIds)
        .eq('classified_intent', 'interested')
        .gte('created_at', from);
      if (e8 && !/relation .* does not exist/i.test(e8.message || '')) {
        throw new Error(`interested count failed (${track}): ${e8.message}`);
      }
      out.interested = cInterested || 0;

      // meetings — contact.metadata.meeting_booked_at is a jsonb key.
      // Pull rows with non-null metadata and count client-side.
      const { data: contactMetaRows, error: e9 } = await supabase
        .from('contacts')
        .select('id, metadata')
        .in('id', contactIds);
      if (e9) throw new Error(`meeting contacts failed (${track}): ${e9.message}`);
      out.meetings = (contactMetaRows || []).filter(c => {
        const ts = c.metadata && c.metadata.meeting_booked_at;
        if (!ts) return false;
        try {
          return new Date(ts).toISOString() >= from;
        } catch { return false; }
      }).length;
    }
  }

  return out;
}

// ── Weekly review (Phase G-4) ────────────────────────────────────────────
//
// Rollup over the last WEEKLY_REVIEW_DAYS surfaced ABOVE the existing
// "Content engagement" + "Outbound conversion" sections in the Performance
// tab. See .ruflo/phase-g4-design.md §2.

/**
 * Aggregate the weekly-review block. All sub-helpers fail gracefully on
 * "relation does not exist" so a missing optional table (e.g. sequences
 * before Phase E lands) doesn't break the whole Performance tab.
 *
 * @param {string} from  ISO timestamp (lower bound of the 7d window)
 * @returns {Promise<{
 *   mode_mix: {monet: number, traffic: number, total: number},
 *   top3_social: Array<{id: string, copy_headline: string|null, engagements: number}>,
 *   breakout_count: number,
 *   follower_delta: {brand: string, first: number|null, last: number|null, delta: number|null}|null,
 *   boost_summary: {spend_pence: number, new_follows: number, cost_per_follower_pence: number|null, runs: number},
 *   suppression_activity: {added: number}|null,
 *   sequence_health: {active: number, paused: number}|null,
 * }>}
 */
async function getWeeklyReview(from) {
  const [mode_mix, top3_social, breakout_count, follower_delta, boost_summary, suppression_activity, sequence_health] =
    await Promise.all([
      _getModeMix(from),
      _getTop3SocialByEngagement(from),
      _getBreakoutCount(from),
      _getFollowerDelta(from),
      _getBoostSummary(from),
      _getSuppressionActivity(from),
      _getSequenceHealth(),
    ]);

  return {
    mode_mix,
    top3_social,
    breakout_count,
    follower_delta,
    boost_summary,
    suppression_activity,
    sequence_health,
  };
}

async function _getModeMix(from) {
  // Same logic as helpers.getSocialModeCounts but window-anchored on `from`
  // rather than days-back. Avoids cross-import surface widening on
  // helpers.js (which would otherwise need a new arg shape).
  const { data, error } = await supabase
    .from('posts')
    .select('meta')
    .eq('track', SOCIAL_TRACK)
    .gte('created_at', from);
  if (error) throw new Error(`getWeeklyReview mode_mix failed: ${error.message}`);
  let monet = 0; let traffic = 0;
  for (const row of data || []) {
    const m = row && row.meta && row.meta.social_mode;
    if (m === 'monet') monet += 1;
    else if (m === 'traffic') traffic += 1;
  }
  return { monet, traffic, total: monet + traffic };
}

async function _getTop3SocialByEngagement(from) {
  // Pull recent social posts + their latest post_metrics engagement, top
  // 3 by engagement. Two queries: posts first (small set), then
  // post_metrics for those ids.
  const { data: posts, error: errPosts } = await supabase
    .from('posts')
    .select('id, copy_headline, published_at')
    .eq('track', SOCIAL_TRACK)
    .gte('published_at', from);
  if (errPosts) throw new Error(`getWeeklyReview top3 posts failed: ${errPosts.message}`);
  if (!posts || posts.length === 0) return [];

  const ids = posts.map((p) => p.id);
  const { data: metrics, error: errMetrics } = await supabase
    .from('post_metrics')
    .select('post_id, engagements, fetched_at')
    .in('post_id', ids)
    .order('fetched_at', { ascending: false });
  if (errMetrics) {
    // post_metrics may not exist on some envs — degrade gracefully.
    if (/relation .* does not exist/i.test(errMetrics.message || '')) return [];
    throw new Error(`getWeeklyReview top3 metrics failed: ${errMetrics.message}`);
  }
  // Pick latest engagements row per post.
  const latest = new Map();
  for (const m of metrics || []) {
    if (!latest.has(m.post_id)) latest.set(m.post_id, Number(m.engagements) || 0);
  }
  const ranked = posts
    .map((p) => ({
      id: p.id,
      copy_headline: p.copy_headline || null,
      engagements: latest.get(p.id) || 0,
    }))
    .filter((p) => p.engagements > 0)
    .sort((a, b) => b.engagements - a.engagements)
    .slice(0, 3);
  return ranked;
}

async function _getBreakoutCount(from) {
  // Count posts.meta.breakout_score >= BREAKOUT_THRESHOLD AND
  // posts.meta.breakout_detected_at in the window. We can't filter inside
  // jsonb with a numeric comparison via PostgREST without a custom RPC, so
  // fetch the meta column + filter client-side. Small set (≤ tens of rows).
  const { data, error } = await supabase
    .from('posts')
    .select('id, meta, published_at')
    .eq('track', SOCIAL_TRACK)
    .gte('published_at', from);
  if (error) throw new Error(`getWeeklyReview breakout_count failed: ${error.message}`);
  let n = 0;
  for (const row of data || []) {
    const score = Number(row.meta && row.meta.breakout_score);
    if (Number.isFinite(score) && score >= BREAKOUT_THRESHOLD) n += 1;
  }
  return n;
}

async function _getFollowerDelta(from) {
  // Follower delta over the window for SOCIAL_BRAND. Returns null when
  // there's < 2 rows in the window (delta undefined).
  const fromDate = from.slice(0, 10); // social_audience_daily.recorded_at is DATE
  const { data, error } = await supabase
    .from('social_audience_daily')
    .select('recorded_at, followers_count')
    .eq('brand', SOCIAL_BRAND)
    .gte('recorded_at', fromDate)
    .order('recorded_at', { ascending: true });
  if (error) {
    if (/relation .* does not exist/i.test(error.message || '')) {
      return { brand: SOCIAL_BRAND, first: null, last: null, delta: null };
    }
    throw new Error(`getWeeklyReview follower_delta failed: ${error.message}`);
  }
  if (!data || data.length < 2) {
    const only = data && data.length === 1 ? Number(data[0].followers_count) : null;
    return { brand: SOCIAL_BRAND, first: only, last: only, delta: null };
  }
  const first = Number(data[0].followers_count);
  const last = Number(data[data.length - 1].followers_count);
  return {
    brand: SOCIAL_BRAND,
    first: Number.isFinite(first) ? first : null,
    last: Number.isFinite(last) ? last : null,
    delta: Number.isFinite(first) && Number.isFinite(last) ? last - first : null,
  };
}

async function _getBoostSummary(from) {
  // Sum spend_pence + ad_new_follows over boost_runs created in window.
  // Compute cost-per-follower only when new_follows > 0 (else null — a
  // £0/follower divide-by-zero would misrepresent reality).
  const { data, error } = await supabase
    .from('boost_runs')
    .select('id, spend_pence, ad_new_follows, status, created_at')
    .gte('created_at', from);
  if (error) {
    if (/relation .* does not exist/i.test(error.message || '')) {
      return { spend_pence: 0, new_follows: 0, cost_per_follower_pence: null, runs: 0 };
    }
    throw new Error(`getWeeklyReview boost_summary failed: ${error.message}`);
  }
  let spend = 0; let follows = 0; let runs = 0;
  for (const r of data || []) {
    runs += 1;
    spend += Number(r.spend_pence) || 0;
    follows += Number(r.ad_new_follows) || 0;
  }
  return {
    spend_pence: spend,
    new_follows: follows,
    cost_per_follower_pence: follows > 0 ? spend / follows : null,
    runs,
  };
}

async function _getSuppressionActivity(from) {
  // Count rows added to the suppression list in the window. Optional
  // table — degrade to null on relation-missing so the Performance tab
  // still renders pre-Phase B.
  const { count, error } = await supabase
    .from('suppression')
    .select('email_or_domain', { count: 'exact', head: true })
    .gte('created_at', from);
  if (error) {
    if (/relation .* does not exist/i.test(error.message || '')) return null;
    // 'column "created_at" does not exist' is also tolerated — the
    // suppression table predates the column being a stable assumption.
    if (/column .* does not exist/i.test(error.message || '')) return null;
    throw new Error(`getWeeklyReview suppression_activity failed: ${error.message}`);
  }
  return { added: count || 0 };
}

async function _getSequenceHealth() {
  // Active vs paused sequence counts. Optional table — degrade to null
  // when missing.
  const { data, error } = await supabase
    .from('sequences')
    .select('id, status');
  if (error) {
    if (/relation .* does not exist/i.test(error.message || '')) return null;
    throw new Error(`getWeeklyReview sequence_health failed: ${error.message}`);
  }
  let active = 0; let paused = 0;
  for (const s of data || []) {
    if (s.status === 'active') active += 1;
    else if (s.status === 'paused') paused += 1;
  }
  return { active, paused };
}

// ── HTML fragment renderer ────────────────────────────────────────────────

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('en-GB');
}

/**
 * Render the inner #perf-content fragment for the Performance tab.
 * The wrapper (window selector + outer chrome) lives in
 * routes/dashboard/performance.html. This is what HTMX swaps in.
 *
 * @param {object} args
 * @param {number|'all'} args.windowDays
 * @param {object} args.metrics
 * @returns {string} HTML fragment
 */
function renderPerformanceFragment({ windowDays, metrics }) {
  const winLabel = windowDays === 'all' ? 'all time' : `last ${windowDays} days`;
  const top3 = (metrics.content.recent_top3 || []).map((p) => {
    return `<li>${escHtml(p.copy_headline || '(no headline)')} — ${fmtNum(p.engagement)} engagements</li>`;
  }).join('') || '<li class="empty">No engagement data in this window.</li>';

  const tracks = ['lender', 'broker', 'auction_house'];
  const rowLabels = [
    ['prospects',        'Prospects'],
    ['contacts',         'Contacts'],
    ['sequences_active', 'Sequences'],
    ['sent',             'Sent'],
    ['opens',            'Opens'],
    ['replies',          'Replies'],
    ['interested',       'Interested'],
    ['meetings',         'Meetings'],
  ];
  const headerCells = tracks.map(t => `<th>${escHtml(t)}</th>`).join('');
  const bodyRows = rowLabels.map(([key, label]) => {
    const cells = tracks.map(t => `<td>${fmtNum((metrics.outbound[t] || {})[key])}</td>`).join('');
    return `<tr><th scope="row">${escHtml(label)}</th>${cells}</tr>`;
  }).join('\n');

  const weeklyReviewHtml = renderWeeklyReview(metrics.weekly_review);

  return `${weeklyReviewHtml}<section class="perf-section">
  <h3>Content engagement <span class="perf-window">— ${escHtml(winLabel)}</span></h3>
  <dl class="perf-content-stats">
    <div><dt>Posts published</dt><dd>${fmtNum(metrics.content.posts_count)}</dd></div>
    <div><dt>FB reach</dt><dd>${fmtNum(metrics.content.fb_reach)}</dd></div>
    <div><dt>FB engagement</dt><dd>${fmtNum(metrics.content.fb_engagement)}</dd></div>
  </dl>
  <p class="perf-sub">Top 3 by engagement</p>
  <ol class="perf-top3">${top3}</ol>
</section>

<section class="perf-section">
  <h3>Outbound conversion <span class="perf-window">— ${escHtml(winLabel)}</span></h3>
  <table class="perf-funnel-table">
    <thead><tr><th scope="col">Metric</th>${headerCells}</tr></thead>
    <tbody>${bodyRows}</tbody>
  </table>
</section>`;
}

/**
 * Render the Phase G-4 weekly review section. Always rendered above the
 * existing perf sections. Returns '' when metrics.weekly_review is missing
 * (defensive — getMetrics always populates it, but legacy callers might
 * pass a hand-built metrics object).
 */
function renderWeeklyReview(wr) {
  if (!wr) return '';
  const mm = wr.mode_mix || { monet: 0, traffic: 0, total: 0 };
  const fd = wr.follower_delta;
  const bs = wr.boost_summary || { spend_pence: 0, new_follows: 0, cost_per_follower_pence: null, runs: 0 };
  const sa = wr.suppression_activity;
  const sh = wr.sequence_health;

  // Helpers for £ formatting — spend stored in pence, display in £.
  const fmtGbp = (pence) => {
    if (pence == null) return '—';
    const p = Number(pence);
    if (!Number.isFinite(p)) return '—';
    return `£${(p / 100).toFixed(2)}`;
  };
  const fmtSigned = (n) => {
    if (n == null) return '—';
    const v = Number(n);
    if (!Number.isFinite(v)) return '—';
    if (v > 0) return `+${fmtNum(v)}`;
    return fmtNum(v);
  };

  const top3 = (wr.top3_social || []).map((p) => (
    `<li>${escHtml(p.copy_headline || '(no headline)')} — ${fmtNum(p.engagements)} engagements</li>`
  )).join('') || '<li class="empty">No social engagement data this week.</li>';

  const suppressionLine = sa
    ? `<div><dt>Suppressions added</dt><dd>${fmtNum(sa.added)}</dd></div>`
    : '';
  const sequenceLine = sh
    ? `<div><dt>Sequences (active / paused)</dt><dd>${fmtNum(sh.active)} / ${fmtNum(sh.paused)}</dd></div>`
    : '';

  return `<section class="perf-section perf-weekly-review">
  <h3>Weekly review <span class="perf-window">— last 7 days</span></h3>
  <dl class="perf-weekly-stats">
    <div><dt>Posts (monet / traffic)</dt><dd>${fmtNum(mm.monet)} / ${fmtNum(mm.traffic)}</dd></div>
    <div><dt>Breakouts detected</dt><dd>${fmtNum(wr.breakout_count)}</dd></div>
    <div><dt>Follower delta</dt><dd>${fmtSigned(fd && fd.delta)}</dd></div>
    <div><dt>Boost spend</dt><dd>${fmtGbp(bs.spend_pence)}</dd></div>
    <div><dt>New follows from boost</dt><dd>${fmtNum(bs.new_follows)}</dd></div>
    <div><dt>Cost per follower</dt><dd>${fmtGbp(bs.cost_per_follower_pence)}</dd></div>
    ${suppressionLine}
    ${sequenceLine}
  </dl>
  <p class="perf-sub">Top 3 social posts by engagement</p>
  <ol class="perf-top3">${top3}</ol>
</section>

`;
}

module.exports = {
  getMetrics,
  getContentMetrics,
  getOutboundMetricsForTrack,
  getWeeklyReview,
  renderPerformanceFragment,
  renderWeeklyReview,
  windowStart,
  TRACKS,
  WEEKLY_REVIEW_DAYS,
};
