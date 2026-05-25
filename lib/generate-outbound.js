require('dotenv').config();

// ── OUTBOUND GENERATION (Phase B) ─────────────────────────────────────────
//
// `generateOutbound` is the outbound-track sibling of `generateBatch` (in
// lib/generate.js). It produces one Claude-written email per (contact,
// sequence step). step=1 = cold open; step=2..4 = +3d/+7d/+14d follow-ups.
//
// Split out into its own file (re-exported from lib/generate.js) so the
// social-path file stays under the 500-line house cap. Uses the same
// Anthropic SDK + MODEL constant as generate.js — re-instantiated locally
// to keep this module standalone (avoids a require cycle with generate.js
// which already imports this file).
//
// Outbound layers in:
//   - track-specific persona (lender / broker / auction_house)
//   - contact + prospect context (name nullable for inboxes — see filters)
//   - prior-step content so follow-ups don't repeat the cold open
//   - mandatory post-generation pass through outbound-filters.runFilters
//     with up-to-2 regeneration retries when filters block
//
// Tone overrides come from runtime-config (same Telegram lever path as the
// social side). The key is `outbound_tone_<track>` on the 'global' brand
// row — Simon flips it with `/tone outbound-lender …`. Falls back to a
// per-track default below.

const Anthropic = require('@anthropic-ai/sdk');
const { runFilters } = require('./outbound-filters');

// Lazy-load runtime-config: pulling it in eagerly creates a Supabase client
// at module load even when this file is required for its side-effect-free
// JSDoc shape (e.g. by tests).
let _runtimeConfig = null;
function getRuntimeConfig() {
  if (!_runtimeConfig) _runtimeConfig = require('./runtime-config');
  return _runtimeConfig;
}

const MODEL = 'claude-haiku-4-5-20251001';
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

const MAX_RETRIES = 2; // total 3 attempts (1 initial + 2 retries)

// ── Per-track personas + step shapes ─────────────────────────────────────

const TRACK_PERSONAS = {
  lender: `You are writing on behalf of BridgeMatch (https://bridgematch.co.uk), the bridging-finance matchmaker that helps brokers find the right lender in minutes. The recipient is a UK bridging lender (BDM or enquiries inbox). Tone: peer-to-peer, fintech-aware, short. They are NOT a customer; they are a potential listed lender. We want their criteria on our platform so brokers find them faster.

IMPORTANT — DUAL-DOMAIN CONTEXT: the email is being sent from a verified address at auctionbrain.co.uk (the sister product, a UK property-auction directory). The recipient will see "@auctionbrain.co.uk" in their From line. To avoid confusion, the FIRST line of the body MUST introduce BridgeMatch by name and briefly explain that AuctionBrain is the sister product — something like "I'm Simon — I built BridgeMatch (a bridging-broker matchmaker) and a sister tool AuctionBrain. Writing from the AuctionBrain domain because the BridgeMatch one is still in DNS setup." Be honest, light, transparent. Don't dwell on it — one sentence.`,
  broker: `You are writing on behalf of BridgeMatch (https://bridgematch.co.uk) to a UK FCA-authorised bridging broker. Tone: warm, respectful of their authorisation, business-to-business. We help them shortlist lenders for a deal in minutes rather than calling each one.`,
  auction_house: `You are writing on behalf of AuctionBrain (https://www.auctionbrain.co.uk) to a UK auction house. Tone: transactional, focused on portal traffic. AuctionBrain aggregates UK auction inventory and drives buyer traffic to the listing page on the auction house's own site.`,
};

