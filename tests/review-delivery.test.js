const { test } = require('node:test');
const assert = require('node:assert/strict');
const { deliverBlogReview, wasBlogReviewDelivered } = require('../lib/review-delivery');

const item = { post_id: 'post-123', brand: 'auctionbrain', content_type: 'blog' };

test('deliverBlogReview marks a successful Telegram delivery', async () => {
  const calls = [];
  const result = await deliverBlogReview(item, {
    send: async value => { calls.push(['send', value.post_id]); return { ok: true }; },
    mark: async (id, brand) => { calls.push(['mark', id, brand]); },
  });
  assert.deepEqual(calls, [
    ['send', 'post-123'],
    ['mark', 'post-123', 'auctionbrain'],
  ]);
  assert.equal(result.marked, true);
});

test('deliverBlogReview rejects a failed Telegram response and does not mark it', async () => {
  let marked = false;
  await assert.rejects(
    deliverBlogReview(item, {
      send: async () => ({ ok: false, error: 'Telegram 502' }),
      mark: async () => { marked = true; },
    }),
    /Telegram 502/
  );
  assert.equal(marked, false);
});

test('deliverBlogReview does not ask the caller to retry after Telegram succeeded but marking failed', async () => {
  const result = await deliverBlogReview(item, {
    send: async () => ({ ok: true }),
    mark: async () => { throw new Error('database unavailable'); },
  });
  assert.deepEqual(result, { ok: true, marked: false });
});

test('wasBlogReviewDelivered reflects the durable marker', async () => {
  assert.equal(await wasBlogReviewDelivered('a', 'auctionbrain', { read: async () => null }), false);
  assert.equal(await wasBlogReviewDelivered('b', 'bridgematch', { read: async () => '2026-07-22T08:00:00Z' }), true);
});
