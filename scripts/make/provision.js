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
 * @param {*} obj
 * @returns {*} a new object with underscore-prefixed keys removed
 */
function stripDocs(obj) {
  // Stub for coder — recursive walk, skip keys starting with '_'
  throw new Error('NOT_IMPLEMENTED: stripDocs');
}

/**
 * Read a blueprint file and parse-clean it.
 * @param {string} filePath
 * @returns {{name: string, blueprint: object, scheduling: object}}
 */
function readBlueprint(filePath) {
  // Stub for coder — fs.readFileSync, JSON.parse, stripDocs, return
  // {name, blueprint, scheduling}. The Make API wants `name` at
  // scenario-create level AND inside `blueprint.name`.
  throw new Error('NOT_IMPLEMENTED: readBlueprint');
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
  // Stub for coder — global fetch, Authorization: Token <MAKE_API_TOKEN>,
  // content-type application/json, JSON.stringify body if present.
  throw new Error('NOT_IMPLEMENTED: makeApi');
}

/**
 * Look up existing scenarios on the team. Returns just the names + ids.
 * @returns {Promise<Array<{id: number, name: string, hookId: number|null}>>}
 */
async function listExistingScenarios() {
  // Stub for coder — GET /scenarios?teamId=<TEAM_ID>, return data.scenarios
  // mapped to {id, name, hookId}.
  throw new Error('NOT_IMPLEMENTED: listExistingScenarios');
}

/**
 * Validate a blueprint via Make's validator endpoint. Returns the validator
 * response so the caller can decide whether to proceed.
 * @param {object} blueprint
 * @returns {Promise<{valid: boolean, errors?: Array}>}
 */
async function validateBlueprint(blueprint) {
  // Stub for coder — POST /scenarios/validate-blueprint with {blueprint}.
  // If MCP `validate_blueprint_schema` is preferred, swap to that here; the
  // HTTP API path is the same.
  throw new Error('NOT_IMPLEMENTED: validateBlueprint');
}

/**
 * Create a scenario from a validated blueprint.
 * @param {{name: string, blueprint: object, scheduling: object}} bp
 * @returns {Promise<{id: number, hookId: number|null}>}
 */
async function createScenario(bp) {
  // Stub for coder — POST /scenarios with body {teamId: TEAM_ID, name,
  // blueprint, scheduling, confirmed: true}. Returns the new scenario id +
  // the auto-provisioned hookId (when the blueprint has a CustomWebHook).
  throw new Error('NOT_IMPLEMENTED: createScenario');
}

/**
 * Look up the public webhook URL for a hook by id.
 * @param {number} hookId
 * @returns {Promise<string|null>}
 */
async function getWebhookUrl(hookId) {
  // Stub for coder — GET /hooks?teamId=<TEAM_ID>, find matching id, return
  // its `url` field (full https URL). null if not found.
  throw new Error('NOT_IMPLEMENTED: getWebhookUrl');
}

/**
 * Provision both scenarios. Idempotent — skips any already-named scenario.
 * @param {{dryRun: boolean}} opts
 * @returns {Promise<{created: Array, skipped: Array, webhookUrl: string|null}>}
 */
async function provision(opts) {
  // Stub for coder — orchestrates the workflow described in the file header.
  // The `webhookUrl` returned is the ub-social-boost webhook (the one Simon
  // copies into Railway as MAKE_BOOST_WEBHOOK_URL).
  throw new Error('NOT_IMPLEMENTED: provision');
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
