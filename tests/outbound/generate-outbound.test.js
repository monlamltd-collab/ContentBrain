// Outbound generator — mock the Anthropic SDK and assert:
//   - filter retry loop runs up to 3 times total
//   - throws with block reasons when retries exhausted
//   - per-track persona is reflected in the system prompt

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const GEN_PATH = require.resolve('../../lib/generate-outbound');
const SDK_PATH = require.resolve('@anthropic-ai/sdk');
const RUNTIME_CFG_PATH = require.resolve('../../lib/runtime-config');

// ── Mock Anthropic SDK ───────────────────────────────────────────────────

let nextResponses = []; // queue of strings to return as content[0].text
let lastCallArgs = [];

class MockAnthropic {
  constructor(opts) {
    this.opts = opts;
    this.messages = {
      create: async (args) => {
        lastCallArgs.push(args);
        if (!nextResponses.length) {
          throw new Error('Mock Anthropic ran out of queued responses');
        }
        const text = nextResponses.shift();
        return { content: [{ type: 'text', text }] };
      },
    };
  }
}

function loadGeneratorFresh() {
  delete require.cache[GEN_PATH];
  delete require.cache[SDK_PATH];
  delete require.cache[RUNTIME_CFG_PATH];

  // Inject mock SDK
  require.cache[SDK_PATH] = {
    id: SDK_PATH,
    filename: SDK_PATH,
    loaded: true,
    exports: MockAnthropic,
  };

  // Inject a fake runtime-config so getOutboundTone returns null without
  // hitting Supabase.
  require.cache[RUNTIME_CFG_PATH] = {
    id: RUNTIME_CFG_PATH,
    filename: RUNTIME_CFG_PATH,
    loaded: true,
    exports: { loadAllLevers: async () => [] },
  };

  return require('../../lib/generate-outbound');
}

const contact = { id: 'c-1', name: null, role: 'BDM', email: 'bdm@example.co.uk', prospect_id: 'p-1' };
const prospect = { id: 'p-1', company_name: 'Example Bridging', website: null, metadata: { funding_model: 'HNW' } };

beforeEach(() => {
  nextResponses = [];
  lastCallArgs = [];
});

// ── Happy path ───────────────────────────────────────────────────────────

test('first attempt passes filters → returns immediately', async () => {
  nextResponses = [JSON.stringify({
    subject: 'Quick note',
    body: 'Hello, a short pitch about BridgeMatch. Worth a ten-minute call?',
    reasoning: 'Direct opener.',
  })];

  const { generateOutbound } = loadGeneratorFresh();
  const res = await generateOutbound('lender', contact, prospect, 1);

  assert.equal(res.subject, 'Quick note');
  assert.equal(lastCallArgs.length, 1, 'should call Anthropic exactly once');
});

// ── Per-track persona ────────────────────────────────────────────────────

test('lender track: system prompt mentions BridgeMatch and bridging lender', async () => {
  nextResponses = [JSON.stringify({ subject: 'A', body: 'Hello, short body.', reasoning: 'x' })];
  const { generateOutbound } = loadGeneratorFresh();
  await generateOutbound('lender', contact, prospect, 1);
  const system = lastCallArgs[0].system;
  assert.match(system, /BridgeMatch/);
  assert.match(system, /bridging lender/i);
});

test('broker track: system prompt mentions FCA-authorised bridging broker', async () => {
  nextResponses = [JSON.stringify({ subject: 'A', body: 'Hello, short body.', reasoning: 'x' })];
  const { generateOutbound } = loadGeneratorFresh();
  await generateOutbound('broker', contact, prospect, 1);
  const system = lastCallArgs[0].system;
  assert.match(system, /BridgeMatch/);
  assert.match(system, /FCA-authorised bridging broker/i);
});

test('auction_house track: system prompt mentions AuctionBrain', async () => {
  nextResponses = [JSON.stringify({ subject: 'A', body: 'Hello, short body.', reasoning: 'x' })];
  const { generateOutbound } = loadGeneratorFresh();
  await generateOutbound('auction_house', contact, prospect, 1);
  const system = lastCallArgs[0].system;
  assert.match(system, /AuctionBrain/);
  assert.match(system, /UK auction house/i);
});

