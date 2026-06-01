require('dotenv').config();
const { createLLM } = require('./llm');
const { getResolvedBrand, getBrandVisualDirective } = require('./runtime-config');
const { renderThemeMenu, THEME_NAMES, DEFAULT_THEME_NAME } = require('./themes');

const MODEL = 'gemini-2.0-flash';

const ARCHETYPE_FRAMES = {
  'best-yield': {
    label: 'Best Yield',
    angle: 'this lot delivers strong rental return — make the yield maths viscerally obvious'
  },
  'deepest-discount': {
    label: 'Deepest Discount',
    angle: 'this lot is priced well below comparable sales — make the gap shocking'
  },
  'dev-or-refurb': {
    label: 'Refurb / Development',
    angle: 'this lot is a project — speak to investors who add value through works'
  },
  'urgent': {
    label: 'Bidding This Week',
    angle: 'this lot auctions in days — urgency without panic, give a reason to act now'
  },

  // ── Weekly superlative reels ("X of the week" series) ──
  // Picked by pickWeeklySuperlatives() in lot-picker.js. Rendered music-only as
  // 30s vertical reels — the angle is written for a scroll-stopping hook.
  'cheapest-week': {
    label: 'Cheapest This Week',
    angle: 'this is the single cheapest property going to auction in the UK this week — lead with the jaw-dropping guide price; write for a scroll-stopping vertical reel that hooks a viewer who has never once thought about buying at auction'
  },
  'dearest-week': {
    label: 'Most Expensive This Week',
    angle: 'this is the most expensive lot at auction this week — lean into spectacle and the "who actually buys this, and why" curiosity; aspirational, not preachy'
  },
  'best-deal-week': {
    label: 'Best Deal This Week',
    angle: 'this is the highest-scoring investment lot this week — make the case fast and concrete with the real numbers (price, yield, discount); confident, no hype'
  },
  'biggest-discount-week': {
    label: 'Biggest Discount This Week',
    angle: 'this lot has the widest gap between guide price and street value this week — make the discount shocking and specific, name both numbers'
  },
  'worst-lot-week': {
    label: 'Worst Lot This Week',
    angle: 'this is the weakest lot at auction this week — frame it as a fun "would you actually buy this?" challenge; honest about the red flags, light-hearted not cruel, and explicitly invite viewers to comment'
  }
};

function gbp(n) {
  if (n == null || isNaN(n)) return '';
  return '£' + Math.round(n).toLocaleString('en-GB');
}

function buildLotSummary(lot) {
  const lines = [
    `Address: ${lot.address || '(unknown)'}${lot.postcode ? ` (${lot.postcode})` : ''}`,
    `Property type: ${lot.prop_type || '?'}${lot.beds ? `, ${lot.beds} bed` : ''}`,
    `Guide price: ${gbp(lot.price)}`,
    lot.below_market ? `Below comparable street average: ${lot.below_market}%` : null,
    lot.street_avg ? `Street average comp: ${gbp(lot.street_avg)}` : null,
    lot.est_gross_yield ? `Estimated gross yield: ${Number(lot.est_gross_yield).toFixed(1)}%` : null,
    lot.est_monthly_rent ? `Estimated monthly rent: ${gbp(lot.est_monthly_rent)}` : null,
    lot.condition ? `Condition: ${lot.condition}` : null,
    lot.tenure ? `Tenure: ${lot.tenure}` : null,
    lot.epc_rating ? `EPC rating: ${lot.epc_rating}` : null,
    lot.flood_risk ? `Flood risk: ${lot.flood_risk}` : null,
    lot.auction_date ? `Auction date: ${lot.auction_date}` : null,
    lot.house ? `Auction house: ${lot.house}` : null,
    lot.score ? `AI investment score: ${lot.score}/10` : null,
    Array.isArray(lot.opps) && lot.opps.length ? `Opportunities: ${lot.opps.join('; ')}` : null,
    Array.isArray(lot.risks) && lot.risks.length ? `Risks: ${lot.risks.join('; ')}` : null,
  ].filter(Boolean);
  return lines.join('\n');
}

