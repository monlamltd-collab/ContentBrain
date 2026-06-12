// Tests for the /api/review theme-dedup helpers (lib/review-api.js).
// Pure-function tests — no express, no supabase. Regression coverage for
// the self-match bug (2026-06-12): engines save the draft before posting,
// so the comparison set must exclude the submitted post's own row.
const { test } = require('node:test');
const assert = require('node:assert');

const { titleWords, jaccardSimilarity, findThemeMatch } = require('../lib/review-api');

test('titleWords drops stopwords and short words', () => {
  const words = titleWords('How the Bank of England Rate Hold Hits UK Bridging');
  assert.ok(words.has('bank'));
  assert.ok(words.has('bridging'));
  assert.ok(!words.has('the'));
  assert.ok(!words.has('of'));
  assert.ok(!words.has('uk')); // length <= 2
});

test('jaccardSimilarity: identical titles are 1, disjoint are 0', () => {
  const a = titleWords('Bridging Finance Pricing Volatility Deepens');
  assert.strictEqual(jaccardSimilarity(a, a), 1);
  const b = titleWords('Auction Legal Pack Checklist Essentials');
  assert.strictEqual(jaccardSimilarity(a, b), 0);
  assert.strictEqual(jaccardSimilarity(new Set(), a), 0);
});

test('findThemeMatch flags a near-duplicate above the 0.40 threshold', () => {
  const recent = [
    { id: 'p1', title: 'BoE Rate Hold Creates Bridging Finance Pricing Paralysis', status: 'rejected' },
    { id: 'p2', title: 'Auction Legal Packs: What Buyers Miss', status: 'published' },
  ];
  const match = findThemeMatch('BoE Rate Hold Leaves Bridging Finance Pricing in Limbo', recent);
  assert.ok(match);
  assert.strictEqual(match.post.id, 'p1');
  assert.ok(match.similarity >= 0.40);
});

test('findThemeMatch passes a fresh theme', () => {
  const recent = [
    { id: 'p1', title: 'BoE Rate Hold Creates Bridging Finance Pricing Paralysis', status: 'published' },
  ];
  const match = findThemeMatch('Commercial Auction Yields Climb in the North West', recent);
  assert.strictEqual(match, null);
});

test('self-match regression: identical title passes once its own row is excluded', () => {
  const title = 'Wealthy Investors Ditching Long Mortgage Fixes as Lending Activity Picks Up';
  const submittedId = 'self-123';
  const recent = [
    { id: 'self-123', title, status: 'draft' }, // the just-saved row for this very submission
    { id: 'other-1', title: 'Auction Legal Packs: What Buyers Miss', status: 'published' },
  ];

  // Without exclusion the post matches itself at 100% — the 2026-06-12 bug.
  const unfiltered = findThemeMatch(title, recent);
  assert.ok(unfiltered && unfiltered.similarity === 1);

  // The route filters the submitted post_id before matching; replicate it.
  const filtered = recent.filter(p => String(p.id) !== String(submittedId));
  assert.strictEqual(findThemeMatch(title, filtered), null);
});