const STEP_SHAPE = {
  1: { name: 'cold open',         brief: 'First touch. Lead with a concrete reason to write to THIS recipient (their company, role, or domain) and end with a one-line ask — usually a 10-min call or a "would this be relevant?". Subject ≤ 7 words.' },
  2: { name: '+3d follow-up',     brief: 'Light second touch. Acknowledge the first message briefly ("following up on my note from Friday") without repeating it. Add ONE new angle or piece of value. Shorter than the cold open.' },
  3: { name: '+7d value-add',     brief: 'Third touch. Lead with a piece of value — a relevant data point, a free resource, a useful framing — and keep the ask soft ("worth a look?"). No restating the prior asks.' },
  4: { name: '+14d final ping',   brief: 'Polite close-out. One short paragraph saying you will stop chasing and leaving the door open. Tone is friendly, not guilt-trippy. End with "no need to reply".' },
};

// ── Helpers ─────────────────────────────────────────────────────────────

async function getOutboundTone(track) {
  // runtime-config stores 'global' brand levers — we abuse the brand slot
  // to namespace outbound tones since they're not per-brand-of-content,
  // they're per-track. Key shape: outbound_tone_lender / _broker / _ah.
  const rc = getRuntimeConfig();
  const key = `outbound_tone_${track}`;
  try {
    // No dedicated getter for this lever; readRaw isn't exported. Roll our
    // own via setLever's underlying Supabase pattern would be heavy; instead,
    // wedge through loadAllLevers and filter. Cheap (one row scan, ~5/sec).
    const all = await rc.loadAllLevers();
    const row = all.find(r => r.brand === 'global' && r.key === key);
    if (row && typeof row.value === 'string' && row.value.trim()) return row.value.trim();
  } catch (err) {
    console.warn(`[generate-outbound] tone lookup for ${key} failed: ${err.message}`);
  }
  return null;
}

function buildSystemPrompt(track, toneOverride) {
  const persona = TRACK_PERSONAS[track] || TRACK_PERSONAS.lender;
  const toneBlock = toneOverride
    ? `\n\nTONE OVERRIDE (current standing instruction from the owner — honour this):\n${toneOverride}`
    : '';
  return `${persona}${toneBlock}

HARD RULES:
- British English only. No Americanisms.
- No FCA-flagged words: never use "guaranteed", "risk-free", "certain return", or "approved" in any finance context.
- Never invent the recipient's first name. If their name is unknown, open with "Hello," — never "Hi [first_name]", "Hi there", or "Dear Sir/Madam".
- No spam-cliché openers: never write "I hope this email finds you well", "I came across", "I noticed that your", or "As an AI".
- Plain text only. No links beyond one signature URL. No emojis. No hashtags.
- Tight. Three short paragraphs maximum. Most cold opens land best at 50-90 words.

OUTPUT — return exactly this JSON shape (no commentary outside the braces):
{
  "subject": "...",
  "body": "...",
  "reasoning": "one sentence explaining the angle you took"
}`;
}

function buildUserPrompt(track, contact, prospect, sequenceStep, regenHints) {
  const step = STEP_SHAPE[sequenceStep] || STEP_SHAPE[1];
  const lines = [];

  lines.push(`STEP: ${sequenceStep} (${step.name})`);
  lines.push(step.brief);
  lines.push('');

  lines.push('RECIPIENT:');
  lines.push(`- Company: ${prospect.company_name || '(unknown)'}`);
  if (prospect.website) lines.push(`- Website: ${prospect.website}`);
  if (contact.name) lines.push(`- Name: ${contact.name}`);
  else lines.push(`- Name: UNKNOWN — this is an inbox/role address; open with "Hello,"`);
  if (contact.role) lines.push(`- Role: ${contact.role}`);
  if (contact.email) lines.push(`- Email: ${contact.email}`);

  // Surface useful metadata for the persona — funding model for lenders etc.
  const meta = (prospect && prospect.metadata) || {};
  if (track === 'lender' && meta.funding_model) {
    lines.push(`- Funding model: ${meta.funding_model}`);
  }
  if (meta.last_updated) lines.push(`- Source last updated: ${meta.last_updated}`);

  if (regenHints && regenHints.length) {
    lines.push('');
    lines.push('REGENERATION CONTEXT — your previous draft was BLOCKED by quality filters. Fix every issue below:');
    for (const h of regenHints) {
      lines.push(`- ${h.rule} (${h.where}): "${h.match}" — ${h.reason}`);
    }
  }

  lines.push('');
  lines.push('Write the email now. Return ONLY the JSON object.');
  return lines.join('\n');
}

