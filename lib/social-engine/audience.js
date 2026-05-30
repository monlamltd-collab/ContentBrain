// Phase G-3 — daily FB Page audience snapshot.
//
// Why in-code, not in Make: see .ruflo/phase-g3-design.md §2.1. TL;DR —
// op budget + single source of FB Graph integration + audience must
// keep landing daily so PR4 dashboard never has gaps even if Make is
// paused.
//
// Reads /<page_id>?fields=fan_count,followers_count per active brand and
// upserts via helpers.upsertAudienceSnapshot. Brands run independently —
// a token error on one does NOT block the other. Errors surface via
// console.warn + sendNotification, never thrown out of
// runDailyAudienceSnapshot.
//
// Scheduled by server.js at 06:30 UTC daily — AFTER the 06:00 UTC
// reconcile so same-day rows in social_audience_daily + boost_runs align.

'use strict';

const { upsertAudienceSnapshot } = require('./helpers');

/**
 * Per-brand env keys. Both brands snapshotted daily so PR4 dashboard
 * can show side-by-side trajectories. BridgeMatch is silently skipped
 * when its env is unset — AuctionBrain continues.
 */
const PAGE_IDS = {
  auctionbrain: {
    brand: 'auctionbrain',
    pageEnv: 'FB_PAGE_ID',
    tokenEnv: 'FB_PAGE_ACCESS_TOKEN',
  },
  bridgematch: {
    brand: 'bridgematch',
    pageEnv: 'FB_BRIDGEMATCH_PAGE_ID',
    tokenEnv: 'FB_BRIDGEMATCH_PAGE_TOKEN',
  },
};

/**
 * Pull one brand's audience snapshot from FB Graph and upsert it.
 *
 * Silent skip + log when the brand's page id or token env is unset
 * (returns null). Throws on Graph API errors so the caller's per-brand
 * try/catch in runDailyAudienceSnapshot can surface the failure without
 * aborting the next brand.
 *
 * @param {'auctionbrain'|'bridgematch'} brandKey
 * @returns {Promise<object|null>}  upserted row, or null on skip
 */
async function snapshotPageAudience(brandKey) {
  const cfg = PAGE_IDS[brandKey];
  if (!cfg) throw new Error(`snapshotPageAudience: unknown brand '${brandKey}'`);

  const page_id = process.env[cfg.pageEnv];
  if (!page_id) {
    console.warn(`[audience] ${brandKey}: env ${cfg.pageEnv} unset — skip`);
    return null;
  }

  const token = process.env[cfg.tokenEnv];
  if (!token) {
    console.warn(`[audience] ${brandKey}: env ${cfg.tokenEnv} unset — skip`);
    return null;
  }

  const url = `https://graph.facebook.com/v22.0/${encodeURIComponent(page_id)}?fields=fan_count,followers_count&access_token=${encodeURIComponent(token)}`;

  const resp = await fetch(url);
  if (!resp.ok) {
    let body = '';
    try { body = await resp.text(); } catch (_) { /* ignore */ }
    throw new Error(`[audience] ${brandKey}: graph ${resp.status}: ${String(body).slice(0, 200)}`);
  }

  const data = await resp.json();
  const followers_count = Number(data && (data.followers_count != null ? data.followers_count : data.fan_count));
  if (!Number.isFinite(followers_count)) {
    throw new Error(`[audience] ${brandKey}: graph response missing followers_count/fan_count: ${JSON.stringify(data).slice(0, 200)}`);
  }
  const fans_count = Number.isFinite(Number(data && data.fan_count)) ? Number(data.fan_count) : undefined;

  const row = await upsertAudienceSnapshot({
    brand: cfg.brand,
    page_id,
    followers_count,
    fans_count,
  });
  console.log(`[audience] ${brandKey}: followers=${followers_count} delta=${row && row.follows_delta != null ? row.follows_delta : 'n/a'}`);
  return row;
}

/**
 * Run the daily snapshot for every brand in PAGE_IDS sequentially. Each
 * brand is independently try/catched so one failure does NOT block the
 * next brand. Failures are summarised via a single Telegram notification
 * (one message even for multi-brand failures, to avoid spam).
 *
 * Never throws. Always returns the result object.
 *
 * @returns {Promise<{successes: Array<{brand: string, row: object|null}>, failures: Array<{brand: string, error: string}>}>}
 */
async function runDailyAudienceSnapshot() {
  const successes = [];
  const failures = [];

  for (const brandKey of Object.keys(PAGE_IDS)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const row = await snapshotPageAudience(brandKey);
      successes.push({ brand: brandKey, row });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`[audience] ${brandKey}: ${message}`);
      failures.push({ brand: brandKey, error: message });
    }
  }

  if (failures.length > 0) {
    try {
      const { sendNotification } = require('../telegram');
      const lines = failures.map(f => `- ${f.brand}: ${f.error.slice(0, 160)}`);
      await sendNotification(`Audience snapshot failed for ${failures.length} brand(s):\n${lines.join('\n')}`);
    } catch (notifyErr) {
      // Never let a Telegram outage cascade out of the cron handler.
      console.warn(`[audience] sendNotification failed: ${notifyErr.message}`);
    }
  }

  return { successes, failures };
}

module.exports = { snapshotPageAudience, runDailyAudienceSnapshot, PAGE_IDS };

// CLI entry — manual test:
//   node lib/social-engine/audience.js auctionbrain
//   node lib/social-engine/audience.js          (runs both via runDailyAudienceSnapshot)
if (require.main === module) {
  (async () => {
    const arg = process.argv[2];
    try {
      if (arg && PAGE_IDS[arg]) {
        const row = await snapshotPageAudience(arg);
        console.log(`[audience cli] ${arg}: ${row ? JSON.stringify(row, null, 2) : 'skipped'}`);
      } else {
        const out = await runDailyAudienceSnapshot();
        console.log(`[audience cli] runDailyAudienceSnapshot: ${JSON.stringify(out, null, 2)}`);
      }
    } catch (err) {
      console.error(`[audience cli] error: ${err.message}`);
      process.exit(1);
    }
  })();
}
