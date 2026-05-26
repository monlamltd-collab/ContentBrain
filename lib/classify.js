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

// Intent definitions baked into the prompt. Brief-authoritative wording.
const INTENT_GLOSSARY = [
  '- interested: positive engagement, asking to talk, requesting a demo or a call.',
  '- questions: substantive question(s) about the offer that need a personal answer.',
  '- not_interested: polite decline, "not for us right now", "we already have a tool".',
  '- out_of_office: autoresponder, holiday/maternity, sick leave; not from a person.',
  '- wrong_person: "you want my colleague Sarah", "I left the company", "wrong inbox".',
  '- unsubscribe: explicit opt-out request — "remove me", "take me off your list".',
  '- hostile: angry/abusive language, "stop emailing me", aggressive tone.',
  '- complaint: threatens reporting (ICO, FCA, spam complaint), legalistic tone.',
].join('\n');

function buildSystemPrompt() {
  return `You classify inbound replies to B2B cold outreach emails. You are precise, neutral, and never invent intent that isn't in the text.

Choose EXACTLY ONE of these 8 intents:
${INTENT_GLOSSARY}

Tie-breakers when multiple intents could apply:
- A polite decline that also includes "please remove me" is unsubscribe, not not_interested.
- An autoresponder that also mentions a colleague is out_of_office, not wrong_person.
- An angry message that threatens regulatory action is complaint, not hostile.
- A question that ALSO expresses interest is interested (the hand-raise wins).

Confidence rules:
- 0.9+ — the text is unambiguous on the chosen intent.
- 0.7-0.9 — clear lean but some ambiguity (e.g. polite decline that hints at "maybe later").
- 0.5-0.7 — short / forwarded / partially-cut message; pick the most plausible intent.
- below 0.5 — you are guessing; pick whichever intent fits best and let the application route to a human.

OUTPUT — return exactly this JSON shape (no commentary outside the braces):
{
  "intent": "<one of the 8 above>",
  "confidence": <number between 0 and 1>,
  "reasoning": "<one short sentence>"
}`;
}

function buildUserPrompt({ subject, body, fromName, fromEmail, contactName, companyName, lastSentSubject }) {
  const truncated = String(body || '').slice(0, MAX_BODY_CHARS);
  const lines = [];
  lines.push('CONTEXT:');
  if (companyName) lines.push(`- Recipient company: ${companyName}`);
  if (contactName) lines.push(`- Contact we wrote to: ${contactName}`);
  else lines.push('- Contact we wrote to: (unknown — likely a role inbox)');
  if (fromName || fromEmail) lines.push(`- Reply from: ${[fromName, fromEmail].filter(Boolean).join(' ')}`);
  if (lastSentSubject) lines.push(`- Subject of our most recent message: ${lastSentSubject}`);
  if (subject) lines.push(`- Reply subject: ${subject}`);
  lines.push('');
  lines.push('REPLY BODY:');
  lines.push(truncated || '(empty body — likely an autoresponder header-only message)');
  lines.push('');
  lines.push('Classify the reply now. Return ONLY the JSON object.');
  return lines.join('\n');
}

