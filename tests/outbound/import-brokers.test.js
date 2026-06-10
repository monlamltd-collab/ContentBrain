// Broker importer — CSV fixture + mocked Supabase, no Connect API calls.
//
// Asserts:
//   - bridging-keyword filter keeps matching rows, drops the rest
//   - rich CSV (firm_name + website + permissions) maps cleanly into
//     the prospects shape
//   - bare-FRN CSV defers to fetchFirmByFrn (mocked) per row
//   - FREE-SYNTHETIC info@<domain> contact at confidence_score=50
//   - useHunterTopN=2 ranks top firms by bridging-keyword count

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let RICH_CSV_PATH;
let BARE_CSV_PATH;

before(() => {
  // Rich CSV — 5 firms, mixed bridging keyword strength.
  const rich = [
    'FRN,Firm Name,Status,Website,Permissions,Trading Names,Postcode',
    '111001,Acme Bridging Limited,Authorised,https://acmebridging.co.uk,Advising on regulated mortgage contracts,,EC1A 1AA',
    '111002,Acme Short-Term Bridging Finance Ltd,Authorised,https://acme-stf.co.uk,Advising on regulated mortgage contracts,,EC1A 1AA',
    '111003,Plain Mortgages Ltd,Authorised,https://plain.co.uk,Advising on regulated mortgage contracts,,SW1A 1AA',
    '111004,Specialist Lend Co,Authorised,,Specialist lending,,M1 1AA',
    '111005,Auction Finance Group Limited,Authorised,https://auctionfinance.co.uk,Advising on regulated mortgage contracts,,B1 1AA',
  ].join('\n');
  RICH_CSV_PATH = path.join(os.tmpdir(), `phase-d-brokers-rich-${Date.now()}.csv`);
  fs.writeFileSync(RICH_CSV_PATH, rich);

  const bare = ['FRN', '222001', '222002'].join('\n');
  BARE_CSV_PATH = path.join(os.tmpdir(), `phase-d-brokers-bare-${Date.now()}.csv`);
  fs.writeFileSync(BARE_CSV_PATH, bare);
});

