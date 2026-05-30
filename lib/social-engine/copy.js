// Phase G — social-engine copywriter.
//
// Mirror of Phase B's lib/generate-outbound.js shape (lazy Anthropic client,
// MAX_RETRIES=2 filter-retry loop, regenHints carrying block reasons into
// the next attempt). Differs on three axes:
//   1. mode='social' on the filter call — runs the SOCIAL_BANS / FCA-
//      context regex set, skips NAME_GUESS + invented-amounts.
//   2. system prompt absorbs the "Unloved Britain" persona block at the
//      END (strongest recency anchor) AFTER getResolvedBrand('auctionbrain')
//      so /tone, /messages, /directive Telegram levers still bite.
//   3. JSON shape differs by socialType — niche-hook / hero-album /
//      regional-roundup return list+frame_captions; curiosity-gap /
//      data-shock return micro_stat + micro_caption; lot-of-day-traffic +
//      superlative-reel DELEGATE to the existing generateLotContent in
//      lib/lot-content.js (their prompt already exists, don't fork it).
//
// The copywriter does NOT render. It returns enriched copy + a meta_additions
// stamp; the orchestrator calls renderer.renderPost / renderAlbum.

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { runFilters } = require('../outbound-filters');
const {
  SOCIAL_MODES,
  SOCIAL_TYPES,
  SOCIAL_TYPE_LIST,
  BRAND_VOICE_NAME,
  BRAND_VOICE_TAGLINE,
  BRAND_VOICE_URL,
  NICHE_TAG_LABELS,
} = require('./constants');

const MODEL = 'claude-haiku-4-5-20251001';
const MAX_RETRIES = 2; // total 3 attempts — matches Phase B

// Lazy clients — same pattern as generate-outbound.js so the module can be
// require()'d in tests without instantiating an Anthropic client.
let _anthropic = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropic;
}

let _runtimeConfig = null;
function getRuntimeConfig() {
  if (!_runtimeConfig) _runtimeConfig = require('../runtime-config');
  return _runtimeConfig;
}

let _themes = null;
function getThemes() {
  if (!_themes) _themes = require('../themes');
  return _themes;
}

let _lotContent = null;
function getLotContent() {
  if (!_lotContent) _lotContent = require('../lot-content');
  return _lotContent;
}

// ── Brand voice block — "Unloved Britain" ───────────────────────────────
// Lifted verbatim from .ruflo/phase-g-design.md §6.

