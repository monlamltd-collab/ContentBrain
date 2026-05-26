// inbound.js — mock fetch (Resend body fetch) + classify + sequence + suppression
// + telegram + supabase. Tests:
//   - unsubscribe intent: addSuppression(email, 'unsubscribe') + optOutSequence
//   - hostile intent: domain suppression + flip siblings cascade
//   - OOO 2-cap: 3rd OOO forces pause + telegram
//   - ON CONFLICT (resend_email_id) silently dedupes
//   - no-contact match: alert + skip
//   - low confidence forces requires_human + telegram

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const INBOUND_PATH = require.resolve('../../lib/inbound');
const SUPABASE_PATH = require.resolve('../../lib/supabase');
const CLASSIFY_PATH = require.resolve('../../lib/classify');
const SEQUENCE_PATH = require.resolve('../../lib/sequence');
const SUPP_PATH = require.resolve('../../lib/suppression');
const TELEGRAM_PATH = require.resolve('../../lib/telegram');

// ── Test state ──────────────────────────────────────────────────────────

let mockSupabase = {
  responses: {},
  inserts: [],
  updates: [],
  upserts: [],
};
let classifyReturn = null;
let suppressionCalls = [];
let sequenceCalls = [];
let telegramCalls = [];
let fetchResponses = [];
let realFetch = null;

function freshSupabaseStub() {
  return {
    from(table) {
      const state = { table, op: null, args: {}, filters: [] };

      function thenable() {
        return {
          then(resolve, reject) {
            const r = popMockResponse(state.table, state.op);
            try {
              return resolve(r);
            } catch (e) {
              return reject(e);
            }
          },
        };
      }

      const api = {
        select(cols) { state.args.select = cols; return api; },
        insert(row) { state.op = 'insert'; state.args.insert = row; mockSupabase.inserts.push({ table: state.table, row }); return api; },
        update(row) { state.op = 'update'; state.args.update = row; mockSupabase.updates.push({ table: state.table, row }); return api; },
        upsert(row, opts) { state.op = 'upsert'; state.args.upsert = row; state.args.upsertOpts = opts; mockSupabase.upserts.push({ table: state.table, row, opts }); return api; },
        eq(col, val) { state.filters.push(['eq', col, val]); return api; },
        in(col, val) { state.filters.push(['in', col, val]); return api; },
        neq(col, val) { state.filters.push(['neq', col, val]); return api; },
        ilike(col, val) { state.filters.push(['ilike', col, val]); return api; },
        order(col, opts) { state.args.order = { col, opts }; return api; },
        limit(n) { state.args.limit = n; return api; },
        filter(col, op, val) { state.filters.push(['filter', col, op, val]); return api; },
        maybeSingle() {
          state.args.single = 'maybe';
          state.op = state.op || 'select';
          return thenable();
        },
        single() {
          state.args.single = 'single';
          state.op = state.op || 'select';
          return thenable();
        },
        then(resolve, reject) {
          state.op = state.op || 'select';
          return thenable().then(resolve, reject);
        },
      };
      return api;
    },
  };
}

function popMockResponse(table, op) {
  // Per-table queue keyed by table only (op is for trace; tests can refine).
  const q = mockSupabase.responses[table];
  if (!q || !q.length) return { data: null, error: null };
  return q.shift();
}

