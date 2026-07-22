const { test } = require('node:test');
const assert = require('node:assert/strict');

const { formatWeeklySummary } = require('../lib/weekly-summary');

test('formatWeeklySummary shows real emoji and per-item failure reasons', () => {
  const text = formatWeeklySummary([], [
    { superlative: 'cheapest-week', error: '[lot:cheapest-week] no JSON object in LLM response' },
    { superlative: 'dearest-week', error: 'browser launch failed' },
  ]);

  assert.match(text, /^📸 <b>Weekly auction posts<\/b> — 0 ready to review/);
  assert.match(text, /cheapest-week — \[lot:cheapest-week\] no JSON object/);
  assert.match(text, /dearest-week — browser launch failed/);
  assert.doesNotMatch(text, /\\u\{1F4F8\}/);
  assert.doesNotMatch(text, /Approve each preview/);
});

test('formatWeeklySummary includes approval guidance when previews exist', () => {
  const text = formatWeeklySummary([
    { superlative: 'best-deal-week' },
  ], []);
  assert.match(text, /⭐/);
  assert.match(text, /Approve each preview above/);
});

test('formatWeeklySummary does not promise retry when all items were skipped', () => {
  const text = formatWeeklySummary([], [], { willRetry: false });
  assert.doesNotMatch(text, /will retry/);
  assert.match(text, /nothing to review/i);
});
