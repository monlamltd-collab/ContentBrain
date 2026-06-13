require('dotenv').config();
const { createClaudeLLM, CLAUDE_MODEL, llmJson } = require('./llm');
const { brands, templateTypes } = require('./config');
const { getPendingBriefs, markBriefsUsed, getRecentApprovedPosts, getRecentRejectedPosts, getRecentPublishedPosts, getRecentDrafts, getUnusedSeeds, markSeedsUsedForSocial, getFreshLotsForMaterial } = require('./supabase');
const { getTopPerformingPosts } = require('./insights');
const { getTemplatePerformance } = require('./closed-loop/template-performance');
const {
  getResolvedBrand,
  getActiveBrands,
  getTemplateWeights,
  getTemplateDurations,
  getBrandVisualDirective,
  renderHookMenu,
  renderCtaMenu,
} = require('./runtime-config');
const { pickAuthor, authorPromptBlock } = require('./authors');

// Generation runs on Claude Sonnet with extended thinking (via createClaudeLLM).
// The `model` field passed to .create() is ignored by that client — it always
// uses CLAUDE_MODEL — but we keep it populated for readable logs.
const MODEL = CLAUDE_MODEL;

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
  const [approved, rejected, recentPublished, recentDrafts, topPerformers, seeds, lots] = await Promise.all([
    getRecentApprovedPosts(brand, 5).catch(() => []),
    getRecentRejectedPosts(brand, 3).catch(() => []),
    getRecentPublishedPosts(brand, 14).catch(() => []),
    getRecentDrafts(brand, 30).catch(() => []),
    getTopPerformingPosts(brand, 3).catch(() => []),
    getUnusedSeeds(brand, 5).catch(() => []),
    getFreshLotsForMaterial(6).catch(() => [])
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

  // ── ANTI-REPETITION AVOID-LIST — drafts in the queue AND recently published ──
  // recentDrafts is the critical fix. The generator used to only avoid
  // approved/published posts, so when approvals stalled it went blind to the
  // (huge) draft backlog and looped on the same handful of angles. We merge
  // both, dedupe by headline, and present them as one hard avoid-list.
  const avoidRows = [...recentDrafts, ...recentPublished];
  const seenAvoid = new Set();
  const avoidHeadlines = [];
  for (const p of avoidRows) {
    const key = (p.copy_headline || '').trim().toLowerCase();
    if (!key || seenAvoid.has(key)) continue;
    seenAvoid.add(key);
    avoidHeadlines.push(p);
  }
  if (avoidHeadlines.length) {
    context += '\n\nALREADY WRITTEN — drafts already in the review queue plus recently published posts. Do NOT reuse these headlines, stats, angles or framings. Every new post must be conspicuously different — if your idea is even adjacent to one below, choose a different subject entirely:\n';
    context += avoidHeadlines.slice(0, 40).map(p => {
      const m = p.meta || {};
      const tag = (m.hook_pattern || m.cta_pattern)
        ? ` [hook=${m.hook_pattern || '?'}, cta=${m.cta_pattern || '?'}]`
        : '';
      return `- "${p.copy_headline}" (${p.template_type})${tag}`;
    }).join('\n');
    context += '\n';

    // Pattern-rotation hint for reel + hook templates: count which patterns
    // have been used recently so the LLM can pick a fresh one.
    const hookCounts = {};
    const ctaCounts = {};
    for (const p of avoidHeadlines) {
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

  // ── FRESH LOT MATERIAL — real, changing inventory to anchor specifics ──
  // The single biggest antidote to repetition: real lots change daily, so a
  // post built on "a 3-bed in Hull, guide £42k, 11% yield" can never collapse
  // into yet another abstract "~50% of lots" line.
  let lotMaterial = '';
  if (lots.length) {
    lotMaterial = lots.map(l => {
      const bits = [
        l.address ? `${l.address}${l.postcode ? ` (${l.postcode})` : ''}` : null,
        l.prop_type ? `${l.prop_type}${l.beds ? `, ${l.beds} bed` : ''}` : null,
        l.price ? `guide £${Math.round(l.price).toLocaleString('en-GB')}` : null,
        (l.below_market && l.below_market > 0) ? `${l.below_market}% below street avg` : null,
        l.est_gross_yield ? `${Number(l.est_gross_yield).toFixed(1)}% gross yield` : null,
        l.condition ? `condition: ${l.condition}` : null,
        l.auction_date ? `auctions ${l.auction_date}` : null,
        l.house ? `via ${l.house}` : null,
      ].filter(Boolean).join(' · ');
      return `- ${bits}`;
    }).join('\n');
    context += '\n\nREAL LOTS ON THE PLATFORM RIGHT NOW (use these concrete, changing specifics to make posts vivid and non-generic — a real postcode, price or yield beats another abstract platform claim every time). Never invent figures: use only what appears here or in the key messages:\n';
    context += lotMaterial + '\n';
  }

  if (seeds.length) {
    context += '\n\nCONTENT SEEDS (research and material from the owner — use these as inspiration):\n';
    context += seeds.map(s =>
      `- ${s.summary}${s.key_points ? ` | Key points: ${s.key_points}` : ''} (source: ${s.source})`
    ).join('\n');
    context += '\n';
  }

  return { context, seedIds: seeds.map(s => s.id), avoidHeadlines, lotMaterial, hasLots: lots.length > 0 };
}

// ── ANGLE SELECTION ──
// Before any copy is written, Claude chooses N DISTINCT angles for the batch,
// given the brand, the avoid-list, real lot material and seeds. This is the
// structural diversity lever: each post is handed a different, specific subject
// up front so a batch can't collapse onto one message. Mirrors the blog
// engine's selectTheme step. Best-effort — callers fall back to no angle.
async function selectAngles(brand, count, ctx) {
  const b = await getResolvedBrand(brand);
  const system = `You are the content strategist for ${b.name} (${b.url}). Your only job here is to choose ${count} DISTINCT, specific angles for the next batch of social posts. Diversity is the absolute priority: recent output has been highly repetitive and the owner has stopped approving it. Each angle must be conspicuously different from the others AND from everything in the "ALREADY WRITTEN" avoid-list. Anchor angles to concrete specifics (a real lot, a real number) wherever possible — abstract brand claims are what caused the repetition.`;

  const user = [
    `AUDIENCE: ${b.audience}`,
    '',
    `WHAT ${b.name} OFFERS (you MAY anchor an angle to one of these, but never just restate it — turn it into a specific, fresh idea):`,
    b.messages.map(m => `- ${m}`).join('\n'),
    ctx.context || '',
    '',
    `Now choose exactly ${count} angles. Spread them across different subjects, emotions and proof types. Prefer angles built on a REAL LOT above when available. Do not reuse any subject already in the avoid-list.`,
    '',
    `Return ONLY JSON, no prose:`,
    `{ "angles": [ { "angle": "one specific sentence describing the post idea and why it is fresh", "anchor": "the concrete lot/number/fact it is built on, or the brand message it reframes", "emotion": "the feeling it should provoke" } ] }`,
  ].join('\n');

  const parsed = await llmJson(createClaudeLLM(), {
    model: MODEL,
    max_tokens: 1200,
    system,
    messages: [{ role: 'user', content: user }],
  }, { label: `angles:${brand}` });
  const angles = parsed.angles;
  return Array.isArray(angles) ? angles.filter(a => a && a.angle) : [];
}

// ── GENERATE COPY ──

async function generateCopy(brand, templateType, briefText, contextBlock, author, angle) {
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

  // The pre-selected angle is the strongest steer toward novelty — place it
  // last so it's the most recent (highest-recency) instruction the model sees.
  if (angle && angle.angle) {
    userPrompt += `\n\nTHE ANGLE FOR THIS POST — build the post around this specific idea. Do NOT drift back to generic brand claims:\n`;
    userPrompt += `Angle: ${angle.angle}`;
    if (angle.anchor) userPrompt += `\nAnchored on: ${angle.anchor}`;
    if (angle.emotion) userPrompt += `\nIntended feeling: ${angle.emotion}`;
  }

  if (briefText) {
    userPrompt += `\n\nADDITIONAL DIRECTION FROM THE CONTENT OWNER:\n${briefText}\n\nWork this direction into the post naturally. Don't mention it was requested.`;
  }

  const parsed = await llmJson(createClaudeLLM(), {
    model: MODEL,
    max_tokens: 700,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  }, { label: `copy:${brand}/${templateType}` });

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

  // Per-template default video duration (Design tab / "/durations" lever).
  // Carried on each post as duration_seconds; insert sites persist it into
  // meta and lib/video-renderer resolves it at render time.
  let templateDurations = null;
  try {
    templateDurations = await getTemplateDurations();
  } catch (err) {
    console.warn(`  Could not load template durations: ${err.message} — composition defaults apply`);
  }

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
    const ctx = await buildContextBlock(brand);
    const brandContext = ctx.context;
    if (ctx.seedIds.length) allUsedSeedIds.push(...ctx.seedIds);

    // Select one distinct angle per post up front so the batch can't collapse
    // onto a single message. Best-effort: on failure we still generate, and the
    // context block keeps generation draft-aware regardless.
    let angles = [];
    try {
      angles = await selectAngles(brand, assignments.length, ctx);
      console.log(`  Selected ${angles.length} distinct angle(s) for ${brands[brand].name}`);
    } catch (err) {
      console.warn(`  Angle selection failed for ${brand}: ${err.message} — proceeding without explicit angles`);
    }

    let postIdx = 0;
    for (const { templateType, platform } of assignments) {
      // Hand each post in the batch its own pre-selected angle.
      const angle = angles[postIdx] || null;
      postIdx++;

      // Pick a fresh author per post so a single batch can voice-rotate.
      // pickAuthor returns null when no eligible (active, brand-scoped)
      // authors exist — generateCopy then falls through to plain brand
      // voice. Persist the author name on meta so engagement can later
      // be attributed by ghost-writer.
      const author = await pickAuthor(brand);
      const authorName = author?.name || null;
      const angleNote = angle ? ` (angle: ${String(angle.angle).slice(0, 60)}…)` : '';
      if (authorName) {
        console.log(`  Generating ${brands[brand].name} / ${templateType} / ${platform} (voice: ${authorName})${angleNote}...`);
      } else {
        console.log(`  Generating ${brands[brand].name} / ${templateType} / ${platform}${angleNote}...`);
      }
      const copy = await generateCopy(brand, templateType, brandBriefText, brandContext, author, angle);
      posts.push({
        brand,
        platform,
        template_type: templateType,
        ...copy,
        // Carry the author through; insertPost shapes the row, so we
        // surface this as a top-level field for the caller and let the
        // server-side insertPost decide whether to fold it into meta.
        author: authorName,
        duration_seconds: templateDurations ? templateDurations[templateType] : undefined,
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

module.exports = { generateCopy, generateBatch, pickTemplates, assignPlatforms, generateOutbound, selectAngles, buildContextBlock };