async function generateLotContent({ lot, archetype }) {
  const frame = ARCHETYPE_FRAMES[archetype];
  if (!frame) throw new Error(`Unknown archetype: ${archetype}`);

  const brand = await getResolvedBrand('auctionbrain');
  const visualDirective = await getBrandVisualDirective('auctionbrain');
  const lotSummary = buildLotSummary(lot);
  const directiveBlock = brand._directive
    ? `\n\nEDITORIAL DIRECTIVE (current standing instruction from the owner — honour this):\n${brand._directive}`
    : '';

  const system = `You write daily social posts and voiceover scripts for AuctionBrain (auctionbrain.co.uk), a UK property auction search platform.

AUDIENCE: ${brand.audience}
TONE: ${brand.tone}

RULES:
- British English only — no Americanisms.
- No hashtags inside the copy.
- Never invent statistics — use only the lot details provided.
- The voiceover script must be readable in 60–90 seconds (~150–225 spoken words).
- The caption must be scannable: 80–130 words, short paragraphs.
- Always end with a CTA pointing to auctionbrain.co.uk.${directiveBlock}`;

  const visualBlock = `\n\n${renderThemeMenu()}${visualDirective ? `\n\nVISUAL DIRECTIVE FROM THE OWNER (honour this when picking the theme):\n${visualDirective}` : ''}`;

  const user = `Today's archetype: ${frame.label}.
Editorial angle: ${frame.angle}.

LOT DETAILS:
${lotSummary}${visualBlock}

Write content for this single lot's daily Lot of the Day post. Output STRICT JSON only — no preamble, no prose, no code fence:

{
  "hook_headline": "One sharp line for a video overlay (3–6 words)",
  "key_bullets": ["3 to 4 short bullets, each under 8 words"],
  "voiceover_script": "60–90 seconds spoken. First sentence is the hook. Build the case using the lot's real numbers. End naturally on the CTA. No SSML tags.",
  "caption_facebook": "80–130 word Facebook caption. Line breaks allowed. CTA on its own line at the end.",
  "visual_style": "<exactly one theme name from the menu above: ${THEME_NAMES.join(' | ')}>"
}`;

  const res = await createLLM().messages.create({
      model: MODEL,
      max_tokens: 1500,
      system,
      messages: [{ role: 'user', content: user }]
  });

  const text = (res.content || []).find(b => b.type === 'text')?.text || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error(`Claude response had no JSON object. Raw: ${text.slice(0, 300)}`);

  let parsed;
  try {
    parsed = JSON.parse(m[0]);
  } catch (err) {
    throw new Error(`Failed to parse Claude JSON: ${err.message}. Raw: ${m[0].slice(0, 300)}`);
  }

  for (const k of ['hook_headline', 'key_bullets', 'voiceover_script', 'caption_facebook']) {
    if (!parsed[k]) throw new Error(`Claude response missing required field: ${k}`);
  }
  if (!Array.isArray(parsed.key_bullets)) throw new Error('key_bullets must be an array');

  // visual_style: validate against the theme menu, fall back to default if
  // Claude returned anything unrecognised. We don't hard-fail here — visuals
  // are recoverable, the rest of the post is more important.
  let visualStyle = typeof parsed.visual_style === 'string' ? parsed.visual_style.trim() : null;
  if (visualStyle && !THEME_NAMES.includes(visualStyle)) {
    console.warn(`[lot-content] Claude returned unknown visual_style '${visualStyle}', falling back to ${DEFAULT_THEME_NAME}`);
    visualStyle = DEFAULT_THEME_NAME;
  }

  return {
    hook_headline: String(parsed.hook_headline).trim(),
    key_bullets: parsed.key_bullets.map(s => String(s).trim()).filter(Boolean),
    voiceover_script: String(parsed.voiceover_script).trim(),
    caption_facebook: String(parsed.caption_facebook).trim(),
    visual_style: visualStyle || DEFAULT_THEME_NAME,
  };
}

module.exports = { generateLotContent, ARCHETYPE_FRAMES, buildLotSummary, gbp };
