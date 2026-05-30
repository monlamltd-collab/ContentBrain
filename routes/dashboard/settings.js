'use strict';

// routes/dashboard/settings.js — Phase F-2 Settings tab.
// HTMX pattern mirrors routes/dashboard/pipeline.js: scoped body-parser,
// every POST returns an HTML fragment for outerHTML swap. Source of truth:
// .ruflo/phase-f-settings-tab-design.md.

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

const settingsQueries = require('../../lib/dashboard/settings-queries');
const renderers = require('../../lib/dashboard/settings-render');
const runtimeConfig = require('../../lib/runtime-config');
const warming = require('../../lib/warming');
const suppression = require('../../lib/suppression');
const { assertSuppressionReason } = require('../../lib/sales-brain/constants');
const telegram = require('../../lib/telegram');

const { VALID_TRACKS, VALID_CONTENT_BRANDS, VALID_TEMPLATE_TYPES } = settingsQueries;

const TEMPLATE_PATH = path.join(__dirname, 'settings.html');
let TEMPLATE_CACHE = null;
function getTemplate() {
  if (TEMPLATE_CACHE == null) TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return TEMPLATE_CACHE;
}

const trim = s => typeof s === 'string' ? s.trim() : '';

// HTML form unchecked checkboxes are absent; checked ones come through as
// the input's value ('on' by default) or 'true'/'1'.
function isTruthyFormField(v) {
  if (v == null) return false;
  if (typeof v === 'string') {
    const lower = v.trim().toLowerCase();
    return lower === 'on' || lower === '1' || lower === 'true' || lower === 'yes';
  }
  return !!v;
}

function send400(res, message) {
  res.status(400).set('Content-Type', 'text/html; charset=utf-8');
  return res.send(renderers.renderErrorFlash(message));
}
function send500(res, message) {
  res.status(500).set('Content-Type', 'text/html; charset=utf-8');
  return res.send(renderers.renderErrorFlash(message));
}
function withSavedFlash(html) {
  return html.replace('class="saved-flash"', 'class="saved-flash show"');
}

// ── Main tab render ───────────────────────────────────────────────────────

router.get('/', (_req, res) => {
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(getTemplate());
  } catch (err) {
    console.error('[dashboard/settings] template read error:', err.message);
    res.status(500).send(`<p class="error">Failed to load Settings tab: ${renderers.escHtml(err.message)}</p>`);
  }
});

// ── Section 1 — Outbound ──────────────────────────────────────────────────

router.get('/outbound/:track/status', async (req, res) => {
  const track = req.params.track;
  if (!VALID_TRACKS.includes(track)) {
    return send400(res, `Unknown track '${track}'.`);
  }
  try {
    const status = await settingsQueries.getOutboundTrackStatus(track);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderers.renderOutboundCard(track, status));
  } catch (err) {
    console.error(`[dashboard/settings] GET /outbound/${track}/status: ${err.message}`);
    return send500(res, `Failed to load ${track} track: ${err.message}`);
  }
});

async function reRenderTrack(res, track, { flash = false } = {}) {
  const status = await settingsQueries.getOutboundTrackStatus(track);
  let html = renderers.renderOutboundCard(track, status);
  if (flash) html = withSavedFlash(html);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('HX-Trigger', 'settings-saved');
  res.send(html);
}

router.post('/outbound/:track/pause', async (req, res) => {
  const track = req.params.track;
  if (!VALID_TRACKS.includes(track)) {
    return send400(res, `Unknown track '${track}'.`);
  }
  try {
    await warming.pauseTrack(track);
    return reRenderTrack(res, track, { flash: true });
  } catch (err) {
    console.error(`[dashboard/settings] POST /outbound/${track}/pause: ${err.message}`);
    return send500(res, `Pause failed: ${err.message}`);
  }
});

router.post('/outbound/:track/resume', async (req, res) => {
  const track = req.params.track;
  if (!VALID_TRACKS.includes(track)) {
    return send400(res, `Unknown track '${track}'.`);
  }
  try {
    await warming.resumeTrack(track);
    return reRenderTrack(res, track, { flash: true });
  } catch (err) {
    console.error(`[dashboard/settings] POST /outbound/${track}/resume: ${err.message}`);
    return send500(res, `Resume failed: ${err.message}`);
  }
});

