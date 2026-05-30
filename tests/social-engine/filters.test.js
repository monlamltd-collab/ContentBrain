// Phase G — runFilters mode='social' coverage.
//
// Three commitments verified here:
//   1. Backward-compat: default mode (no opts arg) keeps Phase B byte-for-byte.
//   2. Social bans: every SOCIAL_BAN regex blocks an input containing it.
//   3. Social-mode skips: NAME_GUESS, scanApprovedContext, checkInventedAmounts
//      do NOT fire when mode='social'.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runFilters } = require('../../lib/outbound-filters');

function socialBlocks(input) {
  return runFilters(input, { mode: 'social' }).blocks.filter(b => b.severity === 'block');
}

function socialWarns(input) {
  return runFilters(input, { mode: 'social' }).blocks.filter(b => b.severity === 'warn');
}

// ── Backward-compat (the default-mode path stays Phase B) ────────────────

test('default mode (no opts): outbound behaviour preserved — guaranteed blocks', () => {
  const res = runFilters({ subject: '', body: 'This is guaranteed.' });
  assert.equal(res.ok, false);
});

test('default mode: outbound [first_name] still blocks (no opts)', () => {
  const res = runFilters({ subject: '', body: 'Hi [first_name],' });
  assert.equal(res.ok, false);
});

test('default mode: outbound — explicit mode:"outbound" is the same path', () => {
  const a = runFilters({ subject: '', body: 'Hi [first_name],' });
  const b = runFilters({ subject: '', body: 'Hi [first_name],' }, { mode: 'outbound' });
  assert.equal(a.ok, b.ok);
});

// ── A. Social mode — every SOCIAL_BAN blocks (body) ──────────────────────

test('social: blocks "wealth creation"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'A guide to wealth creation through auctions.' }).some(b => b.rule === 'wealth-trope'));
});

test('social: blocks "passive income"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Looking for passive income? Try auction property.' }).some(b => b.rule === 'passive-income'));
});

test('social: blocks "financial freedom"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Your path to financial freedom.' }).some(b => b.rule === 'financial-freedom'));
});

test('social: blocks "get rich"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Get rich on auctions.' }).some(b => b.rule === 'get-rich'));
});

test('social: blocks "this is a great investment"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Honestly, this is a great investment lot.' }).some(b => b.rule === 'great-investment'));
});

test('social: blocks "guaranteed return"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'A guaranteed return on this terrace.' }).some(b => b.rule === 'guaranteed-return'));
});

test('social: blocks "massive returns"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Massive returns on Welsh stock.' }).some(b => b.rule === 'massive-returns'));
});

test('social: blocks "safe investment"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'A safe investment in Sheffield.' }).some(b => b.rule === 'safe-investment'));
});

test('social: blocks "we can arrange your mortgage"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'We can arrange your mortgage on this one.' }).some(b => b.rule === 'arrange-mortgage'));
});

test('social: blocks "mortgage rates"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Mortgage rates are dropping again.' }).some(b => b.rule === 'mortgage-rates'));
});

test('social: blocks "approved by lenders"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Approved by lenders within 24 hours.' }).some(b => b.rule === 'approved-by-lenders'));
});

test('social: blocks "best mortgage"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Find the best mortgage for auction buys.' }).some(b => b.rule === 'best-mortgage'));
});

test('social: blocks BridgeMatch mention (decision #1)', () => {
  assert.ok(socialBlocks({ subject: '', body: 'BridgeMatch can help with the funding side.' }).some(b => b.rule === 'bridgematch-mention'));
});

test('social: blocks "bridging finance"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Bridging finance is the usual route.' }).some(b => b.rule === 'bridging-finance'));
});

test('social: blocks sneer word "shit"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'A shit terrace in Cardiff.' }).some(b => b.rule === 'sneer-word'));
});

test('social: blocks sneer-aesthetic "ugly"', () => {
  assert.ok(socialBlocks({ subject: '', body: 'An ugly bungalow in Newport.' }).some(b => b.rule === 'sneer-aesthetic'));
});

test('social: blocks hashtag in body', () => {
  assert.ok(socialBlocks({ subject: '', body: 'Worth a look #propertyporn.' }).some(b => b.rule === 'hashtag'));
});

// ── B. SOCIAL_BANS hit in subject too ────────────────────────────────────

