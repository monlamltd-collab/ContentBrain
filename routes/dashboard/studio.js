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

module.exports = router;