after(() => {
  for (const p of [RICH_CSV_PATH, BARE_CSV_PATH]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
});

// ── Mock Supabase ────────────────────────────────────────────────────────

let store;
function freshStore() { store = { prospects: new Map(), contacts: new Map() }; }
function uuid() { return 'id-' + Math.random().toString(36).slice(2, 12); }

function makeFakeSupabase() { return { from: (t) => makeQuery(t) }; }
function makeQuery(table) {
  let mode = null, filters = {}, payload = null, updatePatch = null;
  const api = {
    select() { return api; },
    insert(row) { mode = 'insert'; payload = row; return api; },
    update(patch) { mode = 'update'; updatePatch = patch; return api; },
    eq(col, val) { filters[col] = val; return api; },
    ilike(col, val) { filters[`__ilike_${col}`] = String(val).toLowerCase(); return api; },
    async maybeSingle() {
      if (table === 'prospects') {
        const key = `${filters.source}::${filters.__ilike_company_name}`;
        return { data: store.prospects.get(key) || null, error: null };
      }
      if (table === 'contacts') {
        const key = `${filters.prospect_id}::${filters.__ilike_email}`;
        return { data: store.contacts.get(key) || null, error: null };
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
        const map = table === 'prospects' ? store.prospects : store.contacts;
        let row = null;
        for (const r of map.values()) {
          if (r.id === id) { Object.assign(r, updatePatch); row = r; break; }
        }
        return { data: row, error: null };
      }
      return { data: null, error: null };
    },
  };
  return api;
}

// Captured Firecrawl scrape calls (reset per loadImporterFresh).
let firecrawlCalls = [];

// Inject mocks via require.cache BEFORE the importer is loaded.
function loadImporterFresh(mocks = {}) {
  const supPath = require.resolve('../../lib/supabase');
  const lendersPath = require.resolve('../../lib/sales-brain/import-lenders');
  const fcaPath = require.resolve('../../lib/sales-brain/fca-fetch');
  const firecrawlPath = require.resolve('../../lib/firecrawl');
  const importerPath = require.resolve('../../lib/sales-brain/import-brokers');
  delete require.cache[supPath];
  delete require.cache[lendersPath];
  delete require.cache[fcaPath];
  delete require.cache[firecrawlPath];
  delete require.cache[importerPath];

  require.cache[supPath] = {
    id: supPath, filename: supPath, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };

  require.cache[fcaPath] = {
    id: fcaPath, filename: fcaPath, loaded: true,
    exports: {
      fetchFirmByFrn: mocks.fetchFirmByFrn || (async () => { throw new Error('fetchFirmByFrn not mocked'); }),
      fetchBulkRegister: mocks.fetchBulkRegister || (async () => { throw new Error('fetchBulkRegister not mocked'); }),
      assertFcaAuth: () => ({ email: 'mock', key: 'mock' }),
    },
  };

  firecrawlCalls = [];
  require.cache[firecrawlPath] = {
    id: firecrawlPath, filename: firecrawlPath, loaded: true,
    exports: {
      isFirecrawlConfigured: mocks.isFirecrawlConfigured || (() => true),
      firecrawlScrape: mocks.firecrawlScrape || (async (url) => {
        firecrawlCalls.push(url);
        return { json: {} };
      }),
    },
  };

  return require('../../lib/sales-brain/import-brokers');
}

// ── Tests ────────────────────────────────────────────────────────────────

beforeEach(() => { freshStore(); });

test('matchBridgingKeywords matches firm name', () => {
  const { matchBridgingKeywords } = loadImporterFresh();
  assert.deepEqual(
    matchBridgingKeywords({ firm_name: 'Acme Bridging Ltd' }),
    { matched: ['bridg'], source: 'firm_name_keyword' }
  );
});

test('matchBridgingKeywords falls back to trading names', () => {
  const { matchBridgingKeywords } = loadImporterFresh();
  const r = matchBridgingKeywords({
    firm_name: 'Acme IFA Ltd',
    trading_names: ['Acme Short-Term Finance'],
  });
  assert.equal(r.source, 'trading_name_keyword');
  assert.ok(r.matched.includes('short-term'));
});

test('matchBridgingKeywords returns null for non-bridging firms', () => {
  const { matchBridgingKeywords } = loadImporterFresh();
  assert.equal(matchBridgingKeywords({ firm_name: 'Plain Mortgages Ltd' }), null);
});

test('readBrokerCsv autodetects rich extract headers', async () => {
  const { readBrokerCsv } = loadImporterFresh();
  const rows = await readBrokerCsv(RICH_CSV_PATH);
  assert.equal(rows.length, 5);
  assert.equal(rows[0].frn, '111001');
  assert.equal(rows[0].firm_name, 'Acme Bridging Limited');
  assert.equal(rows[0].website, 'https://acmebridging.co.uk');
});

test('readBrokerCsv handles bare FRN list', async () => {
  const { readBrokerCsv, readFrnCsv } = loadImporterFresh();
  const rows = await readBrokerCsv(BARE_CSV_PATH);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].frn, '222001');

  const frns = await readFrnCsv(BARE_CSV_PATH);
  assert.deepEqual(frns, ['222001', '222002']);
});

test('importer: filters out non-bridging firms (Plain Mortgages dropped)', async () => {
  const { importBrokers } = loadImporterFresh();
  await importBrokers({ sourceCsvPath: RICH_CSV_PATH });
  // 4 of 5 rows match (Plain Mortgages drops out)
  assert.equal(store.prospects.size, 4);
  const names = [...store.prospects.values()].map(p => p.company_name);
  assert.ok(!names.includes('Plain Mortgages Ltd'),
    'Plain Mortgages must NOT be imported');
});

test('importer: prospects carry FRN + bridging_evidence + permissions', async () => {
  const { importBrokers } = loadImporterFresh();
  await importBrokers({ sourceCsvPath: RICH_CSV_PATH });
  const acme = [...store.prospects.values()].find(p => p.company_name === 'Acme Bridging Limited');
  assert.ok(acme);
  assert.equal(acme.metadata.frn, '111001');
  assert.equal(acme.metadata.bridging_evidence.source, 'firm_name_keyword');
  assert.ok(acme.metadata.bridging_evidence.matched.includes('bridg'));
  assert.equal(acme.website, 'acmebridging.co.uk');
  assert.ok(Array.isArray(acme.metadata.permission_codes));
});

