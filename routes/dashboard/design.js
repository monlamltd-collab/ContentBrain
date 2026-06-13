'use strict';

// routes/dashboard/design.js — Design tab (the /levers control panel,
// consolidated). HTMX pattern mirrors routes/dashboard/settings.js: scoped
// body-parser, every POST returns an HTML fragment for outerHTML swap.
// All state lives in app_config via lib/runtime-config.

const express = require('express');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

const queries = require('../../lib/dashboard/design-queries');
const render = require('../../lib/dashboard/design-render');
const { errorFlash } = require('../../lib/dashboard/html');
const runtimeConfig = require('../../lib/runtime-config');
const { runGenerate } = require('../../lib/cron-jobs');
const { sendNotification } = require('../../lib/telegram');

const BRAND_TEXT_FIELDS = {
  tone: { lever: 'tone', max: 500 },
  audience: { lever: 'audience', max: 500 },
  directive: { lever: 'directive', max: 1000 },
  visual_directive: { lever: 'visual_directive', max: 500 },
};

const trim = s => (typeof s === 'string' ? s.trim() : '');

function sendHtml(res, html, status = 200, saved = false) {
  res.status(status).set('Content-Type', 'text/html; charset=utf-8');
  if (saved) res.set('HX-Trigger', 'design-saved');
  res.send(html);
}
function send400(res, message) { return sendHtml(res, errorFlash(message), 400); }
function send500(res, message) { return sendHtml(res, errorFlash(message), 500); }
function withSavedFlash(html) {
  return html.replace('class="saved-flash"', 'class="saved-flash show"');
}

// ── Tab render ────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
  try {
    const snapshot = await queries.getDesignSnapshot();
    sendHtml(res, render.renderDesignTab(snapshot));
  } catch (err) {
    console.error('[dashboard/design] GET /:', err.message);
    send500(res, `Failed to load Design tab: ${err.message}`);
  }
});

router.get('/live-blogs', async (_req, res) => {
  try {
    sendHtml(res, render.renderLiveBlogs(await queries.getLiveBlogs()));
  } catch (err) {
    console.error('[dashboard/design] GET /live-blogs:', err.message);
    send500(res, `Failed to load live blogs: ${err.message}`);
  }
});

// ── Brand voice ───────────────────────────────────────────────────────────

router.post('/brand/:brand/active', async (req, res) => {
  const brand = req.params.brand;
  if (!queries.BRAND_LIST.includes(brand)) return send400(res, `Unknown brand '${brand}'.`);
  const active = trim((req.body || {}).active) !== '';
  try {
    const current = await runtimeConfig.getActiveBrands();
    const set = new Set(Array.isArray(current) ? current : []);
    if (active) set.add(brand); else set.delete(brand);
    await runtimeConfig.setLever('global', 'active_brands', Array.from(set));
    sendHtml(res, withSavedFlash(render.renderBrandActiveToggle(brand, active)), 200, true);
  } catch (err) {
    console.error(`[dashboard/design] POST /brand/${brand}/active:`, err.message);
    send500(res, `Save failed: ${err.message}`);
  }
});

router.post('/brand/:brand/messages', async (req, res) => {
  const brand = req.params.brand;
  if (!queries.BRAND_LIST.includes(brand)) return send400(res, `Unknown brand '${brand}'.`);
  const body = req.body || {};
  const clear = trim(body.clear) !== '';
  const raw = typeof body.value === 'string' ? body.value : '';
  const messages = raw.split('\n').map(s => s.trim()).filter(Boolean);

  try {
    if (clear || !messages.length) await runtimeConfig.clearLever(brand, 'messages');
    else await runtimeConfig.setLever(brand, 'messages', messages);
    const saved = await runtimeConfig.getBrandMessages(brand);
    sendHtml(res, withSavedFlash(render.renderBrandField(brand, 'messages', saved)), 200, true);
  } catch (err) {
    console.error(`[dashboard/design] POST /brand/${brand}/messages:`, err.message);
    send500(res, `Save failed: ${err.message}`);
  }
});

router.post('/brand/:brand/:key', async (req, res) => {
  const { brand, key } = req.params;
  if (!queries.BRAND_LIST.includes(brand)) return send400(res, `Unknown brand '${brand}'.`);
  const field = BRAND_TEXT_FIELDS[key];
  if (!field) return send400(res, `Unknown field '${key}'.`);
  const body = req.body || {};
  const clear = trim(body.clear) !== '';
  const value = trim(body.value);
  if (!clear && value.length > field.max) {
    return send400(res, `${key} is ${value.length} chars; max ${field.max}.`);
  }

  try {
    if (clear || value === '') await runtimeConfig.clearLever(brand, field.lever);
    else await runtimeConfig.setLever(brand, field.lever, value);

    const getter = {
      tone: runtimeConfig.getBrandTone,
      audience: runtimeConfig.getBrandAudience,
      directive: runtimeConfig.getBrandDirective,
      visual_directive: runtimeConfig.getBrandVisualDirective,
    }[key];
    const saved = await getter(brand);
    sendHtml(res, withSavedFlash(render.renderBrandField(brand, key, saved)), 200, true);
  } catch (err) {
    console.error(`[dashboard/design] POST /brand/${brand}/${key}:`, err.message);
    send500(res, `Save failed: ${err.message}`);
  }
});

// ── Patterns ──────────────────────────────────────────────────────────────

async function patternsFor(kind) {
  return kind === 'hook' ? runtimeConfig.getHookPatterns() : runtimeConfig.getCtaPatterns();
}

