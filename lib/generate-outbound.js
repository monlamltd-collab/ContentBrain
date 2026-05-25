require('dotenv').config();

// ── OUTBOUND GENERATION (Phase B) ─────────────────────────────────────────
//
// `generateOutbound` is the outbound-track sibling of `generateBatch` (in
// lib/generate.js). It produces one Claude-written email per (contact,
// sequence step) — first touch at step=1, then +3d / +7d / +14d follow-ups
// at steps 2/3/4.
//
// Split out into its own file (re-exported from lib/generate.js) so the
// social-path file stays under the 500-line house cap. Both paths share the
// same Anthropic client + brand-resolved system prompt machinery; the coder
// will pull helpers in from ./generate as needed.
//
// Outbound layers in:
//   - track-specific persona (lender / broker / auction_house)
//   - contact + prospect context (name nullable for inboxes — see filter rules)
//   - prior-step content so follow-ups don't repeat the cold open
//   - mandatory post-generation pass through lib/outbound-filters.runFilters,
//     with up-to-N regeneration retries when filters block.
//
// Output is persisted as a row in `posts` with track='outbound', channel='resend',
// meta.{contact_id, sequence_id, sequence_step, prospect_id} for traceability.

/**
 * Generate one outbound email for a given track + contact + step.
 *
 * @param {'lender'|'broker'|'auction_house'} track
 * @param {object} contact   - row from `contacts` (id, name, role, email, prospect_id)
 * @param {object} prospect  - row from `prospects` (id, type, company_name, website, metadata)
 * @param {number} sequenceStep - 1 = cold; 2 = +3d; 3 = +7d; 4 = +14d
 * @returns {Promise<{
 *   subject: string,
 *   body: string,
 *   filterBlocks: Array<object>,   // empty when ok; populated when retries exhausted
 *   meta: {
 *     track: string,
 *     sequence_step: number,
 *     contact_id: string,
 *     prospect_id: string,
 *     hook_pattern: string|null    // for engagement learning, mirrors social path
 *   }
 * }>}
 */
async function generateOutbound(track, contact, prospect, sequenceStep) {
  // TODO(coder):
  //   1. Build a track-specific system prompt (extend getSystemPrompt or a
  //      sibling `getOutboundSystemPrompt(track)` — coder picks).
  //   2. Compose context: prospect.company_name, prospect.metadata.funding_model
  //      (lender) etc., contact.name (skip name-personalisation when NULL —
  //      use a "Hello," opener; outbound-filters will block "Hi [first_name]"),
  //      sequenceStep + any prior-step bodies fetched from posts.meta.
  //   3. Call anthropic.messages.create with MODEL = claude-haiku-4-5-20251001.
  //   4. Parse the JSON response into { subject, body, hook_pattern }.
  //   5. Run lib/outbound-filters.runFilters({subject, body}). On block:
  //      regenerate with the blocks fed back into the prompt (up to 2 retries).
  //   6. Return the shape above. Caller (server.js outbound cron) handles
  //      persistence + Telegram approval prompt.
  void track; void contact; void prospect; void sequenceStep;
  throw new Error('generateOutbound not implemented yet — see TODO(coder)');
}

module.exports = { generateOutbound };
