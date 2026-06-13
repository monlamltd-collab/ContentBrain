'use strict';
// routes/dashboard/index.js
//
// Mounts the dashboard sub-routes and serves the shell HTML.
//
// GET  /dashboard              — full-page shell (loads HTMX, shows Approve tab by default)
// GET  /dashboard/today        — HTMX partial: posts awaiting review
// GET  /dashboard/studio       — HTMX partial: social drafts with creative controls
// GET  /dashboard/approve      — HTMX partial: approved posts queued for publish
// GET  /dashboard/performance  — HTMX partial: content + outbound metrics (Phase D)
// GET  /dashboard/pipeline     — HTMX partial: reply triage + sequence state (Phase F-1)
// GET  /dashboard/design       — HTMX partial: creative levers (voice/patterns/mix/schedule)
// GET  /dashboard/settings     — HTMX partial: outbound/suppression/content/system levers (Phase F-2)

const express = require('express');
const path = require('path');
const router = express.Router();

// Sub-route partials
router.use('/today',       require('./today'));
router.use('/studio',      require('./studio'));
router.use('/approve',     require('./approve'));
router.use('/performance', require('./performance'));
router.use('/pipeline',    require('./pipeline'));
router.use('/design',      require('./design'));
router.use('/settings',    require('./settings'));

// Shell — serves public/dashboard/index.html
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/dashboard/index.html'));
});

// Stylesheet — the shell links /dashboard/styles.css but no static mount
// ever served it (the dashboard ran UNSTYLED in production until the UI
// consolidation). sendFile sets the text/css content-type.
router.get('/styles.css', (_req, res) => {
  res.sendFile(path.join(__dirname, '../../public/dashboard/styles.css'));
});

module.exports = router;
