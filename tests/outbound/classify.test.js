// classify.js — mock lib/llm (not the Anthropic SDK) and assert:
//   - all 8 intents pass through validation
//   - garbage / invalid JSON / out-of-enum intent → fallback questions/0.5
//   - confidence < 0.6 forces requires_human=true and telegram_alert=true
//   - lookupAction table values per researcher's design doc

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const CLASSIFY_PATH = require.resolve('../../lib/classify');
const LLM_PATH = require.resolve('../../lib/llm');

let nextResponses = [];
let lastCallArgs = [];

function makeMockLLM() {
  return {
    createLLM: () => ({
      messages: {
        create: async (args) => {
          lastCallArgs.push(args);
          if (!nextResponses.length) {
            throw new Error('Mock LLM ran out of queued responses');
          }
          const text = nextResponses.shift();
          return { content: [{ type: 'text', text }] };
        },
      },
    }),
    createClaudeLLM: () => ({ messages: { create: async () => ({ content: [] }) } }),
    MODEL: 'test-llm-model',
    CLAUDE_MODEL: 'test-claude-model',
  };
}

function loadClassifyFresh() {
  delete require.cache[CLASSIFY_PATH];
  delete require.cache[LLM_PATH];

  require.cache[LLM_PATH] = {
    id: LLM_PATH,
    filename: LLM_PATH,
    loaded: true,
    exports: makeMockLLM(),
  };

  return require('../../lib/classify');
}

beforeEach(() => {
  nextResponses = [];
  lastCallArgs = [];
  process.env.OPENROUTER_API_KEY = 'test-key';
});

// ── classifyReply — 8 intents ────────────────────────────────────────────

const ALL_INTENTS = [
  'interested',
  'questions',
  'not_interested',
  'out_of_office',
  'wrong_person',
  'unsubscribe',
  'hostile',
  'complaint',
];

for (const intent of ALL_INTENTS) {
  test(`classifyReply: accepts intent '${intent}'`, async () => {
    nextResponses = [JSON.stringify({ intent, confidence: 0.9, reasoning: `test ${intent}` })];
    const { classifyReply } = loadClassifyFresh();
    const res = await classifyReply({ subject: 'Re: hi', body: `Some body about ${intent}` });
    assert.equal(res.intent, intent);
    assert.equal(res.confidence, 0.9);
    assert.match(res.reasoning, new RegExp(intent));
  });
}

// ── Garbage fallback ─────────────────────────────────────────────────────

test('classifyReply: invalid JSON falls back to questions/0.5', async () => {
  nextResponses = ['this is not json at all'];
  const { classifyReply } = loadClassifyFresh();
  const res = await classifyReply({ body: 'something' });
  assert.equal(res.intent, 'questions');
  assert.equal(res.confidence, 0.5);
});

test('classifyReply: out-of-enum intent falls back to questions/0.5', async () => {
  nextResponses = [JSON.stringify({ intent: 'maybe_interested', confidence: 0.9, reasoning: 'x' })];
  const { classifyReply } = loadClassifyFresh();
  const res = await classifyReply({ body: 'something' });
  assert.equal(res.intent, 'questions');
  assert.equal(res.confidence, 0.5);
});

test('classifyReply: missing intent field falls back', async () => {
  nextResponses = [JSON.stringify({ confidence: 0.9, reasoning: 'x' })];
  const { classifyReply } = loadClassifyFresh();
  const res = await classifyReply({ body: 'something' });
  assert.equal(res.intent, 'questions');
  assert.equal(res.confidence, 0.5);
});

test('classifyReply: empty body returns questions/0.5 without an API call', async () => {
  const { classifyReply } = loadClassifyFresh();
  const res = await classifyReply({ body: '' });
  assert.equal(res.intent, 'questions');
  assert.equal(res.confidence, 0.5);
  assert.equal(lastCallArgs.length, 0, 'should NOT call LLM for empty body');
});

test('classifyReply: LLM error falls back to questions/0.5', async () => {
  // empty nextResponses causes mock to throw
  nextResponses = [];
  const { classifyReply } = loadClassifyFresh();
  const res = await classifyReply({ body: 'something' });
  assert.equal(res.intent, 'questions');
  assert.equal(res.confidence, 0.5);
});

// ── Confidence clamping ─────────────────────────────────────────────────

test('classifyReply: percentage-style confidence (95) is normalised to 0.95', async () => {
  nextResponses = [JSON.stringify({ intent: 'interested', confidence: 95, reasoning: 'x' })];
  const { classifyReply } = loadClassifyFresh();
  const res = await classifyReply({ body: 'sure, sounds good' });
  assert.equal(res.confidence, 0.95);
});

test('classifyReply: confidence > 1 is clamped to 1', async () => {
  nextResponses = [JSON.stringify({ intent: 'interested', confidence: 1.5, reasoning: 'x' })];
  const { classifyReply } = loadClassifyFresh();
  const res = await classifyReply({ body: 'sure, sounds good' });
  assert.equal(res.confidence, 1);
});

