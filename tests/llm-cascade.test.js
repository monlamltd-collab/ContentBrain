// tests/llm-cascade.test.js — OpenRouter model cascade.
// createLLM() must try the primary model, and on a "model unavailable" 404
// (the google/gemini-2.0-flash-exp:free incident) fall through to the next
// cheap model rather than failing the whole call. global.fetch stubbed.

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const LLM_PATH = require.resolve('../lib/llm');
const realFetch = global.fetch;

let fetchBodies; // model names requested, in order
let responder;   // (model) => { ok, status, json/text }

function loadFresh() {
  delete require.cache[LLM_PATH];
  return require('../lib/llm');
}

function okBody(text) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message: { content: text } }], usage: { total_tokens: 1 } }),
  };
}
function notFound(model) {
  return {
    ok: false,
    status: 404,
    text: async () => JSON.stringify({ error: { message: `No endpoints found for ${model}.`, code: 404 } }),
  };
}

beforeEach(() => {
  fetchBodies = [];
  responder = null;
  process.env.OPENROUTER_API_KEY = 'or-test-key';
  process.env.OPENROUTER_MODEL = 'primary/model';
  process.env.OPENROUTER_FALLBACK_MODELS = 'fallback/one,fallback/two';
  delete process.env.GEMINI_API_KEY; // ensure no Gemini-direct path
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    fetchBodies.push(body.model);
    return responder(body.model);
  };
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_MODEL;
  delete process.env.OPENROUTER_FALLBACK_MODELS;
});

test('cascade: primary 404 → falls through to first fallback and returns its text', async () => {
  responder = (model) => (model === 'primary/model' ? notFound(model) : okBody('hi from fallback'));
  const { createLLM } = loadFresh();
  const resp = await createLLM().messages.create({ messages: [{ role: 'user', content: 'x' }] });

  const text = (resp.content || []).find(b => b.type === 'text')?.text;
  assert.equal(text, 'hi from fallback');
  assert.equal(resp.model, 'fallback/one');
  assert.deepEqual(fetchBodies, ['primary/model', 'fallback/one']);
});

test('cascade: primary used directly when healthy (no fallback calls)', async () => {
  responder = (model) => (model === 'primary/model' ? okBody('primary ok') : notFound(model));
  const { createLLM } = loadFresh();
  const resp = await createLLM().messages.create({ messages: [{ role: 'user', content: 'x' }] });

  assert.equal((resp.content || [])[0].text, 'primary ok');
  assert.equal(resp.model, 'primary/model');
  assert.deepEqual(fetchBodies, ['primary/model']);
});

test('cascade: all models 404 → throws after exhausting the chain', async () => {
  responder = (model) => notFound(model);
  const { createLLM } = loadFresh();
  await assert.rejects(
    () => createLLM().messages.create({ messages: [{ role: 'user', content: 'x' }] }),
    /No endpoints found/,
  );
  // every model in the chain was attempted at least once
  assert.ok(fetchBodies.includes('primary/model'));
  assert.ok(fetchBodies.includes('fallback/one'));
  assert.ok(fetchBodies.includes('fallback/two'));
});

test('cascade: fallback list dedups the primary', async () => {
  process.env.OPENROUTER_FALLBACK_MODELS = 'primary/model,fallback/one';
  responder = (model) => (model === 'fallback/one' ? okBody('ok') : notFound(model));
  const { createLLM } = loadFresh();
  const resp = await createLLM().messages.create({ messages: [{ role: 'user', content: 'x' }] });
  assert.equal(resp.model, 'fallback/one');
  // primary appears once (not twice) before the fallback
  assert.deepEqual(fetchBodies, ['primary/model', 'fallback/one']);
});
