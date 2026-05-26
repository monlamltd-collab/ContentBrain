// Phase E — CSV importer tests.
//
// Asserts the streaming parser + per-row validate/lookup/insert pipeline.
// Pure unit tests: validateRow + parseCsvLine. Integration test:
// importOutcomes with a fixture CSV against an in-memory fake Supabase.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const SUP_PATH = require.resolve('../../lib/supabase');
const FUNDED_PATH = require.resolve('../../lib/closed-loop/funded-deals');

// ── Test state ───────────────────────────────────────────────────────────

let fakeProspects;  // [{id, company_name}]
let fakeContacts;   // [{id, email}]
let fakeOutcomes;   // [{prospect_id, closed_at, deal_amount, ...}]
let inserts;        // captured insertOutcome calls

function makeFakeSupabase() {
  return {
    from(table) {
      const state = { table, filters: [], single: false };
      const api = {
        select(_sel) { return api; },
        eq(col, val) { state.filters.push({ op: 'eq', col, val }); return api; },
        in(col, val) { state.filters.push({ op: 'in', col, val }); return api; },
        is(col, val) { state.filters.push({ op: 'is', col, val }); return api; },
        ilike(col, val) { state.filters.push({ op: 'ilike', col, val }); return api; },
        not(col, _op, _val) { state.filters.push({ op: 'not_null', col }); return api; },
        order() { return api; },
        limit() { return api; },
        async maybeSingle() {
          const rows = runFilter();
          return { data: rows[0] || null, error: null };
        },
        async single() {
          const rows = runFilter();
          if (rows.length === 0) return { data: null, error: { message: 'no rows' } };
          return { data: rows[0], error: null };
        },
        insert(row) {
          if (state.table === 'outbound_outcomes') inserts.push(row);
          return {
            select() {
              return {
                async single() {
                  return { data: { id: `outcome-${inserts.length}` }, error: null };
                },
              };
            },
          };
        },
      };

      function runFilter() {
        let rows = [];
        if (table === 'prospects') rows = fakeProspects.slice();
        if (table === 'contacts') rows = fakeContacts.slice();
        if (table === 'outbound_outcomes') rows = fakeOutcomes.slice();
        for (const f of state.filters) {
          if (f.op === 'eq') rows = rows.filter(r => r[f.col] === f.val);
          if (f.op === 'in') rows = rows.filter(r => f.val.includes(r[f.col]));
          if (f.op === 'is' && f.val === null) rows = rows.filter(r => r[f.col] === null || r[f.col] === undefined);
          if (f.op === 'ilike') {
            // Importer uses .ilike(col, value) for exact case-insensitive match.
            rows = rows.filter(r => typeof r[f.col] === 'string' && r[f.col].toLowerCase() === String(f.val).toLowerCase());
          }
        }
        return rows;
      }
      return api;
    },
  };
}

