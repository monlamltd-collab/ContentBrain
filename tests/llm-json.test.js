// parseLLMJson / llmJson — JSON extraction from LLM responses.
//
// parseLLMJson is pure (no mocks needed). llmJson takes the llm client as an
// argument, so a plain stub object suffices — no require.cache injection.

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseLLMJson, llmJson } = require('../lib/llm');

// ── parseLLMJson ──────────────────────────────────────────────────────────

test('parseLLMJson: plain JSON object parses', () => {
  const out = parseLLMJson('{"a": 1, "b": "two"}');
  assert.deepEqual(out, { a: 1, b: 'two' });
});

test('parseLLMJson: JSON wrapped in prose preamble + trailing text parses', () => {
  const text = 'Sure! Here is the JSON you asked for:\n{"headline": "Test", "n": 2}\nLet me know if you need anything else.';
  const out = parseLLMJson(text);
  assert.equal(out.headline, 'Test');
  assert.equal(out.n, 2);
});

test('parseLLMJson: JSON in markdown fences parses', () => {
  const text = '```json\n{"ok": true}\n```';
  assert.deepEqual(parseLLMJson(text), { ok: true });
});

test('parseLLMJson: nested objects parse (greedy match spans them)', () => {
  const text = '{"outer": {"inner": [1, 2, {"deep": true}]}}';
  const out = parseLLMJson(text);
  assert.equal(out.outer.inner[2].deep, true);
});

test('parseLLMJson: no JSON → throws labeled error with raw slice', () => {
  assert.throws(
    () => parseLLMJson('I cannot answer that question.', { label: 'caption' }),
    /\[caption\] no JSON object in LLM response\. Raw: I cannot answer/
  );
});

test('parseLLMJson: malformed JSON → throws labeled error with context', () => {
  assert.throws(
    () => parseLLMJson('{"unterminated": "string', { label: 'angle' }),
    /\[angle\] no JSON object|\[angle\] JSON parse failed/
  );
});

test('parseLLMJson: truncated JSON (open brace, close brace, bad middle) → parse-failed error', () => {
  assert.throws(
    () => parseLLMJson('{"a": 1,, "b": 2}', { label: 'x' }),
    /\[x\] JSON parse failed/
  );
});

test('parseLLMJson: non-string input → no-JSON error, not a crash', () => {
  assert.throws(() => parseLLMJson(null), /no JSON object/);
  assert.throws(() => parseLLMJson(undefined), /no JSON object/);
});

// ── llmJson (retry wrapper) ───────────────────────────────────────────────

function stubLLM(responses) {
  const calls = [];
  return {
    calls,
    messages: {
      create: async (args) => {
        calls.push(args);
        const text = responses.shift();
        return { content: [{ type: 'text', text }] };
      },
    },
  };
}

const baseArgs = {
  model: 'test',
  max_tokens: 100,
  messages: [{ role: 'user', content: 'Give me JSON' }],
};

test('llmJson: first attempt parses → one call, no retry', async () => {
  const llm = stubLLM(['{"ok": 1}']);
  const out = await llmJson(llm, baseArgs, { label: 't' });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(llm.calls.length, 1);
});

test('llmJson: parse failure → retries once with JSON-only reminder appended', async () => {
  const llm = stubLLM(['not json at all', '{"ok": 2}']);
  const out = await llmJson(llm, baseArgs, { label: 't' });
  assert.deepEqual(out, { ok: 2 });
  assert.equal(llm.calls.length, 2);
  const retryContent = llm.calls[1].messages[llm.calls[1].messages.length - 1].content;
  assert.match(retryContent, /Return ONLY the JSON object/);
});

test('llmJson: all attempts fail → throws the last parse error', async () => {
  const llm = stubLLM(['nope', 'still nope']);
  await assert.rejects(
    () => llmJson(llm, baseArgs, { label: 't' }),
    /\[t\] no JSON object/
  );
  assert.equal(llm.calls.length, 2);
});

test('llmJson: retries=0 → single attempt only', async () => {
  const llm = stubLLM(['nope']);
  await assert.rejects(() => llmJson(llm, baseArgs, { retries: 0 }), /no JSON object/);
  assert.equal(llm.calls.length, 1);
});

test('llmJson: original createArgs not mutated by retry', async () => {
  const llm = stubLLM(['bad', '{"ok": 3}']);
  const args = { ...baseArgs, messages: [{ role: 'user', content: 'original' }] };
  await llmJson(llm, args);
  assert.equal(args.messages[0].content, 'original');
});
