require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const { brands, templateTypes } = require('./config');
const { getPendingBriefs, markBriefsUsed, getRecentApprovedPosts, getRecentRejectedPosts, getRecentPublishedPosts, getUnusedSeeds, markSeedsUsedForSocial } = require('./supabase');
const { getTopPerformingPosts } = require('./insights');
const { getTemplatePerformance } = require('./closed-loop/template-performance');
const {
  getResolvedBrand,
  getActiveBrands,
  getTemplateWeights,
  getBrandVisualDirective,
  renderHookMenu,
  renderCtaMenu,
} = require('./runtime-config');
const { pickAuthor, authorPromptBlock } = require('./authors');

const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
const MODEL = 'claude-haiku-4-5-20251001';

// ── PROMPT TEMPLATES ──
//
// getSystemPrompt resolves brand voice from runtime-config so Telegram
// edits to /tone, /messages, /audience, /directive land in the next
// generation without a redeploy. Falls back to defaults from config.js
// when no override row exists in app_config.

async function getSystemPrompt(brand) {
  const b = await getResolvedBrand(brand);
  const directiveBlock = b._directive
    ? `\n\nEDITORIAL DIRECTIVE (current standing instruction from the owner — honour this in every post):\n${b._directive}`
    : '';

  // ── Phase E — TEMPLATE PERFORMANCE block ─────────────────────────────────
  // Bias future generation toward template_types that actually performed.
  // Only emit the block when at least one template_type has >5 published
  // posts — below that threshold the signal is too noisy to lean on. Any
  // error degrades to an empty block (don't break generation).
  let perfBlock = '';
  try {
    const perfRows = await getTemplatePerformance(brand, 30);
    const useful = Array.isArray(perfRows) ? perfRows.filter(r => r.posts_published > 5) : [];
    if (useful.length) {
      const summary = useful
        .map(r => {
          const cta = r.top_cta_pattern ? `, top CTA pattern "${r.top_cta_pattern}"` : '';
          return `- ${r.template_type}: ${r.posts_published} posts, ${r.total_engagement} total engagements${cta}`;
        })
        .join('\n');
      perfBlock = `\n\nTEMPLATE PERFORMANCE (last 30 days — lean toward higher-performing template types):\n${summary}`;
    }
  } catch (err) {
    console.warn(`[generate] getTemplatePerformance(${brand}) failed: ${err.message}`);
  }

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
- Never fabricate statistics — only use the key messages provided${directiveBlock}${perfBlock}`;
}

// Hook + CTA pattern menus are now resolved at generation time from
// runtime-config so /hooks and /ctas Telegram edits land immediately.
// Keeping menus driven by a single source (a) avoids prompt drift between
// the reel and hook templates and (b) lets the admin Intel tab chart
// pattern usage uniformly across both.

async function getTemplatePrompts() {
  const [hookMenu, ctaMenu] = await Promise.all([
    renderHookMenu(),
    renderCtaMenu(),
  ]);

  return {
    stat: `Generate a STAT POST.
This template features one large number or short statistic as the headline, with a single explanatory line as the body.

Return JSON:
{
  "copy_headline": "The stat/number (keep under 20 chars ideally, 30 max)",
  "copy_body": "One line explaining what this stat means for the reader (under 80 chars)",
  "copy_cta": "Short CTA with URL"
}`,

    hook: `Generate a HOOK + CTA POST.
This template is a static 1080×1080 image with a bold headline up top, 2-3 lines of supporting body copy in the middle, and a green CTA bar at the bottom. Static — not a video — so the headline doesn't have to compete with motion, but it still needs to make a feed-scroller stop.

────────────────────────────────────────────────────────────
${hookMenu}

────────────────────────────────────────────────────────────
${ctaMenu}

────────────────────────────────────────────────────────────
HARD RULES
- Headline ≤ 60 chars. The first 4–5 words must be the hook hit; everything after is amplification.
- Body ≤ 200 chars across 2-3 lines. Builds on the hook with concrete proof.
- CTA ≤ 40 chars. Forbidden: bare "auctionbrain.co.uk", "Visit our site", "Click below".
- British English. No Americanisms. No emojis. No hashtags.
- Use ONLY brand facts and seed material provided. Do not invent stats.
- Pattern names MUST be returned in hook_pattern + cta_pattern so the next generation can rotate.

Return JSON:
{
  "copy_headline": "Punchy hook headline (≤60 chars)",
  "copy_body": "2-3 lines of supporting copy (≤200 chars total)",
  "copy_cta": "CTA following one of the CTA-menu labels (≤40 chars)",
  "hook_pattern": "the numeric label of the hook pattern you chose",
  "cta_pattern": "the letter label of the CTA pattern you chose"
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
This is a 9:16 cover for a vertical video — one large centred headline, one subline, one CTA bar. The hook has roughly 1 second to stop a scroll.

────────────────────────────────────────────────────────────
${hookMenu}

────────────────────────────────────────────────────────────
${ctaMenu}

────────────────────────────────────────────────────────────
HARD RULES
- Headline ≤ 25 chars where possible, never over 40
- Subline ≤ 60 chars
- CTA ≤ 40 chars
- British English. No Americanisms. No emojis. No hashtags.
- Use ONLY brand facts and seed material provided. Do not invent stats.
- Pattern names below MUST be returned in fields hook_pattern + cta_pattern using labels from the menus above so the next generation can rotate.

Return JSON:
{
  "copy_headline": "Big bold hook (≤25 chars ideal, ≤40 max)",
  "copy_body": "Subline that adds context (≤60 chars)",
  "copy_cta": "CTA following one of the CTA-menu labels (≤40 chars)",
  "hook_pattern": "the numeric label of the hook pattern you chose",
  "cta_pattern": "the letter label of the CTA pattern you chose"
}`,
  };
}

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
    context += recent.map(p => {
      const m = p.meta || {};
      const tag = (m.hook_pattern || m.cta_pattern)
        ? ` [hook=${m.hook_pattern || '?'}, cta=${m.cta_pattern || '?'}]`
        : '';
      return `- "${p.copy_headline}" (${p.template_type})${tag}`;
    }).join('\n');
    context += '\n\nFind a fresh angle.\n';

    // Pattern-rotation hint for reel + hook templates: count which patterns
    // have been used in the last 14 days so the LLM can pick a fresh one.
    const hookCounts = {};
    const ctaCounts = {};
    for (const p of recent) {
      if (p.meta?.hook_pattern) hookCounts[p.meta.hook_pattern] = (hookCounts[p.meta.hook_pattern] || 0) + 1;
      if (p.meta?.cta_pattern) ctaCounts[p.meta.cta_pattern] = (ctaCounts[p.meta.cta_pattern] || 0) + 1;
    }
    if (Object.keys(hookCounts).length || Object.keys(ctaCounts).length) {
      context += `\nPATTERN ROTATION (only relevant for reel + hook templates):\n`;
      if (Object.keys(hookCounts).length) {
        const used = Object.entries(hookCounts).sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${n}×${c}`).join(', ');
        context += `- Hook patterns recently used: ${used} — pick a different one this time.\n`;
      }
      if (Object.keys(ctaCounts).length) {
        const used = Object.entries(ctaCounts).sort((a, b) => b[1] - a[1])
          .map(([n, c]) => `${n}×${c}`).join(', ');
        context += `- CTA patterns recently used: ${used} — pick a different one this time.\n`;
      }
    }
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

