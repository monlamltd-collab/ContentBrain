'use strict';

// lib/dashboard/design-queries.js — data layer for the Design tab (the
// /levers control panel, consolidated into the dashboard). All state lives
// in app_config via lib/runtime-config; this module only aggregates reads
// and hosts the AI pattern drafter shared with the legacy JSON endpoint.

const runtimeConfig = require('../runtime-config');
const { THEMES, THEME_NAMES, DEFAULT_THEME_NAME } = require('../themes');
const { ARCHETYPES, DEFAULT_SCHEDULE } = require('../lot-picker');
const { brands: defaultBrands, templateTypes } = require('../config');
const { supabase } = require('../supabase');
const { createLLM } = require('../llm');

const BRAND_LIST = Object.keys(defaultBrands);

/** Everything the Design tab renders, in one read. */
async function getDesignSnapshot() {
  const perBrand = {};
  for (const brand of BRAND_LIST) {
    const [tone, messages, audience, directive, visualDirective] = await Promise.all([
      runtimeConfig.getBrandTone(brand),
      runtimeConfig.getBrandMessages(brand),
      runtimeConfig.getBrandAudience(brand),
      runtimeConfig.getBrandDirective(brand),
      runtimeConfig.getBrandVisualDirective(brand),
    ]);
    perBrand[brand] = {
      name: defaultBrands[brand].name,
      url: defaultBrands[brand].url,
      tone,
      audience,
      directive,
      visual_directive: visualDirective,
      messages: Array.isArray(messages) ? messages : [],
    };
  }

  const [activeBrands, templateWeights, templateDurations, hookPatterns, ctaPatterns] = await Promise.all([
    runtimeConfig.getActiveBrands(),
    runtimeConfig.getTemplateWeights(),
    runtimeConfig.getTemplateDurations(),
    runtimeConfig.getHookPatterns(),
    runtimeConfig.getCtaPatterns(),
  ]);

  // Schedule lever has no runtime-config helper — read app_config directly
  // (same approach as the legacy GET /api/levers).
  let lotSchedule = DEFAULT_SCHEDULE;
  try {
    const { data } = await supabase
      .from('app_config')
      .select('value')
      .eq('brand', 'global')
      .eq('key', 'lot_archetype_schedule')
      .maybeSingle();
    if (Array.isArray(data?.value) && data.value.length === 7) lotSchedule = data.value;
  } catch { /* default schedule */ }

  // Higgsfield levers (AI media) — same direct-read approach.
  const readLever = async (brand, key) => {
    const { data } = await supabase
      .from('app_config').select('value')
      .eq('brand', brand).eq('key', key).maybeSingle();
    return data ? data.value : null;
  };
  const higgsfield = { perBrand: {}, daily_cap: 20, auto_mode: false };
  try {
    const cap = Number(await readLever('global', 'higgsfield.daily_cap'));
    if (Number.isFinite(cap) && cap > 0) higgsfield.daily_cap = cap;
    higgsfield.auto_mode = (await readLever('global', 'higgsfield.auto_mode')) === true;
    for (const brand of BRAND_LIST) {
      higgsfield.perBrand[brand] = {
        style_prefix: (await readLever(brand, 'higgsfield.style_prefix')) || '',
        default_aspect: (await readLever(brand, 'higgsfield.default_aspect')) || '',
      };
    }
  } catch { /* defaults stand */ }

  return {
    brands: BRAND_LIST,
    perBrand,
    global: {
      active_brands: activeBrands,
      template_weights: templateWeights,
      template_durations: templateDurations,
      hook_patterns: hookPatterns,
      cta_patterns: ctaPatterns,
      lot_archetype_schedule: lotSchedule,
    },
    higgsfield,
    menus: {
      themes: THEME_NAMES.map(n => ({
        name: n,
        label: THEMES[n].label,
        description: THEMES[n].description,
        isDefault: n === DEFAULT_THEME_NAME,
      })),
      archetypes: ARCHETYPES,
      templateTypes,
    },
  };
}

/** Recent published blogs across both brands with public URLs. */
async function getLiveBlogs() {
  const { getPublishedBlogPostsBothBrands } = require('../supabase');
  const posts = await getPublishedBlogPostsBothBrands();
  const BRAND_BLOG_URL = {
    auctionbrain: 'https://www.auctionbrain.co.uk/blog',
    bridgematch: 'https://bridgematch.co.uk/blog',
  };
  return posts.slice(0, 60).map(p => ({
    id: p.id,
    title: p.title,
    slug: p.slug,
    brand: p.brand,
    published_at: p.published_at,
    url: `${BRAND_BLOG_URL[p.brand] || BRAND_BLOG_URL.auctionbrain}/${p.slug}`,
  }));
}

/**
 * AI-assisted pattern drafter — single source of truth for BOTH the Design
 * tab fragment and the legacy POST /api/levers/pattern/draft endpoint.
 * Returns the suggested pattern body string; throws on invalid input.
 */
async function draftPattern(type, idea) {
  if (type !== 'hook' && type !== 'cta') throw new Error('type must be "hook" or "cta"');
  if (!idea || typeof idea !== 'string' || !idea.trim()) throw new Error('idea required');

  const existing = type === 'hook'
    ? await runtimeConfig.getHookPatterns()
    : await runtimeConfig.getCtaPatterns();
  const brand = await runtimeConfig.getResolvedBrand('auctionbrain');

  const examples = existing.slice(0, 8).map(p => `- ${p.body}`).join('\n');

  const formatGuide = type === 'hook'
    ? 'Each pattern is a single line: "NAME — short description with a concrete example in parentheses or quotes". The NAME is 2–4 words in CAPS. The description names the rhetorical move. The example is a specific, plausible UK property auction sentence.'
    : 'Each pattern is a single line: "NAME — short description, then a quoted CTA example pointing at auctionbrain.co.uk or bridgematch.co.uk". The NAME is 2–4 words in CAPS. The example must promise something specific (not a bare URL).';

  const system = `You design ${type === 'hook' ? 'hook' : 'CTA'} patterns for a UK property auction social-content pipeline (AuctionBrain).
AUDIENCE: ${brand.audience}
TONE: ${brand.tone}

${formatGuide}
Return ONE pattern body only — no preamble, no markdown, no surrounding quotes, no numbered label, just the pattern line itself.`;

  const user = `Existing patterns (do not duplicate the rhetorical move of any of these):
${examples}

The operator wants a new pattern based on this rough idea:
"${idea.trim()}"

Write ONE new pattern in the existing format. Output the pattern body only.`;

  const response = await createLLM().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 250,
    system,
    messages: [{ role: 'user', content: user }],
  });

  const text = (response.content || []).find(b => b.type === 'text')?.text || '';
  const suggestion = text
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^[0-9]+[.)]\s+/, '')
    .replace(/^[A-Z][.)]\s+/, '')
    .trim();
  if (!suggestion) throw new Error('Claude returned an empty draft');
  return suggestion;
}

module.exports = { getDesignSnapshot, getLiveBlogs, draftPattern, BRAND_LIST };