const BRAND_VOICE_BLOCK = `You are writing for the "${BRAND_VOICE_NAME}" Facebook page — AuctionBrain's
content arm focused on the UK property auction stock that doesn't make it
to Rightmove. Tagline: "${BRAND_VOICE_TAGLINE}"

VOICE — absorb this before generating:

- Affectionate and slightly wry. NEVER sneering. Every lot has a story —
  probate, repossession, distressed sale, awkward layout, dated decor.
  Each one belonged to someone, and someone is selling for a reason. Treat
  the property and the seller with dignity.
- "Unloved" not "ugly". "Needs love" not "needs work". "Honest" not "rough".
  "Tired" not "shit". The page voice is the friend who sees the potential
  in the dusty cottage, not the dinner-party guest who sneers at the wallpaper.
- The audience is the kind of person who'd renovate a dated bungalow rather
  than knock it down. Property nerds, weekend renovators, niche-hunters,
  first-time investors. NOT wealth-tech bros. NOT get-rich-quick.
- British English ONLY. No Americanisms ("color", "organize", "favorite",
  "neighborhood"). "Whilst" is fine but don't overuse. Use "fortnight" not
  "two weeks".
- Concrete is better than abstract. "A boarded-up terrace on Cardiff's
  Grangetown" beats "a Welsh investment opportunity". Lead with the
  specific street, the specific number, the specific quirk.
- Numbers without melodrama. "8.4% est. gross yield" is fine. "8.4%
  yield — that's bonkers" is not. Let the figure do the talking; the
  reader adds the emotion.
- No financial-promotion language. The page is property + auction, NEVER
  mortgage rates, NEVER bridging finance, NEVER "approved", NEVER
  "guaranteed", NEVER "wealth creation", NEVER "passive income",
  NEVER "financial freedom". (See full ban list in the filter module —
  if any of those words land in your output, the post is auto-rejected
  and you'll be asked to regenerate.)
- NEVER mention BridgeMatch on this page. AuctionBrain is the brand here.
- Quarterly London catalogue posts (Allsop, Savills, Auction House London,
  Strettons) get an event-driven angle — when they're in the news, lean
  into "what's in the new Allsop catalogue" framing.

MODE-SPECIFIC RULES:

- If MODE == 'monet' (monetisation — engagement-first, no link):
  * Headline is a curiosity-gap hook ("5 unloved Welsh terraces...",
    "1 in 6 auction lots gets withdrawn — here's why").
  * Body delivers the hook's payoff in 2-3 lines without giving everything
    away — the reader should want to comment / share / save.
  * NO outbound URL anywhere. copy_cta MUST be null.
  * Include a follow_prompt — must start with "Hit follow if", "Tap follow
    for", or "Follow for", and end with a region/niche anchor pulled from
    the niche_tag. E.g. "Tap follow if you love unloved Welsh terraces".
  * The follow_prompt is the page's monetisation lever — make it specific
    to THIS post's niche, not generic.

- If MODE == 'traffic' (drive to ${BRAND_VOICE_URL}):
  * Same Unloved Britain voice — DON'T switch to corporate.
  * Headline still hooks; body still concrete.
  * copy_cta MUST include a URL with ${BRAND_VOICE_URL}. The UTM stamper
    will append params automatically — just include the bare URL.
  * No follow_prompt — the CTA is the action.

OUTPUT JSON SCHEMA — return EXACTLY this shape (no commentary outside
the braces). The schema varies by social_type; the user prompt below
specifies which fields you must return for the type you've been given.`;

// ── System prompt ───────────────────────────────────────────────────────
// Brand-resolved first (so /tone, /messages, /directive levers bite), then
// the Unloved Britain block last so it's the strongest recency anchor.

async function buildSystemPrompt(socialMode) {
  const rc = getRuntimeConfig();
  let resolved = null;
  try {
    resolved = await rc.getResolvedBrand('auctionbrain');
  } catch (err) {
    console.warn(`[social-engine/copy] getResolvedBrand failed: ${err.message}`);
  }

  const lines = [];
  if (resolved && resolved.name) {
    lines.push(`You write social posts for ${resolved.name} (${resolved.url || BRAND_VOICE_URL}).`);
    if (resolved.audience) lines.push(`AUDIENCE: ${resolved.audience}`);
    if (resolved.tone)     lines.push(`TONE: ${resolved.tone}`);
    if (Array.isArray(resolved.messages) && resolved.messages.length) {
      lines.push('');
      lines.push('KEY MESSAGES (weave these in naturally):');
      for (const m of resolved.messages) lines.push(`- ${m}`);
    }
    if (resolved._directive) {
      lines.push('');
      lines.push('EDITORIAL DIRECTIVE (current standing instruction from the owner — honour this):');
      lines.push(resolved._directive);
    }
  } else {
    // Fallback baseline if runtime-config isn't available.
    lines.push(`You write social posts for AuctionBrain (${BRAND_VOICE_URL}).`);
  }

  lines.push('');
  lines.push(`MODE: ${socialMode}`);
  lines.push('');
  lines.push('— PERSONA OVERLAY ————————————————————————————————————————————');
  lines.push(BRAND_VOICE_BLOCK);
  return lines.join('\n');
}

// ── User prompt builders per social_type ────────────────────────────────

