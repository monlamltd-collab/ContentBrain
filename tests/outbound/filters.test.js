// Outbound filters — coverage for every block rule and the warn rules.
// Each rule has a positive (blocks the offending text) and negative (passes
// legitimate text) assertion. The "approved" rule has extra cases proving
// it only fires near a finance word, per coder verification.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runFilters } = require('../../lib/outbound-filters');

function blocksOf(message) {
  return runFilters(message).blocks.filter(b => b.severity === 'block');
}

function warnsOf(message) {
  return runFilters(message).blocks.filter(b => b.severity === 'warn');
}

// ── FCA — guaranteed ─────────────────────────────────────────────────────

test('FCA: blocks "guaranteed" in body', () => {
  const res = runFilters({ subject: 'Hello', body: 'This is guaranteed to clear.' });
  assert.equal(res.ok, false);
  assert.ok(blocksOf({ subject: 'Hello', body: 'This is guaranteed to clear.' }).some(b => b.rule === 'guaranteed'));
});

test('FCA: blocks "guaranteed" in subject', () => {
  const res = runFilters({ subject: 'Guaranteed bridging', body: 'Hi.' });
  assert.equal(res.ok, false);
  const blocks = res.blocks.filter(b => b.severity === 'block');
  assert.ok(blocks.some(b => b.rule === 'guaranteed' && b.where === 'subject'));
});

test('FCA: passes "guarantor" (does not false-fire on the word stem)', () => {
  // Note: \bguaranteed\b is word-boundary anchored; "guarantor" should pass.
  const res = runFilters({ subject: 'Question', body: 'Do you need a guarantor on bridging loans?' });
  assert.equal(res.ok, true);
});

// ── FCA — risk-free ──────────────────────────────────────────────────────

test('FCA: blocks "risk-free"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'A risk-free way to fund.' }).some(b => b.rule === 'risk-free'));
});

test('FCA: blocks "risk free" (space variant)', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'A risk free way to fund.' }).some(b => b.rule === 'risk-free'));
});

test('FCA: blocks "riskfree" (joined variant)', () => {
  // \brisk[- ]?free\b uses an optional separator, so "riskfree" matches too.
  assert.ok(blocksOf({ subject: 'A', body: 'A riskfree way to fund.' }).some(b => b.rule === 'risk-free'));
});

test('FCA: passes "risky" (does not false-fire)', () => {
  assert.equal(runFilters({ subject: 'A', body: 'Risky deals are tough.' }).ok, true);
});

// ── FCA — certain return ─────────────────────────────────────────────────

test('FCA: blocks "certain return"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'You will get a certain return on this.' }).some(b => b.rule === 'certain return'));
});

test('FCA: passes plain "return" (does not false-fire)', () => {
  assert.equal(runFilters({ subject: 'A', body: 'Looking for your return on Friday.' }).ok, true);
});

// ── FCA — approved (only in finance context) ────────────────────────────

test('FCA: blocks "approved" within 30 chars of "loan"', () => {
  const blocks = blocksOf({ subject: 'A', body: 'Your loan is approved this morning.' });
  assert.ok(blocks.some(b => b.rule === 'approved (finance context)'));
});

test('FCA: blocks "approved" within 30 chars of "bridge"', () => {
  const blocks = blocksOf({ subject: 'A', body: 'Bridge approved within an hour.' });
  assert.ok(blocks.some(b => b.rule === 'approved (finance context)'));
});

test('FCA: blocks "approved" within 30 chars of "credit"', () => {
  const blocks = blocksOf({ subject: 'A', body: 'Credit approved in minutes.' });
  assert.ok(blocks.some(b => b.rule === 'approved (finance context)'));
});

test('FCA: blocks "approved" within 30 chars of "funding"', () => {
  const blocks = blocksOf({ subject: 'A', body: 'Funding approved with no fuss.' });
  assert.ok(blocks.some(b => b.rule === 'approved (finance context)'));
});

test('FCA: blocks "approved" within 30 chars of "finance"', () => {
  const blocks = blocksOf({ subject: 'A', body: 'Finance approved fast.' });
  assert.ok(blocks.some(b => b.rule === 'approved (finance context)'));
});

test('FCA: PASSES "approved" far from any finance word', () => {
  // The finance word "bridge" is 200+ chars away from "approved" — outside the 30-char window.
  const body = 'Approved by our editorial team after several rounds of review. ' +
               'A long stretch of unrelated text follows to push the keyword out of the window. ' +
               'More filler. More filler. More filler. Then later we may build a bridge.';
  const res = runFilters({ subject: 'Editorial', body });
  assert.equal(res.ok, true, `expected ok, got blocks=${JSON.stringify(res.blocks)}`);
});

test('FCA: PASSES "approved" with no finance word at all', () => {
  const res = runFilters({ subject: 'A', body: 'Approved by the team yesterday — well done.' });
  assert.equal(res.ok, true);
});

// ── name_guess ───────────────────────────────────────────────────────────

test('name_guess: blocks "[first_name]" placeholder', () => {
  assert.ok(blocksOf({ subject: 'Hi', body: 'Hi [first_name], a quick note.' }).some(b => b.rule === '[first_name]'));
});

test('name_guess: blocks "[firstname]" placeholder (no underscore)', () => {
  assert.ok(blocksOf({ subject: 'Hi', body: 'Hi [firstname], a quick note.' }).some(b => b.rule === '[first_name]'));
});

