// Auction-house importer — uses a tiny ESM fixture file for dynamic
// import(), mocks the Supabase client via require.cache injection.
//
// Asserts:
//   - prospect count matches fixture size
//   - region derivation for an auctionhouse* slug
//   - platform inference (eig / bespoke)
//   - synthetic contact created at info@<domain> with confidence_score=50
//   - platform-hosted house skipped from contact synthesis
//   - house with no catalogue URL skipped from contact synthesis
//   - idempotency (second run inserts zero)

const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

let FIXTURE_PATH;

// Build an ESM fixture houses.js with three rows.
function buildFixture() {
  const content = `
export const HOUSE_DISPLAY_NAMES = {
  pughauctions: 'Pugh Auctions',
  auctionhousenorthwest: 'Auction House North West',
  retiredhouse: 'Retired House',
  eighostedhouse: 'EIG Hosted Little House'
};

export const HOUSE_ROOTS = {
  pughauctions: 'https://www.pugh-auctions.com/lots',
  auctionhousenorthwest: 'https://auctionhouse.co.uk/northwest/current-auction',
  eighostedhouse: 'https://little.eigonlineauctions.com/'
  // retiredhouse intentionally absent — no catalogue_root_url
};
`;
  const p = path.join(os.tmpdir(), `phase-d-houses-${Date.now()}.mjs`);
  fs.writeFileSync(p, content);
  return p;
}

// ── Fake Supabase ────────────────────────────────────────────────────────

let store;
function freshStore() {
  store = { prospects: new Map(), contacts: new Map() };
}
function uuid() { return 'id-' + Math.random().toString(36).slice(2, 12); }

function makeFakeSupabase() {
  return { from: (table) => makeQuery(table) };
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
        return { data: store.prospects.get(key) || null, error: null };
      }
      if (table === 'contacts') {
        const pid = filters.prospect_id;
        const email = filters.__ilike_email;
        const key = `${pid}::${email}`;
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
        const targetMap = table === 'prospects' ? store.prospects : store.contacts;
        let row = null;
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

function loadImporterFresh() {
  const supPath = require.resolve('../../lib/supabase');
  const importerPath = require.resolve('../../lib/sales-brain/import-houses');
  const lendersPath = require.resolve('../../lib/sales-brain/import-lenders');
  delete require.cache[supPath];
  delete require.cache[importerPath];
  delete require.cache[lendersPath];
  require.cache[supPath] = {
    id: supPath, filename: supPath, loaded: true,
    exports: { supabase: makeFakeSupabase() },
  };
  return require('../../lib/sales-brain/import-houses');
}

// ── Tests ────────────────────────────────────────────────────────────────

before(() => {
  FIXTURE_PATH = buildFixture();
});
beforeEach(() => {
  freshStore();
});
after(() => {
  try { fs.unlinkSync(FIXTURE_PATH); } catch { /* ignore */ }
});

test('readHouses loads the ESM fixture via dynamic import', async () => {
  const { readHouses } = loadImporterFresh();
  const h = await readHouses(FIXTURE_PATH);
  assert.equal(Object.keys(h.HOUSE_DISPLAY_NAMES).length, 4);
  assert.equal(h.HOUSE_DISPLAY_NAMES.pughauctions, 'Pugh Auctions');
});

test('importer: upserts all 4 prospects with region + platform metadata', async () => {
  const { importHouses } = loadImporterFresh();
  const result = await importHouses({ housesPath: FIXTURE_PATH });
  assert.equal(store.prospects.size, 4);
  assert.equal(result.prospects.inserted, 4);

  const ahnw = [...store.prospects.values()].find(p => p.metadata.slug === 'auctionhousenorthwest');
  assert.ok(ahnw);
  assert.equal(ahnw.metadata.region, 'North West');
  assert.equal(ahnw.metadata.platform, 'auctionhouse-uk');
  assert.equal(ahnw.metadata.active, true);

  const pugh = [...store.prospects.values()].find(p => p.metadata.slug === 'pughauctions');
  assert.equal(pugh.metadata.region, null);
  assert.equal(pugh.website, 'pugh-auctions.com');

  const retired = [...store.prospects.values()].find(p => p.metadata.slug === 'retiredhouse');
  assert.equal(retired.metadata.active, false);
  assert.equal(retired.metadata.catalogue_root_url, null);
});

test('importer: synthesises info@<domain> contact for Pugh (non-platform)', async () => {
  const { importHouses } = loadImporterFresh();
  const result = await importHouses({ housesPath: FIXTURE_PATH });

  const pughContact = [...store.contacts.values()].find(c => c.email === 'info@pugh-auctions.com');
  assert.ok(pughContact, 'expected info@pugh-auctions.com contact');
  assert.equal(pughContact.role, 'Generic inbox');
  assert.equal(pughContact.confidence_score, 50);
  assert.equal(pughContact.source, 'manual');
  assert.equal(pughContact.name, null);

  // Inserted at least pugh's contact + AHNW's contact (auctionhouse.co.uk is not platform-hosted)
  assert.ok(result.contacts.inserted >= 1);
});

test('importer: skips platform-hosted house (EIG-hosted) from contact synthesis', async () => {
  const { importHouses } = loadImporterFresh();
  const result = await importHouses({ housesPath: FIXTURE_PATH });

  const platformContact = [...store.contacts.values()].find(c =>
    c.email && c.email.includes('eigonlineauctions.com')
  );
  assert.equal(platformContact, undefined, 'platform-hosted email must not be synthesised');

  // Warnings should mention the platform-hosted skip
  assert.ok(result.warnings.some(w => /platform-hosted/.test(w)));
});

test('importer: skips contact synthesis for house with no catalogue URL', async () => {
  const { importHouses } = loadImporterFresh();
  const result = await importHouses({ housesPath: FIXTURE_PATH });

  const retired = [...store.prospects.values()].find(p => p.metadata.slug === 'retiredhouse');
  const retiredContacts = [...store.contacts.values()].filter(c => c.prospect_id === retired.id);
  assert.equal(retiredContacts.length, 0);

  assert.ok(result.warnings.some(w => /Retired House/.test(w) && /no catalogue URL/.test(w)));
});

test('importer: idempotency — second run inserts zero', async () => {
  const { importHouses } = loadImporterFresh();
  const first = await importHouses({ housesPath: FIXTURE_PATH });
  assert.equal(first.prospects.inserted, 4);
  const sizeAfterFirst = store.prospects.size;
  const contactSizeAfterFirst = store.contacts.size;

  const second = await importHouses({ housesPath: FIXTURE_PATH });
  assert.equal(store.prospects.size, sizeAfterFirst, 'prospects unchanged');
  assert.equal(store.contacts.size, contactSizeAfterFirst, 'contacts unchanged');
  assert.equal(second.prospects.inserted, 0);
  assert.equal(second.prospects.updated, 4);
});

test('importer: synthesiseContacts=false skips contact creation', async () => {
  const { importHouses } = loadImporterFresh();
  await importHouses({ housesPath: FIXTURE_PATH, synthesiseContacts: false });
  assert.equal(store.contacts.size, 0);
  assert.equal(store.prospects.size, 4);
});
