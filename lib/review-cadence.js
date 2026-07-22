// Keep unsolicited blog/guide review cards on the editorial cadence agreed
// with the owner: Monday and Wednesday in Europe/London. Each approved draft
// is scheduled by its source engine for publication two days later
// (Wednesday/Friday), leaving a proper edit window. Social cards and
// owner-requested revision replies are intentionally not governed here.
const REVIEW_DAYS = new Set(['Monday', 'Wednesday']);

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
