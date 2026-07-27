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
// Make API realities (eu1, verified 2026-07-27):
//   - Auth: Authorization: Token <MAKE_API_TOKEN>
//   - POST /scenarios requires:
//       { teamId, blueprint: <JSON string>, scheduling: <JSON string> }
//     Name lives INSIDE the blueprint object (not top-level body).
//   - POST /scenarios/validate-blueprint is gone (404) — we validate locally.
//   - gateway-webhook hooks must be created first; blueprint hook field
//     must be the numeric hook id (not __HOOK_PLACEHOLDER__).
//   - Route `filter` objects are rejected by the public API schema. We strip
//     them before create and warn — HMAC route filters must be re-added in
//     the Make UI (or accept a linear flow until then).
//   - Module rename: util:SetVariables2 -> util:SetVariables on current Make.
//   - facebook-ads:* modules only resolve after the Facebook Ads app is
//     available on the org; generic "facebook" page OAuth is not enough.
//
// Usage:
//   MAKE_API_TOKEN=... node scripts/make/provision.js
//   MAKE_API_TOKEN=... node scripts/make/provision.js --dry-run
//

'use strict';

const fs = require('fs');
const path = require('path');

const MAKE_API_BASE = 'https://eu1.make.com/api/v2';
const TEAM_ID = 1406232;
const BOOST_HOOK_NAME = 'ub-social-boost webhook';

const BLUEPRINTS = [
  {
    file: path.join(__dirname, 'ub-social-boost.blueprint.json'),
    expectedName: 'ub-social-boost',
    needsHook: true,
  },
  {
    file: path.join(__dirname, 'ub-social-boost-reconcile.blueprint.json'),
    expectedName: 'ub-social-boost-reconcile',
    needsHook: false,
  },
];

/** Module renames required by current Make eu1 catalogue. */
const MODULE_RENAMES = Object.freeze({
  'util:SetVariables2': 'util:SetVariables',
});

/**
 * Make public API does not accept scheduling.type=cron.
 * Map our blueprint cron shorthand onto supported daily/weekly forms.
 * @param {object|null} scheduling
 * @returns {object|null}
 */
function normalizeScheduling(scheduling) {
  if (!scheduling || typeof scheduling !== 'object') return scheduling;
  const s = { ...scheduling };
  if (s.type === 'cron') {
    const cron = String(s.cron || '').trim();
    // "0 6 * * *" -> daily 06:00
    const m = cron.match(/^(\d{1,2})\s+(\d{1,2})\s+\*\s+\*\s+\*$/);
    if (m) {
      const minute = String(m[1]).padStart(2, '0');
      const hour = String(m[2]).padStart(2, '0');
      return { type: 'daily', time: `${hour}:${minute}` };
    }
    // fallback: keep daily 06:00 which matches the design default
    return { type: 'daily', time: '06:00' };
  }
  return s;
}

/**
 * Strip leading-underscore comment keys recursively.
 * @param {*} obj
 * @returns {*}
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
 * Drop modules marked `_skipIfRejected` (before stripDocs removes the flag).
 * @param {object} parsed
 * @returns {object}
 */
function dropSkipIfRejectedModules(parsed) {
  const clone = JSON.parse(JSON.stringify(parsed));
  function walkFlow(flow) {
    if (!Array.isArray(flow)) return [];
    const kept = [];
    for (const mod of flow) {
      if (mod && mod._skipIfRejected) continue;
      if (mod && Array.isArray(mod.routes)) {
        mod.routes = mod.routes.map((route) => {
          if (route && Array.isArray(route.flow)) route.flow = walkFlow(route.flow);
          return route;
        });
      }
      kept.push(mod);
    }
    return kept;
  }
  if (Array.isArray(clone.flow)) clone.flow = walkFlow(clone.flow);
  return clone;
}

/**
 * Rename known stale module ids in-place on a blueprint-ish object.
 * @param {*} obj
 * @returns {*}
 */
