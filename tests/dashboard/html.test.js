// lib/dashboard/html.js — canonical HTML helper tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { escHtml, escAttr, fmtDate, relativeTime, chip, savedFlash, errorFlash } = require('../../lib/dashboard/html');

test('escHtml escapes all five specials', () => {
  assert.equal(escHtml(`<img src="x" onerror='a&b'>`),
    '&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;');
});

test('escHtml tolerates null/undefined/numbers', () => {
  assert.equal(escHtml(null), '');
  assert.equal(escHtml(undefined), '');
  assert.equal(escHtml(0), '0');
});

test('escAttr matches escHtml', () => {
  assert.equal(escAttr('"quoted"'), '&quot;quoted&quot;');
});

test('fmtDate renders UK short form and tolerates garbage', () => {
  assert.match(fmtDate('2026-06-12T10:00:00Z'), /12 Jun 2026/);
  assert.equal(fmtDate(null), '');
});

test('relativeTime buckets minutes/hours/days', () => {
  const now = Date.now();
  assert.equal(relativeTime(new Date(now - 30 * 1000).toISOString()), 'just now');
  assert.equal(relativeTime(new Date(now - 5 * 60000).toISOString()), '5m ago');
  assert.equal(relativeTime(new Date(now - 3 * 3600000).toISOString()), '3h ago');
  assert.equal(relativeTime(new Date(now - 2 * 86400000).toISOString()), '2d ago');
  assert.equal(relativeTime(null), '');
});

test('chip escapes label and class', () => {
  const html = chip('<b>x</b>', 'evil"cls');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /evil&quot;cls/);
});

test('savedFlash and errorFlash shapes', () => {
  assert.match(savedFlash(), /class="saved-flash"/);
  assert.match(errorFlash('<oops>'), /&lt;oops&gt;/);
});
