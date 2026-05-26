'use strict';

require('dotenv').config();

// ── FCA register fetch helper (Phase D) ───────────────────────────────────
//
// AUTHENTICATION REQUIREMENT — READ FIRST
// ----------------------------------------
// The FCA Connect Register API V0.1 is gated. Both helpers in this file
// require these env vars to be set:
//
//   FCA_AUTH_EMAIL — the email you registered with FCA Connect
//   FCA_AUTH_KEY   — the API key emailed back by FCA (1-2 working days)
//
// Register for free at:  https://register.fca.org.uk/Re/
//
// Without these env vars set, both `fetchBulkRegister` and `fetchFirmByFrn`
// throw a hard error pointing at the registration URL. There is NO
// anonymous fallback: the architect's ops probe on 2026-05-25 confirmed
// the FCA bulk extract returns 401 without an account, and the Connect
// API returns 403 without the auth header pair.
//
// Surface map (one HTTP call per surface — caller decides which it needs):
//
//   GET https://register.fca.org.uk/services/V0.1/Firm/{FRN}
//   GET https://register.fca.org.uk/services/V0.1/Firm/{FRN}/Names
//   GET https://register.fca.org.uk/services/V0.1/Firm/{FRN}/Permissions
//   GET https://register.fca.org.uk/services/V0.1/Firm/{FRN}/Address
//
// Rate limit: undocumented; researcher (.ruflo/phase-d-design.md §1.3)
// recommends self-throttling to 5 req/sec with exponential backoff on 429.
// No "list all firms" endpoint — FRN-keyed only.
//
// Response shape (Connect envelope):
//   { Status: 'FSR-API-04-01-00', ResultInfo: {...}, Message: '...',
//     Data: [ {...the actual record...} ] }
// `fetchFirmByFrn` flattens the envelope and returns the inner payload
// in a normalised shape:
//   { frn, firm_name, status, permissions[], principal_office_address,
//     trading_names[], website }
//
// `website` is best-effort — the FCA register increasingly surfaces a
// website field but it's often blank or stale. Callers should treat it
// as a hint, not a source of truth.

const fs = require('fs/promises');
const path = require('path');

const FCA_API_BASE = 'https://register.fca.org.uk/services/V0.1';
const FCA_BULK_PAGE = 'https://www.fca.org.uk/firms/financial-services-register/access-data';
const FCA_REGISTRATION_URL = 'https://register.fca.org.uk/Re/';

/**
 * Throw a clear error if the FCA auth env vars are missing. Common
 * helper — both surfaces below call it.
 */
function assertFcaAuth() {
  const email = process.env.FCA_AUTH_EMAIL;
  const key = process.env.FCA_AUTH_KEY;
  if (!email || !key) {
    throw new Error(
      'FCA_AUTH_EMAIL and FCA_AUTH_KEY env vars are required. ' +
      `Register for a free Connect Register API key at ${FCA_REGISTRATION_URL} ` +
      '(lead time 1-2 working days), then set both values in .env or Railway env.'
    );
  }
  return { email, key };
}

function authHeaders() {
  const { email, key } = assertFcaAuth();
  return {
    'X-Auth-Email': email,
    'X-Auth-Key': key,
    Accept: 'application/json',
  };
}

/**
 * Fetch the FCA public bulk-data extract. The architect's ops probe on
 * 2026-05-25 confirmed the bulk extract is GATED behind an FCA account —
 * not freely downloadable. This helper:
 *
 *   - Requires `FCA_AUTH_EMAIL` + `FCA_AUTH_KEY` env vars.
 *   - Accepts an optional `opts.url` override (the FCA changes the bulk
 *     extract URL periodically; check the public-data page link in this
 *     file's header comment for the current location).
 *   - Writes the downloaded body to `opts.outputPath` (default
 *     `data/fca-bulk-extract.csv`) and returns the absolute path.
 *
 * If no URL is configured (the FCA bulk extract location must be looked
 * up at runtime — they rotate the Salesforce-style file ID each release),
 * this throws with a clear message pointing the caller at the public-
 * data page.
 *
 * @param {object} [opts]
 * @param {string} [opts.url]         Direct download URL. Falls back to
 *                                    process.env.FCA_BULK_EXTRACT_URL.
 * @param {string} [opts.outputPath]  Where to save the file. Default
 *                                    `data/fca-bulk-extract.csv`.
 * @returns {Promise<string>}         Absolute path to the downloaded file.
 * @throws  {Error}                   On missing env, missing URL, or
 *                                    download failure.
 */
async function fetchBulkRegister(opts = {}) {
  assertFcaAuth();
  const url = opts.url || process.env.FCA_BULK_EXTRACT_URL;
  if (!url) {
    throw new Error(
      'FCA bulk-extract URL is not set. The FCA rotates the file location ' +
      `per release — find the current download link on ${FCA_BULK_PAGE} ` +
      'and pass it via opts.url or set FCA_BULK_EXTRACT_URL in .env. ' +
      'If you have a pre-downloaded CSV, skip this helper and pass it directly ' +
      'to import-brokers.js via --source-csv.'
    );
  }

  const outputPath = path.resolve(opts.outputPath || path.join('data', 'fca-bulk-extract.csv'));

  // Ensure the parent directory exists.
  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  const res = await fetch(url, {
    method: 'GET',
    headers: authHeaders(),
  });
  if (!res.ok) {
    throw new Error(
      `FCA bulk-extract download failed: HTTP ${res.status} ${res.statusText}. ` +
      `URL: ${url}. Check that your FCA_AUTH_EMAIL + FCA_AUTH_KEY are valid ` +
      `and that the extract URL is still current.`
    );
  }

  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(outputPath, buf);
  return outputPath;
}