function _commonFactsBlock(pick, meta_payload, visual_hints) {
  const lines = [];
  if (meta_payload && meta_payload.niche_tag) {
    const label = NICHE_TAG_LABELS[meta_payload.niche_tag] || meta_payload.niche_tag;
    lines.push(`NICHE TAG: ${meta_payload.niche_tag} (label: "${label}")`);
  }
  if (meta_payload && meta_payload.region_slug) {
    lines.push(`REGION: ${meta_payload.region_slug}`);
  }
  if (pick && pick.lot) {
    const l = pick.lot;
    if (l.address) lines.push(`LOT: ${l.address}${l.postcode ? ` (${l.postcode})` : ''}`);
    if (l.price)   lines.push(`GUIDE: £${Math.round(l.price).toLocaleString('en-GB')}`);
    if (Number.isFinite(l.est_gross_yield)) lines.push(`EST. GROSS YIELD: ${Number(l.est_gross_yield).toFixed(1)}%`);
    if (l.below_market) lines.push(`BELOW STREET AVG: ${l.below_market}%`);
    if (l.condition) lines.push(`CONDITION: ${l.condition}`);
    if (l.auction_date) lines.push(`AUCTION DATE: ${l.auction_date}`);
  }
  if (Array.isArray(pick && pick.lots) && pick.lots.length) {
    lines.push('LOTS:');
    for (const l of pick.lots.slice(0, 6)) {
      const parts = [];
      if (l.address) parts.push(l.address);
      if (l.postcode) parts.push(`(${l.postcode})`);
      if (l.price) parts.push(`£${Math.round(l.price).toLocaleString('en-GB')}`);
      if (l.est_gross_yield) parts.push(`${Number(l.est_gross_yield).toFixed(1)}% yield`);
      lines.push(`- ${parts.join(' · ')}`);
    }
  }
  if (pick && pick.stat_key) {
    lines.push(`STAT KEY: ${pick.stat_key}`);
    if (pick.stat_value != null) lines.push(`STAT VALUE: ${pick.stat_value}`);
    if (pick.narrative_context) lines.push(`CONTEXT: ${pick.narrative_context}`);
  }
  if (visual_hints && visual_hints.niche_tag_label) {
    lines.push(`NICHE LABEL FOR OVERLAY: ${visual_hints.niche_tag_label}`);
  }
  return lines.join('\n');
}

function _themesBlock() {
  try {
    const { renderThemeMenu, THEME_NAMES } = getThemes();
    return `${renderThemeMenu()}\n\nReturn one of these theme names in "visual_style": ${THEME_NAMES.join(', ')}.`;
  } catch (err) {
    return '';
  }
}

function buildUserPrompt({ socialType, socialMode, pick, meta_payload, visual_hints, regenHints }) {
  const facts = _commonFactsBlock(pick, meta_payload, visual_hints);
  const themes = _themesBlock();
  const lines = [];

  lines.push(`SOCIAL TYPE: ${socialType}`);
  lines.push(`SOCIAL MODE: ${socialMode}`);
  lines.push('');
  if (facts) {
    lines.push('FACTS — use only these. No fabricated detail.');
    lines.push(facts);
    lines.push('');
  }

  // Per-type JSON schema instruction
  if (socialType === SOCIAL_TYPES.HERO_ALBUM || socialType === SOCIAL_TYPES.NICHE_HOOK || socialType === SOCIAL_TYPES.REGIONAL_ROUNDUP) {
    lines.push('Write the post. Return STRICT JSON with EXACTLY these fields:');
    lines.push(`{`);
    lines.push(`  "copy_headline": "<= 60 chars; hook the scroll",`);
    lines.push(`  "copy_body":     "<= 200 chars; payoff in 2-3 lines",`);
    lines.push(`  "copy_cta":      ${socialMode === SOCIAL_MODES.TRAFFIC ? `"<= 40 chars; MUST contain ${BRAND_VOICE_URL}"` : 'null'},`);
    lines.push(`  "follow_prompt": ${socialMode === SOCIAL_MODES.MONET    ? '"starts \\"Hit follow if\\" / \\"Tap follow\\" / \\"Follow for\\"; ends with niche anchor"' : 'null'},`);
    lines.push(`  "visual_style":  "<theme name from menu>",`);
    lines.push(`  "frame_captions": ["short caption per frame, 4-5 entries for album/carousel"]`);
    lines.push(`}`);
  } else if (socialType === SOCIAL_TYPES.CURIOSITY_GAP || socialType === SOCIAL_TYPES.DATA_SHOCK) {
    lines.push('Write the post. Return STRICT JSON with EXACTLY these fields:');
    lines.push(`{`);
    lines.push(`  "copy_headline": "<= 80 chars; big-text overlay",`);
    lines.push(`  "copy_body":     "<= 160 chars; one-line caveat or detail",`);
    lines.push(`  "copy_cta":      ${socialMode === SOCIAL_MODES.TRAFFIC ? `"<= 40 chars; MUST contain ${BRAND_VOICE_URL}"` : 'null'},`);
    lines.push(`  "follow_prompt": ${socialMode === SOCIAL_MODES.MONET    ? '"starts \\"Hit follow if\\" / \\"Tap follow\\" / \\"Follow for\\"; ends with niche anchor"' : 'null'},`);
    lines.push(`  "visual_style":  "<theme name from menu>",`);
    lines.push(`  "micro_stat":    "the headline number alone, e.g. \\"31%\\" or \\"1 in 6\\"",`);
    lines.push(`  "micro_caption": "supporting caption under the big number"`);
    lines.push(`}`);
  } else {
    // superlative-reel + lot-of-day-traffic are delegated — copy module
    // does NOT reach the prompt-builder for those.
    throw new Error(`buildUserPrompt: unsupported social_type for prompt build: ${socialType}`);
  }

  if (themes) {
    lines.push('');
    lines.push(themes);
  }

  if (Array.isArray(regenHints) && regenHints.length) {
    lines.push('');
    lines.push('REGENERATION CONTEXT — your previous draft was BLOCKED by quality filters. Fix every issue below:');
    for (const h of regenHints) {
      lines.push(`- ${h.rule} (${h.where || 'body'}): "${h.match || ''}" — ${h.reason || ''}`);
    }
  }

  lines.push('');
  lines.push('Return ONLY the JSON object.');
  return lines.join('\n');
}

