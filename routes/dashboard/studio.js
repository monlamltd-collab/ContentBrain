'use strict';

// routes/dashboard/studio.js — Studio tab (social drafts with creative
// controls). HTMX pattern mirrors routes/dashboard/settings.js: scoped
// body-parser, GET fragments, template cached at module load.
//
// GET  /dashboard/studio                    — tab skeleton
// GET  /dashboard/studio/filters            — filter bar fragment
// GET  /dashboard/studio/grid?brand&type&q  — card grid fragment
// GET  /dashboard/studio/posts/:id/card     — single card re-render
//
// Card actions (save copy / approve / reject / re-render) intentionally go
// through the existing /api/social/* JSON endpoints — shared with Telegram.

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();
router.use(express.urlencoded({ extended: false }));

const queries = require('../../lib/dashboard/studio-queries');
const render = require('../../lib/dashboard/studio-render');
const { errorFlash } = require('../../lib/dashboard/html');
const { THEME_NAMES } = require('../../lib/themes');
const { MIN_DURATION_SECONDS, MAX_DURATION_SECONDS } = require('../../lib/video-renderer');
const hf = require('../../lib/dashboard/studio-higgsfield');
const hfRender = require('../../lib/dashboard/studio-higgsfield-render');

const TEMPLATE_PATH = path.join(__dirname, 'studio.html');
let TEMPLATE_CACHE = null;
function getTemplate() {
  if (TEMPLATE_CACHE == null) TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return TEMPLATE_CACHE;
}

