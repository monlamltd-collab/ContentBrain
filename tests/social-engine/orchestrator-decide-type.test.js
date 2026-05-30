// Phase G — decideType pure-function coverage.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { decideType } = require('../../lib/social-engine/orchestrator');
const { SOCIAL_TYPES, TYPE_MODE_BIAS } = require('../../lib/social-engine/constants');

const rng = (v) => () => v;

// ── Mode-bias filtering ──────────────────────────────────────────

test('decideType("traffic") only returns from {lot-of-day-traffic, hero-album}', () => {
  // Run many seeded draws and ensure no out-of-band type lands.
  const allowed = new Set(['lot-of-day-traffic', 'hero-album']);
  for (let i = 0; i < 100; i++) {
    const t = decideType('traffic', [], { rng: rng(i / 100) });
    assert.ok(allowed.has(t), `traffic mode returned '${t}' which isn't in the allowed set`);
  }
});

test('decideType("monet") never returns lot-of-day-traffic', () => {
  for (let i = 0; i < 100; i++) {
    const t = decideType('monet', [], { rng: rng(i / 100) });
    assert.notEqual(t, 'lot-of-day-traffic', `monet mode returned 'lot-of-day-traffic' (TYPE_MODE_BIAS=${TYPE_MODE_BIAS[t]})`);
  }
});

test('decideType("monet") includes niche-hook over many draws', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    seen.add(decideType('monet', [], { rng: rng((i * 0.731 + 0.13) % 1) }));
  }
  assert.ok(seen.has('niche-hook'), 'niche-hook should land at least once in 200 draws');
});

// ── forceType override ───────────────────────────────────────────

test('forceType: "data-shock" returns data-shock regardless of mode', () => {
  assert.equal(decideType('traffic', [], { forceType: 'data-shock', rng: rng(0.5) }), 'data-shock');
  assert.equal(decideType('monet', [], { forceType: 'data-shock', rng: rng(0.5) }), 'data-shock');
});

test('forceType: unknown value falls back to weighted random', () => {
  const t = decideType('monet', [], { forceType: 'unknown', rng: rng(0.5) });
  // Should be some monet-eligible type, not 'unknown'.
  assert.notEqual(t, 'unknown');
  assert.notEqual(TYPE_MODE_BIAS[t], 'traffic'); // shouldn't drift to lot-of-day-traffic
});

// ── Breakout amplification weighting ────────────────────────────

test('breakout amplification: niche-hook at 5x weight tops the draw distribution', () => {
  const breakoutTags = [{ type: 'niche-hook', weight_multiplier: 5.0 }];
  const counts = {};
  for (let i = 0; i < 1000; i++) {
    const t = decideType('monet', breakoutTags, { rng: rng((i * 0.731 + 0.13) % 1) });
    counts[t] = (counts[t] || 0) + 1;
  }
  // Uniform across 6 monet-eligible types gives ~166 hits each. With 5x on
  // niche-hook (5/(5+5*1)=0.5), expect ~500.
  assert.ok((counts['niche-hook'] || 0) > 300, `niche-hook hits ${counts['niche-hook']} (expected >300 with 5x)`);
});

// ── Edge cases ───────────────────────────────────────────────────

test('decideType: no candidates (impossible) falls back to hero-album', () => {
  // We can't really test this without mocking TYPE_MODE_BIAS, but we can
  // verify the function returns a sensible default if invoked with an
  // unrecognised mode. Pass a mode that filters to empty (none of the
  // SOCIAL_TYPE_LIST biases match 'frobnicate').
  const t = decideType('frobnicate', [], { rng: rng(0.5) });
  // Falls back to either hero-album (the 'either' type) or hero-album via
  // the post-filter fallback.
  assert.equal(t, 'hero-album');
});

test('decideType: empty breakoutTags array works fine', () => {
  const t = decideType('monet', [], { rng: rng(0.5) });
  assert.ok(typeof t === 'string');
});

test('decideType: breakoutTags with unknown type is ignored', () => {
  const t = decideType('monet', [{ type: 'made-up', weight_multiplier: 100 }], { rng: rng(0.5) });
  // Should still return a valid type, never 'made-up'
  assert.notEqual(t, 'made-up');
});

// ── templateNameForType ──────────────────────────────────────────

test('templateNameForType maps each Phase G type to a template', () => {
  const { templateNameForType } = require('../../lib/social-engine/orchestrator');
  assert.equal(templateNameForType('niche-hook'), 'social-engine/niche-hook');
  assert.equal(templateNameForType('hero-album'), 'social-engine/hero-album');
  assert.equal(templateNameForType('regional-roundup'), 'social-engine/regional-roundup');
  assert.equal(templateNameForType('curiosity-gap'), 'social-engine/curiosity-gap');
  assert.equal(templateNameForType('data-shock'), 'social-engine/data-shock');
  // Delegated types return null (orchestrator delegates to lot-flow)
  assert.equal(templateNameForType('lot-of-day-traffic'), null);
  assert.equal(templateNameForType('superlative-reel'), null);
});

// ── isBoostEligible ──────────────────────────────────────────────

test('isBoostEligible: traffic mode → false (no CTA-heavy boosting)', () => {
  const { isBoostEligible } = require('../../lib/social-engine/orchestrator');
  const r = isBoostEligible({
    mode: 'traffic',
    type: 'lot-of-day-traffic',
    meta: { niche_tag: 'wales' },
    copy: { filterBlocks: [] },
    pickResult: { meta_payload: { niche_tag: 'wales' }, visual_hints: { hero_image_url: 'x' } },
  });
  assert.equal(r, false);
});

test('isBoostEligible: monet mode with niche_tag and image → true', () => {
  const { isBoostEligible } = require('../../lib/social-engine/orchestrator');
  const r = isBoostEligible({
    mode: 'monet',
    type: 'niche-hook',
    meta: { niche_tag: 'wales' },
    copy: { filterBlocks: [] },
    pickResult: { meta_payload: { niche_tag: 'wales' }, visual_hints: { hero_image_url: 'https://x.jpg' } },
  });
  assert.equal(r, true);
});

test('isBoostEligible: monet mode with NO niche_tag → false', () => {
  const { isBoostEligible } = require('../../lib/social-engine/orchestrator');
  const r = isBoostEligible({
    mode: 'monet',
    type: 'curiosity-gap',
    meta: {},
    copy: { filterBlocks: [] },
    pickResult: { meta_payload: {}, visual_hints: {} },
  });
  assert.equal(r, false);
});