// ── JSON parse + per-type validation ────────────────────────────────────

function parseJsonResponse(text) {
  if (!text || typeof text !== 'string') throw new Error('Empty Claude response');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON object in Claude response');
  return JSON.parse(m[0]);
}

function validatePerType(parsed, socialType, socialMode) {
  if (!parsed || typeof parsed !== 'object') throw new Error('parsed is not an object');
  if (!parsed.copy_headline) throw new Error('missing copy_headline');
  if (!parsed.copy_body)     throw new Error('missing copy_body');

  if (socialMode === SOCIAL_MODES.TRAFFIC) {
    if (!parsed.copy_cta) throw new Error('traffic mode: missing copy_cta');
    if (!/auctionbrain\.co\.uk/i.test(parsed.copy_cta)) {
      throw new Error('traffic mode: copy_cta must contain auctionbrain.co.uk');
    }
  } else if (socialMode === SOCIAL_MODES.MONET) {
    if (parsed.copy_cta) throw new Error('monet mode: copy_cta must be null');
    if (!parsed.follow_prompt) throw new Error('monet mode: missing follow_prompt');
    if (!/^(Hit follow|Tap follow|Follow for)/i.test(parsed.follow_prompt)) {
      throw new Error('monet mode: follow_prompt must start with "Hit follow"/"Tap follow"/"Follow for"');
    }
  }

  if (socialType === SOCIAL_TYPES.CURIOSITY_GAP || socialType === SOCIAL_TYPES.DATA_SHOCK) {
    if (!parsed.micro_stat) throw new Error(`${socialType}: missing micro_stat`);
  }
}

// ── UTM stamping (traffic mode only) ────────────────────────────────────
// Same regex as lib/generate.js:294-307. Monet mode → no-op.

function stampUtm(cta, socialType) {
  if (!cta) return cta;
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const campaign = `auctionbrain_${socialType}_${today}`;
  const utmTail = `utm_source=facebook&utm_medium=social&utm_campaign=${campaign}`;

  // Full http(s) URL pass — append params, preserve fragment.
  let out = cta.replace(/(https?:\/\/[^\s)]+)/gi, (url) => {
    if (/[?&]utm_source=/i.test(url)) return url;
    const [base, fragment] = url.split('#');
    const sep = base.includes('?') ? '&' : '?';
    const stamped = `${base}${sep}${utmTail}`;
    return fragment ? `${stamped}#${fragment}` : stamped;
  });

  // Bare-domain pass — token-by-token. Match auctionbrain.co.uk anywhere
  // in the string, with an optional path/query, and stamp params on the
  // first hit only. Skip if already stamped.
  if (!/utm_source=/i.test(out)) {
    out = out.replace(/auctionbrain\.co\.uk(\/[^\s]*)?/i, (match) => {
      const [base, fragment] = match.split('#');
      const sep = base.includes('?') ? '&' : '?';
      const stamped = `${base}${sep}${utmTail}`;
      return fragment ? `${stamped}#${fragment}` : stamped;
    });
  }

  return out;
}

