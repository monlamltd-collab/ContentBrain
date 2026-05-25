// Lender importer — fixture sql.js DB + mocked Supabase. Asserts:
//   - email normalisation (backtick prefix stripped, lowercased)
//   - phone-with-letters stashed under metadata.enquiries_phone_raw
//   - BDM vs enquiries dedup (skip enquiries when email matches BDM)
//   - idempotency: running the importer twice yields same row count

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const initSqlJs = require('sql.js');

// ── Build a fixture lenders.db on disk ───────────────────────────────────

let FIXTURE_DB_PATH;

async function buildFixtureDb() {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  // Bare-minimum lenders schema (only the columns the importer reads).
  db.run(`CREATE TABLE lenders (
    name TEXT,
    last_updated TEXT,
    funding_model TEXT,
    enquiries_email TEXT,
    enquiries_phone TEXT,
    sw_bdm_name TEXT,
    sw_bdm_email TEXT,
    sw_bdm_mobile TEXT,
    criteria_update_contact TEXT,
    _source TEXT
  )`);

  // Row 1 — ASG Finance: stray backtick prefix on BDM email
  db.run(`INSERT INTO lenders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    'ASG Finance',
    '2026-01-16',
    'Bank Funding/institutional funds',
    'enquiries@asgfinance.co.uk',
    '020 1234 5678',
    'Chris Buckley',
    '`chris.buckley@asgfinance.co.uk', // backtick prefix
    '07879 855569',
    'Same as above',
    'excel',
  ]);

  // Row 2 — NBSP and "M: " prefix on phone; BDM == enquiries (dedup case)
  db.run(`INSERT INTO lenders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    'Alternative Bridging Corporation',
    '2026-02-01',
    'HNW',
    'contact@altbridging.co.uk',
    '07763 206 238', // NBSP in phone
    'Pat Wilson',
    'contact@altbridging.co.uk', // SAME as enquiries — Contact B should be skipped
    'M: 07879 855569',
    'Pat Wilson - pat@altbridging.co.uk',
    'excel',
  ]);

  // Row 3 — Ascot Bridging: enquiries_phone column actually holds an email
  db.run(`INSERT INTO lenders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    'Ascot Bridging',
    '2026-03-04',
    'Bank Funding',
    'enquiries@ascotbridgingfinance.co.uk',
    'enquiries@ascotbridgingfinance.co.uk', // email-in-phone-column
    'Helen Ascot',
    'helen.ascot@ascotbridgingfinance.co.uk',
    '07716638303',
    null,
    'excel',
  ]);

  // Row 4 — Row filtered out by _source != 'excel'
  db.run(`INSERT INTO lenders VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    'Should Not Import',
    '2026-04-01',
    null, null, null, null, null, null, null,
    'manual',
  ]);

  const buf = Buffer.from(db.export());
  db.close();

  FIXTURE_DB_PATH = path.join(os.tmpdir(), `phase-b-fixture-${Date.now()}.db`);
  fs.writeFileSync(FIXTURE_DB_PATH, buf);
}

// ── Fake Supabase backing store ──────────────────────────────────────────
// In-memory: lookup by (table, ...) just like the real client's chained API.

let store; // { prospects: Map<key, row>, contacts: Map<key, row> }

function freshStore() {
  store = { prospects: new Map(), contacts: new Map() };
}

function uuid() {
  // Cheap monotonic id — no real uuid needed for tests
  return 'id-' + Math.random().toString(36).slice(2, 12);
}

function makeFakeSupabase() {
  return {
    from(table) {
      return makeQuery(table);
    },
  };
}

function makeQuery(table) {
  let mode = null;
  let filters = {};
  let payload = null;
  let updatePatch = null;

  const api = {
    select() { return api; },
    insert(row) { mode = 'insert'; payload = row; return api; },
    update(patch) { mode = 'update'; updatePatch = patch; return api; },
    eq(col, val) { filters[col] = val; return api; },
    ilike(col, val) { filters[`__ilike_${col}`] = String(val).toLowerCase(); return api; },
    async maybeSingle() {
      if (table === 'prospects') {
        const source = filters.source;
        const name = filters.__ilike_company_name;
        const key = `${source}::${name}`;
        const row = store.prospects.get(key) || null;
        return { data: row, error: null };
      }
      if (table === 'contacts') {
        const pid = filters.prospect_id;
        const email = filters.__ilike_email;
        const key = `${pid}::${email}`;
        const row = store.contacts.get(key) || null;
        return { data: row, error: null };
      }
      return { data: null, error: null };
    },
    async single() {
      if (mode === 'insert') {
        const id = uuid();
        const row = { id, ...payload };
        if (table === 'prospects') {
          const key = `${row.source}::${row.company_name.toLowerCase()}`;
          store.prospects.set(key, row);
        } else if (table === 'contacts') {
          const key = `${row.prospect_id}::${row.email.toLowerCase()}`;
          store.contacts.set(key, row);
        }
        return { data: { id }, error: null };
      }
      if (mode === 'update') {
        const id = filters.id;
        let row = null;
        const targetMap = table === 'prospects' ? store.prospects : store.contacts;
        for (const r of targetMap.values()) {
          if (r.id === id) { Object.assign(r, updatePatch); row = r; break; }
        }
        return { data: row, error: null };
      }
      return { data: null, error: null };
    },
  };
  return api;
}

// ── Mock harness loader ──────────────────────────────────────────────────

function loadImporterFresh() {
  const supPath = require.resolve('../../lib/supabase');
  const importerPath = require.resolve('../../lib/sales-brain/import-lenders');
  delete require.cache[supPath];
  delete require.cache[importerPath];

  require.cache[supPath] = {
    id: supPath,
    filename: supPath,
    loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };

  return require('../../lib/sales-brain/import-lenders');
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  freshStore();
  if (!FIXTURE_DB_PATH || !fs.existsSync(FIXTURE_DB_PATH)) {
    await buildFixtureDb();
  }
});

test('normaliseEmail strips backtick prefix, NBSP, and lowercases', () => {
  const { normaliseEmail } = loadImporterFresh();
  assert.equal(normaliseEmail('`chris.buckley@asgfinance.co.uk'), 'chris.buckley@asgfinance.co.uk');
  assert.equal(normaliseEmail('Foo@Bar.co'), 'foo@bar.co');
  assert.equal(normaliseEmail('   contact@example.com  '), 'contact@example.com');
  assert.equal(normaliseEmail(''), null);
  assert.equal(normaliseEmail(null), null);
  assert.equal(normaliseEmail(undefined), null);
});

