// Phase G — exhaustive Part 12 compliance audit.
//
// The architect's "bright lines" table in .ruflo/social-engine-architecture.md
// Part 12 is the FCA + tone + brand-leak compliance contract. This file
// constructs a sample input for every entry on the ban list and asserts
// runFilters(..., {mode:'social'}) blocks it.
//
// This is belt-and-braces on top of tests/social-engine/filters.test.js —
// that file proves each regex blocks ONE input; this file walks the
// architectural contract itself and emits a coverage table to stdout so
// the lead can scan it before signing off the HLP compliance email.
//
// If a Part 12 row exists in the architecture but no filter catches it,
// the test fails — which forces the filter list to keep up with the spec.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { runFilters } = require('../../lib/outbound-filters');

// Each entry: { domain, phrase_in_post, expected_block_rule(s),
//               part12_row (architecture mapping for the audit log) }
//
// Coverage anchored to architecture Part 12's "Banned" column. Where the
// architecture phrases something loosely ("Wealth tropes"), I use the
// concrete regex labels from SOCIAL_BANS as the source of truth.

const COMPLIANCE_TABLE = [
  // ── Wealth / passive-income tropes ────────────────────────────────────
  { domain: 'wealth-trope',         phrase: 'A guide to wealth creation through auctions.',           expectedRules: ['wealth-trope'] },
  { domain: 'wealth-trope',         phrase: 'How to start your wealth building journey.',              expectedRules: ['wealth-trope'] },
  { domain: 'wealth-trope',         phrase: 'The path to wealth freedom.',                              expectedRules: ['wealth-trope'] },
  { domain: 'passive-income',       phrase: 'Looking for passive income? Try auction property.',       expectedRules: ['passive-income'] },
  { domain: 'financial-freedom',    phrase: 'Your route to financial freedom.',                         expectedRules: ['financial-freedom'] },
  { domain: 'get-rich',             phrase: 'Get rich on auctions.',                                     expectedRules: ['get-rich'] },

  // ── Investment-advice framing ──────────────────────────────────────────
  { domain: 'great-investment',     phrase: 'Honestly, this is a great investment lot.',                expectedRules: ['great-investment'] },
  { domain: 'guaranteed-return',    phrase: 'A guaranteed return on this Cardiff terrace.',             expectedRules: ['guaranteed-return', 'guaranteed'] },
  { domain: 'massive-returns',      phrase: 'Massive returns on Welsh auction stock.',                  expectedRules: ['massive-returns'] },
  { domain: 'massive-returns',      phrase: 'Huge return potential.',                                    expectedRules: ['massive-returns'] },
  { domain: 'massive-returns',      phrase: 'Insane returns this fortnight.',                            expectedRules: ['massive-returns'] },
  { domain: 'massive-returns',      phrase: 'Crazy returns possible.',                                   expectedRules: ['massive-returns'] },
  { domain: 'safe-investment',      phrase: 'A safe investment in Sheffield.',                           expectedRules: ['safe-investment'] },
  { domain: 'safe-investment',      phrase: 'Secure investment opportunity.',                            expectedRules: ['safe-investment'] },

  // ── Mortgage / regulated-bridging mentions ─────────────────────────────
  { domain: 'arrange-mortgage',     phrase: 'We can arrange your mortgage on this one.',                expectedRules: ['arrange-mortgage'] },
  { domain: 'mortgage-rates',       phrase: 'Mortgage rates are dropping again.',                        expectedRules: ['mortgage-rates'] },
  { domain: 'approved-by-lenders',  phrase: 'Approved by lenders within 24 hours.',                      expectedRules: ['approved-by-lenders'] },
  { domain: 'best-mortgage',        phrase: 'Find the best mortgage for auction buys.',                  expectedRules: ['best-mortgage'] },
  { domain: 'best-mortgage',        phrase: 'Cheapest mortgage rates this week.',                        expectedRules: ['best-mortgage', 'mortgage-rates'] },

  // ── BridgeMatch leak (decision #1) ─────────────────────────────────────
  { domain: 'bridgematch-mention',  phrase: 'BridgeMatch can help with the funding side.',              expectedRules: ['bridgematch-mention'] },
  { domain: 'bridging-finance',     phrase: 'Bridging finance is the usual route.',                      expectedRules: ['bridging-finance'] },
  { domain: 'bridging-finance',     phrase: 'A trusted bridging lender approved you fast.',              expectedRules: ['bridging-finance', 'finance-near-approved'] },
  { domain: 'bridging-finance',     phrase: 'Bridging loan questions? Read on.',                          expectedRules: ['bridging-finance'] },

  // ── Tone violations (no sneer) ────────────────────────────────────────
  { domain: 'sneer-word',           phrase: 'A shit terrace in Cardiff.',                                expectedRules: ['sneer-word'] },
  { domain: 'sneer-word',           phrase: 'Total dump in Newport.',                                    expectedRules: ['sneer-word'] },
  { domain: 'sneer-word',           phrase: 'Pure junk in Sheffield.',                                   expectedRules: ['sneer-word'] },
  { domain: 'sneer-word',           phrase: 'Crap auction lot this week.',                               expectedRules: ['sneer-word'] },
  { domain: 'sneer-word',           phrase: 'Garbage lot — avoid.',                                       expectedRules: ['sneer-word'] },
  { domain: 'sneer-aesthetic',      phrase: 'An ugly bungalow in Newport.',                              expectedRules: ['sneer-aesthetic'] },
  { domain: 'sneer-aesthetic',      phrase: 'Absolutely hideous frontage.',                              expectedRules: ['sneer-aesthetic'] },
  { domain: 'sneer-aesthetic',      phrase: 'Disgusting state of decor.',                                 expectedRules: ['sneer-aesthetic'] },

  // ── Hashtags (style rule) ─────────────────────────────────────────────
  { domain: 'hashtag',              phrase: 'Worth a look #propertyporn.',                                expectedRules: ['hashtag'] },
  { domain: 'hashtag',              phrase: 'Tag a friend #auction.',                                     expectedRules: ['hashtag'] },

  // ── FCA absolutes (universal — block in social too) ───────────────────
  { domain: 'guaranteed',           phrase: 'This is guaranteed to clear.',                               expectedRules: ['guaranteed'] },
  { domain: 'risk-free',            phrase: 'A risk-free way to buy at auction.',                          expectedRules: ['risk-free'] },
  { domain: 'certain return',       phrase: 'You will get a certain return on this.',                      expectedRules: ['certain return'] },

  // ── Broader finance-context (120-char window) ─────────────────────────
  { domain: 'approved-near-finance',phrase: 'These properties are approved for institutional lender finance — but…', expectedRules: ['approved-near-finance'] },
  { domain: 'approved-near-finance',phrase: 'A scheme that gets approved for bridge loan funding within hours.',    expectedRules: ['approved-near-finance'] },
  { domain: 'finance-near-approved',phrase: 'A bridge loan with criteria that get approved fast.',                  expectedRules: ['finance-near-approved'] },

  // ── AI-tells (universal — applies on social too) ──────────────────────
  { domain: 'ai-tell',              phrase: 'I hope this message finds you well today.',                  expectedRules: ['I hope this email finds you well'] },
  { domain: 'ai-tell',              phrase: 'I came across this lot the other day.',                       expectedRules: ['I came across'] },
];

