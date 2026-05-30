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
//
// Test surface — tests/social-engine/audience.test.js (coder writes):
//   - fetchAudienceSnapshot('auctionbrain') stubs global.fetch + getToken,
//     asserts the URL shape and that upsertAudienceSnapshot is called
//     with the parsed fan_count + followers_count.
//   - fetchAudienceSnapshot returns null when FB_PAGE_ID unset (does NOT
//     throw — bridgematch case where env may be partially set).
//   - fetchAudienceSnapshot returns null and logs when getToken returns
//     null for the brand.
//   - fetchAudienceSnapshot throws when the Graph API returns a 4xx/5xx
//     so the caller's try/catch in runDailyAudienceSnapshot can surface it.
//   - runDailyAudienceSnapshot stubs fetchAudienceSnapshot per brand,
//     asserts both brands are attempted even when auctionbrain throws.

'use strict';

const { upsertAudienceSnapshot } = require('./helpers');

/**
 * Per-brand env keys. Both brands snapshotted daily so PR4 dashboard
 * can show side-by-side trajectories. BridgeMatch is silently skipped
 * when FB_BRIDGEMATCH_PAGE_ID is unset — AuctionBrain continues.
 */
const PAGE_IDS = {
  auctionbrain: { brand: 'auctionbrain', envId: 'FB_PAGE_ID' },
  bridgematch:  { brand: 'bridgematch',  envId: 'FB_BRIDGEMATCH_PAGE_ID' },
};

/**
 * Pull one brand's audience snapshot from FB Graph and upsert it.
 *
 * @param {'auctionbrain'|'bridgematch'} brandKey
 * @returns {Promise<object|null>}  upserted row, or null on per-brand skip
 *                                  (missing env, missing token). Throws
 *                                  on Graph API errors so runDailyAudienceSnapshot
 *                                  can mark this brand as failed without
 *                                  aborting the next one.
 */
async function snapshotPageAudience(brandKey) {
  // Stub for coder — pseudo:
  //   const cfg = PAGE_IDS[brandKey]; if (!cfg) throw new Error(`unknown brand ${brandKey}`)
  //   const page_id = process.env[cfg.envId]; if (!page_id) { console.warn(`[audience] ${brandKey}: env ${cfg.envId} unset — skip`); return null }
  //   const { getToken } = require('../insights');
  //   const token = getToken(brandKey); if (!token) { console.warn(`[audience] ${brandKey}: no token — skip`); return null }
  //   const url = `https://graph.facebook.com/v22.0/${page_id}?fields=fan_count,followers_count&access_token=${encodeURIComponent(token)}`
  //   const resp = await fetch(url); if (!resp.ok) throw new Error(`graph ${resp.status}: ${await resp.text()}`)
  //   const data = await resp.json()
  //   const followers_count = Number(data.followers_count ?? data.fan_count)
  //   if (!Number.isFinite(followers_count)) throw new Error(`graph response missing followers_count: ${JSON.stringify(data).slice(0,160)}`)
  //   return upsertAudienceSnapshot({ brand: cfg.brand, page_id, followers_count, fans_count: data.fan_count })
  throw new Error('NOT_IMPLEMENTED: snapshotPageAudience');
}

/**
 * Run the daily snapshot for every brand in PAGE_IDS sequentially. Each
 * brand is independently try/catched so one failure does NOT block the
 * next brand. Failures are summarised via a single Telegram notification
 * at the end (one message even for multi-brand failures, to avoid spam).
 *
 * @returns {Promise<{successes: Array<{brand: string, row: object}>, failures: Array<{brand: string, error: string}>}>}
 */
async function runDailyAudienceSnapshot() {
  // Stub for coder — iterate Object.keys(PAGE_IDS), call snapshotPageAudience
  // in try/catch. Collect successes / failures. If failures.length > 0,
  // sendNotification one line summarising the failed brands + error
  // messages (joined). Always return the result object — never throw.
  throw new Error('NOT_IMPLEMENTED: runDailyAudienceSnapshot');
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