router.post('/outbound/:track/steady-cap', async (req, res) => {
  const track = req.params.track;
  if (!VALID_TRACKS.includes(track)) {
    return send400(res, `Unknown track '${track}'.`);
  }
  const body = req.body || {};
  const reset = body.reset !== undefined && body.reset !== '';
  const rawCap = trim(body.steady_cap);
  const key = `outbound.warming.${track}.steady_cap`;

  try {
    if (reset || rawCap === '') {
      // DELETE the row — warming.getCurrentCap falls back to default 300.
      await runtimeConfig.clearLever('global', key);
    } else {
      const cap = parseInt(rawCap, 10);
      if (!Number.isFinite(cap) || cap < 0 || cap > 2000) {
        return send400(res, 'Steady cap must be a whole number between 0 and 2000.');
      }
      await runtimeConfig.setLever('global', key, cap);
    }
    return reRenderTrack(res, track, { flash: true });
  } catch (err) {
    console.error(`[dashboard/settings] POST /outbound/${track}/steady-cap: ${err.message}`);
    return send500(res, `Steady cap save failed: ${err.message}`);
  }
});

router.post('/outbound/:track/from-address', async (req, res) => {
  const track = req.params.track;
  if (!VALID_TRACKS.includes(track)) {
    return send400(res, `Unknown track '${track}'.`);
  }
  const body = req.body || {};
  const clear = body.clear !== undefined && body.clear !== '';
  const rawFrom = trim(body.from_address);
  const key = `outbound.from.${track}`;

  try {
    if (clear || rawFrom === '') {
      await runtimeConfig.clearLever('global', key);
    } else {
      // Basic shape check — must contain '@'. Reject embedded HTML tags
      // (except the RFC 5322 display-name angle brackets that wrap the addr).
      if (!rawFrom.includes('@')) {
        return send400(res, 'From address must contain &lsquo;@&rsquo;.');
      }
      // Block any < that isn't part of an RFC 5322 display-name wrap.
      // Heuristic: at most one pair of <...> and it must come AFTER text.
      const openCount = (rawFrom.match(/</g) || []).length;
      const closeCount = (rawFrom.match(/>/g) || []).length;
      if (openCount > 1 || closeCount > 1 || /<\s*(script|style|iframe|img)/i.test(rawFrom)) {
        return send400(res, 'From address contains disallowed characters.');
      }
      await runtimeConfig.setLever('global', key, rawFrom);
    }
    return reRenderTrack(res, track, { flash: true });
  } catch (err) {
    console.error(`[dashboard/settings] POST /outbound/${track}/from-address: ${err.message}`);
    return send500(res, `From-address save failed: ${err.message}`);
  }
});

router.post('/outbound/:track/tone', async (req, res) => {
  const track = req.params.track;
  if (!VALID_TRACKS.includes(track)) {
    return send400(res, `Unknown track '${track}'.`);
  }
  const body = req.body || {};
  const clear = body.clear !== undefined && body.clear !== '';
  const rawTone = trim(body.tone);
  const key = `outbound_tone_${track}`;

  try {
    if (clear || rawTone === '') {
      await runtimeConfig.clearLever('global', key);
    } else {
      if (rawTone.length > 500) {
        return send400(res, `Tone is ${rawTone.length} chars; max 500.`);
      }
      await runtimeConfig.setLever('global', key, rawTone);
    }
    return reRenderTrack(res, track, { flash: true });
  } catch (err) {
    console.error(`[dashboard/settings] POST /outbound/${track}/tone: ${err.message}`);
    return send500(res, `Tone save failed: ${err.message}`);
  }
});

// ── Section 2 — Suppression ───────────────────────────────────────────────

router.get('/suppression', async (req, res) => {
  const rawPage = parseInt(req.query.page, 10);
  const page = Number.isFinite(rawPage) && rawPage >= 0 ? rawPage : 0;
  const q = trim(req.query.q);

  try {
    const { rows, hasMore } = await settingsQueries.getSuppressionPage({ page, q });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(renderers.renderSuppressionTable(rows, q, hasMore, page));
  } catch (err) {
    console.error(`[dashboard/settings] GET /suppression: ${err.message}`);
    return send500(res, `Failed to load suppression list: ${err.message}`);
  }
});

