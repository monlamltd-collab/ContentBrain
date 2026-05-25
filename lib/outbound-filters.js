require('dotenv').config();

// ── Outbound content filters (Phase B) ────────────────────────────────────
//
// Hard quality gate run against every Claude-generated outbound message
// BEFORE it reaches Telegram for human approval. A filter BLOCK is a
// generation bug; generate-outbound retries up to 2 times. If retries are
// exhausted, the failure surfaces with offending blocks attached so the
// operator sees WHY each retry failed.
//
// The forbidden patterns are non-negotiable: see GROWTH_BRAIN_BUILD.md
// lines 111-117 and .ruflo/phase-b-context.md §Filters. Adding categories
// is fine; relaxing existing ones requires Simon's sign-off.
//
// Categories:
//   FCA (BLOCK)        — financial-promotion words flagged by the FCA. Using
//                        them in cold outreach to FCA-authorised audiences
//                        compromises BridgeMatch's AR status.
//   name_guess (BLOCK) — template placeholders that bled through ("[first_name]",
//                        "Hi there"). The bridging-brain importer leaves
//                        contact.name NULL for enquiries inboxes by design;
//                        a bled placeholder is a generator bug AND a
//                        deliverability disaster.
//   ai_tell (BLOCK)    — opener cliches ("I hope this email finds you well",
//                        "I came across…") that trip spam filters AND read
//                        as obviously LLM-generated.
//   americanism (WARN) — soft check ("color", "organize"). Returned alongside
//                        ok:true — surfaced to Telegram as a warning, not a
//                        retry trigger. The persona prompt does most of the
//                        work; this is belt-and-braces.
//
// runFilters returns ALL blocks in one pass so the regeneration prompt can
// address every issue at once instead of a fix-one-bug-at-a-time loop.

// ── FCA-flagged finance words ────────────────────────────────────────────
// Brief §6 (architect's TODOs):
//   - \bguaranteed\b  (any context)
//   - \brisk[- ]?free\b
//   - \bapproved\b only within 30 chars of (loan|funding|finance|bridge|credit)
//   - \bcertain return\b

const FCA_ABSOLUTE = [
  { re: /\bguaranteed\b/i,            label: 'guaranteed',     reason: 'The word "guaranteed" is FCA-flagged for unauthorised financial promotions. Avoid it entirely in outbound.' },
  { re: /\brisk[- ]?free\b/i,         label: 'risk-free',      reason: '"Risk-free" is FCA-flagged. We cannot describe any finance product this way.' },
  { re: /\bcertain return\b/i,        label: 'certain return', reason: '"Certain return" implies a guaranteed outcome and is FCA-flagged.' },
];

// `approved` is only a violation in a finance context. Window check is 30
// chars either side of the match; anything closer is a finance promise.
const APPROVED_RE = /\bapproved\b/gi;
const APPROVED_CONTEXT_RE = /(loan|funding|finance|bridge|credit)/i;
const APPROVED_WINDOW = 30;

// ── Name-guess templates ─────────────────────────────────────────────────
// Brief §6:
//   - \[first_?name\]
//   - \[name\]
//   - \bDear (Sir|Madam)\b
//   - ^Hi there\b   (start of body/subject)

const NAME_GUESS = [
  { re: /\[first_?name\]/i,    label: '[first_name]',  reason: 'Placeholder "[first_name]" bled through. Use a real name or open with "Hello," — never a guess.' },
  { re: /\[name\]/i,           label: '[name]',        reason: 'Placeholder "[name]" bled through. Use a real name or open with "Hello,".' },
  { re: /\bDear (Sir|Madam)\b/i, label: 'Dear Sir/Madam', reason: '"Dear Sir/Madam" reads as a mail-merge fallback. Use "Hello," when no name is available.' },
  { re: /^Hi there\b/i,        label: 'Hi there',      reason: '"Hi there" reads as a name-unknown fallback. Use "Hello," — it owns the no-name situation cleanly.' },
];

// ── AI-tells ─────────────────────────────────────────────────────────────
// Brief §6:
//   - \bI hope this (email|message) finds you well\b
//   - \bI came across\b
//   - \bI noticed that your\b
//   - \bAs an AI\b