function renameModules(obj) {
  if (Array.isArray(obj)) return obj.map(renameModules);
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'module' && typeof v === 'string' && MODULE_RENAMES[v]) {
        out[k] = MODULE_RENAMES[v];
      } else {
        out[k] = renameModules(v);
      }
    }
    return out;
  }
  return obj;
}

/**
 * Public Make API schema rejects route.filter. Strip + count.
 * @param {*} obj
 * @returns {{value: *, strippedFilters: number}}
 */
function stripRouteFilters(obj) {
  let strippedFilters = 0;
  function walk(node) {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        if (k === 'filter' && node.flow) {
          // route object shape: { filter, flow }
          strippedFilters += 1;
          continue;
        }
        out[k] = walk(v);
      }
      return out;
    }
    return node;
  }
  return { value: walk(obj), strippedFilters };
}

/**
 * Replace webhook placeholder with numeric hook id.
 * @param {*} obj
 * @param {number} hookId
 * @returns {*}
 */
function injectHookId(obj, hookId) {
  if (Array.isArray(obj)) return obj.map((x) => injectHookId(x, hookId));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'hook' && (v === '__HOOK_PLACEHOLDER__' || v === '' || v == null)) {
        out[k] = hookId;
      } else {
        out[k] = injectHookId(v, hookId);
      }
    }
    return out;
  }
  return obj;
}

/**
 * Ensure blueprint metadata matches shapes Make accepts on create.
 * @param {object} blueprint
 * @returns {object}
 */
function normalizeBlueprintMetadata(blueprint) {
  const bp = { ...blueprint };
  const md = { ...(bp.metadata || {}) };
  if (md.version == null) md.version = 1;
  md.scenario = {
    roundtrips: 1,
    maxErrors: 3,
    autoCommit: true,
    autoCommitTriggerLast: true,
    sequential: false,
    confidential: false,
    dataloss: false,
    dlq: false,
    freshVariables: false,
    ...(md.scenario || {}),
  };
  md.designer = { orphans: [], ...(md.designer || {}) };
  bp.metadata = md;
  return bp;
}

/**
 * Local structural validation (remote validate-blueprint endpoint is gone).
 * @param {{name: string, blueprint: object, scheduling: object|null}} bp
 */
function validateLocal(bp) {
  if (!bp.name || typeof bp.name !== 'string') {
    throw new Error('Blueprint missing top-level name');
  }
  if (!bp.blueprint || typeof bp.blueprint !== 'object') {
    throw new Error(`Blueprint ${bp.name}: missing blueprint object`);
  }
  if (!Array.isArray(bp.blueprint.flow) || bp.blueprint.flow.length === 0) {
    throw new Error(`Blueprint ${bp.name}: flow must be a non-empty array`);
  }
  if (!bp.scheduling || typeof bp.scheduling !== 'object' || !bp.scheduling.type) {
    throw new Error(`Blueprint ${bp.name}: scheduling.type is required`);
  }
  for (const mod of bp.blueprint.flow) {
    if (!mod || typeof mod.module !== 'string') {
      throw new Error(`Blueprint ${bp.name}: every flow item needs module`);
    }
  }
}

/**
 * Read + normalise a blueprint file for Make POST /scenarios.
 * @param {string} filePath
 * @param {{hookId?: number|null}} opts
 * @returns {{name: string, blueprint: object, scheduling: object, strippedFilters: number, warnings: string[]}}
 */