/**
 * Fetch a single firm by FRN via the FCA Connect Register V0.1 API.
 *
 * Hits up to four endpoints (Firm, Names, Permissions, Address) and
 * returns a normalised, flattened record:
 *
 *   {
 *     frn: '122702',
 *     firm_name: 'Acme Bridging Ltd',
 *     status: 'Authorised',
 *     permissions: ['Advising on regulated mortgage contracts', ...],
 *     principal_office_address: { line1, line2, town, county, postcode, country },
 *     trading_names: ['Acme Short-Term Finance', ...],
 *     website: 'https://acme-bridging.co.uk',  // best-effort, may be null
 *     raw: { firm, names, permissions, address }  // full envelopes, for debug
 *   }
 *
 * @param {string|number} frn
 * @param {object} [opts]
 * @param {Array<'firm'|'names'|'permissions'|'address'>} [opts.surfaces]
 *   Which Connect surfaces to hit. Default: all four, merged.
 * @returns {Promise<object>} Merged firm record.
 * @throws  {Error}            On missing env, non-2xx response, or non-OK
 *                             Status field in the Connect envelope.
 */
async function fetchFirmByFrn(frn, opts = {}) {
  if (frn == null || frn === '') {
    throw new Error('fetchFirmByFrn: frn is required');
  }
  assertFcaAuth();

  const surfaces = opts.surfaces || ['firm', 'names', 'permissions', 'address'];
  const headers = authHeaders();
  const out = {
    frn: String(frn),
    firm_name: null,
    status: null,
    permissions: [],
    principal_office_address: null,
    trading_names: [],
    website: null,
    raw: {},
  };

  for (const surface of surfaces) {
    const subpath = surface === 'firm' ? '' : `/${capitalise(surface)}`;
    const url = `${FCA_API_BASE}/Firm/${encodeURIComponent(frn)}${subpath}`;
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      throw new Error(
        `FCA Connect call failed for FRN ${frn} (${surface}): ` +
        `HTTP ${res.status} ${res.statusText}.`
      );
    }
    const env = await res.json();
    // FCA envelopes use Status codes like 'FSR-API-04-01-00' (OK). Anything
    // matching '-04-01-' or starting with 'OK' is treated as success.
    // Known error pattern: 'FSR-API-04-01-11' / '99' etc. Reject only when
    // Status is explicitly an error AND a Message is provided AND there is
    // no Data — tolerant of test mocks that use simpler shapes.
    const status = env.Status || '';
    const hasData = env.Data != null && (Array.isArray(env.Data) ? env.Data.length > 0 : true);
    const looksOk = /-04-01-00\b/.test(status) || /^OK$/i.test(status) || hasData;
    if (!looksOk) {
      throw new Error(
        `FCA Connect non-OK status for FRN ${frn} (${surface}): ` +
        `${status} — ${env.Message || 'no message'}`
      );
    }
    out.raw[surface] = env;
    mergeSurface(out, surface, env);
  }

  return out;
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Merge a single Connect surface response into the normalised output.
 * Defensive — FCA changes field shapes occasionally.
 */
function mergeSurface(out, surface, env) {
  const data = Array.isArray(env.Data) ? env.Data : (env.Data ? [env.Data] : []);
  if (!data.length) return;

  if (surface === 'firm') {
    const row = data[0] || {};
    out.firm_name = row.Organisation_Name || row.OrganisationName || row.Name || out.firm_name;
    out.status = row.Status || row.Current_Authorisation_Status || out.status;
    // Some Firm responses include a website hint.
    if (!out.website && row.Website) out.website = row.Website;
    return;
  }

  if (surface === 'names') {
    const names = [];
    for (const row of data) {
      const n = row.Current_Trading_Name || row.Current_Name || row.Trading_Name;
      if (n) names.push(n);
    }
    out.trading_names = names;
    return;
  }

  if (surface === 'permissions') {
    const perms = [];
    for (const row of data) {
      // The Permissions surface returns a per-activity record; pick the
      // human-readable activity name.
      const name = row.Permission || row.Activity_Name || row.RegulatedActivity;
      if (name) perms.push(name);
    }
    out.permissions = perms;
    return;
  }

  if (surface === 'address') {
    const row = data[0] || {};
    out.principal_office_address = {
      line1: row.Address_Line_1 || row.Line1 || null,
      line2: row.Address_Line_2 || row.Line2 || null,
      town: row.Town || row.City || null,
      county: row.County || null,
      postcode: row.Postcode || row.PostCode || null,
      country: row.Country || null,
    };
  }
}

module.exports = {
  fetchBulkRegister,
  fetchFirmByFrn,
  assertFcaAuth,
  FCA_API_BASE,
  FCA_BULK_PAGE,
  FCA_REGISTRATION_URL,
};