test('social: blocks "wealth creation" in subject', () => {
  assert.ok(socialBlocks({ subject: 'Wealth creation guide', body: '' }).some(b => b.rule === 'wealth-trope' && b.where === 'subject'));
});

test('social: blocks BridgeMatch in subject', () => {
  assert.ok(socialBlocks({ subject: 'BridgeMatch news', body: '' }).some(b => b.rule === 'bridgematch-mention' && b.where === 'subject'));
});

// ── C. Social mode skips NAME_GUESS ──────────────────────────────────────

test('social: [first_name] in body is NOT blocked (social has no recipient)', () => {
  const res = runFilters({ subject: '', body: 'Hi [first_name], thanks for following.' }, { mode: 'social' });
  assert.equal(res.ok, true);
});

test('social: "Dear Sir" in body is NOT blocked', () => {
  const res = runFilters({ subject: '', body: 'Dear Sir, this is fine on Facebook.' }, { mode: 'social' });
  assert.equal(res.ok, true);
});

// ── D. Social mode skips checkInventedAmounts ───────────────────────────

test('social: £-amount with no dealFacts is NOT blocked', () => {
  const res = runFilters({ subject: '', body: 'Guide £62,000 on a Cardiff terrace.' }, { mode: 'social' });
  assert.equal(res.ok, true);
});

// ── E. Americanism still warns in social mode ────────────────────────────

test('social: "color" in body warns (not block)', () => {
  const res = runFilters({ subject: '', body: 'Cardiff color scheme — interesting.' }, { mode: 'social' });
  assert.equal(res.ok, true);
  assert.ok(socialWarns({ subject: '', body: 'Cardiff color scheme — interesting.' }).some(b => b.rule === 'color'));
});

test('social: applyAmericanismCheck=false suppresses americanism warnings', () => {
  const res = runFilters({ subject: '', body: 'Cardiff color scheme.' }, { mode: 'social', applyAmericanismCheck: false });
  assert.equal(res.ok, true);
  assert.equal(res.blocks.filter(b => b.rule === 'color').length, 0);
});

// ── F. SOCIAL_FINANCE_CONTEXT (broader 120-char window) ─────────────────

test('social: "approved" within 120 chars of "lender" blocks', () => {
  const body = 'These properties are approved for institutional lender finance — but read the small print.';
  assert.ok(socialBlocks({ subject: '', body }).some(b => b.rule === 'approved-near-finance'));
});

test('social: "lender ... approved" reverse direction blocks', () => {
  const body = 'Every lender we listed had their auction lots approved last month.';
  assert.ok(socialBlocks({ subject: '', body }).some(b => b.rule === 'finance-near-approved'));
});

test('social: "approved" far from any finance word does NOT block', () => {
  const body = 'My grandmother\'s favourite cottage was approved by the local council in the 80s.';
  const res = runFilters({ subject: '', body }, { mode: 'social' });
  assert.equal(res.ok, true);
});

// ── G. Round-trip: same input in both modes, both reasonable ────────────

test('round-trip: same clean input passes in both modes', () => {
  // No £-amount so the outbound invented-amount rule doesn't trip; the social
  // mode skips that rule entirely, so the result is the same either way.
  const input = { subject: 'Welsh auction picks', body: 'Five unloved terraces in Cardiff this fortnight.' };
  const outbound = runFilters(input);
  const social = runFilters(input, { mode: 'social' });
  assert.equal(outbound.ok, true);
  assert.equal(social.ok, true);
});

test('round-trip: "guaranteed" blocks in both modes', () => {
  const input = { subject: 'Win', body: 'A guaranteed deal.' };
  assert.equal(runFilters(input).ok, false);
  assert.equal(runFilters(input, { mode: 'social' }).ok, false);
});

test('round-trip: BridgeMatch only blocks in social mode', () => {
  const input = { subject: '', body: 'BridgeMatch news today.' };
  // Outbound has no rule banning BridgeMatch mention — that's fine, sister product references work in outbound.
  assert.equal(runFilters(input).ok, true);
  assert.equal(runFilters(input, { mode: 'social' }).ok, false);
});

test('round-trip: [first_name] blocks in outbound, passes in social', () => {
  const input = { subject: '', body: 'Hi [first_name],' };
  assert.equal(runFilters(input).ok, false);
  assert.equal(runFilters(input, { mode: 'social' }).ok, true);
});