test('importer: synthesises info@<domain> contact at confidence_score=50', async () => {
  const { importBrokers } = loadImporterFresh();
  const result = await importBrokers({ sourceCsvPath: RICH_CSV_PATH });
  const contact = [...store.contacts.values()].find(c => c.email === 'info@acmebridging.co.uk');
  assert.ok(contact);
  assert.equal(contact.role, 'Generic inbox');
  assert.equal(contact.confidence_score, 50);
  assert.equal(contact.source, 'manual');
  assert.equal(contact.name, null);

  // Specialist Lend Co has no website — should have no synth contact.
  const specialist = [...store.prospects.values()].find(p => p.company_name === 'Specialist Lend Co');
  const specialistContacts = [...store.contacts.values()].filter(c => c.prospect_id === specialist.id);
  assert.equal(specialistContacts.length, 0,
    'firm with no website should yield no synth contact');
  assert.equal(specialist.metadata.website_search_failed, true);
  assert.ok(result.warnings.some(w => /Specialist Lend Co/.test(w)));
});

test('importer: useHunterTopN=2 ranks by bridging-keyword strength', async () => {
  // Mock enrich.enrichDomain so we capture which firms get called.
  const enrichPath = require.resolve('../../lib/enrich');
  delete require.cache[enrichPath];
  const calledFor = [];
  require.cache[enrichPath] = {
    id: enrichPath, filename: enrichPath, loaded: true,
    exports: {
      enrichDomain: async (domain) => {
        calledFor.push(domain);
        return { contacts: [] };
      },
    },
  };

  const { importBrokers } = loadImporterFresh();
  await importBrokers({ sourceCsvPath: RICH_CSV_PATH, useHunterTopN: 2 });

  // 'Acme Short-Term Bridging Finance Ltd' has 2 bridging keywords (bridg + short-term)
  // 'Acme Bridging Limited' has 1
  // 'Auction Finance Group Limited' has 1 (auction finance)
  // 'Specialist Lend Co' has 1 (specialist lend) BUT no website → no Hunter call
  // Top-2 by keyword count: Short-Term (2 kw) then any of the 1-kw firms with a website.
  assert.ok(calledFor.length <= 2, `Hunter should be called <=2 times, got ${calledFor.length}`);
  assert.ok(calledFor.includes('acme-stf.co.uk'),
    `top-ranked firm (Short-Term, 2 keywords) should be enriched; calls: ${calledFor.join(',')}`);
});

test('importer: bare-FRN CSV calls fetchFirmByFrn per row', async () => {
  const seenFrns = [];
  const { importBrokers } = loadImporterFresh({
    fetchFirmByFrn: async (frn) => {
      seenFrns.push(String(frn));
      return {
        frn: String(frn),
        firm_name: `Test Bridging ${frn}`,
        status: 'Authorised',
        permissions: ['Advising on regulated mortgage contracts'],
        trading_names: [],
        principal_office_address: { postcode: 'EC1' },
        website: null,
      };
    },
  });

  await importBrokers({ sourceCsvPath: BARE_CSV_PATH });
  assert.deepEqual(seenFrns.sort(), ['222001', '222002']);
  assert.equal(store.prospects.size, 2);
});

test('importer: idempotent — second run inserts zero', async () => {
  const { importBrokers } = loadImporterFresh();
  const first = await importBrokers({ sourceCsvPath: RICH_CSV_PATH });
  const size = store.prospects.size;
  const second = await importBrokers({ sourceCsvPath: RICH_CSV_PATH });
  assert.equal(store.prospects.size, size);
  assert.equal(second.prospects.inserted, 0);
  assert.equal(first.prospects.inserted, size);
});