function parseJsonResponse(text) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON object in Claude response');
  const parsed = JSON.parse(m[0]);
  if (!parsed.subject) throw new Error('Generated message missing subject');
  if (!parsed.body) throw new Error('Generated message missing body');
  return parsed;
}

/**
 * Generate one outbound email.
 *
 * @param {'lender'|'broker'|'auction_house'} track
 * @param {object} contact   row from `contacts` (id, name, role, email, prospect_id)
 * @param {object} prospect  row from `prospects` (id, type, company_name, website, metadata)
 * @param {number} sequenceStep 1..4
 * @returns {Promise<{
 *   subject: string,
 *   body: string,
 *   reasoning: string,
 *   filterBlocks: Array<object>,
 *   meta: { track: string, sequence_step: number, contact_id: string, prospect_id: string }
 * }>}
 * @throws {Error} when all 3 attempts fail filter checks; the thrown error
 *   has a `.blocks` property listing every block from the final attempt.
 */
async function generateOutbound(track, contact, prospect, sequenceStep) {
  if (!['lender', 'broker', 'auction_house'].includes(track)) {
    throw new Error(`Unknown outbound track '${track}'`);
  }
  if (!contact || !contact.id || !contact.email) {
    throw new Error('generateOutbound: contact must include id and email');
  }
  if (!prospect || !prospect.id) {
    throw new Error('generateOutbound: prospect must include id');
  }
  const step = Math.max(1, Math.min(4, parseInt(sequenceStep, 10) || 1));

  const toneOverride = await getOutboundTone(track);
  const system = buildSystemPrompt(track, toneOverride);

  let regenHints = [];
  let lastResult = null;
  let lastBlocks = [];

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const user = buildUserPrompt(track, contact, prospect, step, regenHints);
    const resp = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = resp.content[0].text;
    let parsed;
    try {
      parsed = parseJsonResponse(text);
    } catch (err) {
      console.warn(`[generate-outbound] attempt ${attempt + 1}/${MAX_RETRIES + 1} parse error: ${err.message}`);
      regenHints = [{ rule: 'json_parse', where: 'response', match: '', reason: `Previous attempt returned invalid JSON: ${err.message}. Return ONLY the JSON object.` }];
      continue;
    }

    const filterRes = runFilters({ subject: parsed.subject, body: parsed.body });
    if (filterRes.ok) {
      console.log(`[generate-outbound] attempt ${attempt + 1}/${MAX_RETRIES + 1} ok for ${track} step ${step} (${contact.email})`);
      return {
        subject: parsed.subject,
        body: parsed.body,
        reasoning: parsed.reasoning || '',
        filterBlocks: filterRes.blocks, // warnings still surface
        meta: {
          track,
          sequence_step: step,
          contact_id: contact.id,
          prospect_id: prospect.id,
        },
      };
    }

    const blocks = filterRes.blocks.filter(b => b.severity === 'block');
    console.warn(`[generate-outbound] attempt ${attempt + 1}/${MAX_RETRIES + 1} BLOCKED by ${blocks.length} filter(s) for ${track} step ${step}: ${blocks.map(b => b.rule).join(', ')}`);
    lastResult = parsed;
    lastBlocks = filterRes.blocks;
    regenHints = blocks;
  }

  // All attempts exhausted — surface the final failure for the caller to
  // route to Telegram with the offending blocks attached.
  const err = new Error(`generateOutbound: filter blocks not resolved after ${MAX_RETRIES + 1} attempts for ${track}/${contact.email}`);
  err.blocks = lastBlocks;
  err.lastResult = lastResult;
  throw err;
}

module.exports = { generateOutbound, _internals: { buildSystemPrompt, buildUserPrompt, parseJsonResponse, STEP_SHAPE, TRACK_PERSONAS } };