test('normalisePhone strips "M: " prefix, replaces NBSP, rejects letters', () => {
  const { normalisePhone } = loadImporterFresh();
  assert.equal(normalisePhone('M: 07879 855569'), '07879 855569');
  assert.equal(normalisePhone('m: 07879 855569'), '07879 855569');
  assert.equal(normalisePhone('07763 206 238'), '07763 206 238');
  assert.equal(normalisePhone('enquiries@ascot.co.uk'), null, 'letters present should reject');
  assert.equal(normalisePhone(''), null);
  assert.equal(normalisePhone(null), null);
});

test('importer: imports the fixture and produces expected counts', async () => {
  const { importLenders } = loadImporterFresh();
  const result = await importLenders({ dbPath: FIXTURE_DB_PATH });

  // 3 prospects (excel-filtered, 1 'manual' row dropped)
  assert.equal(store.prospects.size, 3);
  assert.equal(result.prospects.inserted, 3);

  // Contacts: ASG (BDM + enquiries), Alternative (BDM only — enquiries deduped),
  // Ascot (BDM + enquiries) = 5 contacts total.
  assert.equal(store.contacts.size, 5);
  // BDM count = 3 (all 3 fixture rows have a BDM email), enquiries = 2 (deduped on row 2)
  // Inserted total should be 5.
  assert.equal(result.contacts.inserted, 5);
});

test('importer: email normalisation persisted (backtick prefix stripped on store)', async () => {
  const { importLenders } = loadImporterFresh();
  await importLenders({ dbPath: FIXTURE_DB_PATH });

  // ASG's BDM should now be stored as the cleaned email
  const stored = [...store.contacts.values()].map(c => c.email);
  assert.ok(stored.includes('chris.buckley@asgfinance.co.uk'),
    `expected clean BDM email; got: ${stored.join(', ')}`);
  assert.ok(!stored.some(e => e.startsWith('`')),
    'no email should retain a backtick prefix');
});

