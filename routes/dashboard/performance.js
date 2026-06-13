'use strict';

// routes/dashboard/performance.js
//
// GET /dashboard/performance — HTMX partial: the Performance tab content.
// Returns an HTML fragment loaded into #tab-content. The fragment itself
// hits GET /api/dashboard/performance/metrics?window=<7d|30d|all> for the
// numbers, so window-selector changes don't reload the whole tab — only
// the inner #perf-content panel swaps.
//
// Auth: inherited from the parent dashboard router (requireAuth in
// server.js). Same scrypt password as Today / Approve / Pipeline —
// Simon-only, per Phase D OQ §5.3.
//
// Layout reference: .ruflo/phase-d-design.md §4.3 — two halves:
//   1. Content engagement (posts published, FB reach + engagement, top-3)
//   2. Outbound conversion (3-column funnel: lender / broker / auction_house)
//
// All numbers come from lib/dashboard/performance-queries.js (the coder
// writes the SQL helpers there; this route is the render layer only).
// SQL sketches and the 28 queries-per-page-load budget are in §4.4 of
// the design doc.

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Cache the template at module load — it's a few KB, never changes at
// runtime, and reading it on every request would be needless I/O.
const TEMPLATE_PATH = path.join(__dirname, 'performance.html');
let TEMPLATE_CACHE = null;
function getTemplate() {
  if (TEMPLATE_CACHE == null) {
    TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return TEMPLATE_CACHE;
}

/**
 * GET /dashboard/performance
 *
 * Returns the Performance tab's HTML fragment. The fragment includes:
 *   - the window selector (7d / 30d / all radios) with HTMX hooks
 *   - an empty #perf-content div whose hx-trigger="load" fires immediately
 *     to fetch the default window (7d) via /api/dashboard/performance/metrics
 *
 * No DB queries here — the metrics endpoint owns those. This route is
 * pure markup. Keep it that way; queries belong in
 * lib/dashboard/performance-queries.js so they're testable in isolation.
 */
router.get('/', (req, res) => {
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(getTemplate());
  } catch (err) {
    console.error('[dashboard/performance] template read error:', err.message);
    res.status(500).send(`<p class="error">Failed to load Performance tab: ${escHtml(err.message)}</p>`);
  }
});

const { escHtml } = require('../../lib/dashboard/html');

module.exports = router;