router.post('/patterns/:kind/add', async (req, res) => {
  const kind = req.params.kind;
  if (kind !== 'hook' && kind !== 'cta') return send400(res, `Unknown pattern kind '${kind}'.`);
  const body = trim((req.body || {}).body);
  if (!body) return send400(res, 'Pattern text is required.');
  try {
    if (kind === 'hook') await runtimeConfig.addHookPattern(body);
    else await runtimeConfig.addCtaPattern(body);
    sendHtml(res, withSavedFlash(render.renderPatternList(kind, await patternsFor(kind))), 200, true);
  } catch (err) {
    console.error(`[dashboard/design] POST /patterns/${kind}/add:`, err.message);
    send500(res, `Add failed: ${err.message}`);
  }
});

router.post('/patterns/:kind/remove', async (req, res) => {
  const kind = req.params.kind;
  if (kind !== 'hook' && kind !== 'cta') return send400(res, `Unknown pattern kind '${kind}'.`);
  const index = parseInt((req.body || {}).index, 10);
  if (!Number.isFinite(index) || index < 0) return send400(res, 'Invalid pattern index.');
  try {
    if (kind === 'hook') await runtimeConfig.removeHookPattern(index);
    else await runtimeConfig.removeCtaPattern(index);
    sendHtml(res, withSavedFlash(render.renderPatternList(kind, await patternsFor(kind))), 200, true);
  } catch (err) {
    console.error(`[dashboard/design] POST /patterns/${kind}/remove:`, err.message);
    send500(res, `Remove failed: ${err.message}`);
  }
});

router.post('/patterns/:kind/draft', async (req, res) => {
  const kind = req.params.kind;
  if (kind !== 'hook' && kind !== 'cta') return send400(res, `Unknown pattern kind '${kind}'.`);
  const idea = trim((req.body || {}).body);
  if (!idea) return send400(res, 'Type a rough idea first, then Draft with AI.');
  try {
    const suggestion = await queries.draftPattern(kind, idea);
    sendHtml(res, render.renderPatternListWithDraft(kind, await patternsFor(kind), suggestion));
  } catch (err) {
    console.error(`[dashboard/design] POST /patterns/${kind}/draft:`, err.message);
    send500(res, `Draft failed: ${err.message}`);
  }
});

// ── Template mix ──────────────────────────────────────────────────────────

router.post('/mix', async (req, res) => {
  const body = req.body || {};
  const reset = trim(body.reset) !== '';
  try {
    const snapshot = await queries.getDesignSnapshot();
    if (reset) {
      await runtimeConfig.clearLever('global', 'template_weights');
    } else {
      const weights = {};
      for (const t of snapshot.menus.templateTypes) {
        const n = parseInt(body[`weight_${t}`], 10);
        if (!Number.isFinite(n) || n < 0 || n > 5) {
          return send400(res, `Weight for '${t}' must be an integer 0-5.`);
        }
        weights[t] = n;
      }
      await runtimeConfig.setLever('global', 'template_weights', weights);
    }
    const fresh = await queries.getDesignSnapshot();
    sendHtml(res, withSavedFlash(render.renderMixSection(fresh)), 200, true);
  } catch (err) {
    console.error('[dashboard/design] POST /mix:', err.message);
    send500(res, `Save failed: ${err.message}`);
  }
});

// ── Lot schedule ──────────────────────────────────────────────────────────

router.post('/lot-schedule', async (req, res) => {
  const body = req.body || {};
  const reset = trim(body.reset) !== '';
  try {
    const snapshot = await queries.getDesignSnapshot();
    if (reset) {
      await runtimeConfig.clearLever('global', 'lot_archetype_schedule');
    } else {
      const schedule = [];
      for (let i = 0; i < 7; i++) {
        const v = trim(body[`day_${i}`]);
        if (!snapshot.menus.archetypes.includes(v)) {
          return send400(res, `Day ${i}: unknown archetype '${v}'.`);
        }
        schedule.push(v);
      }
      await runtimeConfig.setLever('global', 'lot_archetype_schedule', schedule);
    }
    const fresh = await queries.getDesignSnapshot();
    sendHtml(res, withSavedFlash(render.renderScheduleSection(fresh)), 200, true);
  } catch (err) {
    console.error('[dashboard/design] POST /lot-schedule:', err.message);
    send500(res, `Save failed: ${err.message}`);
  }
});

// ── Manual triggers (fire-and-forget, same bodies as /api/triggers/*) ────

router.post('/trigger/generate', (_req, res) => {
  setImmediate(() => {
    runGenerate({ force: true }).catch(err => {
      console.error('[dashboard/design] trigger generate error:', err.message);
      sendNotification(`Manual /generate failed: ${err.message.slice(0, 200)}`).catch(() => {});
    });
  });
  sendHtml(res, 'Generation started — drafts will appear in the Studio tab shortly.');
});

router.post('/trigger/lot', (req, res) => {
  const archetype = trim((req.body || {}).archetype);
  setImmediate(async () => {
    try {
      const { runLotOfTheDay } = require('../../lib/lot-flow');
      await runLotOfTheDay(archetype ? { forceArchetype: archetype } : {});
    } catch (err) {
      console.error('[dashboard/design] trigger lot error:', err.message);
      try { await sendNotification(`Manual Lot of the Day failed: ${err.message.slice(0, 200)}`); } catch {}
    }
  });
  sendHtml(res, 'Lot of the Day started — script alert will arrive in Telegram shortly.');
});

module.exports = router;
