'use strict';

// lib/dashboard/html.js — canonical HTML helpers for every dashboard
// fragment renderer. This is the ONE escHtml: routes/dashboard/* and
// lib/dashboard/*-render.js must require from here rather than redefining
// it (it had drifted into 7 copies). Telegram-context escapers elsewhere
// are a different output context and stay separate.

/** Escape a value for HTML text content. */
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** Escape a value for use inside a double-quoted HTML attribute. */
function escAttr(s) {
  return escHtml(s);
}

/** "3 Jun 2026" — compact UK date for card metadata. */
function fmtDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return '';
  }
}

/** "4h ago" / "3d ago" — relative time for activity rows. */
function relativeTime(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/** Small uppercase chip, e.g. brand / template / platform badges. */
function chip(label, cls = '') {
  return `<span class="chip ${escAttr(cls)}">${escHtml(label)}</span>`;
}

/** Inline saved-flash span — toggled visible by replacing class via withSavedFlash(). */
function savedFlash() {
  return '<span class="saved-flash">Saved ✓</span>';
}

/** Standalone error fragment for send400/send500 responses. */
function errorFlash(message) {
  return `<p class="error-flash">${escHtml(message)}</p>`;
}

module.exports = { escHtml, escAttr, fmtDate, relativeTime, chip, savedFlash, errorFlash };
