const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isBlogReviewDay, shouldQueueReview } = require('../lib/review-cadence');

test('blog review cards only land on Monday/Wednesday, two days before publication', () => {
  assert.equal(isBlogReviewDay(new Date('2026-07-20T07:00:00Z')), true);  // Monday
  assert.equal(isBlogReviewDay(new Date('2026-07-22T07:00:00Z')), true);  // Wednesday
  assert.equal(isBlogReviewDay(new Date('2026-07-21T07:00:00Z')), false); // Tuesday
  assert.equal(isBlogReviewDay(new Date('2026-07-23T07:00:00Z')), false); // Thursday
  assert.equal(isBlogReviewDay(new Date('2026-07-25T07:00:00Z')), false); // Saturday
});

test('review cadence follows Europe/London calendar days around midnight BST', () => {
  // 23:30 UTC Tuesday is already Wednesday in London during BST.
  assert.equal(isBlogReviewDay(new Date('2026-07-21T23:30:00Z')), true);
});

test('off-day blogs and guides queue, while social review remains immediate', () => {
  const tuesday = new Date('2026-07-21T12:00:00Z');
  assert.equal(shouldQueueReview('blog', tuesday), true);
  assert.equal(shouldQueueReview('guide', tuesday), true);
  assert.equal(shouldQueueReview('social', tuesday), false);
  assert.equal(shouldQueueReview('blog', new Date('2026-07-20T12:00:00Z')), false);
});