function loadInboundFresh() {
  // Wipe all related modules
  for (const p of [INBOUND_PATH, SUPABASE_PATH, CLASSIFY_PATH, SEQUENCE_PATH, SUPP_PATH, TELEGRAM_PATH]) {
    delete require.cache[p];
  }

  // Inject supabase stub
  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH,
    filename: SUPABASE_PATH,
    loaded: true,
    exports: { supabase: freshSupabaseStub() },
  };

  // Stub classify so we control the intent / confidence
  require.cache[CLASSIFY_PATH] = {
    id: CLASSIFY_PATH,
    filename: CLASSIFY_PATH,
    loaded: true,
    exports: {
      classifyReply: async () => classifyReturn,
      lookupAction: require('../../lib/classify').lookupAction,
      MIN_CONFIDENCE_FOR_AUTO: 0.6,
    },
  };

  // Stub sequence so we record which actions were called
  require.cache[SEQUENCE_PATH] = {
    id: SEQUENCE_PATH,
    filename: SEQUENCE_PATH,
    loaded: true,
    exports: {
      pauseSequence: async (id, reason) => { sequenceCalls.push({ fn: 'pause', id, reason }); return { ok: true }; },
      completeSequence: async (id, reason) => { sequenceCalls.push({ fn: 'complete', id, reason }); return { ok: true }; },
      optOutSequence: async (id) => { sequenceCalls.push({ fn: 'opt_out', id }); return { ok: true }; },
      deferSequence: async (id, days) => { sequenceCalls.push({ fn: 'defer', id, days }); return { ok: true }; },
      pauseSiblingsForCompany: async (prospectId, reason, exclude) => {
        sequenceCalls.push({ fn: 'flip_siblings', prospectId, reason, exclude });
        return { paused: 2, ids: ['sib-1', 'sib-2'] };
      },
    },
  };

  // Stub suppression
  require.cache[SUPP_PATH] = {
    id: SUPP_PATH,
    filename: SUPP_PATH,
    loaded: true,
    exports: {
      addSuppression: async (target, reason) => {
        suppressionCalls.push({ target, reason });
        return { inserted: true };
      },
      isSuppressed: async () => ({ suppressed: false }),
    },
  };

  // Stub telegram
  require.cache[TELEGRAM_PATH] = {
    id: TELEGRAM_PATH,
    filename: TELEGRAM_PATH,
    loaded: true,
    exports: {
      sendNotification: async (msg) => { telegramCalls.push(msg); return true; },
    },
  };

  return require('../../lib/inbound');
}

// ── Fetch mock ──────────────────────────────────────────────────────────
// Override the global fetch so fetchInboundBody returns whatever we queue.

function installFetchMock() {
  if (!realFetch) realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (!fetchResponses.length) {
      throw new Error('Mock fetch ran out of queued responses');
    }
    const r = fetchResponses.shift();
    return {
      ok: r.ok !== false,
      status: r.status || 200,
      json: async () => r.json,
      text: async () => r.text || JSON.stringify(r.json || {}),
    };
  };
}

function restoreFetch() {
  if (realFetch) {
    global.fetch = realFetch;
    realFetch = null;
  }
}

beforeEach(() => {
  mockSupabase = { responses: {}, inserts: [], updates: [], upserts: [] };
  classifyReturn = null;
  suppressionCalls = [];
  sequenceCalls = [];
  telegramCalls = [];
  fetchResponses = [];
  installFetchMock();
  process.env.RESEND_API_KEY = 'test-key';
});

afterEach(() => {
  restoreFetch();
});

// ── Helpers ─────────────────────────────────────────────────────────────

function queueContactLookup({ contact, prospect, sequenceId }) {
  // Order matters — must match the order the inbound code reads tables.
  // contacts (ilike) → posts (in-reply-to lookup, none) → sequences (fallback) → replies (insert) → replies (update)
  mockSupabase.responses.contacts = [
    { data: contact ? [{ ...contact, prospect }] : [], error: null },
  ];
  mockSupabase.responses.posts = [{ data: null, error: null }];
  mockSupabase.responses.sequences = sequenceId
    ? [{ data: { id: sequenceId }, error: null }]
    : [{ data: null, error: null }];
}

function queueRepliesInsert({ replyId = 'rep-1', duplicate = false } = {}) {
  // Insert (upsert with ignoreDuplicates) → returns row or null on duplicate.
  // Then the final UPDATE.
  const insertResp = duplicate
    ? { data: null, error: null }
    : { data: { id: replyId }, error: null };
  mockSupabase.responses.replies = [
    insertResp,
    { data: null, error: null }, // update
  ];
}

