// lib/reddit-scraper.js — contract tests against the REAL reddit-briefs
// scoring (the promotion pipeline must keep working unchanged), plus
// orchestrator paths with mocked firecrawl + supabase + runtime-config.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const SCRAPER_PATH = require.resolve('../lib/reddit-scraper');
const FIRECRAWL_PATH = require.resolve('../lib/firecrawl');
const CRAWLEE_PATH = require.resolve('../lib/reddit-crawlee');
const SUPABASE_PATH = require.resolve('../lib/supabase');
const RUNTIME_CFG_PATH = require.resolve('../lib/runtime-config');
const BRIEFS_PATH = require.resolve('../lib/reddit-briefs');

let mockState;

function makeCrawleeMock() {
  return {
    fetchSubredditListingCrawlee: async (sub) => {
      mockState.crawleeCalls.push(`listing:${sub}`);
      if (mockState.crawleeFailSubs.includes(sub)) throw new Error(`crawlee mock failure for r/${sub}`);
      return mockState.crawleeListings[sub] || [];
    },
    fetchThreadCrawlee: async (url) => {
      mockState.crawleeCalls.push(`thread:${url}`);
      const key = Object.keys(mockState.crawleeThreads).find(k => url.includes(k));
      return key ? mockState.crawleeThreads[key] : null;
    },
  };
}

function makeFirecrawlMock() {
  return {
    isFirecrawlConfigured: () => mockState.firecrawlConfigured,
    firecrawlScrape: async (url) => {
      mockState.scrapeCalls.push(url);
      if (mockState.failUrls.some(f => url.includes(f))) {
        throw new Error(`mock failure for ${url}`);
      }
      if (url.includes('/top/?t=')) {
        const sub = url.match(/\/r\/([^/]+)\//)[1];
        return { json: { threads: mockState.listings[sub] || [] } };
      }
      // thread fetch
      const key = Object.keys(mockState.threads).find(k => url.includes(k));
      return { json: key ? mockState.threads[key] : null };
    },
  };
}

function makeSupabaseMock() {
  const bm = mockState.bmClientPresent ? {
    from: () => ({
      select: () => ({
        in: async () => ({ data: mockState.existingRows, error: null }),
      }),
      insert: async (row) => {
        mockState.inserts.push(row);
        return { error: null };
      },
    }),
  } : null;
  return { supabase: {}, supabaseBridgematch: bm };
}

function loadScraperFresh({ realBriefs = false } = {}) {
  for (const p of [SCRAPER_PATH, FIRECRAWL_PATH, CRAWLEE_PATH, SUPABASE_PATH, RUNTIME_CFG_PATH, BRIEFS_PATH]) {
    delete require.cache[p];
  }
  require.cache[FIRECRAWL_PATH] = { id: FIRECRAWL_PATH, filename: FIRECRAWL_PATH, loaded: true, exports: makeFirecrawlMock() };
  require.cache[CRAWLEE_PATH] = { id: CRAWLEE_PATH, filename: CRAWLEE_PATH, loaded: true, exports: makeCrawleeMock() };
  require.cache[SUPABASE_PATH] = { id: SUPABASE_PATH, filename: SUPABASE_PATH, loaded: true, exports: makeSupabaseMock() };
  require.cache[RUNTIME_CFG_PATH] = {
    id: RUNTIME_CFG_PATH, filename: RUNTIME_CFG_PATH, loaded: true,
    exports: { getRedditSubreddits: async () => mockState.subredditLever },
  };
  if (!realBriefs) {
    require.cache[BRIEFS_PATH] = {
      id: BRIEFS_PATH, filename: BRIEFS_PATH, loaded: true,
      exports: {
        promoteRedditThreadsToBriefs: async () => { mockState.promoteCalled++; return { promoted: 2 }; },
        scoreThread: () => ({ score: 0, commentCount: 0, cleanTitle: '' }),
      },
    };
  }
  return require('../lib/reddit-scraper');
}

beforeEach(() => {
  mockState = {
    firecrawlConfigured: true,
    bmClientPresent: true,
    subredditLever: null, // null → DEFAULT_SUBREDDITS
    listings: {},
    threads: {},
    existingRows: [],
    inserts: [],
    scrapeCalls: [],
    failUrls: [],
    promoteCalled: 0,
    // Crawlee fallback fixtures
    crawleeCalls: [],
    crawleeListings: {},
    crawleeThreads: {},
    crawleeFailSubs: [],
  };
});

// ── buildArticleRow — CONTRACT with the real reddit-briefs ───────────────

test('buildArticleRow: scoreThread round-trips comment count and clean title', () => {
  // Real reddit-briefs requires lib/supabase — mock it, but use REAL briefs.
  delete require.cache[BRIEFS_PATH];
  delete require.cache[SUPABASE_PATH];
  require.cache[SUPABASE_PATH] = { id: SUPABASE_PATH, filename: SUPABASE_PATH, loaded: true, exports: makeSupabaseMock() };
  const { scoreThread } = require('../lib/reddit-briefs');

  delete require.cache[SCRAPER_PATH];
  delete require.cache[FIRECRAWL_PATH];
  delete require.cache[RUNTIME_CFG_PATH];
  require.cache[FIRECRAWL_PATH] = { id: FIRECRAWL_PATH, filename: FIRECRAWL_PATH, loaded: true, exports: makeFirecrawlMock() };
  require.cache[RUNTIME_CFG_PATH] = { id: RUNTIME_CFG_PATH, filename: RUNTIME_CFG_PATH, loaded: true, exports: { getRedditSubreddits: async () => null } };
  const { buildArticleRow } = require('../lib/reddit-scraper');

  const row = buildArticleRow('bridging', {
    url: 'https://www.reddit.com/r/bridging/comments/abc123/',
    title: 'How do I get a bridging loan fast?',
    selftext: 'Looking at an auction purchase, 20 days to complete.',
    top_comments: ['Talk to a broker.', 'Rates are 0.9-1.2%/mo.', 'Watch the exit fees.'],
  });

  // Title prefix must match the [Reddit r/<sub>] convention exactly
  const subMatch = row.title.match(/^\[Reddit r\/([^\]]+)\]/);
  assert.ok(subMatch, 'title must carry the [Reddit r/<sub>] prefix');
  assert.equal(subMatch[1], 'bridging');

  // scoreThread (REAL implementation) must count exactly our comments
  const scored = scoreThread(row);
  assert.equal(scored.commentCount, 3, 'comment bullets must round-trip through scoreThread');
  assert.equal(scored.cleanTitle, 'How do I get a bridging loan fast?');
  // Question-shaped title should score (ends with ? = +5, "how" prefix = +5)
  assert.ok(scored.score >= 10);
});

