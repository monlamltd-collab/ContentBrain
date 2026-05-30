#!/usr/bin/env node
//
// scripts/make/provision.js
//
// Provisions the two Phase G-3 Make scenarios (ub-social-boost +
// ub-social-boost-reconcile) from the JSON blueprints in this directory.
//
// Idempotent: lists existing scenarios on team 1406232 and skips any
// whose name matches one we'd create. Re-running after a partial failure
// only creates the missing one(s).
//
// Workflow:
//   1. Read both blueprint files
//   2. For each blueprint:
//      a. Strip _doc / _comment / _skipIfRejected / _targetTeamId / etc. fields
//         (Make rejects unknown top-level keys)
//      b. Validate via POST /api/v2/scenarios/validate-blueprint
//      c. If validation passes AND no existing scenario has this name,
//         POST /api/v2/scenarios to create
//      d. Read back the hookId for ub-social-boost, look up the webhook URL
//         via GET /api/v2/hooks?teamId=, print to stdout
//   3. Print a summary table of what was created vs skipped
//
// Make API auth: requires MAKE_API_TOKEN (a personal API token from
// https://eu1.make.com/user/api). Region is eu1.make.com — hardcoded
// because the team lives there.
//
// Usage:
//   MAKE_API_TOKEN=... node scripts/make/provision.js
//   MAKE_API_TOKEN=... node scripts/make/provision.js --dry-run
//
// Coder: do NOT call this until the operational pre-work in
// .ruflo/phase-g3-ops.md §3 is complete (secrets generated, Railway env
// set, Make Data Store / scenario vars set, FB OAuth refreshed).

'use strict';

const fs = require('fs');
const path = require('path');

const MAKE_API_BASE = 'https://eu1.make.com/api/v2';
const TEAM_ID = 1406232;

const BLUEPRINTS = [
  {
    file: path.join(__dirname, 'ub-social-boost.blueprint.json'),
    expectedName: 'ub-social-boost',
  },
  {
    file: path.join(__dirname, 'ub-social-boost-reconcile.blueprint.json'),
    expectedName: 'ub-social-boost-reconcile',
  },
];

/**
 * Strip the leading-underscore comment keys from a blueprint object
 * recursively. Make's schema validator rejects unknown top-level keys
 * like _doc / _targetTeamId / _fbConnectionId; we keep these in the
 * source files for human reference and remove them at provision time.
 *
 * Depth-first. Arrays preserved as arrays. Primitives returned as-is.
 *
 * @param {*} obj
 * @returns {*} a new value with underscore-prefixed keys removed
 */
function stripDocs(obj) {
  if (Array.isArray(obj)) return obj.map(stripDocs);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const key of Object.keys(obj)) {
      if (key.startsWith('_')) continue;
      out[key] = stripDocs(obj[key]);
    }
    return out;
  }
  return obj;
}

/**
 * Read a blueprint file and parse-clean it. Returns the name + the
 * stripped blueprint + the scheduling preference (if present at top
 * level under `_scheduling`).
 *
 * @param {string} filePath
 * @returns {{name: string, blueprint: object, scheduling: object|null}}
 */
function readBlueprint(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const stripped = stripDocs(parsed);
  const name = stripped.name;
  if (!name) throw new Error(`Blueprint ${filePath} has no top-level "name"`);
  // Make's POST /scenarios takes scheduling as a separate top-level param,
  // not inside the blueprint. Lift it out (after strip so _doc inside the
  // scheduling object is gone too).
  const scheduling = stripped.scheduling || null;
  if (stripped.scheduling) delete stripped.scheduling;
  return { name, blueprint: stripped, scheduling };
}

/**
 * Make API request helper. Throws on non-2xx with the response body
 * embedded in the error message.
 * @param {string} method  GET / POST / PATCH / DELETE
 * @param {string} pathPart  e.g. '/scenarios'
 * @param {object|null} body
 * @returns {Promise<object>}  parsed JSON response
 */
async function makeApi(method, pathPart, body) {
  const url = `${MAKE_API_BASE}${pathPart}`;
  const headers = {
    Authorization: `Token ${process.env.MAKE_API_TOKEN}`,
    Accept: 'application/json',
  };
  const opts = { method, headers };
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  let parsed;
  const text = await resp.text();
  try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = { _rawText: text }; }
  if (!resp.ok) {
    throw new Error(`Make API ${method} ${pathPart} -> ${resp.status}: ${text.slice(0, 400)}`);
  }
  return parsed;
}

/**
 * Look up existing scenarios on the team. Returns just the names + ids.
 * @returns {Promise<Array<{id: number, name: string, hookId: number|null}>>}
 */
async function listExistingScenarios() {
  const resp = await makeApi('GET', `/scenarios?teamId=${TEAM_ID}`, null);
  const scenarios = (resp && resp.scenarios) || [];
  return scenarios.map(s => ({
    id: s.id,
    name: s.name,
    hookId: s.hookId || (s.scheduling && s.scheduling.hook) || null,
  }));
}

/**
 * Validate a blueprint via Make's validator endpoint. Returns the validator
 * response so the caller can decide whether to proceed.
 * @param {object} blueprint
 * @returns {Promise<object>}  validator response (shape depends on Make)
 */
async function validateBlueprint(blueprint) {
  return makeApi('POST', '/scenarios/validate-blueprint', { blueprint });
}

