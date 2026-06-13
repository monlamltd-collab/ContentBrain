'use strict';

// routes/dashboard/editorial.js — Editorial tab (blog coverage, draft
// review, source intake, brief queue). HTMX pattern mirrors the other
// dashboard tabs: skeleton from a cached .html partial, read panels as
// server-rendered fragments. Mutations go through the untouched
// /api/content/* JSON endpoints (see routes/api-content.js).
//
// GET /dashboard/editorial            — tab skeleton
// GET /dashboard/editorial/coverage   — tag coverage fragment (?brand=)
// GET /dashboard/editorial/queue      — draft queue fragment
// GET /dashboard/editorial/briefs     — brief queue fragment

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

const queries = require('../../lib/dashboard/editorial-queries');
const render = require('../../lib/dashboard/editorial-render');
const { errorFlash } = require('../../lib/dashboard/html');

const TEMPLATE_PATH = path.join(__dirname, 'editorial.html');
let TEMPLATE_CACHE = null;
function getTemplate() {
  if (TEMPLATE_CACHE == null) TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  return TEMPLATE_CACHE;
}

function sendHtml(res, html, status = 200) {
  res.status(status).set('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

router.get('/', (_req, res) => {
  try {
    sendHtml(res, getTemplate());
  } catch (err) {
    console.error('[dashboard/editorial] template read error:', err.message);
    sendHtml(res, errorFlash(`Failed to load Editorial tab: ${err.message}`), 500);
  }
});

router.get('/coverage', async (req, res) => {
  const brand = queries.VALID_BRANDS.includes(req.query.brand) ? req.query.brand : '';
  try {
    const data = await queries.getCoverage(brand || undefined);
    sendHtml(res, render.renderCoverage(data, brand));
  } catch (err) {
    console.error('[dashboard/editorial] GET /coverage:', err.message);
    sendHtml(res, `<div id="editorial-coverage">${errorFlash(`Failed to load coverage: ${err.message}`)}</div>`, 500);
  }
});

router.get('/queue', async (_req, res) => {
  try {
    const drafts = await queries.getQueue();
    sendHtml(res, render.renderDraftQueue(drafts));
  } catch (err) {
    console.error('[dashboard/editorial] GET /queue:', err.message);
    sendHtml(res, `<div id="editorial-queue">${errorFlash(`Failed to load drafts: ${err.message}`)}</div>`, 500);
  }
});

router.get('/briefs', async (_req, res) => {
  try {
    const briefs = await queries.getBriefs();
    sendHtml(res, render.renderBriefQueue(briefs));
  } catch (err) {
    console.error('[dashboard/editorial] GET /briefs:', err.message);
    sendHtml(res, `<div id="editorial-briefs">${errorFlash(`Failed to load briefs: ${err.message}`)}</div>`, 500);
  }
});

module.exports = router;
