// FCA fetch — mocked global fetch + env var injection.
//
// Asserts:
//   - missing FCA_AUTH_EMAIL / FCA_AUTH_KEY throws with registration URL
//   - auth headers (X-Auth-Email, X-Auth-Key) attached to each request
//   - fetchFirmByFrn merges Firm + Names + Permissions + Address surfaces
//   - non-2xx response throws with FRN + surface name in the message

const { test, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const originalFetch = global.fetch;

function loadFcaFresh() {
  const p = require.resolve('../../lib/sales-brain/fca-fetch');
  delete require.cache[p];
  return require('../../lib/sales-brain/fca-fetch');
}

let savedEmail, savedKey;
before(() => {
  savedEmail = process.env.FCA_AUTH_EMAIL;
  savedKey = process.env.FCA_AUTH_KEY;
});
after(() => {
  if (savedEmail) process.env.FCA_AUTH_EMAIL = savedEmail;
  else delete process.env.FCA_AUTH_EMAIL;
  if (savedKey) process.env.FCA_AUTH_KEY = savedKey;
  else delete process.env.FCA_AUTH_KEY;
  global.fetch = originalFetch;
});

afterEach(() => {
  global.fetch = originalFetch;
});

test('fetchFirmByFrn throws when FCA_AUTH_EMAIL is missing', async () => {
  delete process.env.FCA_AUTH_EMAIL;
  delete process.env.FCA_AUTH_KEY;
  const { fetchFirmByFrn } = loadFcaFresh();
  await assert.rejects(
    () => fetchFirmByFrn('122702'),
    /FCA_AUTH_EMAIL.*register\.fca\.org\.uk\/Re\//s
  );
});

test('fetchBulkRegister throws when FCA_AUTH_EMAIL is missing', async () => {
  delete process.env.FCA_AUTH_EMAIL;
  delete process.env.FCA_AUTH_KEY;
  const { fetchBulkRegister } = loadFcaFresh();
  await assert.rejects(
    () => fetchBulkRegister({ url: 'https://example.com/x' }),
    /FCA_AUTH_EMAIL.*register\.fca\.org\.uk\/Re\//s
  );
});

test('fetchBulkRegister throws when no URL is configured', async () => {
  process.env.FCA_AUTH_EMAIL = 'a@b.co';
  process.env.FCA_AUTH_KEY = 'k';
  delete process.env.FCA_BULK_EXTRACT_URL;
  const { fetchBulkRegister } = loadFcaFresh();
  await assert.rejects(
    () => fetchBulkRegister({}),
    /FCA bulk-extract URL is not set/
  );
});

test('fetchFirmByFrn attaches auth headers and merges surfaces', async () => {
  process.env.FCA_AUTH_EMAIL = 'a@b.co';
  process.env.FCA_AUTH_KEY = 'KEY-123';

  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    const u = String(url);
    let body;
    if (u.endsWith('/Firm/122702')) {
      body = {
        Status: 'FSR-API-04-01-00',
        Data: [{ Organisation_Name: 'Acme Bridging Ltd', Status: 'Authorised' }],
      };
    } else if (u.endsWith('/Names')) {
      body = {
        Status: 'FSR-API-04-01-00',
        Data: [{ Current_Trading_Name: 'Acme Short-Term Finance' }],
      };
    } else if (u.endsWith('/Permissions')) {
      body = {
        Status: 'FSR-API-04-01-00',
        Data: [
          { Permission: 'Advising on regulated mortgage contracts' },
          { Permission: 'Arranging deals in mortgages' },
        ],
      };
    } else if (u.endsWith('/Address')) {
      body = {
        Status: 'FSR-API-04-01-00',
        Data: [{
          Address_Line_1: '1 Test Street',
          Town: 'London',
          Postcode: 'EC1A 1AA',
        }],
      };
    } else {
      throw new Error(`unexpected URL: ${u}`);
    }
    return {
      ok: true,
      status: 200,
      json: async () => body,
    };
  };

  const { fetchFirmByFrn } = loadFcaFresh();
  const firm = await fetchFirmByFrn('122702');

  // 4 surfaces hit
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.equal(c.opts.headers['X-Auth-Email'], 'a@b.co');
    assert.equal(c.opts.headers['X-Auth-Key'], 'KEY-123');
  }

  assert.equal(firm.frn, '122702');
  assert.equal(firm.firm_name, 'Acme Bridging Ltd');
  assert.equal(firm.status, 'Authorised');
  assert.deepEqual(firm.trading_names, ['Acme Short-Term Finance']);
  assert.deepEqual(firm.permissions, [
    'Advising on regulated mortgage contracts',
    'Arranging deals in mortgages',
  ]);
  assert.equal(firm.principal_office_address.postcode, 'EC1A 1AA');
});

test('fetchFirmByFrn surfaces opt selects subset', async () => {
  process.env.FCA_AUTH_EMAIL = 'a@b.co';
  process.env.FCA_AUTH_KEY = 'KEY';

  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    return {
      ok: true, status: 200,
      json: async () => ({ Status: 'OK', Data: [{ Organisation_Name: 'X' }] }),
    };
  };
  const { fetchFirmByFrn } = loadFcaFresh();
  await fetchFirmByFrn('1', { surfaces: ['firm'] });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].endsWith('/Firm/1'));
});

test('fetchFirmByFrn throws on non-2xx HTTP response', async () => {
  process.env.FCA_AUTH_EMAIL = 'a@b.co';
  process.env.FCA_AUTH_KEY = 'KEY';

  global.fetch = async () => ({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) });
  const { fetchFirmByFrn } = loadFcaFresh();
  await assert.rejects(
    () => fetchFirmByFrn('999999'),
    /HTTP 403/
  );
});
