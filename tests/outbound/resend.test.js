// Resend wrapper — CRITICAL assertions:
//   - isSuppressed(to) is called BEFORE the Resend SDK send
//   - SDK is NEVER invoked when suppression returns true
//   - HMAC signature verification rejects bad signatures, accepts good ones

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const RESEND_PATH = require.resolve('../../lib/resend');
const SUPP_PATH = require.resolve('../../lib/suppression');
const SUPABASE_PATH = require.resolve('../../lib/supabase');
const SDK_PATH = require.resolve('resend');

// Ordered call log so we can prove suppression-before-send.
let callLog = [];
let suppressionReturn = { suppressed: false, match: null, reason: null, level: null };
let resendSendArgs = [];
let addSuppressionCalls = [];

class MockResendClient {
  constructor(key) {
    this.key = key;
    this.emails = {
      send: async (payload) => {
        callLog.push('resend.send');
        resendSendArgs.push(payload);
        return { data: { id: 'mocked-resend-id-123' }, error: null };
      },
    };
  }
}

function loadResendFresh() {
  // Wipe relevant modules so env + mocks take effect
  for (const p of [RESEND_PATH, SUPP_PATH, SUPABASE_PATH, SDK_PATH]) {
    delete require.cache[p];
  }

  // Mock supabase (resend.js still pulls it for posts.meta updates; webhook
  // path uses it — sendOutbound path does not, but module loads it eagerly).
  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH,
    filename: SUPABASE_PATH,
    loaded: true,
    exports: {
      supabase: {
        from() { return { update: () => ({ eq: () => Promise.resolve({ error: null }) }), select: () => ({ filter: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }; },
      },
    },
  };

  // Mock suppression — log the call order
  require.cache[SUPP_PATH] = {
    id: SUPP_PATH,
    filename: SUPP_PATH,
    loaded: true,
    exports: {
      isSuppressed: async (email) => {
        callLog.push('isSuppressed');
        return suppressionReturn;
      },
      addSuppression: async (email, reason) => {
        addSuppressionCalls.push({ email, reason });
        return { inserted: true };
      },
      invalidateCache: () => {},
    },
  };

  // Mock Resend SDK — its export shape is { Resend: class }
  require.cache[SDK_PATH] = {
    id: SDK_PATH,
    filename: SDK_PATH,
    loaded: true,
    exports: { Resend: MockResendClient },
  };

  return require('../../lib/resend');
}

beforeEach(() => {
  callLog = [];
  resendSendArgs = [];
  addSuppressionCalls = [];
  suppressionReturn = { suppressed: false, match: null, reason: null, level: null };
  process.env.RESEND_API_KEY = 'test-resend-key';
  process.env.RESEND_WEBHOOK_SECRET = 'test-webhook-secret';
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_WEBHOOK_SECRET;
});

// ── CRITICAL: suppression before send ────────────────────────────────────

test('sendOutbound: calls isSuppressed BEFORE the Resend SDK send', async () => {
  const { sendOutbound } = loadResendFresh();
  await sendOutbound({
    to: 'someone@example.co.uk',
    from: 'BridgeMatch <out@x.co.uk>',
    subject: 'A subject',
    body: 'A body — short.',
  });

  const suppIdx = callLog.indexOf('isSuppressed');
  const sendIdx = callLog.indexOf('resend.send');
  assert.notEqual(suppIdx, -1, 'isSuppressed must be called');
  assert.notEqual(sendIdx, -1, 'resend.send must be called');
  assert.ok(suppIdx < sendIdx, `isSuppressed must be BEFORE resend.send; got log=${callLog.join(',')}`);
});

test('sendOutbound: when suppressed, SDK is NEVER invoked and an error is thrown', async () => {
  suppressionReturn = { suppressed: true, match: 'someone@example.co.uk', reason: 'manual', level: 'address' };
  const { sendOutbound } = loadResendFresh();

  await assert.rejects(
    () => sendOutbound({
      to: 'someone@example.co.uk',
      from: 'BridgeMatch <out@x.co.uk>',
      subject: 'A subject',
      body: 'A body.',
    }),
    /Suppressed:/,
  );

  assert.ok(!callLog.includes('resend.send'), 'resend.send must NOT be called when suppressed');
});

// ── Field validation ─────────────────────────────────────────────────────

test('sendOutbound: rejects when `to` missing', async () => {
  const { sendOutbound } = loadResendFresh();
  await assert.rejects(
    () => sendOutbound({ from: 'x', subject: 'a', body: 'b' }),
    /`to` is required/,
  );
});

test('sendOutbound: rejects when API key missing', async () => {
  // Empty string (not delete) — dotenv.config() runs on every require and
  // would re-populate a deleted env var from .env. Empty is still "set" so
  // dotenv's default override:false leaves it alone, and getClient()'s
  // falsy check sees missing as intended.
  process.env.RESEND_API_KEY = '';
  const { sendOutbound } = loadResendFresh();
  await assert.rejects(
    () => sendOutbound({
      to: 'a@b.co', from: 'x@y.co', subject: 'a', body: 'b',
    }),
    /Set RESEND_API_KEY/,
  );
});

// ── List-Unsubscribe header is added ─────────────────────────────────────

test('sendOutbound: adds List-Unsubscribe headers', async () => {
  const { sendOutbound } = loadResendFresh();
  await sendOutbound({
    to: 'a@x.co.uk',
    from: 'BridgeMatch <out@outreach.bridgematch.co.uk>',
    subject: 'a',
    body: 'b',
  });
  assert.equal(resendSendArgs.length, 1);
  const headers = resendSendArgs[0].headers;
  assert.ok(headers['List-Unsubscribe'], 'List-Unsubscribe header should be set');
  assert.match(headers['List-Unsubscribe'], /unsubscribe@/);
  assert.equal(headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

// ── Svix signature verification ──────────────────────────────────────────
//
// Resend's webhook signing is Svix. Helpers below match the verifier in
// lib/resend.js: secret has a `whsec_` prefix + base64 body; the signed
// payload is `${svix-id}.${svix-timestamp}.${body}`; signature is base64.

const TEST_SECRET_RAW = 'test-webhook-secret-bytes';   // arbitrary string
const TEST_SECRET_WHSEC = 'whsec_' + Buffer.from(TEST_SECRET_RAW).toString('base64');
const TEST_SECRET_BYTES = Buffer.from(Buffer.from(TEST_SECRET_RAW).toString('base64'), 'base64');

function svixSign(body, { id = 'msg_abc', timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const bodyBuf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const toSign = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, 'utf8'), bodyBuf]);
  const sig = crypto.createHmac('sha256', TEST_SECRET_BYTES).update(toSign).digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': String(timestamp),
    'svix-signature': `v1,${sig}`,
  };
}

test('verifySignature: accepts a good Svix signature', () => {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET_WHSEC;
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from(JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc' } }));
  assert.equal(verifySignature(body, svixSign(body)), true);
});

test('verifySignature: accepts header with multiple "v1,<sig>" parts (key rotation)', () => {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET_WHSEC;
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{"hello":"world"}');
  const headers = svixSign(body);
  // Prepend a bogus sig — accepting any-match.
  headers['svix-signature'] = `v1,${'A'.repeat(44)} ${headers['svix-signature']}`;
  assert.equal(verifySignature(body, headers), true);
});

test('verifySignature: rejects a bad signature', () => {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET_WHSEC;
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{"hello":"world"}');
  const headers = svixSign(body);
  headers['svix-signature'] = 'v1,' + Buffer.alloc(32).toString('base64');
  assert.throws(() => verifySignature(body, headers), /signature mismatch/);
});

test('verifySignature: rejects when signature header missing', () => {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET_WHSEC;
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{"hello":"world"}');
  assert.throws(
    () => verifySignature(body, {}),
    /missing svix-id/,
  );
});

test('verifySignature: rejects when timestamp is outside ±5 min', () => {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET_WHSEC;
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{"hello":"world"}');
  const old = Math.floor(Date.now() / 1000) - 10 * 60;  // 10 min ago
  const headers = svixSign(body, { timestamp: old });
  assert.throws(() => verifySignature(body, headers), /tolerance/);
});

test('verifySignature: fails closed when RESEND_WEBHOOK_SECRET unset', () => {
  process.env.RESEND_WEBHOOK_SECRET = '';
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{}');
  assert.throws(
    () => verifySignature(body, { 'svix-signature': 'v1,aa' }),
    /RESEND_WEBHOOK_SECRET/,
  );
});

test('verifySignature: rejects when rawBody is missing', () => {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET_WHSEC;
  const { verifySignature } = loadResendFresh();
  assert.throws(
    () => verifySignature(null, { 'svix-signature': 'v1,aa', 'svix-id': 'a', 'svix-timestamp': String(Math.floor(Date.now()/1000)) }),
    /rawBody is required/,
  );
});

// ── handleWebhook: bounce → addSuppression call routed ───────────────────

test('handleWebhook: email.bounced routes to addSuppression', async () => {
  process.env.RESEND_WEBHOOK_SECRET = TEST_SECRET_WHSEC;
  const { handleWebhook } = loadResendFresh();

  const event = { type: 'email.bounced', data: { email_id: 'abc', to: ['bounce@x.co'] } };
  const body = Buffer.from(JSON.stringify(event));

  const res = await handleWebhook(body, svixSign(body));
  assert.equal(res.handled, true);
  assert.equal(res.type, 'email.bounced');
  assert.equal(addSuppressionCalls.length, 1);
  assert.equal(addSuppressionCalls[0].email, 'bounce@x.co');
  assert.equal(addSuppressionCalls[0].reason, 'bounce');
});