test('importer: errors clearly when no CSV and no FCA env', async () => {
  const prevEmail = process.env.FCA_AUTH_EMAIL;
  delete process.env.FCA_AUTH_EMAIL;
  try {
    const { importBrokers } = loadImporterFresh();
    await assert.rejects(
      () => importBrokers({}),
      /Download the FCA bulk extract|FCA_AUTH_EMAIL|register\.fca\.org\.uk/
    );
  } finally {
    if (prevEmail) process.env.FCA_AUTH_EMAIL = prevEmail;
  }
});

// ── Firecrawl enrichment (Phase E) ───────────────────────────────────────

test('firecrawl: named-person + generic contacts inserted with right confidence/source', async () => {
  const { importBrokers } = loadImporterFresh({
    firecrawlScrape: async (url) => {
      firecrawlCalls.push(url);
      return {
        json: {
          people: [{ name: 'Jane Broker', role: 'Director', email: 'Jane@AcmeBridging.co.uk' }],
          emails: ['hello@acmebridging.co.uk'],
        },
      };
    },
  });

  await importBrokers({ sourceCsvPath: RICH_CSV_PATH, useFirecrawl: true, firecrawlTopN: 1 });

  const contacts = [...store.contacts.values()].filter(c => c.source === 'firecrawl');
  assert.equal(contacts.length, 2);
  const jane = contacts.find(c => c.email === 'jane@acmebridging.co.uk');
  assert.ok(jane, 'named-person contact inserted, email lowercased');
  assert.equal(jane.confidence_score, 70);
  assert.equal(jane.name, 'Jane Broker');
  const generic = contacts.find(c => c.email === 'hello@acmebridging.co.uk');
  assert.equal(generic.confidence_score, 60);
  assert.equal(generic.role, 'Generic inbox');
});

test('firecrawl: empty extraction → info@ synthetic fallback still inserted', async () => {
  const { importBrokers } = loadImporterFresh(); // default mock returns { json: {} }
  await importBrokers({ sourceCsvPath: RICH_CSV_PATH, useFirecrawl: true, firecrawlTopN: 5 });

  // Synthetic info@ contacts unchanged (source 'manual', confidence 50)
  const synth = [...store.contacts.values()].filter(c => c.source === 'manual');
  assert.ok(synth.length >= 1);
  assert.ok(synth.every(c => c.confidence_score === 50));
});

test('firecrawl: firecrawlTopN caps the number of scrapes', async () => {
  const { importBrokers } = loadImporterFresh();
  await importBrokers({ sourceCsvPath: RICH_CSV_PATH, useFirecrawl: true, firecrawlTopN: 2 });
  // 4 firms match the keyword filter but only 3 have websites; cap=2 means
  // at most 2 scrape calls regardless.
  assert.ok(firecrawlCalls.length <= 2, `expected <=2 scrapes, got ${firecrawlCalls.length}`);
});

test('firecrawl: key missing → warning, zero scrapes, import still completes', async () => {
  const { importBrokers } = loadImporterFresh({
    isFirecrawlConfigured: () => false,
  });
  const result = await importBrokers({ sourceCsvPath: RICH_CSV_PATH, useFirecrawl: true });
  assert.equal(firecrawlCalls.length, 0);
  assert.ok(result.warnings.some(w => /FIRECRAWL_API_KEY missing/.test(w)));
  assert.ok(store.prospects.size > 0, 'prospects still imported');
});

test('firecrawl: scrape failure for one firm warns and continues', async () => {
  let call = 0;
  const { importBrokers } = loadImporterFresh({
    firecrawlScrape: async (url) => {
      firecrawlCalls.push(url);
      call++;
      if (call === 1) throw new Error('site timed out');
      return { json: { emails: ['team@acme-stf.co.uk'] } };
    },
  });
  const result = await importBrokers({ sourceCsvPath: RICH_CSV_PATH, useFirecrawl: true, firecrawlTopN: 3 });
  assert.ok(result.warnings.some(w => /Firecrawl enrichment failed/.test(w)));
  const fc = [...store.contacts.values()].filter(c => c.source === 'firecrawl');
  assert.ok(fc.length >= 1, 'later firms still enriched after one failure');
});