test('buildArticleRow: caps comments at 8 and truncates long ones', () => {
  const { buildArticleRow } = loadScraperFresh();
  const row = buildArticleRow('HousingUK', {
    url: 'https://www.reddit.com/r/HousingUK/comments/zzz/',
    title: 'T',
    selftext: '',
    top_comments: Array.from({ length: 12 }, (_, i) => `comment ${i} ` + 'x'.repeat(400)),
  });
  const bullets = row.content.match(/^•\s/gm) || [];
  assert.equal(bullets.length, 8);
  for (const line of row.content.split('\n')) {
    assert.ok(line.length <= 290, `bullet line too long: ${line.length}`);
  }
});

// ── canonicalThreadUrl ───────────────────────────────────────────────────

test('canonicalThreadUrl: normalises old.reddit, query strings, deep paths', () => {
  const { canonicalThreadUrl } = loadScraperFresh();
  const want = 'https://www.reddit.com/r/bridging/comments/abc123/';
  assert.equal(canonicalThreadUrl('https://old.reddit.com/r/bridging/comments/abc123/some_slug/?ref=share'), want);
  assert.equal(canonicalThreadUrl('https://www.reddit.com/r/bridging/comments/abc123'), want);
  assert.equal(canonicalThreadUrl('https://reddit.com/r/bridging/comments/abc123/slug'), want);
  assert.equal(canonicalThreadUrl('https://www.reddit.com/r/bridging/'), null);
  assert.equal(canonicalThreadUrl(null), null);
});

// ── runRedditScrape orchestrator ─────────────────────────────────────────

function seedHappyPath() {
  mockState.subredditLever = ['bridging', 'HousingUK'];
  mockState.listings = {
    bridging: [
      { title: 'Thread A?', url: 'https://old.reddit.com/r/bridging/comments/aaa/slug/', comment_count: 5 },
    ],
    HousingUK: [
      { title: 'Thread B', url: 'https://old.reddit.com/r/HousingUK/comments/bbb/slug/', comment_count: 2 },
    ],
  };
  mockState.threads = {
    '/comments/aaa': { title: 'Thread A?', selftext: 'body A', top_comments: ['c1', 'c2'] },
    '/comments/bbb': { title: 'Thread B', selftext: 'body B', top_comments: ['c1'] },
  };
}

