// lib/reddit-crawlee.js — parseListing/parseThread against old.reddit-shaped
// HTML fixtures. Pure functions, no network, no crawler spin-up.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const cheerio = require('cheerio');

const { parseListing, parseThread } = require('../lib/reddit-crawlee');

// ── parseListing ──────────────────────────────────────────────────────────

const LISTING_HTML = `
<div id="siteTable">
  <div class="thing link" data-permalink="/r/bridging/comments/abc123/how_fast_can_i_get_a_bridge/" data-comments-count="14">
    <a class="title" href="/r/bridging/comments/abc123/">How fast can I get a bridging loan?</a>
  </div>
  <div class="thing link promoted" data-permalink="/r/bridging/comments/ad999/sponsored/" data-comments-count="0">
    <a class="title" href="#">Sponsored: amazing rates</a>
  </div>
  <div class="thing link" data-permalink="/r/bridging/comments/def456/exit_fees_question/" data-comments-count="3">
    <a class="title" href="/r/bridging/comments/def456/">Exit fees question</a>
  </div>
  <div class="thing link" data-permalink="/r/bridging/comments/ghi789/no_count/">
    <a class="title" href="/r/bridging/comments/ghi789/">Thread missing comment count attr</a>
  </div>
</div>`;

test('parseListing: extracts title, www permalink URL, comment count', () => {
  const threads = parseListing(cheerio.load(LISTING_HTML));
  assert.equal(threads.length, 3); // promoted ad skipped
  assert.equal(threads[0].title, 'How fast can I get a bridging loan?');
  assert.equal(threads[0].url, 'https://www.reddit.com/r/bridging/comments/abc123/how_fast_can_i_get_a_bridge/');
  assert.equal(threads[0].comment_count, 14);
});

test('parseListing: skips promoted posts', () => {
  const threads = parseListing(cheerio.load(LISTING_HTML));
  assert.ok(!threads.some(t => /Sponsored/.test(t.title)));
});

test('parseListing: missing comment count attr → 0', () => {
  const threads = parseListing(cheerio.load(LISTING_HTML));
  assert.equal(threads[2].comment_count, 0);
});

test('parseListing: empty page → []', () => {
  assert.deepEqual(parseListing(cheerio.load('<div id="siteTable"></div>')), []);
});

// ── parseThread ───────────────────────────────────────────────────────────

const THREAD_HTML = `
<div id="siteTable">
  <div class="thing link self">
    <a class="title">How fast can I get a bridging loan?</a>
    <div class="expando">
      <div class="usertext-body"><div class="md"><p>Auction purchase, 20 days to complete. Possible?</p></div></div>
    </div>
  </div>
</div>
<div class="commentarea">
  <div class="sitetable nestedlisting">
    <div class="thing comment">
      <div class="entry">
        <div class="usertext-body"><div class="md"><p>Yes — a good broker can do 10-14 days.</p></div></div>
      </div>
      <div class="child">
        <div class="sitetable">
          <div class="thing comment">
            <div class="entry"><div class="usertext-body"><div class="md"><p>NESTED reply — must not appear</p></div></div></div>
          </div>
        </div>
      </div>
    </div>
    <div class="thing comment">
      <div class="entry">
        <div class="usertext-body"><div class="md"><p>Watch the exit fees.</p></div></div>
      </div>
    </div>
  </div>
</div>`;

test('parseThread: extracts title, selftext, top-level comments only', () => {
  const t = parseThread(cheerio.load(THREAD_HTML));
  assert.equal(t.title, 'How fast can I get a bridging loan?');
  assert.match(t.selftext, /20 days to complete/);
  assert.equal(t.top_comments.length, 2);
  assert.match(t.top_comments[0], /10-14 days/);
  assert.match(t.top_comments[1], /exit fees/);
  assert.ok(!t.top_comments.some(c => /NESTED/.test(c)), 'nested replies must be excluded');
});

test('parseThread: caps comments at 8', () => {
  const many = Array.from({ length: 12 }, (_, i) => `
    <div class="thing comment"><div class="entry">
      <div class="usertext-body"><div class="md"><p>comment ${i}</p></div></div>
    </div></div>`).join('');
  const html = `
    <div id="siteTable"><div class="thing"><a class="title">T</a></div></div>
    <div class="commentarea"><div class="sitetable">${many}</div></div>`;
  const t = parseThread(cheerio.load(html));
  assert.equal(t.top_comments.length, 8);
});

test('parseThread: link post (no selftext) → empty selftext, comments intact', () => {
  const html = `
    <div id="siteTable"><div class="thing link"><a class="title">Link post</a></div></div>
    <div class="commentarea"><div class="sitetable">
      <div class="thing comment"><div class="entry">
        <div class="usertext-body"><div class="md"><p>First!</p></div></div>
      </div></div>
    </div></div>`;
  const t = parseThread(cheerio.load(html));
  assert.equal(t.title, 'Link post');
  assert.equal(t.selftext, '');
  assert.deepEqual(t.top_comments, ['First!']);
});

test('parseThread: unparseable page → null', () => {
  assert.equal(parseThread(cheerio.load('<html><body></body></html>')), null);
});
