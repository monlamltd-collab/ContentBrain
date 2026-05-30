'use strict';
// routes/dashboard/index.js
//
// Mounts the dashboard sub-routes and serves the shell HTML.
//
// GET  /dashboard              — full-page shell (loads HTMX, shows Today tab by default)
// GET  /dashboard/today        — HTMX partial: posts awaiting review
// GET  /dashboard/approve      — HTMX partial: approved posts queued for publish
// GET  /dashboard/performance  — HTMX partial: content + outbound metrics (Phase D)
// GET  /dashboard/pipeline     — HTMX partial: reply triage + sequence state (Phase F-1)

const express = require('express');
const path = require('path');
const router = express.Router();

// Sub-route partials
router.use('/today',       require('./today'));
router.use('/approve',     require('./approve'));
router.use('/performance', require('./performance'));
router.use('/pipeline',    require('./pipeline'));

// Shell — serves public/dashboard/index.html
router.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../../public/dashboard/index.html'));
});

module.exports = router;