function readBlueprint(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(raw);
  const warnings = [];

  let working = dropSkipIfRejectedModules(parsed);
  working = renameModules(working);
  const strippedDocs = stripDocs(working);

  const name = strippedDocs.name;
  if (!name) throw new Error(`Blueprint ${filePath} has no top-level "name"`);

  const scheduling = normalizeScheduling(strippedDocs.scheduling || null);
  if (strippedDocs.scheduling) delete strippedDocs.scheduling;
  if (strippedDocs.interface) {
    delete strippedDocs.interface;
    warnings.push('stripped top-level interface (not accepted on create)');
  }

  let blueprint = strippedDocs;
  // Name must remain inside the blueprint object for Make create.
  blueprint.name = name;
  blueprint = normalizeBlueprintMetadata(blueprint);

  const filterPass = stripRouteFilters(blueprint);
  blueprint = filterPass.value;
  if (filterPass.strippedFilters > 0) {
    warnings.push(
      `stripped ${filterPass.strippedFilters} route filter(s) — re-add HMAC filters in Make UI`
    );
  }

  if (opts.hookId != null) {
    blueprint = injectHookId(blueprint, opts.hookId);
  }

  return {
    name,
    blueprint,
    scheduling,
    strippedFilters: filterPass.strippedFilters,
    warnings,
  };
}

/**
 * Make API request helper.
 * @param {string} method
 * @param {string} pathPart
 * @param {object|null} body
 * @returns {Promise<object>}
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
  const text = await resp.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch (_) {
    parsed = { _rawText: text };
  }
  if (!resp.ok) {
    throw new Error(`Make API ${method} ${pathPart} -> ${resp.status}: ${text.slice(0, 400)}`);
  }
  return parsed;
}

/**
 * @returns {Promise<Array<{id: number, name: string, hookId: number|null}>>}
 */
async function listExistingScenarios() {
  const resp = await makeApi('GET', `/scenarios?teamId=${TEAM_ID}`, null);
  const scenarios = (resp && resp.scenarios) || [];
  return scenarios.map((s) => ({
    id: s.id,
    name: s.name,
    hookId: s.hookId || (s.scheduling && s.scheduling.hook) || null,
  }));
}

/**
 * Ensure the boost webhook hook exists; reuse by name when present.
 * @returns {Promise<{id: number, url: string|null}>}
 */
async function ensureBoostHook() {
  const resp = await makeApi('GET', `/hooks?teamId=${TEAM_ID}`, null);
  const hooks = (resp && resp.hooks) || [];
  const existing = hooks.find(
    (h) => h.name === BOOST_HOOK_NAME && h.typeName === 'gateway-webhook' && !h.gone
  );
  if (existing) {
    return { id: existing.id, url: existing.url || null };
  }
  const created = await makeApi('POST', '/hooks', {
    name: BOOST_HOOK_NAME,
    teamId: TEAM_ID,
    typeName: 'gateway-webhook',
    method: 1,
    headers: true,
    stringify: false,
  });
  const hook = (created && created.hook) || created;
  return { id: hook.id, url: hook.url || null };
}

/**
 * Resolve public webhook URL for a hook id.
 * @param {number} hookId
 * @returns {Promise<string|null>}
 */
async function getWebhookUrl(hookId) {
  const resp = await makeApi('GET', `/hooks?teamId=${TEAM_ID}`, null);
  const hooks = (resp && resp.hooks) || [];
  const match = hooks.find((h) => Number(h.id) === Number(hookId));
  return (match && match.url) || null;
}

/**
 * Create a scenario from a prepared blueprint payload.
 * @param {{name: string, blueprint: object, scheduling: object|null}} bp
 * @returns {Promise<{id: number, hookId: number|null, name: string}>}
 */
async function createScenario(bp) {
  const body = {
    teamId: TEAM_ID,
    blueprint: JSON.stringify(bp.blueprint),
    scheduling: JSON.stringify(bp.scheduling || { type: 'on-demand' }),
  };
  const resp = await makeApi('POST', '/scenarios', body);
  const sc = (resp && resp.scenario) || resp;
  return {
    id: sc && sc.id,
    hookId: (sc && sc.hookId) || null,
    name: (sc && sc.name) || bp.name,
  };
}

function baseScenarioMetadata(extra = {}) {
  return {
    version: 1,
    scenario: {
      roundtrips: 1,
      maxErrors: 3,
      autoCommit: true,
      autoCommitTriggerLast: true,
      sequential: false,
      confidential: false,
      dataloss: false,
      dlq: false,
      freshVariables: false,
    },
    designer: { orphans: [] },
    ...extra,
  };
}