// Mirrors parseJsonResponse from generate-outbound.js — extract first `{...}`
// block and JSON.parse it. We accept the model returning whitespace/preamble
// around the JSON; we DO NOT accept arbitrary types for the three fields.
function parseJsonResponse(text) {
  const m = String(text || '').match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON object in classifier response');
  const parsed = JSON.parse(m[0]);
  if (typeof parsed.intent !== 'string' || !parsed.intent.trim()) {
    throw new Error('Classifier response missing intent');
  }
  if (typeof parsed.confidence !== 'number' || Number.isNaN(parsed.confidence)) {
    throw new Error('Classifier response missing numeric confidence');
  }
  return parsed;
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
 * Garbage handling: if the model returns invalid JSON or an out-of-enum
 * intent, the function logs a warning and returns
 * `{intent: 'questions', confidence: 0.5, reasoning: '<error>'}` — a safe
 * default that routes the reply to a human via the requires_human floor.
 * This is preferred over throwing because the caller (handleInboundEmail)
 * still needs to insert the reply row so Simon can resolve manually.
 *
 * @param {object} params
 * @param {string} [params.subject]
 * @param {string} params.body
 * @param {string} [params.fromName]
 * @param {string} [params.fromEmail]
 * @param {string} [params.contactName]
 * @param {string} [params.companyName]
 * @param {string} [params.lastSentSubject]
 * @returns {Promise<{
 *   intent: 'interested'|'questions'|'not_interested'|'out_of_office'|'wrong_person'|'unsubscribe'|'hostile'|'complaint',
 *   confidence: number,         // 0..1, clamped
 *   reasoning: string,
 * }>}
 */
async function classifyReply({ subject, body, fromName, fromEmail, contactName, companyName, lastSentSubject } = {}) {
  if (!body || typeof body !== 'string') {
    // No body to classify — treat as garbage and force human review.
    console.warn('[classify] reply body missing/empty; falling back to questions/0.5');
    return { intent: 'questions', confidence: 0.5, reasoning: 'Empty body — routed to human.' };
  }

  const system = buildSystemPrompt();
  const user = buildUserPrompt({ subject, body, fromName, fromEmail, contactName, companyName, lastSentSubject });

  let text;
  try {
    const resp = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: user }],
    });
    text = resp.content && resp.content[0] && resp.content[0].text;
  } catch (err) {
    console.warn(`[classify] Anthropic call failed: ${err.message}; falling back to questions/0.5`);
    return { intent: 'questions', confidence: 0.5, reasoning: `Classifier API error: ${err.message}` };
  }

  let parsed;
  try {
    parsed = parseJsonResponse(text);
  } catch (err) {
    console.warn(`[classify] parse error: ${err.message}; falling back to questions/0.5`);
    return { intent: 'questions', confidence: 0.5, reasoning: `Parse error: ${err.message}` };
  }

  // Validate intent. assertReplyIntent throws on bad value — convert to
  // graceful fallback so a model brain-fart never takes the webhook down.
  try {
    assertReplyIntent(parsed.intent);
  } catch (err) {
    console.warn(`[classify] invalid intent '${parsed.intent}'; falling back to questions/0.5`);
    return { intent: 'questions', confidence: 0.5, reasoning: `Invalid intent: ${parsed.intent}` };
  }

  // Clamp confidence to [0, 1]. Models sometimes overshoot the unit interval
  // (e.g. 1.5) or use a percentage-style value (e.g. 95). Treat values in
  // (10, 100] as percentages and divide by 100; clamp anything else into
  // [0, 1]. The 10-threshold prevents a slightly-over-1 decimal (1.5)
  // collapsing to 0.015 — that lands as 1 instead, which matches the
  // intuitive "model overshot but meant max-confidence" reading.
  let confidence = parsed.confidence;
  if (confidence > 10 && confidence <= 100) confidence = confidence / 100;
  if (confidence < 0) confidence = 0;
  if (confidence > 1) confidence = 1;

  return {
    intent: parsed.intent,
    confidence,
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning : '',
  };
}

