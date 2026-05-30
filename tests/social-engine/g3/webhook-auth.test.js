// Phase G-3 — webhook-auth HMAC helpers.
//
// Covers signOutbound, verifyInbound, verifyOutbound:
//   - missing-secret throws (fail-closed)
//   - sign/verify round-trip succeeds
//   - cross-secret leak rejected (sign with A, verify with B fails)
//   - tampered body rejected
//   - missing header rejected
//   - length-mismatched header rejected via pre-check (no timingSafeEqual RangeError)
//   - verifyOutbound accepts query-string sig fallback
//
// No network. No supabase. Pure crypto.

'use strict';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const MOD_PATH = require.resolve('../../../lib/social-engine/webhook-auth');

function loadFresh() {
  delete require.cache[MOD_PATH];
  return require('../../../lib/social-engine/webhook-auth');
}

const OUTBOUND = 'outbound-secret-AAAAAAAAAAAA';
const INBOUND  = 'inbound-secret-BBBBBBBBBBBBB';

beforeEach(() => {
  delete process.env.MAKE_WEBHOOK_SECRET;
  delete process.env.MAKE_CALLBACK_SECRET;
});

// ── signOutbound ──────────────────────────────────────────────

test('signOutbound throws when MAKE_WEBHOOK_SECRET unset', () => {
  const { signOutbound } = loadFresh();
  assert.throws(() => signOutbound('{"a":1}'), /MAKE_WEBHOOK_SECRET/);
});

test('signOutbound returns sha256=<64-hex> for known input', () => {
  process.env.MAKE_WEBHOOK_SECRET = OUTBOUND;
  const { signOutbound } = loadFresh();
  const sig = signOutbound('hello');
  assert.match(sig, /^sha256=[a-f0-9]{64}$/);

  // Cross-check against a manual computation
  const expected = 'sha256=' + crypto.createHmac('sha256', OUTBOUND).update('hello').digest('hex');
  assert.equal(sig, expected);
});

test('signOutbound accepts Buffer body', () => {
  process.env.MAKE_WEBHOOK_SECRET = OUTBOUND;
  const { signOutbound } = loadFresh();
  const sig = signOutbound(Buffer.from('payload'));
  const expected = 'sha256=' + crypto.createHmac('sha256', OUTBOUND).update(Buffer.from('payload')).digest('hex');
  assert.equal(sig, expected);
});

// ── verifyInbound ─────────────────────────────────────────────

test('verifyInbound throws when MAKE_CALLBACK_SECRET unset', () => {
  const { verifyInbound } = loadFresh();
  assert.throws(() => verifyInbound(Buffer.from('{}'), { 'x-make-signature': 'sha256=xxx' }),
    /MAKE_CALLBACK_SECRET/);
});

test('verifyInbound throws when X-Make-Signature header missing', () => {
  process.env.MAKE_CALLBACK_SECRET = INBOUND;
  const { verifyInbound } = loadFresh();
  assert.throws(() => verifyInbound(Buffer.from('{}'), {}), /missing signature header/);
});

test('verifyInbound throws on signature mismatch (tampered body)', () => {
  process.env.MAKE_CALLBACK_SECRET = INBOUND;
  const { verifyInbound } = loadFresh();
  // Signature computed over 'A', body sent is 'B'
  const sig = 'sha256=' + crypto.createHmac('sha256', INBOUND).update('A').digest('hex');
  assert.throws(() => verifyInbound(Buffer.from('B'), { 'x-make-signature': sig }),
    /signature mismatch/);
});

test('verifyInbound returns true on valid sig', () => {
  process.env.MAKE_CALLBACK_SECRET = INBOUND;
  const { verifyInbound } = loadFresh();
  const body = Buffer.from('{"status":"active"}');
  const sig = 'sha256=' + crypto.createHmac('sha256', INBOUND).update(body).digest('hex');
  assert.equal(verifyInbound(body, { 'x-make-signature': sig }), true);
});

test('verifyInbound length-mismatched header is rejected (no RangeError)', () => {
  process.env.MAKE_CALLBACK_SECRET = INBOUND;
  const { verifyInbound } = loadFresh();
  // 'sha256=short' is shorter than the expected 7+64-char string
  assert.throws(() => verifyInbound(Buffer.from('{}'), { 'x-make-signature': 'sha256=short' }),
    /signature mismatch/);
});

