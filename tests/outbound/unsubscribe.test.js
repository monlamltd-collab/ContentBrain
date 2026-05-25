// Unsubscribe — sign/verify round-trip + applyUnsubscribe wiring.
// Mocks lib/suppression so the test doesn't hit Supabase.

const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

let suppressionAddCalls = [];

function setupMocks() {
  const suppressionPath = require.resolve('../../lib/suppression');
  require.cache[suppressionPath] = {
    id: suppressionPath,
    filename: suppressionPath,
    loaded: true,
    exports: {
      addSuppression: async (emailOrDomain, reason) => {
        suppressionAddCalls.push({ emailOrDomain, reason });
        return { inserted: true, emailOrDomain, reason };
      },
      isSuppressed: async () => ({ suppressed: false, match: null, reason: null, level: null }),
      invalidateCache: () => {},
    },
  };
  // Fresh unsubscribe module each call.
  delete require.cache[require.resolve('../../lib/unsubscribe')];
  return require('../../lib/unsubscribe');
}

beforeEach(() => {
  suppressionAddCalls = [];
  process.env.UNSUBSCRIBE_SECRET = 'test-secret-do-not-use-in-prod';
});

// ── sign + verify ────────────────────────────────────────────────────────

test('sign: deterministic for same email', () => {
  const u = setupMocks();
  const a = u.sign('alice@example.com');
  const b = u.sign('alice@example.com');
  assert.equal(a, b);
  assert.match(a, /^[a-f0-9]{64}$/);  // SHA-256 hex
});

test('sign: case-insensitive (canonicalises to lowercase)', () => {
  const u = setupMocks();
  assert.equal(u.sign('Alice@Example.COM'), u.sign('alice@example.com'));
});

test('sign: throws on empty email', () => {
  const u = setupMocks();
  assert.throws(() => u.sign(''), /email is required/);
  assert.throws(() => u.sign(null), /email is required/);
});

test('verify: valid token → ok with canonical email', () => {
  const u = setupMocks();
  const email = 'bob@example.com';
  const token = u.sign(email);
  const r = u.verify(email, token);
  assert.equal(r.ok, true);
  assert.equal(r.email, email);
});

test('verify: tampered token → ok=false', () => {
  const u = setupMocks();
  const token = u.sign('bob@example.com');
  const tampered = token.slice(0, -2) + 'ff';
  assert.equal(u.verify('bob@example.com', tampered).ok, false);
});

test('verify: wrong email but valid-shape token → ok=false', () => {
  const u = setupMocks();
  const token = u.sign('bob@example.com');
  assert.equal(u.verify('eve@example.com', token).ok, false);
});

test('verify: empty/non-hex token → ok=false (no throw)', () => {
  const u = setupMocks();
  assert.equal(u.verify('bob@example.com', '').ok, false);
  assert.equal(u.verify('bob@example.com', 'not-hex').ok, false);
  assert.equal(u.verify('bob@example.com', null).ok, false);
});

test('verify: different secret invalidates tokens (rotation safety)', () => {
  const u1 = setupMocks();
  const token = u1.sign('bob@example.com');

  process.env.UNSUBSCRIBE_SECRET = 'rotated-secret';
  const u2 = setupMocks();
  assert.equal(u2.verify('bob@example.com', token).ok, false);
});

// ── buildUrl ────────────────────────────────────────────────────────────

test('buildUrl: composes the expected /u?e=&t= shape', () => {
  const u = setupMocks();
  const url = u.buildUrl('alice@example.com', 'https://host.test');
  const parsed = new URL(url);
  assert.equal(parsed.origin, 'https://host.test');
  assert.equal(parsed.pathname, '/u');
  assert.equal(parsed.searchParams.get('e'), 'alice@example.com');
  assert.match(parsed.searchParams.get('t'), /^[a-f0-9]{64}$/);
});

test('buildUrl: throws on missing baseUrl', () => {
  const u = setupMocks();
  assert.throws(() => u.buildUrl('a@b.co'), /baseUrl required/);
});

// ── buildHeaders ────────────────────────────────────────────────────────

test('buildHeaders: List-Unsubscribe contains URL and mailto', () => {
  const u = setupMocks();
  const h = u.buildHeaders('alice@example.com', 'https://host.test', 'unsubscribe@bm.co.uk');
  assert.match(h['List-Unsubscribe'], /<https:\/\/host\.test\/u\?e=alice%40example\.com&t=[a-f0-9]{64}>/);
  assert.match(h['List-Unsubscribe'], /<mailto:unsubscribe@bm\.co\.uk>/);
  assert.equal(h['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
});

// ── applyUnsubscribe ────────────────────────────────────────────────────

test('applyUnsubscribe: valid token → calls addSuppression with reason=unsubscribe', async () => {
  const u = setupMocks();
  const email = 'carol@example.com';
  const token = u.sign(email);
  const r = await u.applyUnsubscribe(email, token);
  assert.equal(r.ok, true);
  assert.equal(r.email, email);
  assert.equal(suppressionAddCalls.length, 1);
  assert.equal(suppressionAddCalls[0].emailOrDomain, email);
  assert.equal(suppressionAddCalls[0].reason, 'unsubscribe');
});

test('applyUnsubscribe: invalid token → no suppression call', async () => {
  const u = setupMocks();
  const r = await u.applyUnsubscribe('carol@example.com', 'deadbeef');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'invalid_token');
  assert.equal(suppressionAddCalls.length, 0);
});

test('applyUnsubscribe: timing-safe compare does not leak via early exit', async () => {
  // Sanity-check that two wrong-length tokens both return ok=false without throwing.
  const u = setupMocks();
  assert.equal((await u.applyUnsubscribe('a@b.co', 'aa')).ok, false);
  assert.equal((await u.applyUnsubscribe('a@b.co', 'ff'.repeat(64))).ok, false);
});

// ── secret fallback ─────────────────────────────────────────────────────

test('sign: falls back to RESEND_WEBHOOK_SECRET when UNSUBSCRIBE_SECRET unset', () => {
  delete process.env.UNSUBSCRIBE_SECRET;
  process.env.RESEND_WEBHOOK_SECRET = 'fallback-secret';
  const u = setupMocks();
  assert.match(u.sign('a@b.co'), /^[a-f0-9]{64}$/);
});

test('sign: throws when BOTH secrets unset', () => {
  // Set to empty string (not delete) — dotenv re-runs on each require and
  // would re-populate from .env where the key is real. Empty satisfies the
  // override:false default so the falsy check sees missing.
  process.env.UNSUBSCRIBE_SECRET = '';
  process.env.RESEND_WEBHOOK_SECRET = '';
  const u = setupMocks();
  assert.throws(() => u.sign('a@b.co'), /Set UNSUBSCRIBE_SECRET/);
});
