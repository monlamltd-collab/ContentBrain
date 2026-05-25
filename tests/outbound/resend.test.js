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
  delete process.env.RESEND_API_KEY;
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

// ── HMAC signature verification ──────────────────────────────────────────

test('verifySignature: accepts a good signature', () => {
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from(JSON.stringify({ type: 'email.delivered', data: { email_id: 'abc' } }));
  const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');

  assert.equal(verifySignature(body, { 'resend-signature': sig }), true);
});

test('verifySignature: accepts Svix-style "v1,<sig>" header', () => {
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{"hello":"world"}');
  const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');

  assert.equal(verifySignature(body, { 'svix-signature': `v1,${sig}` }), true);
});

test('verifySignature: rejects a bad signature', () => {
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{"hello":"world"}');
  const badSig = '0'.repeat(64);

  assert.throws(
    () => verifySignature(body, { 'resend-signature': badSig }),
    /signature mismatch/,
  );
});

test('verifySignature: rejects when signature header missing', () => {
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{"hello":"world"}');
  assert.throws(
    () => verifySignature(body, {}),
    /missing resend-signature/,
  );
});

test('verifySignature: fails closed when RESEND_WEBHOOK_SECRET unset', () => {
  delete process.env.RESEND_WEBHOOK_SECRET;
  const { verifySignature } = loadResendFresh();
  const body = Buffer.from('{}');
  assert.throws(
    () => verifySignature(body, { 'resend-signature': 'aa' }),
    /RESEND_WEBHOOK_SECRET/,
  );
});

test('verifySignature: rejects when rawBody is missing', () => {
  const { verifySignature } = loadResendFresh();
  assert.throws(
    () => verifySignature(null, { 'resend-signature': 'aa' }),
    /rawBody is required/,
  );
});

// ── handleWebhook: bounce → addSuppression call routed ───────────────────

test('handleWebhook: email.bounced routes to addSuppression', async () => {
  const { handleWebhook } = loadResendFresh();

  const event = { type: 'email.bounced', data: { email_id: 'abc', to: ['bounce@x.co'] } };
  const body = Buffer.from(JSON.stringify(event));
  const sig = crypto.createHmac('sha256', 'test-webhook-secret').update(body).digest('hex');

  const res = await handleWebhook(body, { 'resend-signature': sig });
  assert.equal(res.handled, true);
  assert.equal(res.type, 'email.bounced');
  assert.equal(addSuppressionCalls.length, 1);
  assert.equal(addSuppressionCalls[0].email, 'bounce@x.co');
  assert.equal(addSuppressionCalls[0].reason, 'bounce');
});
