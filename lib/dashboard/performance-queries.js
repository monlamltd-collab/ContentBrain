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

const TRACKS = Object.freeze(['lender', 'broker', 'auction_house']);

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

  return {
    window: { days: windowDays, from, to },
    content,
    outbound,
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
  const top3 = (metrics.content.recent_top3 || []).map((p, i) => {
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

  return `<section class="perf-section">
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

module.exports = {
  getMetrics,
  getContentMetrics,
  getOutboundMetricsForTrack,
  renderPerformanceFragment,
  windowStart,
  TRACKS,
};
