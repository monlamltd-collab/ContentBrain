// lib/dashboard/design-render.js — Design tab fragment rendering.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const render = require('../../lib/dashboard/design-render');

const snapshot = {
  brands: ['auctionbrain', 'bridgematch'],
  perBrand: {
    auctionbrain: {
      name: 'AuctionBrain', url: 'https://auctionbrain.co.uk',
      tone: 'sharp & <bold>', audience: 'investors', directive: '', visual_directive: '',
      messages: ['168 houses', 'free'],
    },
    bridgematch: {
      name: 'BridgeMatch', url: 'https://bridgematch.co.uk',
      tone: '', audience: '', directive: '', visual_directive: '', messages: [],
    },
  },
  global: {
    active_brands: ['auctionbrain'],
    template_weights: { stat: 2, hook: 1, list: 1, reel: 3 },
    hook_patterns: [{ body: 'HOOK ONE — "<quoted>"' }],
    cta_patterns: [{ body: 'CTA ONE — visit site' }],
    lot_archetype_schedule: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
  },
  menus: {
    themes: [{ name: 'dark-tech', label: 'Dark', description: '', isDefault: true }],
    archetypes: ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
    templateTypes: ['stat', 'hook', 'list', 'reel'],
  },
};

test('renderDesignTab includes every section', () => {
  const html = render.renderDesignTab(snapshot);
  for (const id of ['voice', 'patterns', 'mix', 'schedule', 'triggers', 'blogs']) {
    assert.match(html, new RegExp(`id="design-${id}"`), `section ${id}`);
  }
});

test('brand card escapes lever text and shows active state', () => {
  const html = render.renderBrandCard('auctionbrain', snapshot.perBrand.auctionbrain, true);
  assert.match(html, /sharp &amp; &lt;bold&gt;/);
  assert.match(html, /168 houses\nfree/);
  assert.match(html, /checked/);
  const paused = render.renderBrandCard('bridgematch', snapshot.perBrand.bridgematch, false);
  assert.match(paused, /Paused/);
});

test('pattern list renders rows with remove forms and escapes bodies', () => {
  const html = render.renderPatternList('hook', snapshot.global.hook_patterns);
  assert.match(html, /HOOK ONE — &quot;&lt;quoted&gt;&quot;/);
  assert.match(html, /patterns\/hook\/remove/);
  assert.match(html, /name="index" value="0"/);
});

test('draft prefill injects the suggestion into the add input', () => {
  const html = render.renderPatternListWithDraft('cta', snapshot.global.cta_patterns, 'NEW IDEA — "do it"');
  assert.match(html, /value="NEW IDEA — &quot;do it&quot;"/);
});

test('mix section reflects weights; schedule marks selected archetypes', () => {
  const mix = render.renderMixSection(snapshot);
  assert.match(mix, /name="weight_reel"[^>]*value="3"/);
  const sched = render.renderScheduleSection(snapshot);
  assert.match(sched, /<option value="a" selected>/);
});

test('live blogs list escapes titles and links out', () => {
  const html = render.renderLiveBlogs([
    { brand: 'auctionbrain', title: 'A <title>', url: 'https://x/y', published_at: '2026-06-01T00:00:00Z' },
  ]);
  assert.match(html, /A &lt;title&gt;/);
  assert.match(html, /target="_blank"/);
});
