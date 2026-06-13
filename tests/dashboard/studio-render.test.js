// lib/dashboard/studio-render.js — fragment rendering + escaping.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const render = require('../../lib/dashboard/studio-render');

const basePost = {
  id: 'abc-123',
  brand: 'auctionbrain',
  template_type: 'reel',
  platform: 'facebook',
  status: 'draft',
  copy_headline: 'Plain headline',
  copy_body: 'Body text',
  copy_cta: 'Click here',
  created_at: '2026-06-12T08:00:00Z',
};

test('renderCard escapes hostile copy', () => {
  const html = render.renderCard({
    ...basePost,
    copy_headline: '<script>alert(1)</script>',
    copy_body: `"quotes" & 'apostrophes'`,
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&quot;quotes&quot; &amp; &#39;apostrophes&#39;/);
});

test('renderMediaBlock prefers video, falls back to image, then placeholder', () => {
  const vid = render.renderMediaBlock({ ...basePost, video_url: 'v.mp4', image_url: 'i.png' });
  assert.match(vid, /<video src="\/output\/v\.mp4\?t=\d+"/);
  assert.match(vid, /video-badge/);

  const img = render.renderMediaBlock({ ...basePost, image_url: 'i.png' });
  assert.match(img, /<img src="\/output\/i\.png\?t=\d+"/);

  const none = render.renderMediaBlock(basePost);
  assert.match(none, /media-placeholder/);
});

test('renderGrid: cards for posts, empty-state otherwise', () => {
  const grid = render.renderGrid([basePost], {});
  assert.match(grid, /id="card-abc-123"/);
  assert.match(grid, /id="studio-grid"/);

  const empty = render.renderGrid([], {});
  assert.match(empty, /No drafts waiting/);
  assert.match(empty, /check back later/);

  const emptyFiltered = render.renderGrid([], { brand: 'auctionbrain' });
  assert.match(emptyFiltered, /changing the filters/);
});

test('renderFilterBar reflects current selection', () => {
  const bar = render.renderFilterBar({ brand: 'bridgematch', type: 'reel', q: 'rate "x"' });
  assert.match(bar, /value="bridgematch" selected/);
  assert.match(bar, /value="reel" selected/);
  assert.match(bar, /value="rate &quot;x&quot;"/);
});

test('card actions target the existing /api/social endpoints by id', () => {
  const html = render.renderCard(basePost);
  assert.match(html, /studioSaveCopy\('abc-123'/);
  assert.match(html, /studioApprove\('abc-123'/);
  assert.match(html, /studioReject\('abc-123'/);
  assert.match(html, /studioRerender\('abc-123'/);
});

test('settings row: persisted values selected, template default as placeholder', () => {
  const html = render.renderSettingsRow({
    ...basePost,
    meta: { duration_seconds: 15, visual_style: 'dark-tech', music_file: 'none' },
  });
  assert.match(html, /name="duration_seconds"[^>]*value="15"/);
  assert.match(html, /value="dark-tech" selected/);
  assert.match(html, /value="none" selected>Music: none/);
  assert.match(html, /hx-post="\/dashboard\/studio\/posts\/abc-123\/settings"/);
});

test('settings row: empty meta → empty inputs with reel default placeholder', () => {
  const html = render.renderSettingsRow(basePost); // reel → 6s default
  assert.match(html, /placeholder="6s"/);
  assert.match(html, /name="duration_seconds"[^>]*value=""/);
  assert.match(html, /<option value="" selected>Music: random<\/option>/);
});
