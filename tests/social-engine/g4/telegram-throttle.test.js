// Phase G-4 — telegram-throttle coverage.
//
// Mocks lib/telegram.js#sendNotification via require.cache injection
// (matching tests/social-engine/g3/audience.test.js). Uses node:test
// mock.timers for the 5-min sliding window + 24h once-TTL assertions
// without actually sleeping.
//
// Cases:
//   alertOnce:
//     - fires first time, returns {fired: true}
//     - blocks the second call within 24h, returns {fired: false, reason: 'within-once-ttl'}
//     - fires again after 24h elapses
//     - Telegram throw returns {fired: false, error: ...} (does not throw)
//     - records state BEFORE sendNotification — failed send still blocks repeats
//
//   alertThrottled:
//     - first 3 calls fire normally with incrementing count
//     - 4th call within 5min returns {fired: false, reason: 'throttled'}
//     - summary fires once after WINDOW_MS elapses, with suppressed count
//     - new call after window resets the counter
//     - Telegram throw on fire returns {fired: false, error}
//     - per-key isolation: different identityKey doesn't share state
//
//   _resetForTests clears all state and pending summary timers

'use strict';

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { mock } = require('node:test');

const MOD_PATH = require.resolve('../../../lib/social-engine/telegram-throttle');
const TELEGRAM_PATH = require.resolve('../../../lib/telegram');

let notifyCalls;
let nextNotifyResult; // 'ok' | 'throw' | Error
let mod;

function loadFresh() {
  delete require.cache[MOD_PATH];
  delete require.cache[TELEGRAM_PATH];

  require.cache[TELEGRAM_PATH] = {
    id: TELEGRAM_PATH,
    filename: TELEGRAM_PATH,
    loaded: true,
    exports: {
      sendNotification: async (msg) => {
        notifyCalls.push(msg);
        if (nextNotifyResult === 'throw') {
          throw new Error('telegram-down');
        }
        if (nextNotifyResult instanceof Error) {
          throw nextNotifyResult;
        }
        return true;
      },
    },
  };

  return require('../../../lib/social-engine/telegram-throttle');
}

beforeEach(() => {
  notifyCalls = [];
  nextNotifyResult = 'ok';
  mod = loadFresh();
});

afterEach(() => {
  if (mod && mod._resetForTests) mod._resetForTests();
  // Always restore real timers in case a test enabled them.
  try { mock.timers.reset(); } catch (_) { /* ignore — not enabled */ }
});

// ── alertOnce ─────────────────────────────────────────────────────────────

test('alertOnce: first call fires sendNotification', async () => {
  const r = await mod.alertOnce('breakout-detected', 'post-1', () => 'first breakout');
  assert.equal(r.fired, true);
  assert.equal(notifyCalls.length, 1);
  assert.equal(notifyCalls[0], 'first breakout');
});

test('alertOnce: second call within 24h is suppressed', async () => {
  await mod.alertOnce('breakout-detected', 'post-1', () => 'msg-1');
  const r = await mod.alertOnce('breakout-detected', 'post-1', () => 'msg-2');
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'within-once-ttl');
  assert.equal(notifyCalls.length, 1, 'only the first message should fire');
});

test('alertOnce: fires again after 24h elapses', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  await mod.alertOnce('breakout-detected', 'post-1', () => 'first');
  // Advance just past the 24h window.
  mock.timers.tick(mod.ONCE_TTL_MS + 1000);
  const r = await mod.alertOnce('breakout-detected', 'post-1', () => 'second');
  assert.equal(r.fired, true);
  assert.equal(notifyCalls.length, 2);
});

test('alertOnce: Telegram throw returns {fired:false, error} — does not throw', async () => {
  nextNotifyResult = 'throw';
  const r = await mod.alertOnce('breakout-detected', 'post-1', () => 'msg');
  assert.equal(r.fired, false);
  assert.match(r.error || '', /telegram-down/);
});

test('alertOnce: failed sendNotification still blocks repeats within window', async () => {
  nextNotifyResult = 'throw';
  await mod.alertOnce('breakout-detected', 'post-1', () => 'msg-1');
  // Even though the first send failed, we recorded state — repeats blocked.
  nextNotifyResult = 'ok';
  const r = await mod.alertOnce('breakout-detected', 'post-1', () => 'msg-2');
  assert.equal(r.fired, false);
  assert.equal(r.reason, 'within-once-ttl');
  assert.equal(notifyCalls.length, 1, 'only the failed first attempt should have been called');
});

