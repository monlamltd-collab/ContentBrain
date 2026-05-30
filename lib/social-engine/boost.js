// Phase G — boost row creator.
//
// Called from the 15-min publish cron in server.js after a social post
// publishes successfully and the FB post_id is in hand. PR2 only INSERTS
// the boost_runs row at status='pending'; PR3 wires the Make webhook fire.
// Splitting this out now means PR3 is a 1-file change.
//
// Gated on env var MAKE_BOOST_WEBHOOK_URL — when unset (PR2 + production
// until lead enables Make), the function inserts the row and returns
// without firing any webhook. The PR2 pending row is harmless until PR3
// activates the consumer.

const {
  DEFAULT_DAILY_BUDGET_PENCE,
  DEFAULT_BOOST_DURATION_HOURS,
  REGIONAL_PRESET,
  DEFAULT_AUDIENCE_SPEC,
} = require('./constants');
const { insertBoostRun } = require('./helpers');

/**
 * Derive an audience_spec for the FB Marketing API from the post's
 * niche_tag. Pure function (no I/O). Returns the regional preset when
 * the tag maps to a regional slug, DEFAULT_AUDIENCE_SPEC otherwise.
 * @param {string|null} nicheTag
 * @returns {object}  audience_spec
 */
function deriveAudienceSpec(nicheTag) {
  if (!nicheTag) return cloneAudience(DEFAULT_AUDIENCE_SPEC);

  // Match the niche_tag against REGIONAL_PRESET slugs.
  for (const region of Object.values(REGIONAL_PRESET)) {
    if (region.slug === nicheTag) {
      return {
        geo_locations_cities: [...region.fb_cities],
        geo_locations_regions: [...region.fb_regions],
        age_min: DEFAULT_AUDIENCE_SPEC.age_min,
        age_max: DEFAULT_AUDIENCE_SPEC.age_max,
        interests: [...DEFAULT_AUDIENCE_SPEC.interests],
        publisher_platforms: [...DEFAULT_AUDIENCE_SPEC.publisher_platforms],
      };
    }
  }
  // Non-regional niche (yield-band / prop-type / deal-type) — use the
  // default UK-wide audience. PR4 may further narrow by interest.
  return cloneAudience(DEFAULT_AUDIENCE_SPEC);
}

// Helper — clones a frozen audience spec into a plain mutable object so
// downstream Make scenarios can serialise it without TypeError.
function cloneAudience(a) {
  return {
    geo_locations_cities: [...a.geo_locations_cities],
    geo_locations_regions: a.geo_locations_regions.map(r => ({ ...r })),
    age_min: a.age_min,
    age_max: a.age_max,
    interests: [...a.interests],
    publisher_platforms: [...a.publisher_platforms],
  };
}

/**
 * Request a paid boost for a published social post.
 *
 * PR2 behaviour: insert boost_runs row at status='pending' and return.
 * PR3 behaviour (gated on MAKE_BOOST_WEBHOOK_URL env): ALSO fire the Make
 * webhook with the boost request payload.
 *
 * @param {object} post        the posts row, must have track='social' and
 *                             meta.boost_eligible === true (caller checks).
 * @param {string} fb_post_id  Facebook post ID returned by publishToFacebook.
 * @returns {Promise<{boost_run_id: string, fired_webhook: boolean}>}
 */
async function requestBoost(post, fb_post_id) {
  const niche_tag = post && post.meta && post.meta.niche_tag;
  const audience_spec = deriveAudienceSpec(niche_tag);

  const row = await insertBoostRun({
    post_id: post.id,
    daily_budget_pence: DEFAULT_DAILY_BUDGET_PENCE,
    duration_hours: DEFAULT_BOOST_DURATION_HOURS,
    audience_spec,
    meta: {
      niche_tag: niche_tag || null,
      fb_post_id,
      source: 'orchestrator',
    },
  });
  console.log(`[boost] inserted boost_runs row ${row.id} (status=pending) for post ${post.id}`);

  // PR3 surface — webhook fire. Gated on env var so PR2 ships without it.
  const webhookUrl = process.env.MAKE_BOOST_WEBHOOK_URL;
  if (!webhookUrl) {
    return { boost_run_id: row.id, fired_webhook: false };
  }

  // PR3 will implement: build payload, HMAC sign, fetch POST, handle errors.
  // See .ruflo/social-engine-architecture.md §M.3 for the payload schema.
  return { boost_run_id: row.id, fired_webhook: false };
}

module.exports = { requestBoost, deriveAudienceSpec };