const AI_TELLS = [
  { re: /\bI hope this (email|message) finds you well\b/i, label: 'I hope this email finds you well', reason: 'Spam-filter cliche. Open with something specific to the recipient instead.' },
  { re: /\bI came across\b/i,                              label: 'I came across',                  reason: '"I came across" is a tell-tale cold-outreach opener — too generic to land.' },
  { re: /\bI noticed that your\b/i,                        label: 'I noticed that your',            reason: '"I noticed that your" reads as scraped-from-LinkedIn. Be specific or drop the observation.' },
  { re: /\bAs an AI\b/i,                                   label: 'As an AI',                       reason: '"As an AI" — never. The recipient does not need to know how the message was drafted.' },
];

// ── Americanisms (WARN, not block) ──────────────────────────────────────

const AMERICANISMS = [
  { re: /\bcolor\b/i,      label: 'color',     reason: 'British English: "colour".' },
  { re: /\borganize\b/i,   label: 'organize',  reason: 'British English: "organise".' },
  { re: /\bcustomize\b/i,  label: 'customize', reason: 'British English: "customise".' },
  { re: /\bfavorite\b/i,   label: 'favorite',  reason: 'British English: "favourite".' },
];

/**
 * Scan a single field with the given pattern list, producing block descriptors.
 */
function scan(field, where, patterns, category, severity) {
  if (typeof field !== 'string' || !field) return [];
  const out = [];
  for (const { re, label, reason } of patterns) {
    const m = field.match(re);
    if (m) {
      out.push({ rule: label, category, match: m[0], where, severity, reason });
    }
  }
  return out;
}

/**
 * Approved-in-finance-context scanner. Walks every "approved" occurrence and
 * flags any whose +/-30-char window contains a finance keyword.
 */
function scanApprovedContext(field, where) {
  if (typeof field !== 'string' || !field) return [];
  const out = [];
  APPROVED_RE.lastIndex = 0;
  let m;
  while ((m = APPROVED_RE.exec(field)) !== null) {
    const start = Math.max(0, m.index - APPROVED_WINDOW);
    const end = Math.min(field.length, m.index + m[0].length + APPROVED_WINDOW);
    const window = field.slice(start, end);
    if (APPROVED_CONTEXT_RE.test(window)) {
      out.push({
        rule: 'approved (finance context)',
        category: 'fca',
        match: m[0],
        where,
        severity: 'block',
        reason: '"Approved" is FCA-flagged when within 30 characters of loan/funding/finance/bridge/credit. Rephrase without implying authorisation.',
      });
    }
  }
  return out;
}

/**
 * Run every filter category against a generated outbound message.
 *
 * @param {object|string} message - {subject, body} object, OR a plain string
 *   (combined subject+body). Generate-outbound passes the object form; the
 *   architect's brief shows string-form callers too — both supported.
 * @returns {{ ok: boolean, blocks: Array<object> }}
 *   ok is true iff there are no severity:'block' entries (warnings still
 *   allow the message through).
 */
function runFilters(message) {
  let subject = '';
  let body = '';
  if (typeof message === 'string') {
    body = message;
  } else if (message && typeof message === 'object') {
    subject = typeof message.subject === 'string' ? message.subject : '';
    body = typeof message.body === 'string' ? message.body : '';
  }

  const blocks = [];

  for (const field of [{ text: subject, where: 'subject' }, { text: body, where: 'body' }]) {
    blocks.push(...scan(field.text, field.where, FCA_ABSOLUTE,  'fca',         'block'));
    blocks.push(...scanApprovedContext(field.text, field.where));
    blocks.push(...scan(field.text, field.where, NAME_GUESS,    'name_guess',  'block'));
    blocks.push(...scan(field.text, field.where, AI_TELLS,      'ai_tell',     'block'));
    blocks.push(...scan(field.text, field.where, AMERICANISMS,  'americanism', 'warn'));
  }

  const hasBlock = blocks.some(b => b.severity === 'block');
  return { ok: !hasBlock, blocks };
}

module.exports = { runFilters };