router.post('/suppression/add', async (req, res) => {
  const body = req.body || {};
  const emailOrDomain = trim(body.email_or_domain);
  const reason = trim(body.reason);

  if (!emailOrDomain) {
    return send400(res, 'Email or domain is required.');
  }
  try {
    assertSuppressionReason(reason);
  } catch (err) {
    return send400(res, err.message);
  }

  try {
    await suppression.addSuppression(emailOrDomain, reason);
    // Re-render the row using the canonical lowercased key.
    const rowHtml = renderers.renderSuppressionRow({
      email_or_domain: emailOrDomain.toLowerCase(),
      reason,
      added_at: new Date().toISOString(),
    });
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('HX-Trigger', 'settings-saved');
    res.send(rowHtml);
  } catch (err) {
    console.error(`[dashboard/settings] POST /suppression/add: ${err.message}`);
    return send500(res, `Add to suppression failed: ${err.message}`);
  }
});

router.post('/suppression/remove', async (req, res) => {
  const body = req.body || {};
  const emailOrDomain = trim(body.email_or_domain);

  if (!emailOrDomain) {
    return send400(res, 'Email or domain is required.');
  }

  try {
    const result = await suppression.removeSuppression(emailOrDomain);

    // Telegram receipt — best-effort, never blocks the response.
    try {
      const verb = result.removed ? 'removed' : 'attempted to remove (no row found)';
      await telegram.sendNotification(
        `Settings: ${verb} <code>${renderers.escHtml(result.emailOrDomain)}</code> from suppression list.`
      );
    } catch (notifyErr) {
      console.warn(`[dashboard/settings] Telegram notify failed: ${notifyErr.message}`);
    }

    // Empty 200 — the <tr> hx-target wipes the row on outerHTML swap.
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('HX-Trigger', 'settings-saved');
    res.send('');
  } catch (err) {
    console.error(`[dashboard/settings] POST /suppression/remove: ${err.message}`);
    return send500(res, `Remove from suppression failed: ${err.message}`);
  }
});

// ── Section 3 — Content ───────────────────────────────────────────────────