test('importer: BDM == enquiries → enquiries skipped (Alternative Bridging dedup case)', async () => {
  const { importLenders } = loadImporterFresh();
  const result = await importLenders({ dbPath: FIXTURE_DB_PATH });

  // Find Alt Bridging's prospect id
  const alt = [...store.prospects.values()].find(p => p.company_name === 'Alternative Bridging Corporation');
  assert.ok(alt, 'Alternative Bridging Corporation should have been imported');

  const altContacts = [...store.contacts.values()].filter(c => c.prospect_id === alt.id);
  assert.equal(altContacts.length, 1, 'expected only BDM contact; enquiries should be deduped');
  assert.equal(altContacts[0].role, 'BDM');

  // Dedup increments contacts.skipped — verify it shows up in result counts
  assert.ok(result.contacts.skipped >= 1);
});

test('importer: phone-with-email stashed under metadata.enquiries_phone_raw (Ascot)', async () => {
  const { importLenders } = loadImporterFresh();
  const result = await importLenders({ dbPath: FIXTURE_DB_PATH });

  const ascot = [...store.prospects.values()].find(p => p.company_name === 'Ascot Bridging');
  assert.ok(ascot, 'Ascot Bridging should have been imported');
  assert.equal(ascot.metadata.enquiries_phone_raw,
    'enquiries@ascotbridgingfinance.co.uk',
    'raw email-in-phone value should be stashed on metadata');

  // Warnings include a per-row note
  assert.ok(result.warnings.some(w => /Ascot Bridging/.test(w) && /enquiries_phone/.test(w)));
});

test('importer: confidence scores set correctly (BDM=80, enquiries=60)', async () => {
  const { importLenders } = loadImporterFresh();
  await importLenders({ dbPath: FIXTURE_DB_PATH });

  const all = [...store.contacts.values()];
  const bdms = all.filter(c => c.role === 'BDM');
  const enquiries = all.filter(c => c.role === 'Enquiries inbox');
  assert.ok(bdms.every(c => c.confidence_score === 80), 'all BDM contacts must have score 80');
  assert.ok(enquiries.every(c => c.confidence_score === 60), 'all enquiries contacts must have score 60');
});

test('importer: enquiries contacts have NULL name (never guess from criteria_update_contact)', async () => {
  const { importLenders } = loadImporterFresh();
  await importLenders({ dbPath: FIXTURE_DB_PATH });

  const enquiries = [...store.contacts.values()].filter(c => c.role === 'Enquiries inbox');
  assert.ok(enquiries.length > 0, 'fixture should produce at least one enquiries contact');
  assert.ok(enquiries.every(c => c.name === null),
    'enquiries contacts must NOT have a name guessed from criteria_update_contact');
});

test('importer: idempotency — running twice produces same row count', async () => {
  const { importLenders } = loadImporterFresh();
  const first = await importLenders({ dbPath: FIXTURE_DB_PATH });
  assert.equal(store.prospects.size, 3);
  assert.equal(store.contacts.size, 5);
  assert.equal(first.prospects.inserted, 3);

  const second = await importLenders({ dbPath: FIXTURE_DB_PATH });
  // Sizes unchanged, no new inserts — updates only
  assert.equal(store.prospects.size, 3, 'prospects should not duplicate on re-import');
  assert.equal(store.contacts.size, 5, 'contacts should not duplicate on re-import');
  assert.equal(second.prospects.inserted, 0, 'second run should insert zero prospects');
  assert.equal(second.prospects.updated, 3, 'second run should update all three prospects');
});

test('importer: only _source = excel rows are imported (manual row dropped)', async () => {
  const { importLenders } = loadImporterFresh();
  await importLenders({ dbPath: FIXTURE_DB_PATH });
  const names = [...store.prospects.values()].map(p => p.company_name);
  assert.ok(!names.includes('Should Not Import'),
    'rows with _source != excel must be filtered out');
});
