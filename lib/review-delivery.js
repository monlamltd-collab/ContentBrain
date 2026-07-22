const runtimeConfig = require('./runtime-config');
const { sendBlogForReview } = require('./telegram');

async function deliverBlogReview(item, deps = {}) {
  const send = deps.send || sendBlogForReview;
  const mark = deps.mark || runtimeConfig.markReviewDelivered;
  const result = await send(item);
  if (!result || result.ok !== true) {
    throw new Error(result?.error || 'Telegram review delivery failed');
  }
  try {
    await mark(item.post_id, item.brand || 'auctionbrain');
  } catch (err) {
    // Telegram already accepted the message. Do not return a failure that would
    // make the caller retry and create an immediate duplicate.
    console.warn(`[review-delivery] delivered ${item.post_id} but marker write failed: ${err.message}`);
    return { ...result, marked: false };
  }
  return { ...result, marked: true };
}

async function wasBlogReviewDelivered(postId, brand = 'auctionbrain', deps = {}) {
  const read = deps.read || runtimeConfig.getReviewDeliveredAt;
  return Boolean(await read(postId, brand));
}

module.exports = { deliverBlogReview, wasBlogReviewDelivered };
