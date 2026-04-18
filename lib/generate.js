require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { brands, templateTypes } = require('./config');
const { getPendingBriefs, markBriefsUsed } = require('./supabase');

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// ── PROMPT TEMPLATES ──

function getSystemPrompt(brand) {
  const b = brands[brand];
  return `You write social media posts for ${b.name} (${b.url}).

AUDIENCE: ${b.audience}
TONE: ${b.tone}

KEY MESSAGES (weave these in naturally):
${b.messages.map(m => `- ${m}`).join('\n')}

RULES:
- British English only, no Americanisms
- No hashtags in the copy itself (they go in the caption separately)
- No emojis in headlines
- Keep copy punchy and scannable
- Every post must have a clear hook that stops the scroll
- CTA should drive to ${b.url}
- Never fabricate statistics — only use the key messages provided`;
}

const templatePrompts = {
  stat: `Generate a STAT POST.
This template features one large number or short statistic as the headline, with a single explanatory line as the body.

Return JSON:
{
  "copy_headline": "The stat/number (keep under 20 chars ideally, 30 max)",
  "copy_body": "One line explaining what this stat means for the reader (under 80 chars)",
  "copy_cta": "Short CTA with URL"
}`,

  hook: `Generate a HOOK + CTA POST.
This template has a bold headline that hooks the reader, 2-3 lines of body copy, and a call-to-action bar.

Return JSON:
{
  "copy_headline": "Punchy hook headline (under 60 chars)",
  "copy_body": "2-3 lines of supporting copy that builds on the hook (under 200 chars)",
  "copy_cta": "CTA text for the green bar at the bottom (under 40 chars)"
}`,

  list: `Generate a LIST/VALUE POST.
This template has a title and 3-5 bullet points. The bullets should deliver genuine value — tips, facts, or steps.

Return JSON:
{
  "copy_headline": "List title (under 40 chars)",
  "copy_body": "3-5 bullet points separated by newlines. Each bullet under 60 chars. No bullet markers — just the text, one per line.",
  "copy_cta": "Short CTA with URL"
}`,

  reel: `Generate a VIDEO COVER / REEL post.
This is a 9:16 cover image with one large centred headline and a subline. Think of it as the thumbnail that makes someone tap.

Return JSON:
{
  "copy_headline": "Big bold hook (under 40 chars, ideally under 25)",
  "copy_body": "Subline that adds context (under 60 chars)",
  "copy_cta": "CTA for the video description"
}`
};

// ── GENERATE COPY ──

async function generateCopy(brand, templateType, briefText) {
  const systemPrompt = getSystemPrompt(brand);
  let userPrompt = templatePrompts[templateType];

  if (briefText) {
    userPrompt += `\n\nADDITIONAL DIRECTION FROM THE CONTENT OWNER:\n${briefText}\n\nWork this direction into the post naturally. Don't mention it was requested.`;
  }

  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const text = response.content[0].text;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`No JSON in Claude response for ${brand}/${templateType}`);

  const parsed = JSON.parse(match[0]);

  // Validate required fields
  if (!parsed.copy_headline) throw new Error(`Missing copy_headline for ${brand}/${templateType}`);

  return {
    copy_headline: parsed.copy_headline,
    copy_body: parsed.copy_body || '',
    copy_cta: parsed.copy_cta || ''
  };
}

// ── GENERATE BATCH ──
// Generates 3 posts per brand (one each of stat, hook, list — rotating reel in)

function pickTemplates() {
  // Pick 3 templates for each brand, rotating through all 4 types by week
  const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
  const offset = weekNum % templateTypes.length;
  return [
    templateTypes[offset % 4],
    templateTypes[(offset + 1) % 4],
    templateTypes[(offset + 2) % 4]
  ];
}

function assignPlatforms(templates) {
  // All posts go to Facebook for now — expand to linkedin/tiktok when those APIs are wired up
  return templates.map(t => ({ templateType: t, platform: 'facebook' }));
}

async function generateBatch() {
  const templates = pickTemplates();
  const assignments = assignPlatforms(templates);
  const posts = [];

  // Fetch any pending briefs from Telegram
  let briefText = null;
  try {
    const briefs = await getPendingBriefs();
    if (briefs.length) {
      briefText = briefs.map(b => b.message).join('\n');
      await markBriefsUsed(briefs.map(b => b.id));
      console.log(`  Using ${briefs.length} content brief(s) from Telegram`);
    }
  } catch (err) {
    console.warn(`  Could not fetch briefs: ${err.message}`);
  }

  // Only generate for AuctionBrain for now (BridgeMatch Facebook page not wired up yet)
  const activeBrands = ['auctionbrain'];

  for (const brand of activeBrands) {
    for (const { templateType, platform } of assignments) {
      console.log(`  Generating ${brands[brand].name} / ${templateType} / ${platform}...`);
      const copy = await generateCopy(brand, templateType, briefText);
      posts.push({
        brand,
        platform,
        template_type: templateType,
        ...copy
      });
    }
  }

  return posts;
}

module.exports = { generateCopy, generateBatch, pickTemplates, assignPlatforms };