/**
 * Shell blueprints used when facebook-ads modules are unavailable on the org.
 * Inactive by default; keeps reserved scenario names + webhook linkage so the
 * operator can finish FB Ads wiring in the Make UI without losing the hook URL.
 * @param {'ub-social-boost'|'ub-social-boost-reconcile'} name
 * @param {{hookId?: number|null}} opts
 * @returns {{name: string, blueprint: object, scheduling: object}}
 */
function buildShellBlueprint(name, opts = {}) {
  if (name === 'ub-social-boost') {
    if (!opts.hookId) throw new Error('buildShellBlueprint(ub-social-boost) requires hookId');
    return {
      name,
      scheduling: { type: 'immediately' },
      blueprint: {
        name,
        flow: [
          {
            id: 1,
            module: 'gateway:CustomWebHook',
            version: 1,
            parameters: { hook: opts.hookId, maxResults: 1 },
            mapper: {},
            metadata: { designer: { x: 0, y: 0 } },
          },
          {
            id: 2,
            module: 'util:SetVariables',
            version: 1,
            mapper: {
              variables: [
                { name: 'request_id', value: '{{1.request_id}}' },
                { name: 'post_id', value: '{{1.post_id}}' },
                { name: 'callback_url', value: '{{1.callback_url}}' },
                {
                  name: 'shell_note',
                  value:
                    'SHELL ONLY — install Facebook Ads app + ads OAuth, then replace this path with campaign/adset/ad modules from scripts/make/ub-social-boost.blueprint.json',
                },
              ],
              scope: 'roundtrip',
            },
            metadata: { designer: { x: 300, y: 0 } },
          },
          {
            id: 3,
            module: 'http:ActionSendData',
            version: 3,
            mapper: {
              url: '{{2.callback_url}}',
              method: 'POST',
              headers: [{ name: 'content-type', value: 'application/json' }],
              qs: [],
              bodyType: 'raw',
              contentType: 'application/json',
              data: '{{toJSON({"request_id": 2.request_id, "status": "failed", "boost_campaign_id": null, "boost_ad_id": null, "started_at": null, "error_message": "Make scenario is still a shell — Facebook Ads modules not installed", "make_execution_id": executionId})}}',
              parseResponse: true,
              shareCookies: false,
              followRedirect: true,
              useMtls: false,
              timeout: 40,
            },
            metadata: { designer: { x: 600, y: 0 } },
          },
        ],
        metadata: baseScenarioMetadata({ instant: true }),
      },
    };
  }

  if (name === 'ub-social-boost-reconcile') {
    return {
      name,
      scheduling: { type: 'daily', time: '06:00' },
      blueprint: {
        name,
        flow: [
          {
            id: 1,
            module: 'http:ActionSendData',
            version: 3,
            mapper: {
              url: '{{env.CB_BASE_URL}}/api/social-boost-active',
              method: 'GET',
              headers: [],
              qs: [],
              parseResponse: true,
              shareCookies: false,
              followRedirect: true,
              useMtls: false,
              timeout: 40,
            },
            metadata: { designer: { x: 0, y: 0 } },
          },
          {
            id: 2,
            module: 'util:SetVariables',
            version: 1,
            mapper: {
              variables: [
                {
                  name: 'shell_note',
                  value:
                    'SHELL ONLY — install Facebook Ads getInsights, then restore scripts/make/ub-social-boost-reconcile.blueprint.json',
                },
                { name: 'metrics', value: '[]' },
              ],
              scope: 'roundtrip',
            },
            metadata: { designer: { x: 300, y: 0 } },
          },
          {
            id: 3,
            module: 'http:ActionSendData',
            version: 3,
            mapper: {
              url: '{{env.CB_BASE_URL}}/api/social-boost-reconcile',
              method: 'POST',
              headers: [{ name: 'content-type', value: 'application/json' }],
              qs: [],
              bodyType: 'raw',
              contentType: 'application/json',
              data: '{{toJSON({"as_of": formatDate(now; "YYYY-MM-DDTHH:mm:ssZ"), "metrics": []})}}',
              parseResponse: true,
              shareCookies: false,
              followRedirect: true,
              useMtls: false,
              timeout: 40,
            },
            metadata: { designer: { x: 600, y: 0 } },
          },
        ],
        metadata: baseScenarioMetadata(),
      },
    };
  }

  throw new Error(`No shell blueprint for ${name}`);
}

