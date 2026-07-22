// Keep unsolicited blog/guide review cards on the editorial cadence agreed
// with the owner: Tuesday and Thursday in Europe/London. Social cards and
// owner-requested revision replies are intentionally not governed here.
const REVIEW_DAYS = new Set(['Tuesday', 'Thursday']);

function isBlogReviewDay(date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    weekday: 'long',
  }).format(date);
  return REVIEW_DAYS.has(weekday);
}

function shouldQueueReview(contentType, date = new Date()) {
  return contentType !== 'social' && !isBlogReviewDay(date);
}

module.exports = { REVIEW_DAYS, isBlogReviewDay, shouldQueueReview };
