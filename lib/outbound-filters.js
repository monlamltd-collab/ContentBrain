require('dotenv').config();

// ── Outbound content filters (Phase B) ────────────────────────────────────
//
// Hard quality gate that runs against every Claude-generated outbound
// message BEFORE it reaches Telegram for human approval. A failed filter
// is a generation bug — the message gets regenerated (lib/generate.js
// retries up to N times) rather than escalated. If retries exhaust, the
// gen surfaces a Telegram alert with the offending blocks.
//
// The list of forbidden patterns is non-negotiable — see
// GROWTH_BRAIN_BUILD.md lines 111-117 and .ruflo/phase-b-context.md §Filters.
// Adding categories is fine; relaxing existing ones requires Simon's sign-off.
//
// Categories:
//   - FCA-flagged finance words: "guaranteed", "approved" (in a finance
//     promise sense), "risk-free". These are FCA-flagged for unauthorised
//     financial promotions and would compromise BridgeMatch's AR status.
//   - Name-guess templates: "Hi [first_name]", "Dear [name]",
//     "{{firstName}}", etc. The bridging-brain importer leaves name NULL
//     for enquiries inboxes deliberately — a template that bleeds a literal
//     placeholder through is a generator bug AND a deliverability disaster.
//   - AI-tell openings: "I hope this email finds you well",
//     "I came across your company", "I trust this email finds you" etc.
//     These trip spam filters and read as obviously LLM-generated.
//   - Unsubstantiated claims: "We're the UK's leading…", "thousands of
//     brokers use us…" — block any numeric-or-superlative claim that
//     wasn't passed into the generator as a verified fact.
//   - Americanisms: "color", "favorite", "z" where British uses "s"
//     ("organize" → block; "organise" → ok). Lighter list — coder
//     implements a starter set, the persona prompt does most of the work.
//
// Output shape — `runFilters` returns ALL blocks for one message in one
// pass so the regeneration prompt can address every issue at once instead
// of looping a fix-one-bug-at-a-time conversation.

/**
 * Run every filter category against a generated outbound message.
 *
 * @param {object} message
 * @param {string} message.subject
 * @param {string} message.body
 * @returns {{
 *   ok: boolean,             // true iff blocks.length === 0
 *   blocks: Array<{
 *     category: 'fca' | 'name_guess' | 'ai_tell' | 'unsubstantiated' | 'americanism',
 *     match: string,         // the offending substring
 *     where: 'subject'|'body',
 *     reason: string         // single-sentence explanation for the regen prompt
 *   }>
 * }}
 */
function runFilters(message) {
  // TODO(coder):
  //   - Run each category as a separate scanner function.
  //   - FCA + AI-tell: word-boundary regex scan, case-insensitive.
  //   - Name-guess: regex /\[(first_)?name\]|\{\{\s*\w+\s*\}\}/i over both fields.
  //   - Unsubstantiated: heuristic — flag superlatives + numeric claims that
  //     weren't in the verified-facts list passed to the generator. (Coder:
  //     this category is best-effort in v1; document the false-positive rate.)
  //   - Americanism: small wordlist (see header comment for starter set).
  //   - Aggregate blocks across all categories; ok = blocks.length === 0.
  void message;
  throw new Error('runFilters not implemented yet — see TODO(coder)');
}

module.exports = { runFilters };