router.get('/content/brands', async (_req, res) => {
  try {
    const levers = await settingsQueries.getContentLevers();
    const cards = VALID_CONTENT_BRANDS.map(b =>
      renderers.renderContentCard(b, levers.active_brands.includes(b), levers.directives[b])
    ).join('\n');
    const weightsForm = renderers.renderTemplateWeights(levers.template_weights);

    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<div id="content-brands">
${cards}
${weightsForm}
</div>`);
  } catch (err) {
    console.error(`[dashboard/settings] GET /content/brands: ${err.message}`);
    return send500(res, `Failed to load content levers: ${err.message}`);
  }
});

router.post('/content/brand/:brand/active', async (req, res) => {
  const brand = req.params.brand;
  if (!VALID_CONTENT_BRANDS.includes(brand)) {
    return send400(res, `Unknown brand '${brand}'.`);
  }
  const active = isTruthyFormField((req.body || {}).active);

  try {
    const current = await runtimeConfig.getActiveBrands();
    const set = new Set(Array.isArray(current) ? current : []);
    if (active) set.add(brand);
    else set.delete(brand);
    const next = Array.from(set);
    await runtimeConfig.setLever('global', 'active_brands', next);

    // Re-render this brand card (with the directive textarea preserved).
    const directive = await runtimeConfig.getBrandDirective(brand);
    let html = renderers.renderContentCard(brand, active, directive);
    html = withSavedFlash(html);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('HX-Trigger', 'settings-saved');
    res.send(html);
  } catch (err) {
    console.error(`[dashboard/settings] POST /content/brand/${brand}/active: ${err.message}`);
    return send500(res, `Save failed: ${err.message}`);
  }
});

router.post('/content/template-weights', async (req, res) => {
  const body = req.body || {};
  const reset = body.reset !== undefined && body.reset !== '';

  try {
    if (reset) {
      await runtimeConfig.clearLever('global', 'template_weights');
    } else {
      const weights = {};
      for (const t of VALID_TEMPLATE_TYPES) {
        const raw = body[`weight_${t}`];
        const n = parseInt(raw, 10);
        if (!Number.isFinite(n) || n < 0 || n > 5) {
          return send400(res, `Weight for '${t}' must be an integer 0-5 (got '${raw}').`);
        }
        weights[t] = n;
      }
      await runtimeConfig.setLever('global', 'template_weights', weights);
    }

    const levers = await settingsQueries.getContentLevers();
    let html = renderers.renderTemplateWeights(levers.template_weights);
    html = withSavedFlash(html);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('HX-Trigger', 'settings-saved');
    res.send(html);
  } catch (err) {
    console.error(`[dashboard/settings] POST /content/template-weights: ${err.message}`);
    return send500(res, `Save failed: ${err.message}`);
  }
});

router.post('/content/brand/:brand/directive', async (req, res) => {
  const brand = req.params.brand;
  if (!VALID_CONTENT_BRANDS.includes(brand)) {
    return send400(res, `Unknown brand '${brand}'.`);
  }
  const body = req.body || {};
  const clear = body.clear !== undefined && body.clear !== '';
  const rawDirective = trim(body.directive);

  try {
    if (clear || rawDirective === '') {
      await runtimeConfig.clearLever(brand, 'directive');
    } else {
      if (rawDirective.length > 1000) {
        return send400(res, `Directive is ${rawDirective.length} chars; max 1000.`);
      }
      await runtimeConfig.setLever(brand, 'directive', rawDirective);
    }

    const directive = await runtimeConfig.getBrandDirective(brand);
    const active = (await runtimeConfig.getActiveBrands()).includes(brand);
    let html = renderers.renderContentCard(brand, active, directive);
    html = withSavedFlash(html);
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('HX-Trigger', 'settings-saved');
    res.send(html);
  } catch (err) {
    console.error(`[dashboard/settings] POST /content/brand/${brand}/directive: ${err.message}`);
    return send500(res, `Save failed: ${err.message}`);
  }
});

// ── Section 4 — System ────────────────────────────────────────────────────

async function reRenderSystem(res, { flash = false } = {}) {
  const levers = await settingsQueries.getSystemLevers();
  let html = renderers.renderSystemSection(levers);
  if (flash) html = withSavedFlash(html);
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.set('HX-Trigger', 'settings-saved');
  res.send(html);
}

router.get('/system', async (_req, res) => {
  try {
    return reRenderSystem(res);
  } catch (err) {
    console.error(`[dashboard/settings] GET /system: ${err.message}`);
    return send500(res, `Failed to load system levers: ${err.message}`);
  }
});

router.post('/system/bulk-approve-cap', async (req, res) => {
  const body = req.body || {};
  const reset = body.reset !== undefined && body.reset !== '';
  const rawCap = trim(body.cap);
  const key = 'dashboard.bulk_approve_cap';

  try {
    if (reset || rawCap === '') {
      await runtimeConfig.clearLever('global', key);
    } else {
      const cap = parseInt(rawCap, 10);
      if (!Number.isFinite(cap) || cap < 1 || cap > 50) {
        return send400(res, 'Bulk approve cap must be a whole number between 1 and 50.');
      }
      await runtimeConfig.setLever('global', key, cap);
    }
    return reRenderSystem(res, { flash: true });
  } catch (err) {
    console.error(`[dashboard/settings] POST /system/bulk-approve-cap: ${err.message}`);
    return send500(res, `Save failed: ${err.message}`);
  }
});

router.post('/system/telegram-receipt', async (req, res) => {
  const enabled = isTruthyFormField((req.body || {}).enabled);
  const key = 'dashboard.send_telegram_receipt';

  try {
    if (enabled) {
      // ON is the default — clear the row so the default applies cleanly.
      await runtimeConfig.clearLever('global', key);
    } else {
      await runtimeConfig.setLever('global', key, false);
    }
    return reRenderSystem(res, { flash: true });
  } catch (err) {
    console.error(`[dashboard/settings] POST /system/telegram-receipt: ${err.message}`);
    return send500(res, `Save failed: ${err.message}`);
  }
});

/**
 * NOTE — write-only lever. lib/publish.js#publishToResend still calls
 * isSuppressed unconditionally; this toggle records intent but does NOT
 * gate the read side (yet). The safe failure mode is "check stays on".
 * See design doc §6.3 + the JSDoc on the lib/publish.js call site for the
 * read-side wiring TODO.
 */
router.post('/system/suppression-check', async (req, res) => {
  const enabled = isTruthyFormField((req.body || {}).enabled);
  const key = 'outbound.suppression_check_enabled';

  try {
    await runtimeConfig.setLever('global', key, enabled);

    // Telegram paper trail on every flip.
    try {
      await telegram.sendNotification(
        `Settings: suppression_check_enabled toggled ${enabled ? '<b>ON</b>' : '<b>OFF</b>'} by dashboard user.`
      );
    } catch (notifyErr) {
      console.warn(`[dashboard/settings] Telegram notify failed: ${notifyErr.message}`);
    }

    return reRenderSystem(res, { flash: true });
  } catch (err) {
    console.error(`[dashboard/settings] POST /system/suppression-check: ${err.message}`);
    return send500(res, `Save failed: ${err.message}`);
  }
});

module.exports = router;
module.exports._internals = { trim, isTruthyFormField, withSavedFlash };
