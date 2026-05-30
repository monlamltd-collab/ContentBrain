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

// ── Phase G — social-engine bans (BLOCK in mode='social') ───────────────
// Architecture Part 12. AuctionBrain's social page must NEVER drift into
// regulated-finance promo language. AR status under HLP (FCA 450491)
// requires the bright line stays bright. See .ruflo/phase-g-design.md §2.1.

const SOCIAL_BANS = [
  // Investment / wealth tropes (FCA bright line)
  { re: /\bwealth\s+(creation|building|generation|freedom)\b/i, label: 'wealth-trope',     reason: '"Wealth creation/building/freedom" reads as financial promotion. AuctionBrain talks property, not wealth-tech.' },
  { re: /\bpassive\s+income\b/i,                                label: 'passive-income',   reason: '"Passive income" is FCA-flagged investment-advice language. Use "rental income" or skip the framing.' },
  { re: /\bfinancial\s+freedom\b/i,                             label: 'financial-freedom',reason: '"Financial freedom" is FCA-flagged. Stay on property + auction, not wealth-tech tropes.' },
  { re: /\bget\s+rich(\b|\s)/i,                                 label: 'get-rich',         reason: '"Get rich" reads as get-rich-quick. Not the page voice and FCA-adjacent.' },

  // Investment-advice framing
  { re: /\bthis\s+is\s+a\s+great\s+investment\b/i,              label: 'great-investment', reason: 'Stating something IS a great investment is investment advice. Reframe as opportunity ("this lot looks interesting") with *est. on yields.' },
  { re: /\bguaranteed\s+return\b/i,                             label: 'guaranteed-return',reason: '"Guaranteed return" is FCA-flagged. No yield projection without *est. and no "guaranteed" anywhere near.' },
  { re: /\b(massive|huge|insane|crazy)\s+returns?\b/i,          label: 'massive-returns',  reason: 'Superlative-return language is FCA-flagged. Use neutral yield figures with *est. and let the data speak.' },
  { re: /\b(safe|secure)\s+investment\b/i,                      label: 'safe-investment',  reason: '"Safe/secure investment" is FCA-flagged — no investment can be characterised this way in promo.' },

  // Mortgage / regulated-bridging mentions
  { re: /\bwe\s+can\s+arrange\s+your\s+mortgage\b/i,            label: 'arrange-mortgage',  reason: 'AuctionBrain does not arrange mortgages. Mortgage talk = regulated activity. Stay on auctions.' },
  { re: /\bmortgage\s+rates?\b/i,                               label: 'mortgage-rates',    reason: 'No mortgage rate talk on this Page. Stays on auction stock.' },
  { re: /\bapproved\s+by\s+lenders?\b/i,                        label: 'approved-by-lenders',reason: '"Approved by lenders" implies regulated-finance approval — FCA-flagged. Drop it.' },
  { re: /\b(best|cheapest|lowest)\s+mortgage\b/i,               label: 'best-mortgage',     reason: 'No mortgage comparison language. Stays on auctions.' },

  // BridgeMatch leak (decision #1 — never on Unloved Britain page)
  { re: /\bBridgeMatch\b/i,                                     label: 'bridgematch-mention',reason: 'BridgeMatch is the sister product. The Unloved Britain page never mentions it (decision #1). Keep brand voices separate.' },
  { re: /\bbridging\s+(finance|loan|lender)\b/i,                label: 'bridging-finance',  reason: 'Bridging finance is regulated/unregulated lending — not the Unloved Britain page voice. Stays on auctions.' },

  // Tone violations (architecture Part 3 — "no sneer")
  { re: /\b(shit|crap|junk|garbage|dump)\b/i,                   label: 'sneer-word',        reason: 'Page voice is affectionate-wry, never sneering. "Unloved" / "needs love" instead.' },
  { re: /\b(ugly|hideous|disgusting)\b/i,                       label: 'sneer-aesthetic',   reason: 'Page voice respects the property. "Unloved" / "tired" / "honest" instead.' },

  // Hashtags + emoji headlines (existing style rule made explicit)
  { re: /#[A-Za-z0-9]+/,                                        label: 'hashtag',           reason: 'No hashtags in body copy — they go in the Facebook caption separately (and we currently use none).' },
];

// In social mode, the FCA "approved" rule is replaced with a broader
// finance-context scan. The outbound 30-char window is too narrow for
// social copy which is much longer-form per paragraph.

const SOCIAL_FINANCE_CONTEXT = [
  { re: /\bapproved\b.{0,120}\b(loan|funding|finance|bridge|credit|mortgage|lender)\b/i, label: 'approved-near-finance', reason: '"Approved" near loan/funding/finance/bridge/credit/mortgage/lender is FCA-flagged in any context wider than ~120 chars on a public page. Rephrase or drop.' },
  { re: /\b(loan|funding|finance|bridge|credit|mortgage|lender)\b.{0,120}\bapproved\b/i, label: 'finance-near-approved', reason: 'Reverse direction — finance keyword leading into "approved" is the same problem. Drop the approval framing.' },
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

// ── Invented £-amounts (BLOCK) ────────────────────────────────────────────
// Phase E anti-hallucination guard. The outbound prompt may include a
// DEAL HISTORY block listing pre-sanitised `claude_fact` strings (see
// lib/closed-loop/funded-deals.js). Any £-amount in the model's output
// that doesn't appear in those facts is — by definition — invented.
//
// When `dealFacts` is empty (no DEAL HISTORY block was injected), ANY
// £-amount in the body is a block — the model had no allowed source for
// numbers, so anything numeric it wrote is fabricated.
//
// Match shape: £450k, £450,000, £1.2m, £ 200 (with space), case-
// insensitive. Comparison is whitespace-stripped, lowercased, suffix-
// preserving — so "£450k" and "£ 450K" canonicalise to the same key
// but "£450,000" stays distinct (Simon's claude_fact wrote the figure
// one specific way and we honour his exact phrasing).

const AMOUNT_RE = /£\s?\d[\d,.]*\s?(?:k|m|bn)?\b/gi;

/**
 * Pull every £-amount out of a string, canonicalise for comparison.
 * Returns an array of { raw, key } objects — `raw` preserves the
 * original substring for the block message, `key` is the comparison
 * form.
 *
 * @param {string} text
 * @returns {Array<{ raw: string, key: string }>}
 */
function extractAmounts(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  let m;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    const raw = m[0];
    const key = raw.replace(/\s+/g, '').toLowerCase();
    out.push({ raw, key });
  }
  return out;
}

/**
 * Phase E filter rule: detect £-amounts in the generated message that
 * the model wasn't authorised to quote. Returns an array of blocks
 * (one per invented amount, deduped on the canonical key).
 *
 * @param {{subject: string, body: string}} message
 * @param {Array<{claude_fact: string}>} dealFacts - from
 *   getProspectOutcomes(); may be empty.
 * @returns {Array<object>} block descriptors, severity='block'.
 */
function checkInventedAmounts(message, dealFacts) {
  const subject = (message && typeof message.subject === 'string') ? message.subject : '';
  const body    = (message && typeof message.body    === 'string') ? message.body    : '';
  const facts = Array.isArray(dealFacts) ? dealFacts : [];

  // Build the allow-set: every £-amount mentioned in any claude_fact.
  const allowedKeys = new Set();
  for (const f of facts) {
    const factText = (f && typeof f.claude_fact === 'string') ? f.claude_fact : '';
    for (const a of extractAmounts(factText)) {
      allowedKeys.add(a.key);
    }
  }

  const found = [...extractAmounts(subject).map(a => ({ ...a, where: 'subject' })),
                 ...extractAmounts(body)   .map(a => ({ ...a, where: 'body'    }))];

  const out = [];
  const seen = new Set();
  for (const a of found) {
    if (allowedKeys.has(a.key)) continue;
    if (seen.has(a.key)) continue;
    seen.add(a.key);
    out.push({
      rule: 'invented_amount',
      category: 'hallucination',
      match: a.raw,
      where: a.where,
      severity: 'block',
      reason: facts.length
        ? `£-amount "${a.raw}" is not in the DEAL HISTORY block — the model invented it. Remove the figure or quote one of the facts verbatim.`
        : `£-amount "${a.raw}" appears in the draft but no DEAL HISTORY was supplied — the model has no authorised source for any number. Remove all £-figures.`,
    });
  }
  return out;
}

// ── Per-mode inner runners ───────────────────────────────────────────────

function runOutboundFilters(subject, body, dealFacts) {
  const blocks = [];
  for (const field of [{ text: subject, where: 'subject' }, { text: body, where: 'body' }]) {
    blocks.push(...scan(field.text, field.where, FCA_ABSOLUTE,  'fca',         'block'));
    blocks.push(...scanApprovedContext(field.text, field.where));
    blocks.push(...scan(field.text, field.where, NAME_GUESS,    'name_guess',  'block'));
    blocks.push(...scan(field.text, field.where, AI_TELLS,      'ai_tell',     'block'));
    blocks.push(...scan(field.text, field.where, AMERICANISMS,  'americanism', 'warn'));
  }
  // Phase E — invented £-amounts. Needs dealFacts allow-list.
  blocks.push(...checkInventedAmounts({ subject, body }, dealFacts));
  return blocks;
}

function runSocialFilters(subject, body, applyAmericanismCheck) {
  const blocks = [];
  for (const field of [{ text: subject, where: 'subject' }, { text: body, where: 'body' }]) {
    // Universal FCA absolutes (guaranteed / risk-free / certain return)
    blocks.push(...scan(field.text, field.where, FCA_ABSOLUTE, 'fca', 'block'));
    // AI tells apply equally on social
    blocks.push(...scan(field.text, field.where, AI_TELLS, 'ai_tell', 'block'));
    // Phase G — social-only ban list (wealth tropes, mortgage talk, BridgeMatch leak, sneer, hashtags)
    blocks.push(...scan(field.text, field.where, SOCIAL_BANS, 'social_ban', 'block'));
    // Phase G — broader finance-context check (replaces the narrow outbound scanApprovedContext)
    blocks.push(...scan(field.text, field.where, SOCIAL_FINANCE_CONTEXT, 'fca', 'block'));
    // Americanisms warn-only (same as outbound) — surface but don't retry
    if (applyAmericanismCheck) {
      blocks.push(...scan(field.text, field.where, AMERICANISMS, 'americanism', 'warn'));
    }
  }
  // NOTE — name_guess + scanApprovedContext + checkInventedAmounts skipped
  // by design: social has no recipient name, no narrow finance window
  // (replaced above), no DEAL HISTORY allow-list.
  return blocks;
}

/**
 * Run every filter category against a generated message.
 *
 * @param {object|string} input  Object: {subject, body, dealFacts} OR a plain
 *   string treated as body. Backward-compat with the architect's brief.
 * @param {object} opts
 *   - mode: 'outbound'|'social'    default 'outbound' (preserves Phase B
 *                                  behaviour byte-for-byte; 95 existing
 *                                  filter tests pass unchanged).
 *   - applyAmericanismCheck: bool  default true. Social mode only.
 * @returns {{ ok: boolean, blocks: Array<object> }}
 */
function runFilters(input, opts = {}) {
  let subject = '';
  let body = '';
  let dealFacts = [];
  if (typeof input === 'string') {
    body = input;
  } else if (input && typeof input === 'object') {
    subject = typeof input.subject === 'string' ? input.subject : '';
    body    = typeof input.body    === 'string' ? input.body    : '';
    dealFacts = Array.isArray(input.dealFacts) ? input.dealFacts : [];
  }

  const mode = (opts && opts.mode) || 'outbound';
  let blocks;
  if (mode === 'social') {
    const applyAmericanismCheck = opts.applyAmericanismCheck !== false;
    blocks = runSocialFilters(subject, body, applyAmericanismCheck);
  } else {
    blocks = runOutboundFilters(subject, body, dealFacts);
  }

  const hasBlock = blocks.some(b => b.severity === 'block');
  return { ok: !hasBlock, blocks };
}

module.exports = { runFilters, checkInventedAmounts, extractAmounts };
