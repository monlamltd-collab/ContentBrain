// Phase G-4 — Telegram alert dedup / throttle.
//
// Thin wrapper around lib/telegram.js#sendNotification with two surfaces:
//
//   alertOnce(eventType, identityKey, messageFn)
//     - Fires sendNotification IF (eventType, identityKey) hasn't fired in
//       the last ONCE_TTL_MS (24h). Used for "this post is a breakout" —
//       once per post per day, ever.
//
//   alertThrottled(eventType, identityKey, messageFn)
//     - 5-minute sliding window per (eventType, identityKey). First
//       MAX_ALERTS_PER_WINDOW calls fire normally; subsequent calls within
//       the window are suppressed but COUNTED. When the window closes, a
//       single summary fires: "Throttled N more alerts in last 5 min".
//
// In-memory only — process restart resets state. That's fine: a restart
// is rare (Railway redeploy ~weekly) and the same-restart scenario is
// "boost failed 10x in 30s" which 5-min dedup absorbs even on cold-cache.
//
// No external dependency (no Redis, no DB). Self-prunes hourly.
//
// See .ruflo/phase-g4-design.md §4.

'use strict';

const { sendNotification } = require('../telegram');

const ONCE_TTL_MS = 24 * 60 * 60 * 1000;     // 24h for alertOnce
const WINDOW_MS = 5 * 60 * 1000;             // 5min sliding window
const MAX_ALERTS_PER_WINDOW = 3;             // first 3 fire normally
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;    // hourly self-prune

/** @type {Map<string, {firstAt: number, lastAt: number, count: number, suppressed: number, summaryTimer: NodeJS.Timeout|null}>} */
const _state = new Map();

function _key(eventType, identityKey) {
  return `${eventType}::${identityKey}`;
}

// Self-prune: every hour, drop entries older than ONCE_TTL_MS. Keeps the
// map bounded even if eventType/identityKey cardinality is unbounded.
const _pruneInterval = setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _state) {
    if (now - v.lastAt > ONCE_TTL_MS) {
      if (v.summaryTimer) clearTimeout(v.summaryTimer);
      _state.delete(k);
    }
  }
}, PRUNE_INTERVAL_MS);
if (_pruneInterval.unref) _pruneInterval.unref();

/**
 * Send a Telegram notification at most once per (eventType, identityKey)
 * in any ONCE_TTL_MS (24h) window. Subsequent calls within the window are
 * silent.
 *
 * @param {string} eventType   short stable string (e.g. 'breakout-detected')
 * @param {string} identityKey unique per-event id (e.g. post_id)
 * @param {() => string} messageFn  invoked only when the alert fires
 * @returns {Promise<{fired: boolean, reason?: string, error?: string}>}
 */
async function alertOnce(eventType, identityKey, messageFn) {
  const k = _key(eventType, identityKey);
  const now = Date.now();
  const existing = _state.get(k);

  if (existing && now - existing.lastAt < ONCE_TTL_MS) {
    return { fired: false, reason: 'within-once-ttl' };
  }

  // Record FIRST so a sendNotification that throws still blocks repeats.
  _state.set(k, { firstAt: now, lastAt: now, count: 1, suppressed: 0, summaryTimer: null });

  try {
    await sendNotification(messageFn());
    return { fired: true };
  } catch (err) {
    // Telegram outage must not throw out of the throttle — caller's
    // pipeline shouldn't break because the side-channel is down.
    return { fired: false, error: err && err.message ? err.message : String(err) };
  }
}

/**
 * Send a Telegram notification with a sliding-window throttle. The first
 * MAX_ALERTS_PER_WINDOW calls per (eventType, identityKey) fire normally.
 * Subsequent calls within WINDOW_MS are suppressed and counted; a single
 * summary message fires after the window closes if any were suppressed.
 *
 * @param {string} eventType
 * @param {string} identityKey
 * @param {() => string} messageFn
 * @returns {Promise<{fired: boolean, count?: number, reason?: string, error?: string}>}
 */
async function alertThrottled(eventType, identityKey, messageFn) {
  const k = _key(eventType, identityKey);
  const now = Date.now();
  let s = _state.get(k);

  // Fresh entry or expired window — reset counts.
  if (!s || now - s.firstAt > WINDOW_MS) {
    if (s && s.summaryTimer) clearTimeout(s.summaryTimer);
    s = { firstAt: now, lastAt: now, count: 0, suppressed: 0, summaryTimer: null };
    _state.set(k, s);
  }

  s.count += 1;
  s.lastAt = now;

  if (s.count <= MAX_ALERTS_PER_WINDOW) {
    try {
      await sendNotification(messageFn());
      return { fired: true, count: s.count };
    } catch (err) {
      return { fired: false, error: err && err.message ? err.message : String(err) };
    }
  }

  // Suppressed. Schedule the summary if one isn't queued yet.
  s.suppressed += 1;
  if (!s.summaryTimer) {
    s.summaryTimer = setTimeout(async () => {
      const cur = _state.get(k);
      if (!cur || cur.suppressed === 0) {
        if (cur) cur.summaryTimer = null;
        return;
      }
      const n = cur.suppressed;
      cur.suppressed = 0;
      cur.summaryTimer = null;
      try {
        await sendNotification(
          `<i>Throttled ${n} more "${eventType}" alert(s) for ${identityKey} in the last ${Math.round(WINDOW_MS / 60000)} min.</i>`
        );
      } catch (_) {
        // Telegram outage during summary — drop quietly. The next alert
        // that fires will already have caller-side context anyway.
      }
    }, WINDOW_MS);
    if (s.summaryTimer.unref) s.summaryTimer.unref();
  }
  return { fired: false, reason: 'throttled', count: s.count };
}

// Test hook — clear all state + timers between unit tests.
function _resetForTests() {
  for (const [, v] of _state) {
    if (v.summaryTimer) clearTimeout(v.summaryTimer);
  }
  _state.clear();
}

module.exports = {
  alertOnce,
  alertThrottled,
  _resetForTests,
  ONCE_TTL_MS,
  WINDOW_MS,
  MAX_ALERTS_PER_WINDOW,
};