test('classifyReply: confidence < 0 is clamped to 0', async () => {
  nextResponses = [JSON.stringify({ intent: 'interested', confidence: -0.2, reasoning: 'x' })];
  const { classifyReply } = loadClassifyFresh();
  const res = await classifyReply({ body: 'sure, sounds good' });
  assert.equal(res.confidence, 0);
});

// ── LLM plumbing ──────────────────────────────────────────────────────

test('classifyReply: calls LLM with the MODEL constant from classify.js', async () => {
  nextResponses = [JSON.stringify({ intent: 'interested', confidence: 0.9, reasoning: 'x' })];
  const { classifyReply, MODEL } = loadClassifyFresh();
  await classifyReply({ body: 'hi' });
  assert.equal(lastCallArgs.length, 1);
  assert.equal(lastCallArgs[0].model, MODEL, 'should call the LLM with its MODEL constant');
  assert.equal(typeof MODEL, 'string');
  assert.ok(MODEL.length > 0, 'MODEL should be non-empty');
});

// ── lookupAction — per-intent table ─────────────────────────────────────

test('lookupAction: interested → pause + telegram + urgent, no suppression', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('interested', 0.9);
  assert.equal(a.requires_human, true);
  assert.equal(a.suppression, null);
  assert.equal(a.sequence_action, 'pause');
  assert.equal(a.telegram_alert, true);
  assert.equal(a.urgent, true);
  assert.equal(a.ended_reason, 'awaiting_human');
});

test('lookupAction: questions → pause + telegram, no suppression', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('questions', 0.9);
  assert.equal(a.requires_human, true);
  assert.equal(a.suppression, null);
  assert.equal(a.sequence_action, 'pause');
  assert.equal(a.telegram_alert, true);
});

test('lookupAction: not_interested → complete with replied_decline, no alerts', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('not_interested', 0.9);
  assert.equal(a.requires_human, false);
  assert.equal(a.sequence_action, 'complete');
  assert.equal(a.ended_reason, 'replied_decline');
  assert.equal(a.telegram_alert, false);
});

test('lookupAction: out_of_office → continue, no suppression, no alerts', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('out_of_office', 0.9);
  assert.equal(a.sequence_action, 'continue');
  assert.equal(a.suppression, null);
  assert.equal(a.telegram_alert, false);
});

test('lookupAction: wrong_person → email suppression + complete + telegram', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('wrong_person', 0.9);
  assert.equal(a.suppression, 'email');
  assert.equal(a.suppression_reason, 'wrong_person');
  assert.equal(a.sequence_action, 'complete');
  assert.equal(a.ended_reason, 'wrong_person');
  assert.equal(a.telegram_alert, true);
});

test('lookupAction: unsubscribe → email suppression + opt_out, no alert', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('unsubscribe', 0.9);
  assert.equal(a.suppression, 'email');
  assert.equal(a.suppression_reason, 'unsubscribe');
  assert.equal(a.sequence_action, 'opt_out');
  assert.equal(a.ended_reason, 'unsubscribe');
  assert.equal(a.telegram_alert, false);
});

test('lookupAction: hostile → domain suppression + pause + flip_siblings + urgent', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('hostile', 0.9);
  assert.equal(a.suppression, 'domain');
  assert.equal(a.suppression_reason, 'hostile_reply');
  assert.equal(a.sequence_action, 'pause');
  assert.equal(a.ended_reason, 'hostile_pause');
  assert.equal(a.telegram_alert, true);
  assert.equal(a.urgent, true);
  assert.equal(a.flip_siblings, true);
});

test('lookupAction: complaint → domain suppression + pause + flip_siblings', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('complaint', 0.9);
  assert.equal(a.suppression, 'domain');
  assert.equal(a.suppression_reason, 'hostile_reply');
  assert.equal(a.flip_siblings, true);
});

// ── Confidence floor override ───────────────────────────────────────────

test('lookupAction: confidence < 0.6 forces requires_human + telegram_alert', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('not_interested', 0.4);
  assert.equal(a.requires_human, true, 'low conf should force human');
  assert.equal(a.telegram_alert, true, 'low conf should force telegram');
  assert.equal(a.low_confidence, true);
  assert.equal(a.sequence_action, 'complete');
});

test('lookupAction: confidence >= 0.6 preserves table values', () => {
  const { lookupAction } = loadClassifyFresh();
  const a = lookupAction('not_interested', 0.7);
  assert.equal(a.requires_human, false);
  assert.equal(a.telegram_alert, false);
  assert.equal(a.low_confidence, false);
});

test('lookupAction: throws on out-of-enum intent', () => {
  const { lookupAction } = loadClassifyFresh();
  assert.throws(() => lookupAction('maybe_interested', 0.9), /Invalid reply intent/);
});