// ── Caption assembly ────────────────────────────────────────────────────

function assembleCaption({ headline, body, cta, follow_prompt, mode }) {
  const parts = [headline, body];
  if (mode === SOCIAL_MODES.TRAFFIC) {
    if (cta) parts.push(cta);
  } else if (mode === SOCIAL_MODES.MONET) {
    if (follow_prompt) parts.push(follow_prompt);
  }
  return parts.filter(Boolean).join('\n\n');
}

// ── Theme validation ───────────────────────────────────────────────────

function resolveVisualStyle(claudeStyle) {
  try {
    const { THEME_NAMES, DEFAULT_THEME_NAME } = getThemes();
    const s = typeof claudeStyle === 'string' ? claudeStyle.trim() : '';
    if (s && THEME_NAMES.includes(s)) return s;
    if (s) {
      console.warn(`[social-engine/copy] unknown visual_style '${s}', falling back to ${DEFAULT_THEME_NAME}`);
    }
    return DEFAULT_THEME_NAME;
  } catch (err) {
    return claudeStyle || null;
  }
}

// ── Public entry ────────────────────────────────────────────────────────

/**
 * Generate copy for a Phase G post. Mirrors the Phase B filter-retry loop:
 * MAX_RETRIES=2 (total 3 attempts), regenHints from blocking filter results
 * land in the next prompt.
 *
 * For lot-of-day-traffic + superlative-reel: delegates to existing
 * generateLotContent (lib/lot-content.js) — same caption shape as today,
 * NO additional filter pass, NO additional brand-voice block (the lot-flow
 * is the source of truth for those types).
 *
 * @param {object} args
 *   - socialType: SOCIAL_TYPES value
 *   - socialMode: 'monet'|'traffic'
 *   - pick:       picker output (lot row OR { lots: [...] } OR stat shape)
 *   - meta_payload: picker.meta_payload
 *   - visual_hints: picker.visual_hints (optional)
 * @returns {Promise<{
 *   copy_headline: string,
 *   copy_body: string,
 *   copy_cta: string|null,
 *   follow_prompt: string|null,
 *   caption_facebook: string,
 *   visual_style: string,
 *   filterBlocks: Array<object>,
 *   meta_additions: object
 * }>}
 * @throws Error with .blocks attached on filter-retry exhaustion.
 */
