const { test } = require('node:test');
const assert = require('node:assert/strict');

const { bridgematchVoice } = require('../lib/voice');

test('BridgeMatch blog voice forbids false FCA and broker claims', () => {
  assert.match(bridgematchVoice, /BridgeMatch is not FCA-authorised/i);
  assert.match(bridgematchVoice, /not a mortgage broker/i);
  assert.match(bridgematchVoice, /correct it even if the editor did not explicitly ask/i);
});

test('BridgeMatch blog voice supplies a compliant canonical byline', () => {
  assert.match(bridgematchVoice, /BridgeMatch is an AI-powered lender-matching platform/i);
  assert.doesNotMatch(bridgematchVoice, /BridgeMatch Team<\/strong> is a specialist mortgage broker/i);
});