// ── Exhaustive sweep ───────────────────────────────────────────────────

test('Part 12 compliance: every entry produces at least one expected block', () => {
  const coverage = [];
  for (const row of COMPLIANCE_TABLE) {
    const res = runFilters({ subject: '', body: row.phrase }, { mode: 'social' });
    const ruleNames = res.blocks.filter(b => b.severity === 'block').map(b => b.rule);
    // At least one of the expected rules must fire.
    const hit = row.expectedRules.some(r => ruleNames.includes(r));
    coverage.push({ domain: row.domain, phrase: row.phrase, expectedAny: row.expectedRules, actual: ruleNames, hit });
    assert.ok(
      hit,
      `Domain "${row.domain}" — phrase "${row.phrase}" — expected ANY of ${JSON.stringify(row.expectedRules)} but got ${JSON.stringify(ruleNames)}`
    );
  }

  // Emit a coverage summary so the lead can scan it pre-HLP-email.
  // (node --test surfaces console.log only on failure, so this is dormant
  // unless something breaks. Re-enable by setting PHASE_G_COMPLIANCE_DUMP=1.)
  if (process.env.PHASE_G_COMPLIANCE_DUMP === '1') {
    console.log('\n── Phase G Part 12 coverage ──');
    for (const c of coverage) {
      console.log(`${c.hit ? 'OK' : 'XX'}  [${c.domain}] -> ${c.actual.join(', ') || '(no match)'}`);
    }
    console.log(`Total: ${coverage.length}, hits: ${coverage.filter(c => c.hit).length}`);
  }
});

