// lib/dashboard/editorial-render.js — Editorial tab fragments (PR4).
const { test } = require('node:test');
const assert = require('node:assert/strict');

const render = require('../../lib/dashboard/editorial-render');

test('coverage: chips classify covered vs saturated and escape tags', () => {
  const html = render.renderCoverage({
    posts: 5,
    coverage: [
      { tag: 'bridging<script>', count: 4, status: 'saturated' },
      { tag: 'auctions', count: 1, status: 'covered' },
    ],
  }, 'bridgematch');
  assert.match(html, /tag-chip saturated/);
  assert.match(html, /tag-chip covered/);
  assert.match(html, /bridging&lt;script&gt;/);
  assert.match(html, /5 published posts/);
  // brand filter reflects selection
  assert.match(html, /coverage\?brand=bridgematch"[^>]*>BridgeMatch/);
});

test('coverage: empty state', () => {
  const html = render.renderCoverage({ posts: 0, coverage: [] }, '');
  assert.match(html, /No published posts yet/);
});

test('draft card: escapes title/summary, wires brand+id actions, shows score', () => {
  const html = render.renderDraftCard({
    id: 'd-1', brand: 'bridgematch', title: 'A <b>title</b>', summary: 'S & co',
    created_at: '2026-06-13T08:00:00Z', post_type: 'blog', evaluation_score: 9,
  });
  assert.match(html, /A &lt;b&gt;title&lt;\/b&gt;/);
  assert.match(html, /S &amp; co/);
  assert.match(html, /edApprove\('bridgematch','d-1'/);
  assert.match(html, /edReject\('bridgematch','d-1'/);
  assert.match(html, /draft-score pass/);
  assert.match(html, /9\/10/);
});

test('draft card: unknown brand falls back to auctionbrain; sub-8 score not pass', () => {
  const html = render.renderDraftCard({ id: 'd2', brand: 'evil', title: 'T', evaluation_score: 6 });
  assert.match(html, /edApprove\('auctionbrain','d2'/);
  assert.match(html, /draft-score">6\/10/);
});

test('queue + briefs: lists and empty states', () => {
  assert.match(render.renderDraftQueue([]), /No drafts waiting/);
  assert.match(render.renderBriefQueue([]), /No briefs queued/);
  const briefs = render.renderBriefQueue([
    { id: 'b1', topic: 'Rates <x>', message: 'Watch the MPC & note swaps', brand: 'auctionbrain', created_at: '2026-06-12T10:00:00Z' },
  ]);
  assert.match(briefs, /Rates &lt;x&gt;/);
  assert.match(briefs, /Watch the MPC &amp; note swaps/);
  assert.match(briefs, /edDismissBrief\('b1'/);
});