async function generateCopy(brand, templateType, briefText, contextBlock, author) {
  const basePrompt = await getSystemPrompt(brand);
  // Use pre-built context if provided, otherwise build fresh (e.g. standalone calls)
  if (!contextBlock) {
    ({ context: contextBlock } = await buildContextBlock(brand));
  }
  // Author overlay sits AFTER context so the most recent instruction in
  // the system prompt is "write in this writer's voice" — strongest
  // recency anchor for Claude.
  const systemPrompt = basePrompt + contextBlock + authorPromptBlock(author);

  // Resolve template prompts at request time so /hooks /ctas edits in
  // Telegram are reflected without restarting the worker.
  const templatePrompts = await getTemplatePrompts();
  let userPrompt = templatePrompts[templateType];

  // Visual theme picker — Claude reads the visual_directive (operator-set
  // free text via /visual) and the theme menu, then names a theme. The
  // renderer turns that name into actual fonts/colours/decorations.
  const { renderThemeMenu, THEME_NAMES, DEFAULT_THEME_NAME } = require('./themes');
  const visualDirective = await getBrandVisualDirective(brand);
  userPrompt += `\n\n${renderThemeMenu()}`;
  if (visualDirective) {
    userPrompt += `\n\nVISUAL DIRECTIVE FROM THE OWNER (honour this when picking the theme):\n${visualDirective}`;
  }
  userPrompt += `\n\nIn addition to the other JSON fields, include "visual_style": "<theme name>" — exactly one of: ${THEME_NAMES.join(', ')}.`;

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
        // Split off fragment (#...) so UTM params go before it
        const [base, fragment] = url.split('#');
        const sep = base.includes('?') ? '&' : '?';
        const utm = `${sep}utm_source=facebook&utm_medium=social&utm_campaign=${campaign}`;
        return fragment ? `${base}${utm}#${fragment}` : `${base}${utm}`;
      }
    );
  }

  // Log which pattern was picked when the reel template returned them — gives
  // operators visibility in Railway logs and a foothold for future rotation
  // tracking (e.g. add a meta jsonb column to posts later).
  if (templateType === 'reel' && (parsed.hook_pattern || parsed.cta_pattern)) {
    console.log(`  [reel] pattern: hook=${parsed.hook_pattern || '?'} cta=${parsed.cta_pattern || '?'}`);
  }

  // Validate visual_style — fall back silently to default if Claude returned
  // an invalid theme name (so a one-off prompt regression doesn't crash the
  // generation pipeline; the renderer would also fall back, but persisting
  // a clean value keeps post.meta accurate).
  let visualStyle = typeof parsed.visual_style === 'string' ? parsed.visual_style.trim() : null;
  if (visualStyle && !THEME_NAMES.includes(visualStyle)) {
    console.warn(`  [generate] Claude returned unknown visual_style '${visualStyle}', falling back to ${DEFAULT_THEME_NAME}`);
    visualStyle = DEFAULT_THEME_NAME;
  }

  return {
    copy_headline: parsed.copy_headline,
    copy_body: parsed.copy_body || '',
    copy_cta: cta,
    // Pattern names propagated through so insertPost can persist them later
    // if/when a meta column lands on posts. Currently ignored downstream.
    hook_pattern: parsed.hook_pattern || null,
    cta_pattern: parsed.cta_pattern || null,
    visual_style: visualStyle || null,
  };
}