async function generateSocialCopy({ socialType, socialMode, pick, meta_payload, visual_hints }) {
  if (!SOCIAL_TYPE_LIST.includes(socialType)) {
    throw new Error(`generateSocialCopy: unknown socialType '${socialType}'`);
  }
  if (socialMode !== SOCIAL_MODES.MONET && socialMode !== SOCIAL_MODES.TRAFFIC) {
    throw new Error(`generateSocialCopy: socialMode must be 'monet' or 'traffic' (got '${socialMode}')`);
  }

  // Delegation paths — lot-of-day-traffic + superlative-reel reuse the
  // existing generateLotContent without re-running social filters.
  if (socialType === SOCIAL_TYPES.LOT_OF_DAY_TRAFFIC || socialType === SOCIAL_TYPES.SUPERLATIVE_REEL) {
    const lot = pick && pick.lot;
    const archetype = pick && pick.archetype;
    if (!lot || !archetype) {
      throw new Error(`${socialType}: pick must include { lot, archetype } for delegation`);
    }
    const { generateLotContent } = getLotContent();
    const c = await generateLotContent({ lot, archetype });
    return {
      copy_headline: c.hook_headline,
      copy_body: Array.isArray(c.key_bullets) ? c.key_bullets.join('\n') : '',
      copy_cta: socialMode === SOCIAL_MODES.TRAFFIC ? 'auctionbrain.co.uk' : null,
      follow_prompt: null,
      caption_facebook: c.caption_facebook,
      visual_style: c.visual_style,
      filterBlocks: [],
      meta_additions: {
        social_mode: socialMode,
        social_type: socialType,
        hook_headline: c.hook_headline,
        key_bullets: c.key_bullets,
        voiceover_script: c.voiceover_script || null,
      },
    };
  }

  // Non-delegated types — full Claude call + filter-retry loop.
  const system = await buildSystemPrompt(socialMode);

  let regenHints = [];
  let lastBlocks = [];
  let lastParsed = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const user = buildUserPrompt({ socialType, socialMode, pick, meta_payload, visual_hints, regenHints });
    // eslint-disable-next-line no-await-in-loop
    const resp = await getAnthropic().messages.create({
      model: MODEL,
      max_tokens: 800,
      system,
      messages: [{ role: 'user', content: user }],
    });
    const text = (resp.content || []).find(b => b.type === 'text')?.text || '';

    let parsed;
    try {
      parsed = parseJsonResponse(text);
      validatePerType(parsed, socialType, socialMode);
    } catch (err) {
      console.warn(`[social-engine/copy] attempt ${attempt + 1}/${MAX_RETRIES + 1} parse/validate error: ${err.message}`);
      regenHints = [{ rule: 'json_or_schema', where: 'response', match: '', reason: `Previous attempt was unusable: ${err.message}. Return ONLY the JSON object with the exact field names and the mode-specific rules honoured.` }];
      continue;
    }

    // UTM stamp BEFORE filter so a malformed URL trips the filter too.
    let cta = parsed.copy_cta || null;
    if (cta && socialMode === SOCIAL_MODES.TRAFFIC) cta = stampUtm(cta, socialType);

    const filterText = [parsed.copy_body, cta || '', parsed.follow_prompt || '', parsed.micro_caption || ''].filter(Boolean).join('\n\n');
    const filterRes = runFilters({ subject: parsed.copy_headline, body: filterText, dealFacts: [] }, { mode: 'social' });

    if (filterRes.ok) {
      const visual_style = resolveVisualStyle(parsed.visual_style);
      const caption_facebook = assembleCaption({
        headline: parsed.copy_headline,
        body: parsed.copy_body,
        cta,
        follow_prompt: parsed.follow_prompt || null,
        mode: socialMode,
      });
      return {
        copy_headline: parsed.copy_headline,
        copy_body: parsed.copy_body,
        copy_cta: cta,
        follow_prompt: parsed.follow_prompt || null,
        caption_facebook,
        visual_style,
        filterBlocks: filterRes.blocks, // warnings still surface
        meta_additions: {
          social_mode: socialMode,
          social_type: socialType,
          micro_stat: parsed.micro_stat || null,
          micro_caption: parsed.micro_caption || null,
          frame_captions: Array.isArray(parsed.frame_captions) ? parsed.frame_captions : null,
        },
      };
    }

    const blocks = filterRes.blocks.filter(b => b.severity === 'block');
    console.warn(`[social-engine/copy] attempt ${attempt + 1}/${MAX_RETRIES + 1} BLOCKED by ${blocks.length} filter(s): ${blocks.map(b => b.rule).join(', ')}`);
    lastBlocks = filterRes.blocks;
    lastParsed = parsed;
    regenHints = blocks;
  }

  const err = new Error(`generateSocialCopy: filter blocks not resolved after ${MAX_RETRIES + 1} attempts for ${socialType}/${socialMode}`);
  err.blocks = lastBlocks;
  err.lastResult = lastParsed;
  throw err;
}

module.exports = {
  generateSocialCopy,
  // Internals exposed for tests
  _internals: {
    buildSystemPrompt,
    buildUserPrompt,
    parseJsonResponse,
    validatePerType,
    stampUtm,
    assembleCaption,
    resolveVisualStyle,
    BRAND_VOICE_BLOCK,
    MODEL,
    MAX_RETRIES,
  },
};
