// Phase G — decideMode pure-function coverage.
//
// Deterministic seeded-rng scenarios per design §7.3. Pure function — no
// I/O, no mocking required.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decideMode } = require('../../lib/social-engine/orchestrator');

// Fixed RNG factories for deterministic assertions.
const rng = (v) => () => v;

// ── 1. Cold-start ────────────────────────────────────────────────────

test('decideMode: cold-start (total=0) → monet', () => {
  assert.equal(decideMode({ monet: 0, traffic: 0, total: 0 }, { rng: rng(0.5) }), 'monet');
});

test('decideMode: cold-start (total=1) → monet (under threshold)', () => {
  assert.equal(decideMode({ monet: 1, traffic: 0, total: 1 }, { rng: rng(0.5) }), 'monet');
});

test('decideMode: cold-start (total=2) → monet (still under 3)', () => {
  assert.equal(decideMode({ monet: 2, traffic: 0, total: 2 }, { rng: rng(0.99) }), 'monet');
});

// ── 2. Above hysteresis → traffic ─────────────────────────────────

test('decideMode: ratio=1.0 (monet=3 of 3) → traffic (>0.80)', () => {
  assert.equal(decideMode({ monet: 3, traffic: 0, total: 3 }, { rng: rng(0.5) }), 'traffic');
});

test('decideMode: ratio=0.857 (6m/1t) → traffic (>0.80)', () => {
  assert.equal(decideMode({ monet: 6, traffic: 1, total: 7 }, { rng: rng(0.5) }), 'traffic');
});

// ── 3. Below target → monet ─────────────────────────────────────

test('decideMode: ratio=0.571 (4m/3t) → monet (<0.70)', () => {
  assert.equal(decideMode({ monet: 4, traffic: 3, total: 7 }, { rng: rng(0.99) }), 'monet');
});

test('decideMode: ratio=0.50 (2m/2t total=4) → monet', () => {
  assert.equal(decideMode({ monet: 2, traffic: 2, total: 4 }, { rng: rng(0.99) }), 'monet');
});

// ── 4. Inside hysteresis band (0.70-0.80) → weighted random ─────────

test('decideMode: ratio=0.714 (5m/2t) + rng=0.3 → monet', () => {
  // ratio = 0.714, inside band (0.70-0.80). rng=0.3 < 0.70 → monet.
  assert.equal(decideMode({ monet: 5, traffic: 2, total: 7 }, { rng: rng(0.3) }), 'monet');
});

test('decideMode: ratio=0.714 (5m/2t) + rng=0.85 → traffic', () => {
  // rng=0.85 > 0.70 → traffic.
  assert.equal(decideMode({ monet: 5, traffic: 2, total: 7 }, { rng: rng(0.85) }), 'traffic');
});

// ── 5. Overrides ────────────────────────────────────────────────

test('decideMode: forceMode="monet" beats everything', () => {
  // Even if ratio is high, forceMode wins.
  assert.equal(decideMode({ monet: 6, traffic: 1, total: 7 }, { forceMode: 'monet', rng: rng(0.5) }), 'monet');
});

test('decideMode: forceMode="traffic" beats cold-start', () => {
  assert.equal(decideMode({ monet: 0, traffic: 0, total: 0 }, { forceMode: 'traffic', rng: rng(0.5) }), 'traffic');
});

test('decideMode: forceMode="invalid" is ignored', () => {
  // Not 'monet' or 'traffic' → falls through normal logic.
  assert.equal(decideMode({ monet: 0, traffic: 0, total: 0 }, { forceMode: 'something', rng: rng(0.5) }), 'monet');
});

test('decideMode: breakoutActive forces monet', () => {
  // Even when ratio > hysteresis, breakout override → monet.
  assert.equal(decideMode({ monet: 0, traffic: 7, total: 7 }, { breakoutActive: true, rng: rng(0.5) }), 'monet');
});

test('decideMode: breakoutActive + forceMode="traffic" — forceMode wins', () => {
  assert.equal(decideMode({ monet: 0, traffic: 7, total: 7 }, { breakoutActive: true, forceMode: 'traffic' }), 'traffic');
});

// ── 6. Null / undefined counts ──────────────────────────────────

test('decideMode: undefined counts → monet (cold-start)', () => {
  assert.equal(decideMode(undefined, { rng: rng(0.5) }), 'monet');
});

test('decideMode: null counts → monet', () => {
  assert.equal(decideMode(null, { rng: rng(0.5) }), 'monet');
});

// ── 7. Default Math.random when no rng provided ────────────────

test('decideMode: no rng option → uses Math.random without crashing', () => {
  const m = decideMode({ monet: 5, traffic: 2, total: 7 });
  assert.ok(['monet', 'traffic'].includes(m));
});

// ── 8. computeScheduledFor ────────────────────────────────────

test('computeScheduledFor returns a valid ISO timestamp', () => {
  const { computeScheduledFor } = require('../../lib/social-engine/orchestrator');
  const ts = computeScheduledFor(0);
  const d = new Date(ts);
  assert.ok(!isNaN(d.getTime()), `${ts} should parse`);
});

test('computeScheduledFor falls back to slot 0 for unknown slotIndex', () => {
  const { computeScheduledFor } = require('../../lib/social-engine/orchestrator');
  const t0 = computeScheduledFor(0);
  const t999 = computeScheduledFor(999);
  // Both should be valid; t999 just falls back to the slot-0 hour rules.
  assert.ok(!isNaN(new Date(t0).getTime()));
  assert.ok(!isNaN(new Date(t999).getTime()));
});