function queueRepliesInsertWithOooCount(priorCount) {
  // Insert + countPriorOooReplies (HEAD select) + update.
  mockSupabase.responses.replies = [
    { data: { id: 'rep-1' }, error: null },     // upsert insert
    { count: priorCount, error: null },          // count head select
    { data: null, error: null },                 // final update
  ];
}

function queueResendBody({ text = 'Hello, please unsubscribe me.', headers = {} } = {}) {
  fetchResponses.push({ ok: true, json: { text, html: null, headers } });
}

const eventData = {
  email_id: 'resend-id-abc',
  from: 'replier@example.co.uk',
  subject: 'Re: hi',
};

// ── Test: unsubscribe → suppress + opt_out + reply UPDATE ───────────────

test('handleInboundEmail: unsubscribe → addSuppression(email) + optOutSequence', async () => {
  queueResendBody({ text: 'Please remove me from your list. Cheers.' });
  classifyReturn = { intent: 'unsubscribe', confidence: 0.95, reasoning: 'explicit opt-out' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'Bob', email: 'replier@example.co.uk', prospect_id: 'pr-1' },
    prospect: { id: 'pr-1', type: 'lender', company_name: 'Acme' },
    sequenceId: 'seq-1',
  });
  queueRepliesInsert();

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.ok, true);
  assert.equal(res.intent, 'unsubscribe');
  assert.equal(res.requires_human, false);
  assert.equal(res.contactId, 'c-1');
  assert.equal(res.sequenceId, 'seq-1');

  assert.equal(suppressionCalls.length, 1);
  assert.equal(suppressionCalls[0].target, 'replier@example.co.uk');
  assert.equal(suppressionCalls[0].reason, 'unsubscribe');

  const optOut = sequenceCalls.find(c => c.fn === 'opt_out');
  assert.ok(optOut, 'optOutSequence should be called');
  assert.equal(optOut.id, 'seq-1');
});

// ── Test: hostile → domain suppression + flip siblings + telegram ───────

test('handleInboundEmail: hostile → domain suppression + flip siblings + telegram alert', async () => {
  queueResendBody({ text: 'STOP emailing me — this is harassment.' });
  classifyReturn = { intent: 'hostile', confidence: 0.92, reasoning: 'angry, asks to stop' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'Carol', email: 'angry@acme.com', prospect_id: 'pr-1' },
    prospect: { id: 'pr-1', type: 'lender', company_name: 'Acme' },
    sequenceId: 'seq-1',
  });
  queueRepliesInsert();
  eventData.from = 'angry@acme.com';

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.ok, true);
  assert.equal(res.intent, 'hostile');
  assert.equal(res.requires_human, true);

  // Domain suppression
  assert.equal(suppressionCalls.length, 1);
  assert.equal(suppressionCalls[0].target, 'acme.com');
  assert.equal(suppressionCalls[0].reason, 'hostile_reply');

  // Pause main sequence
  const pause = sequenceCalls.find(c => c.fn === 'pause');
  assert.ok(pause, 'pauseSequence should be called');
  assert.equal(pause.id, 'seq-1');
  assert.equal(pause.reason, 'hostile_pause');

  // Flip siblings
  const flip = sequenceCalls.find(c => c.fn === 'flip_siblings');
  assert.ok(flip, 'pauseSiblingsForCompany should be called');
  assert.equal(flip.prospectId, 'pr-1');
  assert.equal(flip.reason, 'hostile_pause');

  // Telegram
  assert.ok(telegramCalls.length >= 1, 'Telegram alert should fire');
  assert.match(telegramCalls[0], /URGENT/);
  assert.match(telegramCalls[0], /hostile/);
});

// ── Test: complaint also flips siblings (same domain branch) ────────────

