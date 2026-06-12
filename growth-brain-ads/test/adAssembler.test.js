'use strict';

// Plain-node test runner, no deps. Run: node test/adAssembler.test.js

const assert = require('node:assert');
const crypto = require('node:crypto');
const { processGeneration, computeDedupKey, buildRetryPrompt } = require('../lib/adAssembler');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (e) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(`  ${e.message}`);
  }
}

const gates = (result) => [...new Set(result.errors.map((e) => e.gate))];

// 1. Valid X post — assembles, passes all gates, deterministic dedup key.
test('valid X post passes all gates', () => {
  const gen = {
    platform: 'x',
    hook_id: 'H3',
    proof_point_ids: ['P1'],
    cta_id: 'C2',
    filled_slots: {},
  };
  const result = processGeneration(gen, new Set());
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(
    result.ad.primary,
    "The best lots go to the prepared. We read catalogues from 170+ auction houses, so you don't have to. Try it free at auctions.bridgematch.co.uk."
  );
  assert.ok(result.ad.primary.length <= 280);
  assert.strictEqual(result.ad.headline, undefined);
  const expectedKey = crypto.createHash('sha256').update('x|H3|P1|C2', 'utf8').digest('hex');
  assert.strictEqual(result.ad.dedup_key, expectedKey);
});

// 2. Facebook over-length — schema-valid components, assembled copy > 125 chars.
test('FB over-length fails the length gate only', () => {
  const gen = {
    platform: 'facebook',
    hook_id: 'H4',
    proof_point_ids: ['P1', 'P3'],
    cta_id: 'C2',
    filled_slots: {
      tedious_activity: 'cross-referencing guide prices against years of sold-price archives',
    },
    headline: 'Stop the spreadsheet grind',
  };
  const result = processGeneration(gen, new Set());
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(gates(result), ['length'], JSON.stringify(result.errors));
  assert.strictEqual(result.errors[0].code, 'primary_too_long');
});

// 3. Hallucinated scale claim — "500 auction houses" smuggled in via a slot fill.
test('unapproved "500 auction houses" claim is blocked', () => {
  const gen = {
    platform: 'x',
    hook_id: 'H1',
    proof_point_ids: ['P2'],
    cta_id: 'C1',
    filled_slots: { tedious_activity: 'comparing 500 auction houses' },
  };
  const result = processGeneration(gen, new Set());
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(gates(result), ['claims'], JSON.stringify(result.errors));
  assert.strictEqual(result.errors[0].code, 'unapproved_scale_claim');
  assert.ok(result.errors[0].message.includes('500'));
});

// 4. CTA-platform mismatch — C3 is Instagram-only, generation targets facebook.
test('CTA not whitelisted for platform is rejected', () => {
  const gen = {
    platform: 'facebook',
    hook_id: 'H2',
    proof_point_ids: ['P2'],
    cta_id: 'C3',
    filled_slots: {},
    headline: 'Auction research in minutes',
  };
  const result = processGeneration(gen, new Set());
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(gates(result), ['cta_platform'], JSON.stringify(result.errors));
});

// 5. Missing slot — H1 declares {tedious_activity}, model omitted it.
test('missing required slot fails the schema gate', () => {
  const gen = {
    platform: 'x',
    hook_id: 'H1',
    proof_point_ids: ['P2'],
    cta_id: 'C1',
    filled_slots: {},
  };
  const result = processGeneration(gen, new Set());
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(gates(result), ['schema']);
  assert.strictEqual(result.errors[0].code, 'missing_slot');
  assert.ok(result.errors[0].message.includes('tedious_activity'));
});

// 6. Dedup — same component combination already in the 30-day publish log.
test('repeat creative within 30 days is dropped by dedup', () => {
  const gen = {
    platform: 'x',
    hook_id: 'H3',
    proof_point_ids: ['P1'],
    cta_id: 'C2',
    filled_slots: {},
  };
  const first = processGeneration(gen, new Set());
  assert.strictEqual(first.ok, true);
  const result = processGeneration(gen, new Set([first.ad.dedup_key]));
  assert.strictEqual(result.ok, false);
  assert.deepStrictEqual(gates(result), ['dedup'], JSON.stringify(result.errors));
  // Sorted proof IDs: [P3, P1] must collide with [P1, P3].
  assert.strictEqual(
    computeDedupKey({ platform: 'x', hook_id: 'H3', proof_point_ids: ['P3', 'P1'], cta_id: 'C2' }),
    computeDedupKey({ platform: 'x', hook_id: 'H3', proof_point_ids: ['P1', 'P3'], cta_id: 'C2' })
  );
});

// 7. Valid facebook ad with headline — within 125/40, headline carried through.
test('valid FB ad with headline passes', () => {
  const gen = {
    platform: 'facebook',
    hook_id: 'H1',
    proof_point_ids: ['P2'],
    cta_id: 'C1',
    filled_slots: { tedious_activity: 'scanning auction catalogues' },
    headline: 'Auction research in minutes',
  };
  const result = processGeneration(gen, new Set());
  assert.strictEqual(result.ok, true, JSON.stringify(result.errors));
  assert.strictEqual(
    result.ad.primary,
    'Still scanning auction catalogues by hand? Every lot scored in seconds. Follow for daily lot picks.'
  );
  assert.ok(result.ad.primary.length <= 125, `primary is ${result.ad.primary.length} chars`);
  assert.strictEqual(result.ad.headline, 'Auction research in minutes');
  assert.ok(result.ad.headline.length <= 40);
  // Retry prompt shape sanity check while we're here.
  const failure = processGeneration({ ...gen, cta_id: 'C3' }, new Set());
  assert.ok(buildRetryPrompt(failure.errors).includes('[cta_platform/cta_platform_mismatch]'));
});

console.log(`\n${passed}/${passed + failed} tests passed`);
process.exit(failed > 0 ? 1 : 0);