function resetMocks() {
  fakeProspects = [];
  fakeContacts = [];
  fakeOutcomes = [];
  inserts = [];
  delete require.cache[SUP_PATH];
  delete require.cache[FUNDED_PATH];
  require.cache[SUP_PATH] = {
    id: SUP_PATH, filename: SUP_PATH, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
}

beforeEach(() => { resetMocks(); });

// ── parseCsvLine ──────────────────────────────────────────────────────────

test('parseCsvLine: handles simple comma-separated values', async () => {
  const { parseCsvLine } = await import('../../scripts/import-outbound-outcomes.mjs');
  assert.deepEqual(parseCsvLine('a,b,c'), ['a', 'b', 'c']);
});

test('parseCsvLine: handles quoted fields with embedded commas', async () => {
  const { parseCsvLine } = await import('../../scripts/import-outbound-outcomes.mjs');
  assert.deepEqual(parseCsvLine('"Acme, Ltd",bdm@acme.com,450000'), ['Acme, Ltd', 'bdm@acme.com', '450000']);
});

test('parseCsvLine: handles escaped quotes via doubled ""', async () => {
  const { parseCsvLine } = await import('../../scripts/import-outbound-outcomes.mjs');
  assert.deepEqual(parseCsvLine('"He said ""hi""",second'), ['He said "hi"', 'second']);
});

test('parseCsvLine: empty cells are preserved', async () => {
  const { parseCsvLine } = await import('../../scripts/import-outbound-outcomes.mjs');
  assert.deepEqual(parseCsvLine('a,,c'), ['a', '', 'c']);
});

// ── validateRow ───────────────────────────────────────────────────────────

test('validateRow: rejects empty prospect_company', async () => {
  const { validateRow } = await import('../../scripts/import-outbound-outcomes.mjs');
  assert.throws(
    () => validateRow({ prospect_company: '', claude_fact: 'ok', closed_at: '2026-01-01' }, 2),
    /prospect_company is required/,
  );
});

test('validateRow: rejects empty claude_fact', async () => {
  const { validateRow } = await import('../../scripts/import-outbound-outcomes.mjs');
  assert.throws(
    () => validateRow({ prospect_company: 'Acme', claude_fact: '   ', closed_at: '2026-01-01' }, 2),
    /claude_fact is required/,
  );
});

test('validateRow: rejects unparseable closed_at', async () => {
  const { validateRow } = await import('../../scripts/import-outbound-outcomes.mjs');
  assert.throws(
    () => validateRow({ prospect_company: 'Acme', claude_fact: 'ok', closed_at: 'not-a-date' }, 2),
    /closed_at .* is not a valid date/,
  );
});

test('validateRow: rejects non-numeric deal_amount', async () => {
  const { validateRow } = await import('../../scripts/import-outbound-outcomes.mjs');
  assert.throws(
    () => validateRow({ prospect_company: 'Acme', claude_fact: 'ok', closed_at: '2026-01-01', deal_amount: 'abc' }, 2),
    /deal_amount .* is not numeric/,
  );
});

test('validateRow: accepts £/comma-formatted deal_amount', async () => {
  const { validateRow } = await import('../../scripts/import-outbound-outcomes.mjs');
  const r = validateRow({ prospect_company: 'Acme', claude_fact: 'ok', closed_at: '2026-01-01', deal_amount: '£450,000' }, 2);
  assert.equal(r.deal_amount, 450000);
});

test('validateRow: normalises empty strings to null on optional fields', async () => {
  const { validateRow } = await import('../../scripts/import-outbound-outcomes.mjs');
  const r = validateRow({
    prospect_company: 'Acme', claude_fact: 'ok',
    closed_at: '2026-01-01', deal_amount: '',
    deal_type: '', property_location: '', contact_email: '',
    days_to_close: '', raw_notes: '',
  }, 2);
  assert.equal(r.deal_amount, null);
  assert.equal(r.deal_type, null);
  assert.equal(r.property_location, null);
  assert.equal(r.contact_email, null);
  assert.equal(r.days_to_close, null);
  assert.equal(r.raw_notes, null);
});

// ── importOutcomes integration ────────────────────────────────────────────

function writeTempCsv(content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase-e-importer-'));
  const fp = path.join(dir, 'test.csv');
  fs.writeFileSync(fp, content, 'utf8');
  return fp;
}

test('importOutcomes: matches prospects and inserts rows', async () => {
  fakeProspects = [
    { id: 'p-acme', company_name: 'Acme Bridging Ltd' },
    { id: 'p-pugh', company_name: 'Pugh Auctions' },
  ];
  const csv = [
    'prospect_company,deal_amount,deal_type,closed_at,claude_fact',
    '"Acme Bridging Ltd",450000,auction-purchase,2026-04-12,"BridgeMatch closed £450k for Acme."',
    '"Pugh Auctions",,traffic-driver,2026-05-01,"AuctionBrain drove 200 clicks to Pugh."',
  ].join('\n');
  const fp = writeTempCsv(csv);

  const { importOutcomes } = await import('../../scripts/import-outbound-outcomes.mjs');
  const stats = await importOutcomes(fp);

  assert.equal(stats.rows_read, 2);
  assert.equal(stats.prospects_matched, 2);
  assert.equal(stats.inserted, 2);
  assert.equal(stats.skipped.no_prospect, 0);
  assert.equal(stats.skipped.validation, 0);
  assert.equal(stats.skipped.duplicate, 0);
  assert.equal(inserts.length, 2);
  assert.equal(inserts[0].prospect_id, 'p-acme');
  assert.equal(inserts[0].deal_amount, 450000);
  assert.equal(inserts[0].source, 'manual-csv');
  assert.equal(inserts[1].prospect_id, 'p-pugh');
  assert.equal(inserts[1].deal_amount, null);
});

test('importOutcomes: skips rows with no matching prospect', async () => {
  fakeProspects = [{ id: 'p-acme', company_name: 'Acme Bridging Ltd' }];
  const csv = [
    'prospect_company,deal_amount,deal_type,closed_at,claude_fact',
    '"Acme Bridging Ltd",450000,auction-purchase,2026-04-12,"closed £450k"',
    '"Mystery Co",100000,bridge,2026-04-12,"unknown fact"',
  ].join('\n');
  const fp = writeTempCsv(csv);

  const { importOutcomes } = await import('../../scripts/import-outbound-outcomes.mjs');
  const stats = await importOutcomes(fp);

  assert.equal(stats.rows_read, 2);
  assert.equal(stats.prospects_matched, 1);
  assert.equal(stats.inserted, 1);
  assert.equal(stats.skipped.no_prospect, 1);
});

test('importOutcomes: skips invalid rows', async () => {
  fakeProspects = [{ id: 'p-acme', company_name: 'Acme' }];
  const csv = [
    'prospect_company,deal_amount,deal_type,closed_at,claude_fact',
    'Acme,not-a-number,bridge,2026-04-12,"ok"',
    '"",100,bridge,2026-04-12,"missing company"',
    'Acme,200,bridge,not-a-date,"bad date"',
  ].join('\n');
  const fp = writeTempCsv(csv);

  const { importOutcomes } = await import('../../scripts/import-outbound-outcomes.mjs');
  const stats = await importOutcomes(fp);

  assert.equal(stats.rows_read, 3);
  assert.equal(stats.skipped.validation, 3);
  assert.equal(stats.inserted, 0);
});

test('importOutcomes: dedupes against existing (prospect_id, closed_at, deal_amount)', async () => {
  fakeProspects = [{ id: 'p-acme', company_name: 'Acme' }];
  fakeOutcomes = [{
    id: 'o-existing', prospect_id: 'p-acme',
    closed_at: '2026-04-12T00:00:00.000Z', deal_amount: 450000,
  }];
  const csv = [
    'prospect_company,deal_amount,deal_type,closed_at,claude_fact',
    'Acme,450000,bridge,2026-04-12,"dup"',
    'Acme,500000,bridge,2026-04-12,"new"',
  ].join('\n');
  const fp = writeTempCsv(csv);

  const { importOutcomes } = await import('../../scripts/import-outbound-outcomes.mjs');
  const stats = await importOutcomes(fp);

  assert.equal(stats.rows_read, 2);
  assert.equal(stats.skipped.duplicate, 1);
  assert.equal(stats.inserted, 1);
});

test('importOutcomes: throws on missing required header column', async () => {
  // Missing 'claude_fact' column → fatal at header parse.
  const csv = [
    'prospect_company,deal_amount,deal_type,closed_at',
    'Acme,1000,bridge,2026-04-12',
  ].join('\n');
  const fp = writeTempCsv(csv);

  const { importOutcomes } = await import('../../scripts/import-outbound-outcomes.mjs');
  await assert.rejects(
    () => importOutcomes(fp),
    /header missing required columns/,
  );
});

test('importOutcomes: throws on missing CSV file', async () => {
  const { importOutcomes } = await import('../../scripts/import-outbound-outcomes.mjs');
  await assert.rejects(
    () => importOutcomes('/nonexistent/path/to.csv'),
    /CSV not found/,
  );
});