test('handleInboundEmail: complaint → domain suppression with hostile_reply reason + flip siblings', async () => {
  queueResendBody({ text: 'I will report you to the ICO.' });
  classifyReturn = { intent: 'complaint', confidence: 0.95, reasoning: 'threatens ICO' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'Diana', email: 'd@bigco.co.uk', prospect_id: 'pr-2' },
    prospect: { id: 'pr-2', type: 'lender', company_name: 'BigCo' },
    sequenceId: 'seq-2',
  });
  queueRepliesInsert();
  eventData.from = 'd@bigco.co.uk';

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.intent, 'complaint');
  assert.equal(suppressionCalls[0].target, 'bigco.co.uk');
  assert.equal(suppressionCalls[0].reason, 'hostile_reply');
  const flip = sequenceCalls.find(c => c.fn === 'flip_siblings');
  assert.ok(flip);
});

// ── Test: OOO 2-cap — 3rd OOO forces pause + telegram ──────────────────

test('handleInboundEmail: OOO with 2 prior → forces pause + awaiting_human', async () => {
  queueResendBody({ text: 'Out of office until next Monday.' });
  classifyReturn = { intent: 'out_of_office', confidence: 0.95, reasoning: 'autoresponder' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'Eric', email: 'e@x.co.uk', prospect_id: 'pr-1' },
    prospect: { id: 'pr-1', type: 'lender', company_name: 'X' },
    sequenceId: 'seq-1',
  });
  queueRepliesInsertWithOooCount(2);  // 2 prior OOO → 3rd hit
  eventData.from = 'e@x.co.uk';

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.ok, true);
  assert.equal(res.requires_human, true, 'OOO cap should force human');

  // Should pause (not defer)
  const pause = sequenceCalls.find(c => c.fn === 'pause');
  assert.ok(pause, 'pauseSequence should be called when OOO cap hit');
  assert.equal(pause.reason, 'awaiting_human');

  // Should NOT defer
  const defer = sequenceCalls.find(c => c.fn === 'defer');
  assert.ok(!defer, 'deferSequence should NOT be called when OOO cap hit');

  // Telegram alert
  assert.ok(telegramCalls.length >= 1, 'Telegram alert should fire when OOO cap hits');
});

test('handleInboundEmail: OOO with 1 prior → defers +7d (under cap)', async () => {
  queueResendBody({ text: 'On leave until next week.' });
  classifyReturn = { intent: 'out_of_office', confidence: 0.95, reasoning: 'autoresponder' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'Frank', email: 'f@x.co.uk', prospect_id: 'pr-1' },
    prospect: { id: 'pr-1', type: 'lender', company_name: 'X' },
    sequenceId: 'seq-1',
  });
  queueRepliesInsertWithOooCount(1);  // 1 prior — still under cap

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.ok, true);
  // Should defer, not pause
  const defer = sequenceCalls.find(c => c.fn === 'defer');
  assert.ok(defer, 'deferSequence should be called');
  assert.equal(defer.days, 7);

  const pause = sequenceCalls.find(c => c.fn === 'pause');
  assert.ok(!pause, 'pauseSequence should NOT be called when OOO under cap');
});

// ── Test: ON CONFLICT silent dedupe ─────────────────────────────────────

test('handleInboundEmail: ON CONFLICT duplicate → silent skip, no classify, no dispatch', async () => {
  queueResendBody({ text: 'whatever' });
  classifyReturn = { intent: 'not_interested', confidence: 0.9, reasoning: 'x' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'G', email: 'replier@example.co.uk', prospect_id: 'pr-1' },
    prospect: { id: 'pr-1', type: 'lender', company_name: 'X' },
    sequenceId: 'seq-1',
  });
  // Insert returns null → duplicate.
  queueRepliesInsert({ duplicate: true });

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.skipped, true);
  assert.equal(res.intent, null);
  assert.equal(suppressionCalls.length, 0, 'no suppression on duplicate');
  assert.equal(sequenceCalls.length, 0, 'no sequence dispatch on duplicate');
});

// ── Test: no contact match → alert + skip ───────────────────────────────

test('handleInboundEmail: no contact match → Telegram alert, no insert', async () => {
  queueResendBody({ text: 'random reply' });
  // No contact match
  mockSupabase.responses.contacts = [{ data: [], error: null }];

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.ok, false);
  assert.equal(res.skipped, true);
  assert.equal(res.contactId, null);
  assert.ok(telegramCalls.length >= 1, 'Telegram alert should fire for unknown sender');
  assert.equal(suppressionCalls.length, 0);
});