function sendHtml(res, html, status = 200) {
  res.status(status).set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

function parseFilters(query) {
  return {
    brand: queries.VALID_BRANDS.includes(query.brand) ? query.brand : '',
    type: queries.VALID_TYPES.includes(query.type) ? query.type : '',
    q: typeof query.q === 'string' ? query.q.slice(0, 80) : '',
  };
}

router.get('/', (_req, res) => {
  try {
    sendHtml(res, getTemplate());
  } catch (err) {
    console.error('[dashboard/studio] template read error:', err.message);
    sendHtml(res, errorFlash(`Failed to load Studio tab: ${err.message}`), 500);
  }
});

router.get('/filters', (req, res) => {
  sendHtml(res, render.renderFilterBar(parseFilters(req.query)));
});

router.get('/grid', async (req, res) => {
  const filters = parseFilters(req.query);
  try {
    const posts = await queries.getStudioPosts(filters);
    sendHtml(res, render.renderGrid(posts, filters));
  } catch (err) {
    console.error('[dashboard/studio] GET /grid:', err.message);
    sendHtml(res, `<div class="card-grid studio-grid" id="studio-grid">${errorFlash(`Failed to load drafts: ${err.message}`)}</div>`, 500);
  }
});

// Creative settings — duration / theme / music → posts.meta. Empty values
// clear the key (template default / AI-picked theme / random music).
router.post('/posts/:id/settings', async (req, res) => {
  const body = req.body || {};

  const patch = {};
  const rawDuration = typeof body.duration_seconds === 'string' ? body.duration_seconds.trim() : '';
  if (rawDuration === '') {
    patch.duration_seconds = null;
  } else {
    const n = parseInt(rawDuration, 10);
    if (!Number.isFinite(n) || n < MIN_DURATION_SECONDS || n > MAX_DURATION_SECONDS) {
      return sendHtml(res, errorFlash(`Length must be ${MIN_DURATION_SECONDS}–${MAX_DURATION_SECONDS} seconds.`), 400);
    }
    patch.duration_seconds = n;
  }

  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  if (theme === '') patch.visual_style = null;
  else if (THEME_NAMES.includes(theme)) patch.visual_style = theme;
  else return sendHtml(res, errorFlash(`Unknown theme '${theme}'.`), 400);

  const music = typeof body.music === 'string' ? body.music.trim() : '';
  if (music === '') patch.music_file = null;
  else if (music === 'none' || queries.getMusicTracks().includes(music)) patch.music_file = music;
  else return sendHtml(res, errorFlash(`Unknown music track '${music}'.`), 400);

  try {
    const updated = await queries.mergePostMeta(req.params.id, patch);
    const html = render.renderSettingsRow(updated)
      .replace('class="saved-flash"', 'class="saved-flash show"');
    res.set('HX-Trigger', 'studio-saved');
    sendHtml(res, html);
  } catch (err) {
    console.error('[dashboard/studio] POST /posts/:id/settings:', err.message);
    sendHtml(res, errorFlash(`Save failed: ${err.message}`), 500);
  }
});

router.get('/posts/:id/card', async (req, res) => {
  try {
    const post = await queries.getPostRow(req.params.id);
    if (!post) return sendHtml(res, errorFlash('Post not found.'), 404);
    sendHtml(res, render.renderCard(post));
  } catch (err) {
    console.error('[dashboard/studio] GET /posts/:id/card:', err.message);
    sendHtml(res, errorFlash(`Failed to load card: ${err.message}`), 500);
  }
});

// ── Higgsfield AI media (PR3) ─────────────────────────────────────────────
// All fragments; errors render inline in the job slot so the operator sees
// exactly what happened without a toast layer.

function jobError(res, postId, message, status = 400) {
  res.status(status).set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<div class="hf-job hf-error" id="hf-job-${postId}">✗ ${require('../../lib/dashboard/html').escHtml(message)}</div>`);
}

// LLM-drafted prompt → returns the filled textarea fragment.
router.post('/posts/:id/prompt-draft', async (req, res) => {
  const kind = (req.body || {}).kind === 'video' ? 'video' : 'image';
  try {
    const post = await queries.getPostRow(req.params.id);
    if (!post) return sendHtml(res, errorFlash('Post not found.'), 404);
    const prompt = await hf.draftPrompt(post, kind);
    sendHtml(res, hfRender.renderPromptTextarea(req.params.id, prompt));
  } catch (err) {
    console.error('[dashboard/studio] prompt-draft:', err.message);
    sendHtml(res, hfRender.renderPromptTextarea(req.params.id, `(draft failed: ${err.message.slice(0, 120)})`));
  }
});

router.post('/posts/:id/generate-image', async (req, res) => {
  const prompt = typeof (req.body || {}).prompt === 'string' ? req.body.prompt.trim() : '';
  if (!prompt) return jobError(res, req.params.id, 'Write or prefill a prompt first.');
  try {
    const job = await hf.startImageJob(req.params.id, prompt);
    sendHtml(res, hfRender.renderJobStatus(req.params.id, job));
  } catch (err) {
    jobError(res, req.params.id, err.message, 400);
  }
});

router.post('/posts/:id/animate', async (req, res) => {
  const body = req.body || {};
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (!prompt) return jobError(res, req.params.id, 'Write or prefill a motion prompt first.');
  try {
    const job = await hf.startVideoJob(req.params.id, prompt, body.source || 'current');
    sendHtml(res, hfRender.renderJobStatus(req.params.id, job));
  } catch (err) {
    jobError(res, req.params.id, err.message, 400);
  }
});

// HTMX poll target — HTTP 286 stops the polling loop on terminal states.
router.get('/posts/:id/jobs/:requestId/status', async (req, res) => {
  try {
    const { job, post } = await hf.refreshJob(req.params.id, req.params.requestId);
    const terminal = ['completed', 'nsfw', 'failed', 'timed_out'].includes(job.status);
    const html = renderJobAndMaybeVariants(req.params.id, job, post, terminal);
    res.status(terminal ? 286 : 200).set('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    console.error('[dashboard/studio] job status:', err.message);
    res.status(286).set('Content-Type', 'text/html; charset=utf-8');
    res.send(`<div class="hf-job hf-error" id="hf-job-${req.params.id}">✗ ${require('../../lib/dashboard/html').escHtml(err.message)}</div>`);
  }
});

function renderJobAndMaybeVariants(postId, job, post, terminal) {
  let html = hfRender.renderJobStatus(postId, job);
  if (terminal && job.status === 'completed') {
    // Out-of-band swap refreshes the variant strip alongside the status.
    const strip = hfRender.renderVariantStrip(post)
      .replace('class="variant-strip"', 'class="variant-strip" hx-swap-oob="outerHTML"');
    html += `\n${strip}`;
  }
  return html;
}

// Make a generated variant the live media — returns the whole refreshed card.
router.post('/posts/:id/variants/use', async (req, res) => {
  const variantId = (req.body || {}).variant;
  if (!variantId) return sendHtml(res, errorFlash('No variant specified.'), 400);
  try {
    await hf.useVariant(req.params.id, variantId);
    const post = await queries.getPostRow(req.params.id);
    sendHtml(res, render.renderCard(post));
  } catch (err) {
    console.error('[dashboard/studio] variants/use:', err.message);
    sendHtml(res, errorFlash(`Could not apply variant: ${err.message}`), 400);
  }
});

module.exports = router;
