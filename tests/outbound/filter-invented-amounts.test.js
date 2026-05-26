// Phase E — checkInventedAmounts filter rule tests.
//
// The rule blocks £-amounts that appear in the generated message but
// aren't in any of the supplied DEAL HISTORY facts. When dealFacts is
// empty, ANY £-amount in the message is invented.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runFilters, checkInventedAmounts, extractAmounts } = require('../../lib/outbound-filters');

function blockedAmounts(message, dealFacts) {
  return checkInventedAmounts(message, dealFacts).map(b => b.match);
}

// ── No DEAL HISTORY → ANY amount blocks ───────────────────────────────────

test('no DEAL HISTORY: blocks £450k in body', () => {
  const blocks = blockedAmounts({ subject: 'Hi', body: 'We secured £450k for a recent client.' }, []);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /£\s?450k/i);
});

test('no DEAL HISTORY: blocks £1.2m in body', () => {
  const blocks = blockedAmounts({ subject: 'Hi', body: 'A £1.2m bridging deal.' }, []);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /£\s?1\.2m/i);
});

test('no DEAL HISTORY: blocks plain £200 in subject', () => {
  const blocks = blockedAmounts({ subject: '£200 saving', body: 'Hi.' }, []);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /£\s?200/);
});

test('no DEAL HISTORY: passes a body with no £-amounts', () => {
  const blocks = blockedAmounts({ subject: 'Hi', body: 'A bridging deal for an auction lot.' }, []);
  assert.equal(blocks.length, 0);
});

// ── With DEAL HISTORY → only matching amounts allowed ─────────────────────

test('with DEAL HISTORY: allows £450k when fact mentions £450k', () => {
  const facts = [{ claude_fact: 'BridgeMatch closed £450k for Acme in April.' }];
  const blocks = blockedAmounts({ subject: 'Hi', body: 'We closed £450k for Acme.' }, facts);
  assert.equal(blocks.length, 0);
});

test('with DEAL HISTORY: still blocks invented amount when one fact is present', () => {
  const facts = [{ claude_fact: '£450k bridging in April.' }];
  const blocks = blockedAmounts({ subject: 'Hi', body: 'How about £1.2m for the next one?' }, facts);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0], /£\s?1\.2m/i);
});

test('with DEAL HISTORY: case + spacing canonicalisation lets "£ 450K" match "£450k"', () => {
  const facts = [{ claude_fact: 'BridgeMatch closed £450k for Acme.' }];
  const blocks = blockedAmounts({ subject: 'Hi', body: 'Closed £ 450K.' }, facts);
  assert.equal(blocks.length, 0, '£ 450K should canonicalise to £450k');
});

test('with DEAL HISTORY: distinct canonical forms stay distinct (£450k vs £450,000)', () => {
  const facts = [{ claude_fact: '£450k auction purchase.' }];
  const blocks = blockedAmounts({ subject: 'Hi', body: 'A £450,000 deal.' }, facts);
  assert.equal(blocks.length, 1, '£450,000 should NOT match £450k by design');
});

// ── runFilters integration ────────────────────────────────────────────────

test('runFilters: invented amount makes ok=false', () => {
  const res = runFilters({
    subject: 'Quick note',
    body: 'We closed £999k last week.',
    dealFacts: [],
  });
  assert.equal(res.ok, false);
  assert.ok(res.blocks.some(b => b.rule === 'invented_amount'));
});

test('runFilters: amount in DEAL HISTORY passes (no other blocks)', () => {
  const res = runFilters({
    subject: 'Quick note',
    body: 'For Acme we closed £450k in six days.',
    dealFacts: [{ claude_fact: 'Acme closed £450k in six days, April 2026.' }],
  });
  assert.equal(res.ok, true);
});

test('runFilters: works on string input (backward-compat) — but ANY £-amount blocks because dealFacts defaults to []', () => {
  // The string-input branch sets dealFacts=[]. So a body string with a
  // £-amount blocks under the no-history rule.
  const res = runFilters('We closed £450k for a client.');
  assert.equal(res.ok, false);
  assert.ok(res.blocks.some(b => b.rule === 'invented_amount'));
});

// ── extractAmounts helper ─────────────────────────────────────────────────

test('extractAmounts: pulls every £-amount, in order', () => {
  const got = extractAmounts('A £450k deal and a £1.2m follow-on, plus £200 in fees.');
  assert.equal(got.length, 3);
  assert.deepEqual(got.map(a => a.key), ['£450k', '£1.2m', '£200']);
});

test('extractAmounts: empty string yields []', () => {
  assert.deepEqual(extractAmounts(''), []);
  assert.deepEqual(extractAmounts(null), []);
});