// ── Test: low confidence override ───────────────────────────────────────

test('handleInboundEmail: low-confidence not_interested → requires_human + telegram', async () => {
  queueResendBody({ text: 'hmm not sure' });
  classifyReturn = { intent: 'not_interested', confidence: 0.4, reasoning: 'ambiguous' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'H', email: 'h@x.co.uk', prospect_id: 'pr-1' },
    prospect: { id: 'pr-1', type: 'lender', company_name: 'X' },
    sequenceId: 'seq-1',
  });
  queueRepliesInsert();

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.requires_human, true, 'low conf should force human');
  assert.ok(telegramCalls.length >= 1, 'low conf should fire telegram');
});

// ── Test: not_interested (high conf) → complete + no alert ──────────────

test('handleInboundEmail: not_interested → completeSequence + no alert', async () => {
  queueResendBody({ text: 'not for us, thanks' });
  classifyReturn = { intent: 'not_interested', confidence: 0.9, reasoning: 'polite decline' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'I', email: 'i@x.co.uk', prospect_id: 'pr-1' },
    prospect: { id: 'pr-1', type: 'lender', company_name: 'X' },
    sequenceId: 'seq-1',
  });
  queueRepliesInsert();

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(res.requires_human, false);
  const complete = sequenceCalls.find(c => c.fn === 'complete');
  assert.ok(complete, 'completeSequence should be called');
  assert.equal(complete.reason, 'replied_decline');
  assert.equal(telegramCalls.length, 0, 'no telegram for high-conf not_interested');
});

// ── Test: wrong_person → email suppression + complete + telegram ────────

test('handleInboundEmail: wrong_person → email suppression + complete', async () => {
  queueResendBody({ text: 'You want Sarah in BD.' });
  classifyReturn = { intent: 'wrong_person', confidence: 0.9, reasoning: 'redirected to colleague' };

  queueContactLookup({
    contact: { id: 'c-1', name: 'J', email: 'j@x.co.uk', prospect_id: 'pr-1' },
    prospect: { id: 'pr-1', type: 'lender', company_name: 'X' },
    sequenceId: 'seq-1',
  });
  queueRepliesInsert();
  eventData.from = 'j@x.co.uk';

  const inbound = loadInboundFresh();
  const res = await inbound.handleInboundEmail(eventData);

  assert.equal(suppressionCalls[0].target, 'j@x.co.uk');
  assert.equal(suppressionCalls[0].reason, 'wrong_person');
  const complete = sequenceCalls.find(c => c.fn === 'complete');
  assert.ok(complete);
  assert.equal(complete.reason, 'wrong_person');
});

// ── Sanity: missing email_id throws ─────────────────────────────────────

test('handleInboundEmail: missing email_id throws', async () => {
  const inbound = loadInboundFresh();
  await assert.rejects(
    () => inbound.handleInboundEmail({ from: 'a@b.co' }),
    /email_id required/,
  );
});

// ── Internal helpers ────────────────────────────────────────────────────

test('_internals.domainOf returns lowercase domain', () => {
  const inbound = loadInboundFresh();
  assert.equal(inbound._internals.domainOf('Bob@Acme.COM'), 'acme.com');
  assert.equal(inbound._internals.domainOf('noat'), null);
  assert.equal(inbound._internals.domainOf(''), null);
});

test('_internals.extractResendIdsFromHeader pulls the id before @', () => {
  const inbound = loadInboundFresh();
  const ids = inbound._internals.extractResendIdsFromHeader('<abc-123@email.eu-west-1.amazonaws.com>');
  assert.deepEqual(ids, ['abc-123']);
});

test('_internals.stripHtml removes tags and collapses whitespace', () => {
  const inbound = loadInboundFresh();
  const t = inbound._internals.stripHtml('<p>Hello <b>world</b>!</p>');
  assert.equal(t, 'Hello world !');
});