/**
 * Back-compat no-op remote validator — local only.
 * Kept exported so older tests/tools can still call it.
 * @param {object} blueprint
 * @returns {Promise<{valid: boolean, mode: string}>}
 */
async function validateBlueprint(blueprint) {
  validateLocal({
    name: blueprint && blueprint.name,
    blueprint,
    scheduling: { type: 'on-demand' },
  });
  return { valid: true, mode: 'local' };
}

/**
 * @param {{dryRun?: boolean, allowShellFallback?: boolean}} opts
 * @returns {Promise<{created: Array, skipped: Array, webhookUrl: string|null, warnings: string[], shells: string[]}>}
 */
async function provision(opts) {
  const dryRun = opts && opts.dryRun;
  const allowShellFallback = !opts || opts.allowShellFallback !== false;
  const out = { created: [], skipped: [], webhookUrl: null, warnings: [], shells: [] };

  const needsHook = BLUEPRINTS.some((b) => b.needsHook);
  let hook = null;
  if (needsHook) {
    if (dryRun) {
      // Dry-run still touches GET hooks so operators see auth works; do not create.
      const resp = await makeApi('GET', `/hooks?teamId=${TEAM_ID}`, null);
      const hooks = (resp && resp.hooks) || [];
      const existing = hooks.find(
        (h) => h.name === BOOST_HOOK_NAME && h.typeName === 'gateway-webhook' && !h.gone
      );
      if (existing) {
        hook = { id: existing.id, url: existing.url || null };
        console.log(`[provision] dry-run: reusing hook id ${hook.id}`);
      } else {
        console.log('[provision] dry-run: boost hook missing (would create on real run)');
        hook = { id: 0, url: null };
      }
    } else {
      console.log('[provision] ensuring boost webhook hook...');
      hook = await ensureBoostHook();
      console.log(`[provision] hook id ${hook.id}${hook.url ? ` url ${hook.url}` : ''}`);
      out.webhookUrl = hook.url || (await getWebhookUrl(hook.id));
    }
  }

  const prepared = BLUEPRINTS.map((b) => {
    const bp = readBlueprint(b.file, {
      hookId: b.needsHook && hook && hook.id ? hook.id : null,
    });
    if (bp.name !== b.expectedName) {
      throw new Error(`Blueprint name mismatch: expected '${b.expectedName}', got '${bp.name}'`);
    }
    validateLocal(bp);
    for (const w of bp.warnings) {
      const msg = `${bp.name}: ${w}`;
      out.warnings.push(msg);
      console.warn(`[provision] warning: ${msg}`);
    }
    return { meta: b, bp };
  });

  if (dryRun) {
    console.log('[provision] dry-run mode — local validation OK, stopping before create');
    console.log(
      `[provision] would create/skip: ${prepared.map((p) => p.bp.name).join(', ')}`
    );
    return out;
  }

  console.log(`[provision] listing existing scenarios on team ${TEAM_ID}...`);
  const existing = await listExistingScenarios();
  console.log(`[provision] found ${existing.length} existing scenario(s)`);

  for (const item of prepared) {
    const already = existing.find((s) => s.name === item.bp.name);
    if (already) {
      console.log(`[provision] SKIP ${item.bp.name} — already exists (id ${already.id})`);
      out.skipped.push({ name: item.bp.name, id: already.id, hookId: already.hookId });
      if (item.bp.name === 'ub-social-boost') {
        const url =
          (already.hookId && (await getWebhookUrl(already.hookId))) ||
          out.webhookUrl ||
          (hook && hook.url) ||
          null;
        if (url) out.webhookUrl = url;
      }
      continue;
    }

    console.log(`[provision] CREATE ${item.bp.name}...`);
    try {
      const created = await createScenario(item.bp);
      console.log(
        `[provision] created ${item.bp.name} -> id ${created.id} (hookId ${created.hookId || 'n/a'})`
      );
      out.created.push({
        name: item.bp.name,
        id: created.id,
        hookId: created.hookId,
        shell: false,
      });
      if (item.bp.name === 'ub-social-boost' && !out.webhookUrl) {
        out.webhookUrl =
          (hook && hook.url) ||
          (created.hookId && (await getWebhookUrl(created.hookId))) ||
          null;
      }
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const missingModule = /Module not found/i.test(msg);
      if (missingModule && allowShellFallback) {
        console.warn(`[provision] full blueprint failed for ${item.bp.name}: ${msg}`);
        console.warn(`[provision] falling back to SHELL scenario for ${item.bp.name}`);
        const shell = buildShellBlueprint(item.bp.name, {
          hookId: hook && hook.id ? hook.id : null,
        });
        validateLocal(shell);
        const created = await createScenario(shell);
        console.log(
          `[provision] created SHELL ${item.bp.name} -> id ${created.id} (hookId ${created.hookId || 'n/a'})`
        );
        out.created.push({
          name: item.bp.name,
          id: created.id,
          hookId: created.hookId,
          shell: true,
        });
        out.shells.push(item.bp.name);
        out.warnings.push(
          `${item.bp.name}: created as SHELL because Make org lacks required modules (${msg.slice(0, 160)})`
        );
        if (item.bp.name === 'ub-social-boost' && !out.webhookUrl) {
          out.webhookUrl = (hook && hook.url) || null;
        }
        continue;
      }
      if (/facebook-ads:/i.test(msg) || missingModule) {
        throw new Error(
          `${msg}\n\n` +
            'Hint: this Make org does not currently resolve facebook-ads modules. ' +
            'In Make UI: add the Facebook Ads app, reconnect OAuth with ads_management + ads_read, ' +
            'then re-run provision. Generic Facebook Page connection is not enough.'
        );
      }
      throw err;
    }
  }

  return out;
}