/**
 * Create a scenario from a validated blueprint.
 * @param {{name: string, blueprint: object, scheduling: object|null}} bp
 * @returns {Promise<{id: number, hookId: number|null}>}
 */
async function createScenario(bp) {
  const body = {
    teamId: TEAM_ID,
    name: bp.name,
    blueprint: bp.blueprint,
    confirmed: true,
  };
  if (bp.scheduling) body.scheduling = bp.scheduling;
  const resp = await makeApi('POST', '/scenarios', body);
  const sc = (resp && resp.scenario) || resp;
  return {
    id: sc && sc.id,
    hookId: sc && (sc.hookId || (sc.scheduling && sc.scheduling.hook)) || null,
  };
}

/**
 * Look up the public webhook URL for a hook by id.
 * @param {number} hookId
 * @returns {Promise<string|null>}
 */
async function getWebhookUrl(hookId) {
  const resp = await makeApi('GET', `/hooks?teamId=${TEAM_ID}`, null);
  const hooks = (resp && resp.hooks) || [];
  const match = hooks.find(h => Number(h.id) === Number(hookId));
  return (match && match.url) || null;
}

/**
 * Provision both scenarios. Idempotent — skips any already-named scenario.
 * @param {{dryRun: boolean}} opts
 * @returns {Promise<{created: Array, skipped: Array, webhookUrl: string|null}>}
 */
async function provision(opts) {
  const dryRun = opts && opts.dryRun;
  const out = { created: [], skipped: [], webhookUrl: null };

  // 1. Read + validate both blueprints up-front so we fail fast on parse
  //    or validator errors before touching Make.
  const bps = BLUEPRINTS.map(b => ({
    expectedName: b.expectedName,
    bp: readBlueprint(b.file),
  }));

  for (const item of bps) {
    if (item.bp.name !== item.expectedName) {
      throw new Error(`Blueprint name mismatch: file expected '${item.expectedName}', got '${item.bp.name}'`);
    }
    console.log(`[provision] validating ${item.expectedName}...`);
    const validation = await validateBlueprint(item.bp.blueprint);
    if (validation && validation.valid === false) {
      const errors = Array.isArray(validation.errors)
        ? validation.errors.map(e => `- ${JSON.stringify(e)}`).join('\n')
        : JSON.stringify(validation);
      throw new Error(`Blueprint ${item.expectedName} failed validation:\n${errors}`);
    }
    console.log(`[provision] ${item.expectedName} validated OK`);
  }

  if (dryRun) {
    console.log('[provision] dry-run mode — stopping before create');
    return out;
  }

  // 2. List existing scenarios to support idempotency.
  console.log(`[provision] listing existing scenarios on team ${TEAM_ID}...`);
  const existing = await listExistingScenarios();
  console.log(`[provision] found ${existing.length} existing scenario(s)`);

  // 3. Create or skip each blueprint.
  for (const item of bps) {
    const already = existing.find(s => s.name === item.expectedName);
    if (already) {
      console.log(`[provision] SKIP ${item.expectedName} — already exists (id ${already.id})`);
      out.skipped.push({ name: item.expectedName, id: already.id, hookId: already.hookId });
      if (item.expectedName === 'ub-social-boost' && already.hookId) {
        const url = await getWebhookUrl(already.hookId);
        if (url) out.webhookUrl = url;
      }
      continue;
    }
    console.log(`[provision] CREATE ${item.expectedName}...`);
    const created = await createScenario(item.bp);
    console.log(`[provision] created ${item.expectedName} -> id ${created.id} (hookId ${created.hookId || 'n/a'})`);
    out.created.push({ name: item.expectedName, id: created.id, hookId: created.hookId });
    if (item.expectedName === 'ub-social-boost' && created.hookId) {
      const url = await getWebhookUrl(created.hookId);
      if (url) out.webhookUrl = url;
    }
  }

  return out;
}

module.exports = {
  stripDocs,
  readBlueprint,
  listExistingScenarios,
  validateBlueprint,
  createScenario,
  getWebhookUrl,
  provision,
  MAKE_API_BASE,
  TEAM_ID,
  BLUEPRINTS,
};

if (require.main === module) {
  (async () => {
    const dryRun = process.argv.includes('--dry-run');
    if (!process.env.MAKE_API_TOKEN) {
      console.error('error: MAKE_API_TOKEN env var is required (https://eu1.make.com/user/api)');
      process.exit(1);
    }
    try {
      const result = await provision({ dryRun });
      console.log('\n=== Provision summary ===');
      console.log(`Created: ${result.created.length}`);
      result.created.forEach(s => console.log(`  - ${s.name} (id ${s.id}${s.hookId ? `, hookId ${s.hookId}` : ''})`));
      console.log(`Skipped (already exist): ${result.skipped.length}`);
      result.skipped.forEach(s => console.log(`  - ${s.name} (id ${s.id})`));
      if (result.webhookUrl) {
        console.log(`\nub-social-boost webhook URL:`);
        console.log(`  ${result.webhookUrl}`);
        console.log(`\nNext step: set MAKE_BOOST_WEBHOOK_URL to that URL in Railway env.`);
      }
    } catch (err) {
      console.error(`provision failed: ${err.message}`);
      process.exit(1);
    }
  })();
}