// ── GENERATE BATCH ──
// Generates 3 posts per brand (one each of stat, hook, list — rotating reel in)

async function pickTemplates() {
  // Three-template batch. The deterministic week-rotation gave even
  // exposure across the four templates; runtime weights override it so
  // the operator can bias the mix (e.g. /templates reel 3 to get more
  // reels than statics). When all weights are equal we still rotate
  // through the 4 types deterministically by week to preserve "seen
  // every type" behaviour.
  const weights = await getTemplateWeights();
  const types = templateTypes.filter(t => (weights[t] ?? 0) > 0);
  if (types.length === 0) {
    // Fail safe: weights all zero — fall back to default rotation.
    const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const offset = weekNum % templateTypes.length;
    return [
      templateTypes[offset % 4],
      templateTypes[(offset + 1) % 4],
      templateTypes[(offset + 2) % 4]
    ];
  }

  // All weights equal? Use the legacy week-rotation for predictability.
  const allEqual = types.every(t => weights[t] === weights[types[0]]);
  if (allEqual && types.length === templateTypes.length) {
    const weekNum = Math.floor(Date.now() / (7 * 24 * 60 * 60 * 1000));
    const offset = weekNum % templateTypes.length;
    return [
      templateTypes[offset % 4],
      templateTypes[(offset + 1) % 4],
      templateTypes[(offset + 2) % 4]
    ];
  }

  // Weighted random sampling without replacement, capped at 3 picks.
  const picks = [];
  const pool = [...types];
  for (let i = 0; i < 3 && pool.length > 0; i++) {
    const totalWeight = pool.reduce((s, t) => s + weights[t], 0);
    let r = Math.random() * totalWeight;
    let chosen = pool[0];
    for (const t of pool) {
      r -= weights[t];
      if (r <= 0) { chosen = t; break; }
    }
    picks.push(chosen);
    // Remove from pool to avoid duplicate templates in one batch unless
    // the operator has fewer than 3 enabled types.
    if (pool.length > 1) {
      const idx = pool.indexOf(chosen);
      if (idx >= 0) pool.splice(idx, 1);
    }
  }
  return picks;
}

