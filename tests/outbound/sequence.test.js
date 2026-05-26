// sequence.js — mock Supabase + the lazy-loaded generate-outbound module.
// Tests:
//   - createSequenceOnPublish idempotency (existing active row → no-op)
//   - createSequenceOnPublish happy path inserts with current_step=1
//   - advanceSequence happy path → queues post + Telegram
//   - advanceSequence at MAX_STEP → completes
//   - pauseSiblingsForCompany cascades to every active sibling
//   - bumpSequenceOnSendSuccess on step 4 → completed
//   - bumpSequenceOnSendSuccess on step 2 → updates current_step + next_at
//   - terminal helpers validate ended_reason

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SEQUENCE_PATH = require.resolve('../../lib/sequence');
const SUPABASE_PATH = require.resolve('../../lib/supabase');
const RUNTIME_CFG_PATH = require.resolve('../../lib/runtime-config');
const GEN_OUTBOUND_PATH = require.resolve('../../lib/generate-outbound');

// ── Supabase stub ────────────────────────────────────────────────────────
// Builder-style chain that the sequence module uses. Each call site builds
// a chain we record; finally awaits resolve to a configured { data, error }.

let mockResponses = {}; // table → array of next responses (popped per call)
let lastCalls = [];     // every chain logged: { table, op, args }
let lastInsertedRow = null;
let lastUpdatedRow = null;

function pop(table) {
  const q = mockResponses[table];
  if (!q || !q.length) return { data: null, error: null };
  return q.shift();
}

function freshSupabaseStub() {
  return {
    from(table) {
      const state = { table, op: null, args: {}, filters: [] };

      function thenable() {
        return {
          then(resolve, reject) {
            lastCalls.push({ table: state.table, op: state.op, args: state.args, filters: state.filters });
            try {
              return resolve(pop(state.table));
            } catch (e) {
              return reject(e);
            }
          },
        };
      }

      const api = {
        select(cols) { state.args.select = cols; return api; },
        insert(row) { state.op = 'insert'; state.args.insert = row; lastInsertedRow = row; return api; },
        update(row) { state.op = 'update'; state.args.update = row; lastUpdatedRow = row; return api; },
        upsert(row, opts) { state.op = 'upsert'; state.args.upsert = row; state.args.upsertOpts = opts; return api; },
        delete() { state.op = 'delete'; return api; },
        eq(col, val) { state.filters.push(['eq', col, val]); return api; },
        neq(col, val) { state.filters.push(['neq', col, val]); return api; },
        in(col, val) { state.filters.push(['in', col, val]); return api; },
        lt(col, val) { state.filters.push(['lt', col, val]); return api; },
        lte(col, val) { state.filters.push(['lte', col, val]); return api; },
        gte(col, val) { state.filters.push(['gte', col, val]); return api; },
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
          // bare-await on a chain that ended in update/insert/select-without-single
          state.op = state.op || 'select';
          return thenable().then(resolve, reject);
        },
      };
      return api;
    },
  };
}

function loadSequenceFresh() {
  delete require.cache[SEQUENCE_PATH];
  delete require.cache[SUPABASE_PATH];
  delete require.cache[RUNTIME_CFG_PATH];
  delete require.cache[GEN_OUTBOUND_PATH];

  require.cache[SUPABASE_PATH] = {
    id: SUPABASE_PATH,
    filename: SUPABASE_PATH,
    loaded: true,
    exports: { supabase: freshSupabaseStub() },
  };

  // Stub runtime-config so getFollowupIntervals returns the default without
  // hitting Supabase via a different client.
  require.cache[RUNTIME_CFG_PATH] = {
    id: RUNTIME_CFG_PATH,
    filename: RUNTIME_CFG_PATH,
    loaded: true,
    exports: { loadAllLevers: async () => [] },
  };

  // Stub generate-outbound so advanceSequence's lazy require returns a
  // predictable subject/body without an Anthropic call.
  require.cache[GEN_OUTBOUND_PATH] = {
    id: GEN_OUTBOUND_PATH,
    filename: GEN_OUTBOUND_PATH,
    loaded: true,
    exports: {
      generateOutbound: async (track, contact, prospect, step) => ({
        subject: `Step ${step} subject`,
        body: `Step ${step} body for ${prospect.company_name}.`,
        reasoning: 'mock',
        meta: { track, sequence_step: step, contact_id: contact.id, prospect_id: prospect.id },
      }),
    },
  };

  return require('../../lib/sequence');
}

beforeEach(() => {
  mockResponses = {};
  lastCalls = [];
  lastInsertedRow = null;
  lastUpdatedRow = null;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
});

// ── createSequenceOnPublish ──────────────────────────────────────────────