module.exports = {
  stripDocs,
  dropSkipIfRejectedModules,
  renameModules,
  stripRouteFilters,
  injectHookId,
  normalizeScheduling,
  readBlueprint,
  validateLocal,
  validateBlueprint,
  listExistingScenarios,
  ensureBoostHook,
  createScenario,
  buildShellBlueprint,
  getWebhookUrl,
  provision,
  MAKE_API_BASE,
  TEAM_ID,
  BLUEPRINTS,
  MODULE_RENAMES,
  BOOST_HOOK_NAME,
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
      result.created.forEach((s) =>
        console.log(
          `  - ${s.name} (id ${s.id}${s.hookId ? `, hookId ${s.hookId}` : ''}${s.shell ? ', SHELL' : ''})`
        )
      );
      if (result.shells && result.shells.length) {
        console.log(
          `\nNOTE: ${result.shells.join(', ')} created as SHELL(s). Install Facebook Ads in Make UI, refresh OAuth (ads_management + ads_read), then replace shell modules from scripts/make/*.blueprint.json`
        );
      }
      console.log(`Skipped (already exist): ${result.skipped.length}`);
      result.skipped.forEach((s) => console.log(`  - ${s.name} (id ${s.id})`));
      if (result.warnings && result.warnings.length) {
        console.log('Warnings:');
        result.warnings.forEach((w) => console.log(`  - ${w}`));
      }
      if (result.webhookUrl) {
        console.log('\nub-social-boost webhook URL:');
        console.log(`  ${result.webhookUrl}`);
        console.log('\nNext step: set MAKE_BOOST_WEBHOOK_URL to that URL in Railway env.');
      }
    } catch (err) {
      console.error(`provision failed: ${err.message}`);
      process.exit(1);
    }
  })();
}
