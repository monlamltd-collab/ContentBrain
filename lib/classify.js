require('dotenv').config();

// ── Reply classifier (Phase C) ────────────────────────────────────────────
//
// Cheap Haiku call that takes a raw inbound email body and returns one of
// the 8 reply intents defined by the brief (GROWTH_BRAIN_BUILD.md §4):
//
//   interested · questions · not_interested · out_of_office ·
//   wrong_person · unsubscribe · hostile · complaint
//
// The classifier returns `{intent, confidence, reasoning}` ONLY.
// `requires_human` is NOT set by the model — it's a deterministic
// application lookup (`lookupAction` below). Two reasons:
//
//   1) The brief is unambiguous about which intents need a human (interested,
//      questions, wrong_person, hostile, complaint) and which don't
//      (not_interested, out_of_office, unsubscribe). Letting the model decide
//      adds variance for no benefit.
//
//   2) Confidence < 0.6 forces requires_human = true regardless of intent —
//      another deterministic rule that belongs outside the model.
//
// Model: claude-haiku-4-5-20251001 — same as lib/generate.js and
// lib/generate-outbound.js. House style.
//
// Body truncation: capped at 4000 chars. UK B2B replies in our pilot run
// were all under 1500 chars; 4000 leaves headroom for a verbose hostile
// rant or a forwarded thread.
//
// Validation: parsed intent is asserted via constants.assertReplyIntent. A
// model that returns a not-in-list intent surfaces a thrown error to the
// caller (handleInboundEmail), which logs and falls back to requires_human
// = true with intent = null — better an unrouted reply on Simon's desk than
// a silently-misclassified one.
//
// British English in all log strings.

const Anthropic = require('@anthropic-ai/sdk');
const { assertReplyIntent, VALID_REPLY_INTENTS } = require('./sales-brain/constants');

const MODEL = 'claude-haiku-4-5-20251001';

const MAX_BODY_CHARS = 4000;
const MIN_CONFIDENCE_FOR_AUTO = 0.6;

let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

/**
 * Classify one inbound reply.
 *
 * Builds a minimal prompt: the 8 intents (with one-line definitions), the
 * conversation context (subject of the message we sent + the company /
 * contact name), and the raw reply body. Returns strict JSON. Parsing
 * mirrors `parseJsonResponse` in generate-outbound.js — extract the first
 * `{...}` block and JSON.parse it.
 *
 * @param {object} params
 * @param {string} params.subject       inbound subject line (Re: ...)
 * @param {string} params.body          inbound body — caller passes plain
 *   text, with HTML stripped. Will be trimmed to MAX_BODY_CHARS.
 * @param {string} [params.fromName]    display name on the From header
 *   (helps the model distinguish a personal vs role inbox)
 * @param {string} [params.fromEmail]   sender address
 * @param {string} [params.contactName] the contact we wrote to (may be null
 *   if the cold open was sent to a role inbox)
 * @param {string} [params.companyName] the prospect's company_name
 * @param {string} [params.lastSentSubject] the subject of OUR most recent
 *   message in the thread — helps the model judge "this is OOO" vs "this is
 *   a question about that pitch"
 * @returns {Promise<{
 *   intent: 'interested'|'questions'|'not_interested'|'out_of_office'|'wrong_person'|'unsubscribe'|'hostile'|'complaint',
 *   confidence: number,         // 0..1
 *   reasoning: string,          // one sentence — stored on replies for audit
 * }>}
 * @throws when the model returns invalid JSON, when the intent is not in
 *   VALID_REPLY_INTENTS, or when the Anthropic API errors out. NEVER returns
 *   `requires_human` — that's `lookupAction`'s job.
 */
async function classifyReply({ subject, body, fromName, fromEmail, contactName, companyName, lastSentSubject } = {}) {
  throw new Error('classifyReply: not yet implemented — coder');
}

/**
 * Intent → application action lookup table.
 *
 * Application-deterministic mapping from a classifier intent to:
 *   - whether Simon must eyeball the reply before any further automation
 *     fires (`requires_human`)
 *   - what suppression to apply to the sender (`suppression`)
 *   - what to do with the active sequence (`sequence_action`)
 *   - whether a Telegram alert fires (`telegram_alert`)
 *
 * Per researcher's Phase-C design (.ruflo/phase-c-design.md §4):
 *
 *   | Intent          | requires_human | suppression | sequence_action | telegram_alert |
 *   |-----------------|----------------|-------------|-----------------|----------------|
 *   | interested      | true           | null        | pause           | true (urgent)  |
 *   | questions       | true           | null        | pause           | true           |
 *   | not_interested  | false          | null        | complete        | false          |
 *   | out_of_office   | false          | null        | continue (+7d)  | false          |
 *   | wrong_person    | true           | email       | complete        | true           |
 *   | unsubscribe     | false          | email       | opt_out         | false          |
 *   | hostile         | true           | domain      | pause (cascade) | true (urgent)  |
 *   | complaint       | true           | domain      | pause (cascade) | true (urgent)  |
 *
 * `sequence_action` values:
 *   - 'pause'      → status='paused' (ended_reason set by intent; see sequence.js)
 *   - 'complete'   → status='completed' (terminal)
 *   - 'opt_out'    → status='opted_out' (terminal — unsubscribe only)
 *   - 'continue'   → next_scheduled_at += 7d, status stays 'active'
 *     (OOO auto-defer; see §5.3 of the design doc — coder enforces the
 *     2-OOO cap in lib/inbound.js, not here)
 *
 * @param {string} intent  one of VALID_REPLY_INTENTS
 * @returns {{
 *   requires_human: boolean,
 *   suppression: 'email'|'domain'|null,
 *   sequence_action: 'pause'|'complete'|'opt_out'|'continue',
 *   telegram_alert: boolean,
 *   ended_reason: string|null,    // pre-resolved ended_reason — saves the
 *                                   // caller from a second switch statement
 *   urgent: boolean,               // for Telegram styling — interested /
 *                                   // hostile / complaint get prominent treatment
 * }}
 * @throws when intent is not in VALID_REPLY_INTENTS.
 */
function lookupAction(intent) {
  throw new Error('lookupAction: not yet implemented — coder');
}

module.exports = {
  classifyReply,
  lookupAction,
  MODEL,
  MAX_BODY_CHARS,
  MIN_CONFIDENCE_FOR_AUTO,
  VALID_REPLY_INTENTS,
};