test('createSequenceOnPublish: idempotent — returns existing row on duplicate', async () => {
  mockResponses = {
    sequences: [
      // existence check — returns existing
      { data: { id: 'seq-1', current_step: 1, status: 'active' }, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.createSequenceOnPublish(
    { id: 'p-1', meta: { track: 'lender' } },
    { id: 'c-1' },
    { id: 'pr-1' }
  );
  assert.equal(res.id, 'seq-1');
  assert.equal(res.created, false);
});

test('createSequenceOnPublish: inserts new row with current_step=1 when no existing', async () => {
  mockResponses = {
    sequences: [
      // existence check — empty
      { data: null, error: null },
      // insert
      { data: { id: 'seq-new', current_step: 1, status: 'active' }, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.createSequenceOnPublish(
    { id: 'p-1', meta: { track: 'lender' } },
    { id: 'c-1' },
    { id: 'pr-1' }
  );
  assert.equal(res.created, true);
  assert.equal(res.id, 'seq-new');
  assert.equal(lastInsertedRow.contact_id, 'c-1');
  assert.equal(lastInsertedRow.track, 'lender');
  assert.equal(lastInsertedRow.current_step, 1);
  assert.equal(lastInsertedRow.status, 'active');
  assert.ok(lastInsertedRow.next_scheduled_at, 'next_scheduled_at should be set');
});

test('createSequenceOnPublish: rejects invalid track', async () => {
  const seq = loadSequenceFresh();
  await assert.rejects(
    () => seq.createSequenceOnPublish(
      { id: 'p-1', meta: { track: 'weird' } },
      { id: 'c-1' },
      { id: 'pr-1' }
    ),
    /Invalid track/,
  );
});

test('createSequenceOnPublish: 23505 race → returns no-op', async () => {
  mockResponses = {
    sequences: [
      { data: null, error: null },
      { data: null, error: { code: '23505', message: 'duplicate key' } },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.createSequenceOnPublish(
    { id: 'p-1', meta: { track: 'lender' } },
    { id: 'c-1' },
    { id: 'pr-1' }
  );
  assert.equal(res.created, false);
});

// ── advanceSequence ──────────────────────────────────────────────────────

test('advanceSequence: happy path → inserts new post + step bump in advance flow', async () => {
  mockResponses = {
    sequences: [
      { data: { id: 'seq-1', contact_id: 'c-1', track: 'lender', current_step: 1, status: 'active' }, error: null },
    ],
    contacts: [
      { data: { id: 'c-1', name: 'A', role: 'BDM', email: 'a@x.co', prospect_id: 'pr-1',
                prospect: { id: 'pr-1', type: 'lender', company_name: 'X', website: null, metadata: {} } }, error: null },
    ],
    posts: [
      { data: { id: 'post-2', copy_headline: 'Step 2 subject', copy_body: 'Step 2 body for X.', meta: { sequence_id: 'seq-1', sequence_step: 2 } }, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.advanceSequence('seq-1');
  assert.equal(res.ok, true);
  assert.equal(res.nextStep, 2);
  assert.equal(res.queuedPostId, 'post-2');
  assert.equal(res.completed, false);
  assert.equal(lastInsertedRow.copy_headline, 'Step 2 subject');
  assert.equal(lastInsertedRow.meta.sequence_id, 'seq-1');
  assert.equal(lastInsertedRow.meta.sequence_step, 2);
});

test('advanceSequence: not active → skips and reports', async () => {
  mockResponses = {
    sequences: [
      { data: { id: 'seq-1', contact_id: 'c-1', track: 'lender', current_step: 2, status: 'paused' }, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.advanceSequence('seq-1');
  assert.equal(res.ok, false);
});

test('advanceSequence: at MAX_STEP - 1 advance produces the final step', async () => {
  // current_step=3 → nextStep=4 (which IS MAX_STEP). advanceSequence still
  // queues a post (the +14d final ping); completion happens on send via
  // bumpSequenceOnSendSuccess. Only when current_step is already MAX_STEP
  // does advanceSequence short-circuit to completed.
  mockResponses = {
    sequences: [
      { data: { id: 'seq-1', contact_id: 'c-1', track: 'lender', current_step: 3, status: 'active' }, error: null },
    ],
    contacts: [
      { data: { id: 'c-1', name: 'A', role: 'BDM', email: 'a@x.co', prospect_id: 'pr-1',
                prospect: { id: 'pr-1', type: 'lender', company_name: 'X', website: null, metadata: {} } }, error: null },
    ],
    posts: [
      { data: { id: 'post-4', copy_headline: 'Step 4 subject', copy_body: 'b', meta: {} }, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.advanceSequence('seq-1');
  assert.equal(res.ok, true);
  assert.equal(res.nextStep, 4);
  assert.equal(res.completed, false);
});

test('advanceSequence: when current_step already at MAX_STEP, flips to completed', async () => {
  mockResponses = {
    sequences: [
      { data: { id: 'seq-1', contact_id: 'c-1', track: 'lender', current_step: 4, status: 'active' }, error: null },
      // completeSequence inner update
      { data: null, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.advanceSequence('seq-1');
  assert.equal(res.completed, true);
});

// ── pauseSiblingsForCompany ──────────────────────────────────────────────

test('pauseSiblingsForCompany: pauses all active siblings, returns count', async () => {
  mockResponses = {
    contacts: [
      // contact list for the prospect
      { data: [{ id: 'c-1' }, { id: 'c-2' }, { id: 'c-3' }], error: null },
    ],
    sequences: [
      // sibling sequences
      { data: [{ id: 'seq-1' }, { id: 'seq-2' }], error: null },
      // bulk update
      { data: null, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.pauseSiblingsForCompany('pr-1', 'hostile_pause', 'seq-trigger');
  assert.equal(res.paused, 2);
  assert.deepEqual(res.ids.sort(), ['seq-1', 'seq-2']);
});

test('pauseSiblingsForCompany: zero contacts → zero', async () => {
  mockResponses = {
    contacts: [{ data: [], error: null }],
  };
  const seq = loadSequenceFresh();
  const res = await seq.pauseSiblingsForCompany('pr-1', 'hostile_pause');
  assert.equal(res.paused, 0);
});

test('pauseSiblingsForCompany: rejects unknown ended_reason', async () => {
  const seq = loadSequenceFresh();
  await assert.rejects(
    () => seq.pauseSiblingsForCompany('pr-1', 'NOT_AN_END'),
    /Invalid ended_reason/,
  );
});

// ── bumpSequenceOnSendSuccess ────────────────────────────────────────────

test('bumpSequenceOnSendSuccess: step 4 → flips to completed', async () => {
  mockResponses = {
    sequences: [
      // load
      { data: { id: 'seq-1', track: 'lender', current_step: 3 }, error: null },
      // completeSequence inner update
      { data: null, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.bumpSequenceOnSendSuccess('seq-1', 4);
  assert.equal(res.ok, true);
});

test('bumpSequenceOnSendSuccess: step 2 → updates current_step + next_scheduled_at', async () => {
  mockResponses = {
    sequences: [
      // load
      { data: { id: 'seq-1', track: 'lender', current_step: 1 }, error: null },
      // bump update
      { data: null, error: null },
    ],
  };
  const seq = loadSequenceFresh();
  const res = await seq.bumpSequenceOnSendSuccess('seq-1', 2);
  assert.equal(res.current_step, 2);
  assert.ok(res.next_scheduled_at, 'next_scheduled_at should be set');
  assert.equal(lastUpdatedRow.current_step, 2);
});

test('bumpSequenceOnSendSuccess: rejects invalid step', async () => {
  const seq = loadSequenceFresh();
  await assert.rejects(
    () => seq.bumpSequenceOnSendSuccess('seq-1', 0),
    /invalid step/,
  );
  await assert.rejects(
    () => seq.bumpSequenceOnSendSuccess('seq-1', 5),
    /invalid step/,
  );
});

// ── Terminal helpers validate ended_reason ──────────────────────────────

test('pauseSequence: rejects unknown ended_reason', async () => {
  const seq = loadSequenceFresh();
  await assert.rejects(
    () => seq.pauseSequence('seq-1', 'arbitrary'),
    /Invalid ended_reason/,
  );
});

test('completeSequence: passes for replied_decline', async () => {
  mockResponses = {
    sequences: [{ data: null, error: null }],
  };
  const seq = loadSequenceFresh();
  const res = await seq.completeSequence('seq-1', 'replied_decline');
  assert.equal(res.ok, true);
});

test('optOutSequence: applies ended_reason=unsubscribe', async () => {
  mockResponses = {
    sequences: [{ data: null, error: null }],
  };
  const seq = loadSequenceFresh();
  const res = await seq.optOutSequence('seq-1');
  assert.equal(res.ok, true);
  assert.equal(lastUpdatedRow.ended_reason, 'unsubscribe');
  assert.equal(lastUpdatedRow.status, 'opted_out');
  assert.equal(lastUpdatedRow.next_scheduled_at, null);
});

test('bounceSequence: terminal status=bounced', async () => {
  mockResponses = {
    sequences: [{ data: null, error: null }],
  };
  const seq = loadSequenceFresh();
  const res = await seq.bounceSequence('seq-1');
  assert.equal(res.ok, true);
  assert.equal(lastUpdatedRow.status, 'bounced');
  assert.equal(lastUpdatedRow.ended_reason, 'bounced');
});

test('deferSequence: updates next_scheduled_at, leaves status alone', async () => {
  mockResponses = {
    sequences: [{ data: null, error: null }],
  };
  const seq = loadSequenceFresh();
  const res = await seq.deferSequence('seq-1', 7);
  assert.equal(res.ok, true);
  assert.ok(res.next_scheduled_at);
  // Should NOT set status — only next_scheduled_at
  assert.equal(lastUpdatedRow.status, undefined);
});

test('deferSequence: rejects non-positive days', async () => {
  const seq = loadSequenceFresh();
  await assert.rejects(() => seq.deferSequence('seq-1', 0), /positive/);
  await assert.rejects(() => seq.deferSequence('seq-1', -3), /positive/);
});

// ── FOLLOWUP_INTERVALS shape ────────────────────────────────────────────

test('FOLLOWUP_INTERVALS default is [3, 7, 14]', () => {
  const seq = loadSequenceFresh();
  assert.deepEqual([...seq.FOLLOWUP_INTERVALS], [3, 7, 14]);
});

test('MAX_STEP is 4', () => {
  const seq = loadSequenceFresh();
  assert.equal(seq.MAX_STEP, 4);
});
