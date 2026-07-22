const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBlogReviewDay, shouldQueueReview } = require('../lib/review-cadence');

test('blog review cards only land on the agreed Tuesday/Thursday cadence', () => {
  assert.equal(isBlogReviewDay(new Date('2026-07-21T07:00:00Z')), true);  // Tuesday
  assert.equal(isBlogReviewDay(new Date('2026-07-23T07:00:00Z')), true);  // Thursday
  assert.equal(isBlogReviewDay(new Date('2026-07-22T07:00:00Z')), false); // Wednesday
  assert.equal(isBlogReviewDay(new Date('2026-07-25T07:00:00Z')), false); // Saturday
});

test('review cadence follows Europe/London calendar days around midnight BST', () => {
  // 23:30 UTC Tuesday is already Wednesday in London during BST.
  assert.equal(isBlogReviewDay(new Date('2026-07-21T23:30:00Z')), false);
});

test('off-day blogs and guides queue, while social review remains immediate', () => {
  const wednesday = new Date('2026-07-22T12:00:00Z');
  assert.equal(shouldQueueReview('blog', wednesday), true);
  assert.equal(shouldQueueReview('guide', wednesday), true);
  assert.equal(shouldQueueReview('social', wednesday), false);
  assert.equal(shouldQueueReview('blog', new Date('2026-07-23T12:00:00Z')), false);
});
