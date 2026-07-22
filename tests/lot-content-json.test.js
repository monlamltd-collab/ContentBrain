const { test } = require('node:test');
const assert = require('node:assert/strict');

const LOT_CONTENT_PATH = require.resolve('../lib/lot-content');
const RUNTIME_CONFIG_PATH = require.resolve('../lib/runtime-config');

function loadLotContentFresh() {
  delete require.cache[LOT_CONTENT_PATH];
  delete require.cache[RUNTIME_CONFIG_PATH];
  require.cache[RUNTIME_CONFIG_PATH] = {
    id: RUNTIME_CONFIG_PATH,
    filename: RUNTIME_CONFIG_PATH,
    loaded: true,
    exports: {
      getResolvedBrand: async () => ({ audience: 'UK property investors', tone: 'clear' }),
      getBrandVisualDirective: async () => '',
    },
  };
  return require('../lib/lot-content');
}

function stubLLM(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async args => {
        calls.push(args);
        return { content: [{ type: 'text', text: responses.shift() }] };
      },
    },
  };
}

test('generateLotContent retries unrelated weekly status text and parses JSON', async () => {
  const { generateLotContent } = loadLotContentFresh();
  const llm = stubLLM([
    '📸 Weekly auction posts — 0 ready to review',
    JSON.stringify({
      hook_headline: 'Cheapest Lot This Week',
      key_bullets: ['Guide £25,000', 'Auction this Friday'],
      voiceover_script: 'This is the cheapest lot this week. Visit auctionbrain.co.uk.',
      caption_facebook: 'The cheapest auction lot this week.\n\nVisit auctionbrain.co.uk.',
      visual_style: 'editorial',
    }),
  ]);

  const content = await generateLotContent({
    lot: { id: 'lot-1', address: '1 High Street', price: 25000 },
    archetype: 'cheapest-week',
    llm,
  });

  assert.equal(content.hook_headline, 'Cheapest Lot This Week');
  assert.equal(llm.calls.length, 2);
  assert.match(llm.calls[1].messages.at(-1).content, /Return ONLY the JSON object/);
});

test('generateLotContent retries valid JSON missing required fields', async () => {
  const { generateLotContent } = loadLotContentFresh();
  const llm = stubLLM([
    JSON.stringify({ hook_headline: 'Incomplete' }),
    JSON.stringify({
      hook_headline: 'Complete',
      key_bullets: ['One'],
      voiceover_script: 'A complete script.',
      caption_facebook: 'A complete caption.',
      visual_style: 'dark-tech',
    }),
  ]);
  const out = await generateLotContent({
    lot: { id: 'lot-2', address: '2 High Street', price: 30000 },
    archetype: 'cheapest-week',
    llm,
  });
  assert.equal(out.hook_headline, 'Complete');
  assert.equal(llm.calls.length, 2);
});

test('generateLotContent rejects key_bullets containing empty or non-string items', async () => {
  const { generateLotContent } = loadLotContentFresh();
  const valid = {
    hook_headline: 'Complete',
    key_bullets: ['One useful fact'],
    voiceover_script: 'A complete script.',
    caption_facebook: 'A complete caption.',
    visual_style: 'dark-tech',
  };
  const llm = stubLLM([
    JSON.stringify({ ...valid, key_bullets: ['Useful', '', 42] }),
    JSON.stringify(valid),
  ]);
  const out = await generateLotContent({
    lot: { id: 'lot-bullets', address: '4 High Street', price: 45000 },
    archetype: 'cheapest-week',
    llm,
  });
  assert.deepEqual(out.key_bullets, ['One useful fact']);
  assert.equal(llm.calls.length, 2);
});

test('generateLotContent supports every weekly archetype', async () => {
  const archetypes = [
    'cheapest-week',
    'dearest-week',
    'best-deal-week',
    'biggest-discount-week',
    'worst-lot-week',
  ];
  for (const archetype of archetypes) {
    const { generateLotContent } = loadLotContentFresh();
    const llm = stubLLM([JSON.stringify({
      hook_headline: `Post for ${archetype}`,
      key_bullets: ['One useful fact'],
      voiceover_script: 'A complete script.',
      caption_facebook: 'A complete caption.',
      visual_style: 'dark-tech',
    })]);
    const out = await generateLotContent({
      lot: { id: archetype, address: '3 High Street', price: 40000 },
      archetype,
      llm,
    });
    assert.equal(out.hook_headline, `Post for ${archetype}`);
    assert.equal(llm.calls.length, 1);
    assert.match(llm.calls[0].messages[0].content, /Today's archetype:/);
  }
});