// ── Intent → application action lookup ───────────────────────────────────
//
// Application-deterministic mapping from a classifier intent to:
//   - whether Simon must eyeball the reply before any further automation
//     fires (`requires_human`)
//   - what suppression to apply to the sender (`suppression`)
//   - what to do with the active sequence (`sequence_action`)
//   - whether a Telegram alert fires (`telegram_alert`)
//
// Researcher's Phase-C design table is the source of truth here
// (.ruflo/phase-c-design.md §4). The architect added `ended_reason`,
// `urgent`, and `flip_siblings` as derived fields so callers don't repeat
// a switch statement downstream.
//
// Suppression reasons are validated against
// VALID_SUPPRESSION_REASONS in constants.js — see addSuppression.
const INTENT_ACTIONS = Object.freeze({
  interested: {
    requires_human: true,
    suppression: null,
    suppression_reason: null,
    sequence_action: 'pause',
    ended_reason: 'awaiting_human',
    telegram_alert: true,
    urgent: true,
    flip_siblings: false,
  },
  questions: {
    requires_human: true,
    suppression: null,
    suppression_reason: null,
    sequence_action: 'pause',
    ended_reason: 'awaiting_human',
    telegram_alert: true,
    urgent: false,
    flip_siblings: false,
  },
  not_interested: {
    requires_human: false,
    suppression: null,
    suppression_reason: null,
    sequence_action: 'complete',
    ended_reason: 'replied_decline',
    telegram_alert: false,
    urgent: false,
    flip_siblings: false,
  },
  out_of_office: {
    requires_human: false,
    suppression: null,
    suppression_reason: null,
    sequence_action: 'continue',
    ended_reason: null,
    telegram_alert: false,
    urgent: false,
    flip_siblings: false,
  },
  wrong_person: {
    requires_human: true,
    suppression: 'email',
    suppression_reason: 'wrong_person',
    sequence_action: 'complete',
    ended_reason: 'wrong_person',
    telegram_alert: true,
    urgent: false,
    flip_siblings: false,
  },
  unsubscribe: {
    requires_human: false,
    suppression: 'email',
    suppression_reason: 'unsubscribe',
    sequence_action: 'opt_out',
    ended_reason: 'unsubscribe',
    telegram_alert: false,
    urgent: false,
    flip_siblings: false,
  },
  hostile: {
    requires_human: true,
    suppression: 'domain',
    suppression_reason: 'hostile_reply',
    sequence_action: 'pause',
    ended_reason: 'hostile_pause',
    telegram_alert: true,
    urgent: true,
    flip_siblings: true,
  },
  complaint: {
    requires_human: true,
    suppression: 'domain',
    suppression_reason: 'hostile_reply',
    sequence_action: 'pause',
    ended_reason: 'hostile_pause',
    telegram_alert: true,
    urgent: true,
    flip_siblings: true,
  },
});

/**
 * Intent → application action lookup, plus the confidence-floor override.
 *
 * Confidence below MIN_CONFIDENCE_FOR_AUTO forces `requires_human=true` and
 * `telegram_alert=true` regardless of intent (Simon eyeballs the borderline
 * case). All other fields stay as the per-intent table dictates.
 *
 * @param {string} intent      one of VALID_REPLY_INTENTS
 * @param {number} [confidence] classifier confidence (default 1)
 * @returns {{
 *   requires_human: boolean,
 *   suppression: 'email'|'domain'|null,
 *   suppression_reason: string|null,
 *   sequence_action: 'pause'|'complete'|'opt_out'|'continue',
 *   ended_reason: string|null,
 *   telegram_alert: boolean,
 *   urgent: boolean,
 *   flip_siblings: boolean,
 *   low_confidence: boolean,
 * }}
 * @throws when intent is not in VALID_REPLY_INTENTS.
 */
function lookupAction(intent, confidence = 1) {
  assertReplyIntent(intent);
  const base = INTENT_ACTIONS[intent];
  const lowConfidence = typeof confidence === 'number' && confidence < MIN_CONFIDENCE_FOR_AUTO;
  if (lowConfidence) {
    // Override: force human + telegram alert. Suppression and sequence
    // action remain as the intent says — Simon's review is the gate that
    // decides whether to roll back any of those.
    return {
      ...base,
      requires_human: true,
      telegram_alert: true,
      low_confidence: true,
    };
  }
  return { ...base, low_confidence: false };
}

module.exports = {
  classifyReply,
  lookupAction,
  MODEL,
  MAX_BODY_CHARS,
  MIN_CONFIDENCE_FOR_AUTO,
  VALID_REPLY_INTENTS,
  _internals: { buildSystemPrompt, buildUserPrompt, parseJsonResponse, INTENT_ACTIONS },
};
