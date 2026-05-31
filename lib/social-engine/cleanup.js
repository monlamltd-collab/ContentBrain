// Phase G-4 — boost_runs cleanup. Stops 'pending' rows accumulating
// when Make fails to call back on /api/social-boost-callback. Same shape
// as audience.js (PR3) — one function the cron calls.
//
// Algorithm (see .ruflo/phase-g4-design.md §3.2):
//   1. SELECT all boost_runs WHERE status='pending' AND created_at < now-24h
//   2. For each, UPDATE status='failed', meta = merge({ended_reason: 'make_no_callback'}),
//      ended_at = now
//   3. If aged-out count >= STALE_PENDING_ALERT_THRESHOLD, fire one
//      throttled Telegram alert (1+ alerts/day = silent, 5+ = actionable)
//
// Why 'failed' not 'cancelled' — the BOOST_STATUSES enum is
// ['pending','active','complete','failed']; adding 'cancelled' would
// force a constants change + downstream filter updates for a label-only
// gain. 'failed' + meta.ended_reason='make_no_callback' is sufficient
// for grep + postmortem.
//
// Cron registration: server.js 04:00 UTC (quiet hour, well before any
// other social-engine cron).

'use strict';

const { supabase } = require('../supabase');
const { alertThrottled } = require('./telegram-throttle');

const STALE_PENDING_HOURS = 24;
const STALE_PENDING_ALERT_THRESHOLD = 5;

/**
 * Find all boost_runs rows stuck at status='pending' for longer than
 * STALE_PENDING_HOURS and flip them to status='failed' with
 * meta.ended_reason='make_no_callback'. Returns the affected ids for
 * logging.
 *
 * Per-row UPDATE failures are logged but do NOT abort the loop — one bad
 * row mustn't block cleanup of the rest.
 *
 * @param {{now?: Date}} [opts]
 * @returns {Promise<{aged_out: number, ids: string[]}>}
 */
async function reconcileStalePending({ now = new Date() } = {}) {
  const cutoff = new Date(now.getTime() - STALE_PENDING_HOURS * 60 * 60 * 1000).toISOString();

  // Read first so we can return the affected ids for logging + alerting.
  const { data: stale, error: readErr } = await supabase
    .from('boost_runs')
    .select('id, post_id, created_at, meta')
    .eq('status', 'pending')
    .lt('created_at', cutoff);
  if (readErr) throw new Error(`reconcileStalePending read failed: ${readErr.message}`);
  if (!stale || stale.length === 0) {
    return { aged_out: 0, ids: [] };
  }

  // Update each row; merge meta so niche_tag/source/etc are preserved.
  const ids = [];
  for (const row of stale) {
    const newMeta = { ...(row.meta || {}), ended_reason: 'make_no_callback' };
    // eslint-disable-next-line no-await-in-loop
    const { error: upErr } = await supabase
      .from('boost_runs')
      .update({ status: 'failed', meta: newMeta, ended_at: now.toISOString() })
      .eq('id', row.id);
    if (upErr) {
      console.warn(`[cleanup] failed to age-out boost_run ${row.id}: ${upErr.message}`);
      continue;
    }
    ids.push(row.id);
  }

  // Alert if this run aged out enough to indicate a systemic Make issue.
  if (ids.length >= STALE_PENDING_ALERT_THRESHOLD) {
    try {
      await alertThrottled(
        'stale-pending-cleanup',
        'global',
        () => `<b>Stale boost cleanup:</b> ${ids.length} pending row(s) failed-out as 'make_no_callback'. `
          + `Check Make scenario health. First 5: ${ids.slice(0, 5).join(', ')}`
      );
    } catch (notifyErr) {
      // Telegram outage must not bubble out of the cron handler.
      console.warn(`[cleanup] alertThrottled failed: ${notifyErr.message}`);
    }
  }

  console.log(`[cleanup] aged out ${ids.length} stale 'pending' boost_runs (cutoff=${cutoff})`);
  return { aged_out: ids.length, ids };
}

module.exports = {
  reconcileStalePending,
  STALE_PENDING_HOURS,
  STALE_PENDING_ALERT_THRESHOLD,
};

// CLI entry — manual one-shot:  node lib/social-engine/cleanup.js
if (require.main === module) {
  (async () => {
    try {
      const r = await reconcileStalePending();
      console.log(`[cleanup cli] ${JSON.stringify(r, null, 2)}`);
    } catch (err) {
      console.error(`[cleanup cli] error: ${err.message}`);
      process.exit(1);
    }
  })();
}