test('verifyInbound accepts X-Make-Signature header in capital form', () => {
  process.env.MAKE_CALLBACK_SECRET = INBOUND;
  const { verifyInbound } = loadFresh();
  const body = Buffer.from('payload');
  const sig = 'sha256=' + crypto.createHmac('sha256', INBOUND).update(body).digest('hex');
  assert.equal(verifyInbound(body, { 'X-Make-Signature': sig }), true);
});

test('verifyInbound: secret swap (signed with OUTBOUND verifying with INBOUND) is rejected', () => {
  process.env.MAKE_CALLBACK_SECRET = INBOUND;
  const { verifyInbound } = loadFresh();
  const body = Buffer.from('{}');
  const sigWithWrongSecret = 'sha256=' + crypto.createHmac('sha256', OUTBOUND).update(body).digest('hex');
  assert.throws(() => verifyInbound(body, { 'x-make-signature': sigWithWrongSecret }),
    /signature mismatch/);
});

// ── verifyOutbound ────────────────────────────────────────────

test('verifyOutbound throws when MAKE_WEBHOOK_SECRET unset', () => {
  const { verifyOutbound } = loadFresh();
  assert.throws(() => verifyOutbound(Buffer.alloc(0), { 'x-cb-signature': 'sha256=xxx' }, undefined),
    /MAKE_WEBHOOK_SECRET/);
});

test('verifyOutbound succeeds with X-CB-Signature header', () => {
  process.env.MAKE_WEBHOOK_SECRET = OUTBOUND;
  const { verifyOutbound } = loadFresh();
  const body = Buffer.alloc(0);
  const sig = 'sha256=' + crypto.createHmac('sha256', OUTBOUND).update(body).digest('hex');
  assert.equal(verifyOutbound(body, { 'x-cb-signature': sig }, undefined), true);
});

test('verifyOutbound falls back to query-string sig when header missing', () => {
  process.env.MAKE_WEBHOOK_SECRET = OUTBOUND;
  const { verifyOutbound } = loadFresh();
  const body = Buffer.alloc(0);
  const sig = 'sha256=' + crypto.createHmac('sha256', OUTBOUND).update(body).digest('hex');
  assert.equal(verifyOutbound(body, {}, sig), true);
});

test('verifyOutbound prefers header over query when both present', () => {
  process.env.MAKE_WEBHOOK_SECRET = OUTBOUND;
  const { verifyOutbound } = loadFresh();
  const body = Buffer.alloc(0);
  const headerSig = 'sha256=' + crypto.createHmac('sha256', OUTBOUND).update(body).digest('hex');
  // Query sig is wrong — header is right; expect success
  assert.equal(verifyOutbound(body, { 'x-cb-signature': headerSig }, 'sha256=garbage_that_is_64_long_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), true);
});

test('verifyOutbound rejects when neither header nor query sig present', () => {
  process.env.MAKE_WEBHOOK_SECRET = OUTBOUND;
  const { verifyOutbound } = loadFresh();
  assert.throws(() => verifyOutbound(Buffer.alloc(0), {}, undefined),
    /missing signature header/);
});

test('verifyOutbound rejects mismatched query sig', () => {
  process.env.MAKE_WEBHOOK_SECRET = OUTBOUND;
  const { verifyOutbound } = loadFresh();
  const body = Buffer.alloc(0);
  // Build a sig of CORRECT length but wrong content
  const wrong = 'sha256=' + 'a'.repeat(64);
  assert.throws(() => verifyOutbound(body, {}, wrong), /signature mismatch/);
});

// ── round-trip ────────────────────────────────────────────────

test('round-trip: sign + verify with same secret returns true', () => {
  // Same secret in both env vars so signOutbound and verifyInbound interop.
  process.env.MAKE_WEBHOOK_SECRET = OUTBOUND;
  process.env.MAKE_CALLBACK_SECRET = OUTBOUND;
  const { signOutbound, verifyInbound } = loadFresh();
  const body = Buffer.from(JSON.stringify({ ok: true, n: 42 }));
  const sig = signOutbound(body);
  assert.equal(verifyInbound(body, { 'x-make-signature': sig }), true);
});
