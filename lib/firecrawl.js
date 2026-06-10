// lib/firecrawl.js — thin Firecrawl v2 API client (plain fetch, no SDK).
//
// Consumers: lib/reddit-scraper.js (subreddit listings + threads) and
// lib/sales-brain/import-brokers.js (broker contact enrichment).
//
// JSON extraction: pass formats: [{ type: 'json', schema, prompt }] and the
// extracted object comes back on data.json — this is the house mechanism for
// all scraping (no custom DOM parsing).

require('dotenv').config();

const API_BASE = 'https://api.firecrawl.dev/v2';

function isFirecrawlConfigured() {
  return !!process.env.FIRECRAWL_API_KEY;
}

/**
 * Scrape a URL via Firecrawl.
 * @param {string} url
 * @param {object} [opts]
 * @param {Array}  [opts.formats]   e.g. ['markdown'] or [{ type:'json', schema, prompt }]
 * @param {number} [opts.timeoutMs] request timeout (default 60s)
 * @returns {Promise<object>} the Firecrawl `data` object ({ markdown, json, metadata, ... })
 */
async function firecrawlScrape(url, { formats = ['markdown'], timeoutMs = 60000 } = {}) {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) throw new Error('FIRECRAWL_API_KEY not set');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${API_BASE}/scrape`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`,
      },
      body: JSON.stringify({ url, formats }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Firecrawl ${res.status} for ${url}: ${errText.slice(0, 300)}`);
    }

    const payload = await res.json();
    if (!payload.success || !payload.data) {
      throw new Error(`Firecrawl returned success=false for ${url}: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    return payload.data;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { firecrawlScrape, isFirecrawlConfigured };