test('name_guess: blocks "[name]" placeholder', () => {
  assert.ok(blocksOf({ subject: 'Hi', body: 'Hi [name], a quick note.' }).some(b => b.rule === '[name]'));
});

test('name_guess: blocks "Dear Sir"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'Dear Sir, a note.' }).some(b => b.rule === 'Dear Sir/Madam'));
});

test('name_guess: blocks "Dear Madam"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'Dear Madam, a note.' }).some(b => b.rule === 'Dear Sir/Madam'));
});

test('name_guess: blocks "Hi there" at start of body', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'Hi there, a note.' }).some(b => b.rule === 'Hi there'));
});

test('name_guess: PASSES "Hello," (legitimate no-name opener)', () => {
  assert.equal(runFilters({ subject: 'A', body: 'Hello, a quick note about BridgeMatch.' }).ok, true);
});

test('name_guess: PASSES "Hi Sarah," (real name)', () => {
  assert.equal(runFilters({ subject: 'A', body: 'Hi Sarah, a quick note.' }).ok, true);
});

// ── ai_tell ──────────────────────────────────────────────────────────────

test('ai_tell: blocks "I hope this email finds you well"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'I hope this email finds you well. Cheers.' })
    .some(b => b.rule === 'I hope this email finds you well'));
});

test('ai_tell: blocks "I hope this message finds you well"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'I hope this message finds you well.' })
    .some(b => b.rule === 'I hope this email finds you well'));
});

test('ai_tell: blocks "I came across"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'I came across your firm last week.' })
    .some(b => b.rule === 'I came across'));
});

test('ai_tell: blocks "I noticed that your"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'I noticed that your team has grown.' })
    .some(b => b.rule === 'I noticed that your'));
});

test('ai_tell: blocks "As an AI"', () => {
  assert.ok(blocksOf({ subject: 'A', body: 'As an AI I cannot help you with that.' })
    .some(b => b.rule === 'As an AI'));
});

test('ai_tell: PASSES specific opener ("Saw your post on LinkedIn this morning")', () => {
  assert.equal(runFilters({ subject: 'A', body: 'Saw your post on LinkedIn this morning.' }).ok, true);
});

// ── americanisms (warn — NOT a block) ────────────────────────────────────

test('americanism: warns on "color" but does NOT block', () => {
  const res = runFilters({ subject: 'A', body: 'The brand color is teal.' });
  assert.equal(res.ok, true, 'americanisms must warn, never block');
  assert.ok(warnsOf({ subject: 'A', body: 'The brand color is teal.' }).some(w => w.rule === 'color'));
});

test('americanism: warns on "organize"', () => {
  const res = runFilters({ subject: 'A', body: 'We can organize the call for Thursday.' });
  assert.equal(res.ok, true);
  assert.ok(warnsOf({ subject: 'A', body: 'We can organize the call for Thursday.' }).some(w => w.rule === 'organize'));
});

test('americanism: warns on "customize"', () => {
  const res = runFilters({ subject: 'A', body: 'You can customize the dashboard.' });
  assert.equal(res.ok, true);
  assert.ok(warnsOf({ subject: 'A', body: 'You can customize the dashboard.' }).some(w => w.rule === 'customize'));
});

test('americanism: warns on "favorite"', () => {
  const res = runFilters({ subject: 'A', body: 'A favorite of our brokers.' });
  assert.equal(res.ok, true);
  assert.ok(warnsOf({ subject: 'A', body: 'A favorite of our brokers.' }).some(w => w.rule === 'favorite'));
});

test('americanism: PASSES British spelling (no warning)', () => {
  const res = runFilters({ subject: 'A', body: 'The brand colour is teal. Organise the call.' });
  assert.equal(res.ok, true);
  assert.equal(warnsOf({ subject: 'A', body: 'The brand colour is teal. Organise the call.' }).length, 0);
});

// ── combined / edge ──────────────────────────────────────────────────────

test('runFilters: returns ALL blocks in one pass (no fail-fast)', () => {
  const res = runFilters({
    subject: 'Guaranteed funding',
    body: 'Hi [first_name], I hope this email finds you well. Risk-free.',
  });
  assert.equal(res.ok, false);
  const blockRules = res.blocks.filter(b => b.severity === 'block').map(b => b.rule);
  // Expect at least: guaranteed, [first_name], I hope this email finds you well, risk-free
  assert.ok(blockRules.includes('guaranteed'));
  assert.ok(blockRules.includes('[first_name]'));
  assert.ok(blockRules.includes('I hope this email finds you well'));
  assert.ok(blockRules.includes('risk-free'));
});

test('runFilters: handles string input (combined subject+body)', () => {
  const res = runFilters('This is guaranteed to clear.');
  assert.equal(res.ok, false);
});

test('runFilters: handles empty input', () => {
  const res = runFilters({ subject: '', body: '' });
  assert.equal(res.ok, true);
  assert.equal(res.blocks.length, 0);
});

test('runFilters: handles null/undefined message', () => {
  assert.equal(runFilters(null).ok, true);
  assert.equal(runFilters(undefined).ok, true);
});

test('runFilters: PASSES a clean lender outreach draft', () => {
  const res = runFilters({
    subject: 'BridgeMatch — two-minute look?',
    body: 'Hello,\n\nWe send qualified bridging enquiries to lenders that fit a broker\'s criteria. ' +
          'If we listed your product range, brokers would shortlist you faster.\n\nWorth a ten-minute call?',
  });
  assert.equal(res.ok, true, `expected ok, got ${JSON.stringify(res.blocks)}`);
});
