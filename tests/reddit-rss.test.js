const { test } = require('node:test');
const assert = require('node:assert/strict');

const { parseListingRss, parseThreadRss, fetchRss } = require('../lib/reddit-rss');

const FEED_OPEN = '<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">';
const FEED_CLOSE = '</feed>';

test('parseListingRss extracts canonical thread links and listing selftext', () => {
  const xml = `${FEED_OPEN}<entry>
    <title>Seller said no chain</title>
    <link href="https://www.reddit.com/r/HousingUK/comments/abc123/seller_said_no_chain/" />
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;First time buyer body.&lt;/p&gt;&lt;/div&gt;</content>
  </entry>${FEED_CLOSE}`;
  assert.deepEqual(parseListingRss(xml), [{
    title: 'Seller said no chain',
    url: 'https://www.reddit.com/r/HousingUK/comments/abc123/seller_said_no_chain/',
    comment_count: 0,
    selftext: 'First time buyer body.',
  }]);
});

test('parseThreadRss returns post body and skips AutoModerator comments', () => {
  const xml = `${FEED_OPEN}
    <entry><title>Auction deadline question</title><author><name>/u/owner</name></author><content type="html">&lt;div class="md"&gt;&lt;p&gt;Need to complete in 20 days.&lt;/p&gt;&lt;/div&gt;</content></entry>
    <entry><title>/u/AutoModerator on Auction deadline question</title><author><name>/u/AutoModerator</name></author><content type="html">&lt;div class="md"&gt;&lt;p&gt;Rules&lt;/p&gt;&lt;/div&gt;</content></entry>
    <entry><title>/u/helpful on Auction deadline question</title><author><name>/u/helpful</name></author><content type="html">&lt;div class="md"&gt;&lt;p&gt;Speak to your solicitor.&lt;/p&gt;&lt;/div&gt;</content></entry>
  ${FEED_CLOSE}`;
  assert.deepEqual(parseThreadRss(xml), {
    title: 'Auction deadline question',
    selftext: 'Need to complete in 20 days.',
    top_comments: ['Speak to your solicitor.'],
  });
});

test('parseListingRss strips Reddit attribution boilerplate from link posts', () => {
  const xml = `${FEED_OPEN}<entry>
    <title>External link</title>
    <link href="https://www.reddit.com/r/HousingUK/comments/xyz987/external_link/" />
    <content type="html">&lt;p&gt;submitted by /u/name&lt;/p&gt;&lt;a href="https://example.com"&gt;[link]&lt;/a&gt;</content>
  </entry>${FEED_CLOSE}`;
  assert.equal(parseListingRss(xml)[0].selftext, '');
});

test('fetchRss retries a 403 through old.reddit.com and sets a request timeout', async () => {
  const originalFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return { ok: false, status: 403, headers: { get: () => null } };
    }
    return { ok: true, status: 200, text: async () => '<feed />' };
  };
  try {
    assert.equal(await fetchRss('https://www.reddit.com/r/test/top/.rss'), '<feed />');
    assert.match(calls[1].url, /^https:\/\/old\.reddit\.com\//);
    assert.ok(calls.every(call => call.options.signal instanceof AbortSignal));
  } finally {
    global.fetch = originalFetch;
  }
});