// ── Symmetric: clean copy must NOT block ───────────────────────────────

const CLEAN_COPY = [
  'Five unloved Welsh terraces this fortnight. None on Rightmove.',
  'A boarded-up Sheffield mid-terrace, guide £42,000.',
  'Tap follow for more unloved Welsh terraces.',
  'Auctions Tuesday: three lots in Cardiff worth a second look.',
  'A tired three-bed in Manchester — needs love, but the bones are good.',
  'New Allsop catalogue today. Five lots stand out.',
  'A probate sale in Newport — vacant possession, ready to bid.',
];

for (const text of CLEAN_COPY) {
  test(`Part 12 compliance: clean copy passes — "${text.slice(0, 40)}..."`, () => {
    const res = runFilters({ subject: 'Welsh auction picks', body: text }, { mode: 'social' });
    assert.equal(res.ok, true, `clean copy unexpectedly blocked: ${JSON.stringify(res.blocks.filter(b => b.severity === 'block'))}`);
  });
}

// ── Headline coverage too ─────────────────────────────────────────────

test('Part 12 compliance: subject-line bans fire too', () => {
  // Spot-check 3 key bans in the subject position.
  const subjects = [
    { s: 'Wealth creation guide',      rule: 'wealth-trope' },
    { s: 'BridgeMatch news this week', rule: 'bridgematch-mention' },
    { s: 'Get rich on auctions',       rule: 'get-rich' },
  ];
  for (const { s, rule } of subjects) {
    const res = runFilters({ subject: s, body: '' }, { mode: 'social' });
    const hit = res.blocks.some(b => b.rule === rule && b.where === 'subject');
    assert.ok(hit, `subject "${s}" should fire '${rule}' on subject field`);
  }
});

// ── Audit shape: filter_pass false is impossible if we threw ──────────

test('Part 12 audit shape: blocks have rule/where/severity/reason', () => {
  const res = runFilters({ subject: '', body: 'A wealth creation guide.' }, { mode: 'social' });
  assert.equal(res.ok, false);
  const block = res.blocks.find(b => b.severity === 'block');
  assert.ok(block, 'expected at least one block');
  assert.ok(block.rule, 'block must have rule');
  assert.ok(block.where, 'block must have where');
  assert.ok(block.severity === 'block');
  assert.ok(block.reason && block.reason.length > 20, 'block reason must be human-readable');
});

// ── COMPLIANCE_TABLE size sentinel ───────────────────────────────────

test('Part 12 audit: COMPLIANCE_TABLE has comprehensive coverage', () => {
  // Make sure we don't accidentally shrink the table on a refactor.
  assert.ok(COMPLIANCE_TABLE.length >= 35, `COMPLIANCE_TABLE shrank to ${COMPLIANCE_TABLE.length}; expected >=35 entries`);
});