test('runRedditScrape: inserts new threads and promotes', async () => {
  seedHappyPath();
  const { runRedditScrape } = loadScraperFresh();
  const res = await runRedditScrape();

  assert.equal(res.subs, 2);
  assert.equal(res.listed, 2);
  assert.equal(res.inserted, 2);
  assert.equal(res.skipped, 0);
  assert.equal(res.promoted, 2);
  assert.equal(mockState.promoteCalled, 1);
  // Inserted rows carry canonical www URLs and the title prefix
  assert.match(mockState.inserts[0].url, /^https:\/\/www\.reddit\.com\/r\/bridging\/comments\/aaa\/$/);
  assert.match(mockState.inserts[0].title, /^\[Reddit r\/bridging\] /);
});

test('runRedditScrape: skips URLs already in scraped_articles', async () => {
  seedHappyPath();
  mockState.existingRows = [{ url: 'https://www.reddit.com/r/bridging/comments/aaa/' }];
  const { runRedditScrape } = loadScraperFresh();
  const res = await runRedditScrape();

  assert.equal(res.skipped, 1);
  assert.equal(res.inserted, 1);
  assert.equal(mockState.inserts.length, 1);
  assert.match(mockState.inserts[0].title, /HousingUK/);
});

test('runRedditScrape: BM client missing → no_bm_client, zero firecrawl calls', async () => {
  mockState.bmClientPresent = false;
  const { runRedditScrape } = loadScraperFresh();
  const res = await runRedditScrape();
  assert.equal(res.reason, 'no_bm_client');
  assert.equal(mockState.scrapeCalls.length, 0);
});

test('runRedditScrape: Firecrawl key unset → proceeds via Crawlee fallback', async () => {
  mockState.firecrawlConfigured = false;
  mockState.subredditLever = ['bridging'];
  mockState.crawleeListings = {
    bridging: [{ title: 'Crawlee thread?', url: 'https://www.reddit.com/r/bridging/comments/ccc/slug/', comment_count: 4 }],
  };
  mockState.crawleeThreads = {
    '/comments/ccc': { title: 'Crawlee thread?', selftext: 'body', top_comments: ['c1'] },
  };
  const { runRedditScrape } = loadScraperFresh();
  const res = await runRedditScrape();

  assert.equal(res.inserted, 1);
  assert.equal(mockState.scrapeCalls.length, 0, 'Firecrawl must not be called when unconfigured');
  assert.ok(mockState.crawleeCalls.includes('listing:bridging'));
  assert.match(mockState.inserts[0].title, /^\[Reddit r\/bridging\] /);
});

test('runRedditScrape: Firecrawl error → Crawlee fallback used for that call', async () => {
  seedHappyPath();
  mockState.failUrls = ['/r/bridging/top']; // Firecrawl listing fails for bridging only
  mockState.crawleeListings = {
    bridging: [{ title: 'Thread A?', url: 'https://old.reddit.com/r/bridging/comments/aaa/slug/', comment_count: 5 }],
  };
  const { runRedditScrape } = loadScraperFresh();
  const res = await runRedditScrape();

  // Both threads land: bridging via Crawlee, HousingUK via Firecrawl
  assert.equal(res.inserted, 2);
  assert.equal(res.errors.length, 0, 'fallback success means no recorded error');
  assert.ok(mockState.crawleeCalls.includes('listing:bridging'));
  assert.ok(!mockState.crawleeCalls.includes('listing:HousingUK'), 'healthy Firecrawl sub must not hit Crawlee');
});

test('runRedditScrape: one sub failing on BOTH paths does not sink the others', async () => {
  seedHappyPath();
  mockState.failUrls = ['/r/bridging/top'];   // Firecrawl fails for bridging
  mockState.crawleeFailSubs = ['bridging'];   // ...and so does Crawlee
  const { runRedditScrape } = loadScraperFresh();
  const res = await runRedditScrape();

  assert.equal(res.inserted, 1); // HousingUK still processed
  assert.equal(res.errors.length, 1);
  assert.match(res.errors[0], /listing r\/bridging/);
});

test('runRedditScrape: no promotion call when nothing inserted', async () => {
  mockState.subredditLever = ['bridging'];
  mockState.listings = { bridging: [] };
  const { runRedditScrape } = loadScraperFresh();
  const res = await runRedditScrape();
  assert.equal(res.reason, 'no_threads');
  assert.equal(mockState.promoteCalled, 0);
});