function assignPlatforms(templates) {
  // All posts go to Facebook for now — expand to linkedin/tiktok when those APIs are wired up
  return templates.map(t => ({ templateType: t, platform: 'facebook' }));
}

async function generateBatch() {
  const templates = await pickTemplates();
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

  // Active brands list is operator-tunable via /active in Telegram.
  // Defaults to ['auctionbrain'] (BridgeMatch FB page not wired) — see
  // runtime-config.DEFAULT_ACTIVE_BRANDS.
  const activeBrands = await getActiveBrands();

  const allUsedSeedIds = [];

  for (const brand of activeBrands) {
    // Filter briefs: use ones with matching brand or no brand specified
    const brandBriefs = briefs.filter(b => !b.brand || b.brand === brand);
    const brandBriefText = brandBriefs.length
      ? brandBriefs.map(b => b.message).join('\n')
      : null;

    // Build context once per brand — reuse across all template generations
    const { context: brandContext, seedIds } = await buildContextBlock(brand);
    if (seedIds.length) allUsedSeedIds.push(...seedIds);

    for (const { templateType, platform } of assignments) {
      // Pick a fresh author per post so a single batch can voice-rotate.
      // pickAuthor returns null when no eligible (active, brand-scoped)
      // authors exist — generateCopy then falls through to plain brand
      // voice. Persist the author name on meta so engagement can later
      // be attributed by ghost-writer.
      const author = await pickAuthor(brand);
      const authorName = author?.name || null;
      if (authorName) {
        console.log(`  Generating ${brands[brand].name} / ${templateType} / ${platform} (voice: ${authorName})...`);
      } else {
        console.log(`  Generating ${brands[brand].name} / ${templateType} / ${platform}...`);
      }
      const copy = await generateCopy(brand, templateType, brandBriefText, brandContext, author);
      posts.push({
        brand,
        platform,
        template_type: templateType,
        ...copy,
        // Carry the author through; insertPost shapes the row, so we
        // surface this as a top-level field for the caller and let the
        // server-side insertPost decide whether to fold it into meta.
        author: authorName,
      });
    }
  }

  // Only mark briefs and seeds as used after successful generation
  // Only mark briefs that were actually consumed (matched an active brand)
  const usedBriefIds = briefs
    .filter(b => activeBrands.some(brand => !b.brand || b.brand === brand))
    .map(b => b.id);

  if (posts.length > 0) {
    if (usedBriefIds.length) {
      try {
        await markBriefsUsed(usedBriefIds);
        console.log(`  Marked ${usedBriefIds.length} brief(s) as used`);
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

// Phase B outbound generator lives in lib/generate-outbound.js so this file
// stays under the 500-line house cap. Re-exported here so callers can keep
// using `require('./generate').generateOutbound`.
const { generateOutbound } = require('./generate-outbound');

module.exports = { generateCopy, generateBatch, pickTemplates, assignPlatforms, generateOutbound };