test('alertOnce: different identityKey is independent', async () => {
  await mod.alertOnce('breakout-detected', 'post-1', () => 'a');
  const r = await mod.alertOnce('breakout-detected', 'post-2', () => 'b');
  assert.equal(r.fired, true);
  assert.equal(notifyCalls.length, 2);
});

// ── alertThrottled ────────────────────────────────────────────────────────

test('alertThrottled: first 3 calls fire normally with incrementing count', async () => {
  const r1 = await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'fail-1');
  const r2 = await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'fail-2');
  const r3 = await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'fail-3');
  assert.equal(r1.fired, true); assert.equal(r1.count, 1);
  assert.equal(r2.fired, true); assert.equal(r2.count, 2);
  assert.equal(r3.fired, true); assert.equal(r3.count, 3);
  assert.equal(notifyCalls.length, 3);
});

test('alertThrottled: 4th call within window returns {fired:false, reason:"throttled"}', async () => {
  for (let i = 0; i < 3; i += 1) {
    await mod.alertThrottled('boost-hook-failed', 'post-1', () => `m${i}`);
  }
  const r4 = await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'm4');
  assert.equal(r4.fired, false);
  assert.equal(r4.reason, 'throttled');
  assert.equal(notifyCalls.length, 3, 'no extra send for the throttled call');
});

test('alertThrottled: summary fires once after WINDOW_MS with suppressed count', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  for (let i = 0; i < 3; i += 1) {
    await mod.alertThrottled('boost-hook-failed', 'post-1', () => `m${i}`);
  }
  // 4th + 5th + 6th get suppressed within window
  await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'm4');
  await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'm5');
  await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'm6');
  assert.equal(notifyCalls.length, 3, 'three suppressed calls do not fire');

  // Advance past the window — summary should now fire.
  mock.timers.tick(mod.WINDOW_MS + 1000);
  // Microtask drain — the summary timer awaits sendNotification.
  await new Promise((res) => setImmediate(res));

  assert.equal(notifyCalls.length, 4, 'one summary message should have fired');
  const summary = notifyCalls[3];
  assert.match(summary, /Throttled 3 more/);
  assert.match(summary, /boost-hook-failed/);
  assert.match(summary, /post-1/);
});

test('alertThrottled: new call after window resets the counter', async () => {
  mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'] });
  for (let i = 0; i < 3; i += 1) {
    await mod.alertThrottled('boost-hook-failed', 'post-1', () => `m${i}`);
  }
  // Advance past the window — next call should be fresh (count=1, fired).
  mock.timers.tick(mod.WINDOW_MS + 1000);
  await new Promise((res) => setImmediate(res));

  const r = await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'fresh');
  assert.equal(r.fired, true);
  assert.equal(r.count, 1);
});

test('alertThrottled: Telegram throw on fire returns {fired:false, error}', async () => {
  nextNotifyResult = 'throw';
  const r = await mod.alertThrottled('boost-hook-failed', 'post-1', () => 'msg');
  assert.equal(r.fired, false);
  assert.match(r.error || '', /telegram-down/);
});

test('alertThrottled: per-key isolation — different identityKey does not share window', async () => {
  for (let i = 0; i < 3; i += 1) {
    await mod.alertThrottled('boost-hook-failed', 'post-A', () => `a${i}`);
  }
  // 'post-A' is now throttled but 'post-B' should still be fresh.
  const r = await mod.alertThrottled('boost-hook-failed', 'post-B', () => 'b1');
  assert.equal(r.fired, true);
  assert.equal(r.count, 1);
  assert.equal(notifyCalls.length, 4);
});

// ── _resetForTests ────────────────────────────────────────────────────────

test('_resetForTests clears state and lets the next call fire fresh', async () => {
  await mod.alertOnce('breakout-detected', 'post-1', () => 'a');
  mod._resetForTests();
  const r = await mod.alertOnce('breakout-detected', 'post-1', () => 'b');
  assert.equal(r.fired, true);
  assert.equal(notifyCalls.length, 2);
});