// ── Retry on filter block ────────────────────────────────────────────────

test('filter block on attempt 1 → retries on attempt 2 (eventually succeeds)', async () => {
  nextResponses = [
    // Attempt 1: contains a blocked word ("guaranteed")
    JSON.stringify({ subject: 'Guaranteed funding', body: 'Hello, short body.', reasoning: 'x' }),
    // Attempt 2: clean
    JSON.stringify({ subject: 'Quick note', body: 'Hello, short body.', reasoning: 'x' }),
  ];

  const { generateOutbound } = loadGeneratorFresh();
  const res = await generateOutbound('lender', contact, prospect, 1);
  assert.equal(res.subject, 'Quick note');
  assert.equal(lastCallArgs.length, 2);
  // Retry's user prompt should contain regeneration context
  assert.match(lastCallArgs[1].messages[0].content, /BLOCKED by quality filters/);
});

// ── Retry exhausted → throws with block reasons ──────────────────────────

test('filter block on all 3 attempts → throws with blocks attached', async () => {
  const bad = JSON.stringify({ subject: 'Guaranteed funding', body: 'Hello, short body.', reasoning: 'x' });
  nextResponses = [bad, bad, bad];

  const { generateOutbound } = loadGeneratorFresh();
  let thrown = null;
  try { await generateOutbound('lender', contact, prospect, 1); }
  catch (err) { thrown = err; }

  assert.ok(thrown, 'expected an Error to be thrown after exhausting retries');
  assert.match(thrown.message, /filter blocks not resolved after 3 attempts/);
  assert.ok(Array.isArray(thrown.blocks) && thrown.blocks.length > 0,
    'thrown error should carry the blocks array');
  assert.ok(thrown.blocks.some(b => b.rule === 'guaranteed'));
  assert.equal(lastCallArgs.length, 3, 'should attempt the full 3 times before giving up');
});

// ── JSON-parse failure also retries ──────────────────────────────────────

test('parse error on attempt 1 → retries with parse-context hint', async () => {
  nextResponses = [
    'this is not JSON at all', // parse fail
    JSON.stringify({ subject: 'Quick note', body: 'Hello, short body.', reasoning: 'x' }),
  ];

  const { generateOutbound } = loadGeneratorFresh();
  const res = await generateOutbound('lender', contact, prospect, 1);
  assert.equal(res.subject, 'Quick note');
  assert.equal(lastCallArgs.length, 2);
});

// ── Validation guards ────────────────────────────────────────────────────

test('rejects unknown track', async () => {
  const { generateOutbound } = loadGeneratorFresh();
  await assert.rejects(
    () => generateOutbound('weird-track', contact, prospect, 1),
    /Unknown outbound track/,
  );
});

test('rejects contact missing id or email', async () => {
  const { generateOutbound } = loadGeneratorFresh();
  await assert.rejects(
    () => generateOutbound('lender', { email: 'x@y.co' }, prospect, 1),
    /contact must include id and email/,
  );
});

test('rejects prospect missing id', async () => {
  const { generateOutbound } = loadGeneratorFresh();
  await assert.rejects(
    () => generateOutbound('lender', contact, { company_name: 'X' }, 1),
    /prospect must include id/,
  );
});

// ── User prompt includes contact context ────────────────────────────────

test('user prompt includes "UNKNOWN" name note when contact.name is null', async () => {
  nextResponses = [JSON.stringify({ subject: 'A', body: 'Hello, short body.', reasoning: 'x' })];
  const { generateOutbound } = loadGeneratorFresh();
  await generateOutbound('lender', contact, prospect, 1);
  const user = lastCallArgs[0].messages[0].content;
  assert.match(user, /Name: UNKNOWN/);
  assert.match(user, /open with "Hello,"/);
});

test('user prompt for lender step includes funding model from prospect.metadata', async () => {
  nextResponses = [JSON.stringify({ subject: 'A', body: 'Hello, short body.', reasoning: 'x' })];
  const { generateOutbound } = loadGeneratorFresh();
  await generateOutbound('lender', contact, prospect, 1);
  const user = lastCallArgs[0].messages[0].content;
  assert.match(user, /Funding model: HNW/);
});
