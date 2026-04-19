require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { brands, templateTypes } = require('./config');
const { getPendingBriefs, markBriefsUsed, getRecentApprovedPosts, getRecentRejectedPosts, getRecentPublishedPosts, getUnusedSeeds, markSeedsUsedForSocial } = require('./supabase');
const { getTopPerformingPosts } = require('./insights');

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

// ── LEARNING CONTEXT ──

async function buildContextBlock(brand) {
  const [approved, rejected, recent, topPerformers, seeds] = await Promise.all([
    getRecentApprovedPosts(brand, 5).catch(() => []),
    getRecentRejectedPosts(brand, 3).catch(() => []),
    getRecentPublishedPosts(brand, 7).catch(() => []),
    getTopPerformingPosts(brand, 3).catch(() => []),
    getUnusedSeeds(brand, 5).catch(() => [])
  ]);

  let context = '';

  // Prefer performance-ranked posts when we have metrics
  if (topPerformers.length) {
    context += '\n\nTOP PERFORMING POSTS (these got the most engagement — write more like these):\n';
    context += topPerformers.map(p =>
      `---\n[${p.template_type}] Headline: "${p.copy_headline}"\nBody: "${p.copy_body}"\nCTA: "${p.copy_cta}"\nReach: ${p.reach} | Engagements: ${p.engagements} | Clicks: ${p.clicks}\n`
    ).join('');
  } else if (approved.length) {
    context += '\n\nEXAMPLES OF POSTS THE OWNER APPROVED (match this style):\n';
    context += approved.map(p =>
      `---\n[${p.template_type}] Headline: "${p.copy_headline}"\nBody: "${p.copy_body}"\nCTA: "${p.copy_cta}"\n`
    ).join('');
  }

  if (rejected.length) {
    context += '\n\nREJECTED POSTS (avoid writing like these):\n';
    context += rejected.map(p => {
      let entry = `---\n[${p.template_type}] Headline: "${p.copy_headline}"\nBody: "${p.copy_body}"`;
      if (p.rejection_feedback) entry += `\nOwner feedback: "${p.rejection_feedback}"`;
      return entry + '\n';
    }).join('');
    context += 'Avoid repeating the same mistakes. Note the owner\'s feedback where given.\n';
  }

  if (recent.length) {
    context += '\n\nPOSTS PUBLISHED IN THE LAST 7 DAYS (do NOT reuse these angles/stats/headlines):\n';
    context += recent.map(p => `- "${p.copy_headline}" (${p.template_type})`).join('\n');
    context += '\n\nFind a fresh angle.\n';
  }

  if (seeds.length) {
    context += '\n\nCONTENT SEEDS (research and material from the owner — use these as inspiration):\n';
    context += seeds.map(s =>
      `- ${s.summary}${s.key_points ? ` | Key points: ${s.key_points}` : ''} (source: ${s.source})`
    ).join('\n');
    context += '\n';
  }

  return { context, seedIds: seeds.map(s => s.id) };
}

// ── GENERATE COPY ──

async function generateCopy(brand, templateType, briefText) {
  const basePrompt = getSystemPrompt(brand);
  const { context: contextBlock } = await buildContextBlock(brand);
  const systemPrompt = basePrompt + contextBlock;

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

  // Append UTM params to any URL in CTA
  let cta = parsed.copy_cta || '';
  if (cta) {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const campaign = `${brand}_${templateType}_${today}`;
    cta = cta.replace(
      /(https?:\/\/[^\s)]+)/g,
      (url) => {
        const sep = url.includes('?') ? '&' : '?';
        return `${url}${sep}utm_source=facebook&utm_medium=social&utm_campaign=${campaign}`;
      }
    );
  }

  return {
    copy_headline: parsed.copy_headline,
    copy_body: parsed.copy_body || '',
    copy_cta: cta
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
  let briefs = [];
  try {
    briefs = await getPendingBriefs();
    if (briefs.length) {
      console.log(`  Fetched ${briefs.length} content brief(s) from Telegram`);
    }
  } catch (err) {
    console.warn(`  Could not fetch briefs: ${err.message}`);
  }

  // Only generate for AuctionBrain for now (BridgeMatch Facebook page not wired up yet)
  const activeBrands = ['auctionbrain'];

  const allUsedSeedIds = [];

  for (const brand of activeBrands) {
    // Filter briefs: use ones with matching brand or no brand specified
    const brandBriefs = briefs.filter(b => !b.brand || b.brand === brand);
    const brandBriefText = brandBriefs.length
      ? brandBriefs.map(b => b.message).join('\n')
      : null;

    // Get seed IDs that will be in context (for marking used later)
    const { seedIds } = await buildContextBlock(brand);
    if (seedIds.length) allUsedSeedIds.push(...seedIds);

    for (const { templateType, platform } of assignments) {
      console.log(`  Generating ${brands[brand].name} / ${templateType} / ${platform}...`);
      const copy = await generateCopy(brand, templateType, brandBriefText);
      posts.push({
        brand,
        platform,
        template_type: templateType,
        ...copy
      });
    }
  }

  // Only mark briefs and seeds as used after successful generation
  if (posts.length > 0) {
    if (briefs.length) {
      try {
        await markBriefsUsed(briefs.map(b => b.id));
        console.log(`  Marked ${briefs.length} brief(s) as used`);
      } catch (err) {
        console.warn(`  Could not mark briefs used: ${err.message}`);
      }
    }
    if (allUsedSeedIds.length) {
      try {
        await markSeedsUsedForSocial(allUsedSeedIds);
        console.log(`  Marked ${allUsedSeedIds.length} content seed(s) as used for social`);
      } catch (err) {
        console.warn(`  Could not mark seeds used: ${err.message}`);
      }
    }
  }

  return posts;
}

module.exports = { generateCopy, generateBatch, pickTemplates, assignPlatforms };
