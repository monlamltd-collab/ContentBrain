require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { timingSafeEqual } = require('crypto');
const { getDraftPosts, getApprovedPosts, updatePostStatus, getPostById, saveBrief, insertPost, saveSeed, getDraftBlogPosts, updateBlogPostStatus, getBlogPostById, getPublishedBlogPostsBothBrands, getPendingBriefsAll, dismissBrief } = require('./lib/supabase');
const { publish } = require('./lib/publish');
const { sendPostForReview, sendNotification, answerCallback, removeButtons, downloadTelegramFile, API, BOT_TOKEN, CHAT_ID } = require('./lib/telegram');
const reviewRouter = require('./lib/review-api');
const runtimeConfig = require('./lib/runtime-config');
const authorsLib = require('./lib/authors');
const { brands: defaultBrands, templateTypes } = require('./lib/config');

// HTML-escape user-supplied strings before echoing them in Telegram
// notifications (sendNotification uses parse_mode HTML).
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Whitespace-aware tokeniser: splits on runs of whitespace but keeps
// the rest of the line intact when only the first N tokens are needed.
// e.g. cmdTokens('/tone bridgematch sharp, stoic', 2) ->
//   ['/tone', 'bridgematch', 'sharp, stoic']
function cmdTokens(text, fixedHead = 1) {
  const trimmed = text.trim();
  const parts = [];
  let cursor = 0;
  for (let i = 0; i < fixedHead; i++) {
    while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
    const start = cursor;
    while (cursor < trimmed.length && !/\s/.test(trimmed[cursor])) cursor++;
    if (start === cursor) break;
    parts.push(trimmed.slice(start, cursor));
  }
  while (cursor < trimmed.length && /\s/.test(trimmed[cursor])) cursor++;
  if (cursor < trimmed.length) parts.push(trimmed.slice(cursor));
  return parts;
}

// Validate brand argument against the brands defined in lib/config.js.
function requireBrand(arg) {
  const brand = (arg || '').toLowerCase().trim();
  if (!defaultBrands[brand]) {
    throw new Error(`Unknown brand "${arg}". Use one of: ${Object.keys(defaultBrands).join(', ')}.`);
  }
  return brand;
}

// ── Lever command dispatcher ───────────────────────────────────────────
// Returns true when the command was a recognised lever command (so the
// caller knows to `continue` past the conversational fallback). Throws
// on user error so the caller can echo a friendly message.
async function handleLeverCommand(text /* , msg */) {
  const head = text.split(/\s+/, 1)[0];

  // /levers — full snapshot
  if (head === '/levers') {
    const [activeBrands, weights, hooks, ctas, allRows, authors] = await Promise.all([
      runtimeConfig.getActiveBrands(),
      runtimeConfig.getTemplateWeights(),
      runtimeConfig.getHookPatterns(),
      runtimeConfig.getCtaPatterns(),
      runtimeConfig.loadAllLevers(),
      authorsLib.listAuthors(),
    ]);

    const activeAuthors = authors.filter(a => a.active);
    const lines = [
      `<b>Levers snapshot</b>`,
      ``,
      `<b>Active brands:</b> ${escapeHtml(activeBrands.join(', ') || '(none)')}`,
      `<b>Template weights:</b> ${templateTypes.map(t => `${t}=${weights[t] ?? 0}`).join(', ')}`,
      `<b>Hook patterns:</b> ${hooks.length} (use /hooks to view)`,
      `<b>CTA patterns:</b> ${ctas.length} (use /ctas to view)`,
      `<b>Ghost-writers:</b> ${activeAuthors.length} active / ${authors.length} total (use /authors)`,
      ``,
      `<b>Per-brand voice:</b>`,
    ];

    for (const brandKey of Object.keys(defaultBrands)) {
      const resolved = await runtimeConfig.getResolvedBrand(brandKey);
      lines.push(``);
      lines.push(`<b>${escapeHtml(resolved.name)}</b>`);
      lines.push(`tone: ${escapeHtml(resolved.tone || '(default)')}`);
      lines.push(`audience: ${escapeHtml(resolved.audience || '(default)')}`);
      lines.push(`messages: ${resolved.messages.length} item(s)`);
      lines.push(`directive: ${resolved._directive ? escapeHtml(resolved._directive.slice(0, 80)) + (resolved._directive.length > 80 ? '…' : '') : '(none)'}`);
    }

    if (allRows.length) {
      lines.push(``);
      lines.push(`<i>${allRows.length} override row(s) in app_config.</i>`);
    } else {
      lines.push(``);
      lines.push(`<i>No overrides — all values are from defaults in lib/config.js.</i>`);
    }
    await sendNotification(lines.join('\n'));
    return true;
  }

  // /tone <brand> [new tone…]
  if (head === '/tone') {
    const [, brandArg, rest] = cmdTokens(text, 2);
    if (!brandArg) {
      await sendNotification(`Usage: <code>/tone &lt;brand&gt; [new tone…]</code>`);
      return true;
    }
    const brand = requireBrand(brandArg);
    if (!rest) {
      const tone = await runtimeConfig.getBrandTone(brand);
      await sendNotification(`<b>${defaultBrands[brand].name} tone</b>\n${escapeHtml(tone)}`);
      return true;
    }
    if (rest.toLowerCase() === 'reset' || rest.toLowerCase() === 'clear') {
      await runtimeConfig.clearLever(brand, 'tone');
      await sendNotification(`Reset <b>${defaultBrands[brand].name}</b> tone to default.`);
      return true;
    }
    await runtimeConfig.setLever(brand, 'tone', rest);
    await sendNotification(`Updated <b>${defaultBrands[brand].name}</b> tone:\n${escapeHtml(rest)}`);
    return true;
  }

  // /audience <brand> [new audience…]
  if (head === '/audience') {
    const [, brandArg, rest] = cmdTokens(text, 2);
    if (!brandArg) {
      await sendNotification(`Usage: <code>/audience &lt;brand&gt; [new audience…]</code>`);
      return true;
    }
    const brand = requireBrand(brandArg);
    if (!rest) {
      const aud = await runtimeConfig.getBrandAudience(brand);
      await sendNotification(`<b>${defaultBrands[brand].name} audience</b>\n${escapeHtml(aud)}`);
      return true;
    }
    if (rest.toLowerCase() === 'reset' || rest.toLowerCase() === 'clear') {
      await runtimeConfig.clearLever(brand, 'audience');
      await sendNotification(`Reset <b>${defaultBrands[brand].name}</b> audience to default.`);
      return true;
    }
    await runtimeConfig.setLever(brand, 'audience', rest);
    await sendNotification(`Updated <b>${defaultBrands[brand].name}</b> audience:\n${escapeHtml(rest)}`);
    return true;
  }

  // /messages <brand> [list | add <text> | rm <n> | reset]
  if (head === '/messages') {
    const [, brandArg, rest] = cmdTokens(text, 2);
    if (!brandArg) {
      await sendNotification(`Usage: <code>/messages &lt;brand&gt; [list | add &lt;text&gt; | rm &lt;n&gt; | reset]</code>`);
      return true;
    }
    const brand = requireBrand(brandArg);
    const sub = (rest || 'list').trim();
    const subHead = sub.split(/\s+/, 1)[0].toLowerCase();
    const subRest = sub.slice(subHead.length).trim();

    if (subHead === 'list' || sub === '') {
      const messages = await runtimeConfig.getBrandMessages(brand);
      const body = messages.length
        ? messages.map((m, i) => `${i + 1}. ${escapeHtml(m)}`).join('\n')
        : '(no messages set)';
      await sendNotification(`<b>${defaultBrands[brand].name} key messages</b>\n${body}`);
      return true;
    }
    if (subHead === 'add') {
      if (!subRest) throw new Error('Add what? Provide the message text.');
      const next = await runtimeConfig.appendArrayLever(
        brand, 'messages',
        () => defaultBrands[brand].messages,
        subRest
      );
      await sendNotification(`Added message #${next.length}: ${escapeHtml(subRest)}`);
      return true;
    }
    if (subHead === 'rm' || subHead === 'remove' || subHead === 'delete') {
      const idx = parseInt(subRest, 10);
      if (Number.isNaN(idx) || idx < 1) throw new Error('Provide a 1-based index, e.g. /messages auctionbrain rm 2');
      const next = await runtimeConfig.removeArrayLever(
        brand, 'messages',
        () => defaultBrands[brand].messages,
        idx - 1
      );
      await sendNotification(`Removed message #${idx}. ${next.length} remaining.`);
      return true;
    }
    if (subHead === 'reset' || subHead === 'clear') {
      await runtimeConfig.clearLever(brand, 'messages');
      await sendNotification(`Reset <b>${defaultBrands[brand].name}</b> messages to default.`);
      return true;
    }
    throw new Error(`Unknown /messages subcommand "${subHead}". Try list / add / rm / reset.`);
  }

  // /directive <brand> [show | clear | <text…>]
  if (head === '/directive') {
    const [, brandArg, rest] = cmdTokens(text, 2);
    if (!brandArg) {
      await sendNotification(`Usage: <code>/directive &lt;brand&gt; [show | clear | &lt;text…&gt;]</code>`);
      return true;
    }
    const brand = requireBrand(brandArg);
    if (!rest || rest.toLowerCase() === 'show') {
      const d = await runtimeConfig.getBrandDirective(brand);
      await sendNotification(`<b>${defaultBrands[brand].name} directive</b>\n${d ? escapeHtml(d) : '(none)'}`);
      return true;
    }
    if (rest.toLowerCase() === 'clear' || rest.toLowerCase() === 'reset' || rest.toLowerCase() === 'remove') {
      await runtimeConfig.clearLever(brand, 'directive');
      await sendNotification(`Cleared <b>${defaultBrands[brand].name}</b> directive.`);
      return true;
    }
    await runtimeConfig.setLever(brand, 'directive', rest);
    await sendNotification(`Updated <b>${defaultBrands[brand].name}</b> directive:\n${escapeHtml(rest)}`);
    return true;
  }

  // /visual <brand> [show | clear | themes | <text…>]
  // Free-form visual steer per brand. Claude reads it at generation time and
  // picks one of the available themes. `themes` lists what's available.
  if (head === '/visual') {
    const [, brandArg, rest] = cmdTokens(text, 2);
    const { THEMES, THEME_NAMES, DEFAULT_THEME_NAME } = require('./lib/themes');
    if (!brandArg) {
      await sendNotification(`Usage: <code>/visual &lt;brand&gt; [show | clear | themes | &lt;text…&gt;]</code>`);
      return true;
    }
    if (brandArg.toLowerCase() === 'themes') {
      const lines = THEME_NAMES.map(n => `• <b>${n}</b>${n === DEFAULT_THEME_NAME ? ' (default)' : ''}\n  ${escapeHtml(THEMES[n].description)}`);
      await sendNotification(`<b>Available themes</b>\n\n${lines.join('\n\n')}`);
      return true;
    }
    const brand = requireBrand(brandArg);
    if (!rest || rest.toLowerCase() === 'show') {
      const d = await runtimeConfig.getBrandVisualDirective(brand);
      await sendNotification(`<b>${defaultBrands[brand].name} visual directive</b>\n${d ? escapeHtml(d) : '(none — Claude picks freely from the theme menu)'}`);
      return true;
    }
    if (rest.toLowerCase() === 'clear' || rest.toLowerCase() === 'reset' || rest.toLowerCase() === 'remove') {
      await runtimeConfig.clearLever(brand, 'visual_directive');
      await sendNotification(`Cleared <b>${defaultBrands[brand].name}</b> visual directive.`);
      return true;
    }
    await runtimeConfig.setLever(brand, 'visual_directive', rest);
    await sendNotification(`Updated <b>${defaultBrands[brand].name}</b> visual directive:\n${escapeHtml(rest)}\n\nClaude will use this to pick from: ${THEME_NAMES.join(', ')}.`);
    return true;
  }

  // /hooks [list | add <text> | rm <n> | reset]
  if (head === '/hooks') {
    const [, ...args] = cmdTokens(text, 2);
    const sub = (args[0] || 'list').trim();
    const subHead = sub.split(/\s+/, 1)[0].toLowerCase();
    const subRest = sub.slice(subHead.length).trim();

    if (subHead === 'list' || sub === '') {
      const patterns = await runtimeConfig.getHookPatterns();
      const lines = patterns.map((p, i) => `${i + 1}. [${escapeHtml(p.label)}] ${escapeHtml(p.body)}`);
      await sendNotification(`<b>Hook patterns (${patterns.length})</b>\n${lines.join('\n') || '(empty)'}`);
      return true;
    }
    if (subHead === 'add') {
      if (!subRest) throw new Error('Add what? Provide the pattern text.');
      const { label, count } = await runtimeConfig.addHookPattern(subRest);
      await sendNotification(`Added hook pattern <b>${escapeHtml(label)}</b> (${count} total).`);
      return true;
    }
    if (subHead === 'rm' || subHead === 'remove' || subHead === 'delete') {
      const idx = parseInt(subRest, 10);
      if (Number.isNaN(idx) || idx < 1) throw new Error('Provide a 1-based index, e.g. /hooks rm 4');
      const next = await runtimeConfig.removeHookPattern(idx - 1);
      await sendNotification(`Removed hook pattern #${idx}. ${next.length} remaining.`);
      return true;
    }
    if (subHead === 'reset' || subHead === 'clear') {
      await runtimeConfig.clearLever('global', 'hook_patterns');
      await sendNotification(`Reset hook patterns to defaults.`);
      return true;
    }
    throw new Error(`Unknown /hooks subcommand "${subHead}". Try list / add / rm / reset.`);
  }

  // /ctas [list | add <text> | rm <n> | reset]
  if (head === '/ctas') {
    const [, ...args] = cmdTokens(text, 2);
    const sub = (args[0] || 'list').trim();
    const subHead = sub.split(/\s+/, 1)[0].toLowerCase();
    const subRest = sub.slice(subHead.length).trim();

    if (subHead === 'list' || sub === '') {
      const patterns = await runtimeConfig.getCtaPatterns();
      const lines = patterns.map((p, i) => `${i + 1}. [${escapeHtml(p.label)}] ${escapeHtml(p.body)}`);
      await sendNotification(`<b>CTA patterns (${patterns.length})</b>\n${lines.join('\n') || '(empty)'}`);
      return true;
    }
    if (subHead === 'add') {
      if (!subRest) throw new Error('Add what? Provide the pattern text.');
      const { label, count } = await runtimeConfig.addCtaPattern(subRest);
      await sendNotification(`Added CTA pattern <b>${escapeHtml(label)}</b> (${count} total).`);
      return true;
    }
    if (subHead === 'rm' || subHead === 'remove' || subHead === 'delete') {
      const idx = parseInt(subRest, 10);
      if (Number.isNaN(idx) || idx < 1) throw new Error('Provide a 1-based index, e.g. /ctas rm 3');
      const next = await runtimeConfig.removeCtaPattern(idx - 1);
      await sendNotification(`Removed CTA pattern #${idx}. ${next.length} remaining.`);
      return true;
    }
    if (subHead === 'reset' || subHead === 'clear') {
      await runtimeConfig.clearLever('global', 'cta_patterns');
      await sendNotification(`Reset CTA patterns to defaults.`);
      return true;
    }
    throw new Error(`Unknown /ctas subcommand "${subHead}". Try list / add / rm / reset.`);
  }

  // /active [list | add <brand> | rm <brand>]
  if (head === '/active') {
    const [, ...args] = cmdTokens(text, 2);
    const sub = (args[0] || 'list').trim();
    const subHead = sub.split(/\s+/, 1)[0].toLowerCase();
    const subRest = sub.slice(subHead.length).trim();

    if (subHead === 'list' || sub === '') {
      const list = await runtimeConfig.getActiveBrands();
      await sendNotification(`<b>Active brands:</b> ${escapeHtml(list.join(', ') || '(none)')}`);
      return true;
    }
    if (subHead === 'add') {
      const brand = requireBrand(subRest);
      const current = await runtimeConfig.getActiveBrands();
      if (current.includes(brand)) {
        await sendNotification(`<b>${defaultBrands[brand].name}</b> is already active.`);
        return true;
      }
      const next = [...current, brand];
      await runtimeConfig.setLever('global', 'active_brands', next);
      await sendNotification(`Activated <b>${defaultBrands[brand].name}</b>. Active: ${next.join(', ')}.`);
      return true;
    }
    if (subHead === 'rm' || subHead === 'remove' || subHead === 'delete') {
      const brand = requireBrand(subRest);
      const current = await runtimeConfig.getActiveBrands();
      const next = current.filter(b => b !== brand);
      await runtimeConfig.setLever('global', 'active_brands', next);
      await sendNotification(`Deactivated <b>${defaultBrands[brand].name}</b>. Active: ${next.join(', ') || '(none)'}.`);
      return true;
    }
    if (subHead === 'reset' || subHead === 'clear') {
      await runtimeConfig.clearLever('global', 'active_brands');
      await sendNotification(`Reset active brands to default.`);
      return true;
    }
    throw new Error(`Unknown /active subcommand "${subHead}". Try list / add / rm / reset.`);
  }

  // /templates [show | <type> <weight>]
  if (head === '/templates') {
    const [, ...args] = cmdTokens(text, 3);
    const sub = (args[0] || 'show').trim().toLowerCase();
    const arg2 = args[1];

    if (sub === 'show' || sub === 'list' || sub === '') {
      const w = await runtimeConfig.getTemplateWeights();
      const body = templateTypes.map(t => `${t}: ${w[t] ?? 0}`).join('\n');
      await sendNotification(`<b>Template weights</b>\n${body}\n\n<i>Higher weight = more frequent. Set zero to disable. e.g. <code>/templates reel 3</code></i>`);
      return true;
    }
    if (sub === 'reset' || sub === 'clear') {
      await runtimeConfig.clearLever('global', 'template_weights');
      await sendNotification(`Reset template weights to default (all 1).`);
      return true;
    }
    if (templateTypes.includes(sub)) {
      const weight = parseFloat(arg2);
      if (Number.isNaN(weight) || weight < 0) throw new Error('Provide a non-negative number, e.g. /templates reel 3');
      const current = await runtimeConfig.getTemplateWeights();
      const next = { ...current, [sub]: weight };
      await runtimeConfig.setLever('global', 'template_weights', next);
      const body = templateTypes.map(t => `${t}: ${next[t] ?? 0}`).join('\n');
      await sendNotification(`Updated weights:\n${body}`);
      return true;
    }
    throw new Error(`Unknown /templates argument "${sub}". Use one of: ${templateTypes.join(', ')}, or "show" / "reset".`);
  }

  // /authors (or /author) — manage ghost-writer personas.
  // Subcommands: list | add <name> <voice…> | show <name> | tone <name> <text>
  //              directive <name> <text> | weight <name> <n> | brand <name> <brand|all>
  //              pause <name> | resume <name> | rm <name>
  if (head === '/authors' || head === '/author') {
    const [, ...args] = cmdTokens(text, 2);
    const sub = (args[0] || 'list').trim();
    const subHead = sub.split(/\s+/, 1)[0].toLowerCase();
    const subRest = sub.slice(subHead.length).trim();

    if (subHead === 'list' || sub === '') {
      const list = await authorsLib.listAuthors();
      if (!list.length) {
        await sendNotification(
          `<b>No ghost-writers yet.</b>\n\n` +
          `Add one: <code>/authors add StoicUncle world-weary, monetarily literate, fond of long sentences</code>\n\n` +
          `When no authors exist, posts use plain brand voice.`
        );
        return true;
      }
      const lines = list.map(a => {
        const status = a.active ? '' : ' [paused]';
        const scope = (Array.isArray(a.brands) && a.brands.length) ? a.brands.join('+') : 'roaming';
        const tone = a.tone ? a.tone.slice(0, 60) + (a.tone.length > 60 ? '…' : '') : '(no tone set)';
        return `<b>${escapeHtml(a.name)}</b>${status} · w=${a.weight} · ${scope}\n   ${escapeHtml(tone)}`;
      });
      await sendNotification(`<b>Ghost-writers (${list.length})</b>\n\n${lines.join('\n\n')}`);
      return true;
    }

    if (subHead === 'add') {
      // /authors add <Name> <voice text…>
      const nameToken = subRest.split(/\s+/, 1)[0];
      const rest = subRest.slice(nameToken.length).trim();
      if (!nameToken) throw new Error('Usage: /authors add <Name> <voice description…>');
      const created = await authorsLib.createAuthor({
        name: nameToken,
        tone: rest || null,
      });
      await sendNotification(
        `Added <b>${escapeHtml(created.name)}</b> (roaming, weight 1).\n` +
        (rest ? `Voice: ${escapeHtml(rest)}` : '<i>No voice set yet — use /authors tone &lt;name&gt; &lt;text&gt;</i>')
      );
      return true;
    }

    if (subHead === 'show') {
      const name = subRest.trim();
      if (!name) throw new Error('Usage: /authors show <Name>');
      const a = await authorsLib.getAuthor(name);
      if (!a) throw new Error(`No author "${name}".`);
      const scope = (Array.isArray(a.brands) && a.brands.length) ? a.brands.join(', ') : 'roaming (any active brand)';
      await sendNotification(
        `<b>${escapeHtml(a.name)}</b> ${a.active ? '' : '[paused]'}\n` +
        `Weight: ${a.weight}\n` +
        `Brands: ${escapeHtml(scope)}\n` +
        `Tone: ${escapeHtml(a.tone || '(not set)')}\n` +
        `Directive: ${escapeHtml(a.directive || '(none)')}`
      );
      return true;
    }

    if (subHead === 'tone') {
      const name = subRest.split(/\s+/, 1)[0];
      const value = subRest.slice(name.length).trim();
      if (!name || !value) throw new Error('Usage: /authors tone <Name> <voice description…>');
      await authorsLib.updateAuthor(name, { tone: value });
      await sendNotification(`Updated <b>${escapeHtml(name)}</b> tone:\n${escapeHtml(value)}`);
      return true;
    }

    if (subHead === 'directive') {
      const name = subRest.split(/\s+/, 1)[0];
      const value = subRest.slice(name.length).trim();
      if (!name) throw new Error('Usage: /authors directive <Name> <text…> | clear');
      if (!value || value.toLowerCase() === 'clear') {
        await authorsLib.updateAuthor(name, { directive: null });
        await sendNotification(`Cleared <b>${escapeHtml(name)}</b> directive.`);
        return true;
      }
      await authorsLib.updateAuthor(name, { directive: value });
      await sendNotification(`Updated <b>${escapeHtml(name)}</b> directive:\n${escapeHtml(value)}`);
      return true;
    }

    if (subHead === 'weight') {
      const name = subRest.split(/\s+/, 1)[0];
      const numStr = subRest.slice(name.length).trim();
      const w = parseFloat(numStr);
      if (!name || Number.isNaN(w) || w < 0) throw new Error('Usage: /authors weight <Name> <non-negative number>');
      await authorsLib.updateAuthor(name, { weight: w });
      await sendNotification(`Set <b>${escapeHtml(name)}</b> weight to ${w}. (Higher weight = picked more often. 0 disables.)`);
      return true;
    }

    if (subHead === 'brand') {
      // /authors brand <name> <brandSlug | all | roaming>
      const name = subRest.split(/\s+/, 1)[0];
      const target = subRest.slice(name.length).trim().toLowerCase();
      if (!name || !target) throw new Error('Usage: /authors brand <Name> <auctionbrain | bridgematch | all>');
      let brands;
      if (target === 'all' || target === 'roaming' || target === 'any') {
        brands = null;
      } else {
        const validated = requireBrand(target);
        brands = [validated];
      }
      await authorsLib.updateAuthor(name, { brands });
      await sendNotification(`Scoped <b>${escapeHtml(name)}</b> to: ${brands ? brands.join(', ') : 'roaming (any active brand)'}.`);
      return true;
    }

    if (subHead === 'pause') {
      const name = subRest.trim();
      if (!name) throw new Error('Usage: /authors pause <Name>');
      await authorsLib.updateAuthor(name, { active: false });
      await sendNotification(`Paused <b>${escapeHtml(name)}</b>. They'll be skipped in rotation until /authors resume.`);
      return true;
    }

    if (subHead === 'resume') {
      const name = subRest.trim();
      if (!name) throw new Error('Usage: /authors resume <Name>');
      await authorsLib.updateAuthor(name, { active: true });
      await sendNotification(`Resumed <b>${escapeHtml(name)}</b>.`);
      return true;
    }

    if (subHead === 'rm' || subHead === 'remove' || subHead === 'delete') {
      const name = subRest.trim();
      if (!name) throw new Error('Usage: /authors rm <Name>');
      await authorsLib.deleteAuthor(name);
      await sendNotification(`Deleted <b>${escapeHtml(name)}</b>.`);
      return true;
    }

    throw new Error(
      `Unknown /authors subcommand "${subHead}". Try:\n` +
      `list, add, show, tone, directive, weight, brand, pause, resume, rm`
    );
  }

  // /regen — alias for /generate. Future: take optional brand arg.
  if (head === '/regen') {
    // Re-emit a /generate message into our own dispatcher by setting
    // text and falling through. Simpler: handle it identically here.
    try {
      await sendNotification('Generating posts now...');
      const { generateBatch } = require('./lib/generate');
      const { renderPost } = require('./lib/renderer');
      const { renderVideo } = require('./lib/video-renderer');

      const posts = await generateBatch();
      for (const post of posts) {
        try {
          const { filename } = await renderPost(post.template_type, post.brand, post);
          let videoFilename = null;
          try {
            const video = await renderVideo(post.template_type, post.brand, post);
            videoFilename = video.filename;
          } catch (videoErr) {
            console.warn(`  Video render skipped: ${videoErr.message}`);
          }

          const scheduledFor = new Date();
          scheduledFor.setHours(scheduledFor.getHours() + 1, 0, 0, 0);

          // meta tracks hook/cta patterns + author for rotation and
          // engagement attribution.
          const meta = {};
          if (post.hook_pattern) meta.hook_pattern = post.hook_pattern;
          if (post.cta_pattern) meta.cta_pattern = post.cta_pattern;
          if (post.author) meta.author = post.author;
          if (post.visual_style) meta.visual_style = post.visual_style;

          const saved = await insertPost({
            brand: post.brand,
            platform: post.platform,
            template_type: post.template_type,
            copy_headline: post.copy_headline,
            copy_body: post.copy_body,
            copy_cta: post.copy_cta,
            image_url: filename,
            video_url: videoFilename,
            status: 'draft',
            scheduled_for: scheduledFor.toISOString(),
            meta
          });
          await sendPostForReview(saved);
        } catch (err) {
          console.error(`  Error: ${err.message}`);
        }
      }
      console.log(`[Telegram] /regen completed: ${posts.length} posts`);
    } catch (err) {
      await sendNotification(`Generate failed: ${err.message}`);
    }
    return true;
  }

  return false;
}
const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.REVIEW_UI_PASSWORD;

// Constant-time string compare for session/password checks. Length mismatch
// returns false without comparing bytes (length itself isn't a secret).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

app.use(express.json());
app.use('/output', express.static(path.join(__dirname, 'output')));

// Cookie parser — MUST run before any route or middleware that reads req.cookies
// (e.g. requireAuth). Express runs middleware in registration order, so this
// has to come before app.use('/api', ...) and before route handlers below.
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [key, val] = c.trim().split('=');
      req.cookies[key] = val;
    });
  }
  next();
});

// Health check (no auth — used by Railway)
app.get('/health', (req, res) => res.json({ ok: true }));

// /diag — proves whether the Telegram polling loop is actually alive.
// pollLastAt should be < ~32s ago in a healthy state (long-poll = 30s
// timeout + setTimeout + handler time). pollCount should be increasing
// across requests. Anything else means polling is dead and clicks are
// going to /dev/null. Also fetches the bot's own getMe + webhook info
// for a one-shot diagnostic.
app.get('/diag', async (req, res) => {
  const now = Date.now();
  const out = {
    process_uptime_s: Math.round(process.uptime()),
    poll: {
      last_at_iso: pollLastAt ? new Date(pollLastAt).toISOString() : null,
      seconds_since_last_poll: pollLastAt ? Math.round((now - pollLastAt) / 1000) : null,
      total_polls: pollCount,
      last_error: pollLastError,
      offset: telegramOffset,
    },
    telegram: { ok: false },
  };
  try {
    if (BOT_TOKEN) {
      const [me, wh] = await Promise.all([
        fetch(`${API}/getMe`).then(r => r.json()),
        fetch(`${API}/getWebhookInfo`).then(r => r.json()),
      ]);
      out.telegram = {
        ok: !!me.ok,
        username: me.result?.username,
        webhook_url: wh.result?.url || '',
        pending_update_count: wh.result?.pending_update_count,
        last_error: wh.result?.last_error_message || null,
      };
    } else {
      out.telegram.error = 'BOT_TOKEN not set';
    }
  } catch (err) {
    out.telegram.error = err.message;
  }
  res.json(out);
});

// Review API (auth via API key, not session cookie)
app.use('/api', reviewRouter);

// ── AUTH MIDDLEWARE ──
function requireAuth(req, res, next) {
  // Check session cookie or query param — constant-time compare against PASSWORD
  const token = req.cookies?.auth || req.query.token || req.headers['x-auth-token'];
  if (PASSWORD && safeEqual(token, PASSWORD)) return next();

  // Show login form for any HTML page route. /api/* and non-GET requests
  // get JSON 401 so client code can handle them programmatically.
  // Previously this was hard-coded to '/' and '/content' only, so /social,
  // /levers, and any new page route returned raw JSON to a logged-out user.
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.send(loginPage(null, req.path));
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// ── LOGIN ──
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const returnTo = (req.body.returnTo || '/').replace(/[^a-zA-Z0-9/_-]/g, '');
  if (PASSWORD && safeEqual(req.body.password, PASSWORD)) {
    res.setHeader('Set-Cookie', `auth=${PASSWORD}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect(returnTo || '/');
  }
  res.status(401).send(loginPage('Wrong password', returnTo));
});

// ── DASHBOARD ──
app.get('/', requireAuth, async (req, res) => {
  try {
    const filter = req.query.type || 'all';
    const [socialPosts, blogPosts] = await Promise.all([
      filter === 'blog' || filter === 'guide' ? Promise.resolve([]) : getDraftPosts(),
      filter === 'social' ? Promise.resolve([]) : getDraftBlogPosts()
    ]);
    res.send(dashboardPage(socialPosts, blogPosts, filter));
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// ── APPROVE / REJECT ──
app.post('/api/posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const post = await updatePostStatus(req.params.id, 'approved');
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const post = await updatePostStatus(req.params.id, 'rejected');
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── BLOG POST APPROVE / REJECT ──
// Optional `?brand=bridgematch` (defaults to auctionbrain) selects which
// Supabase project the update lands in. Matches the Telegram callback behaviour.
app.post('/api/blog-posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const brand = req.query.brand === 'bridgematch' ? 'bridgematch' : 'auctionbrain';
    const post = await updateBlogPostStatus(req.params.id, 'approved', {}, brand);
    // Cross-pollinate: create a content seed from the approved blog
    try {
      await saveSeed({
        source: 'blog_approved',
        summary: `New blog: ${post.title}`,
        key_points: post.summary || post.meta_description || '',
        brand: post.brand || brand,
        tags: post.tags || []
      });
      console.log(`[Cross-pollinate] Seed created from blog: ${post.title}`);
    } catch (seedErr) {
      console.error(`[Cross-pollinate] Seed creation failed: ${seedErr.message}`);
    }
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/blog-posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const brand = req.query.brand === 'bridgematch' ? 'bridgematch' : 'auctionbrain';
    const post = await updateBlogPostStatus(req.params.id, 'rejected', {}, brand);
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTML PAGES ──

function loginPage(error, returnTo = '/') {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ContentBrain — Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login { background: #fff; border-radius: 12px; padding: 48px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); width: 360px; }
  h1 { font-size: 24px; color: #1a2b4b; margin-bottom: 24px; }
  input { width: 100%; padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; margin-bottom: 16px; }
  button { width: 100%; padding: 12px; background: #0f8a5f; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
  button:hover { background: #0d7a54; }
  .error { color: #C0392B; font-size: 14px; margin-bottom: 12px; }
</style>
</head><body>
<div class="login">
  <h1>ContentBrain</h1>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/login">
    <input type="hidden" name="returnTo" value="${returnTo}">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

function dashboardPage(socialPosts, blogPosts, filter) {
  const socialCards = socialPosts.map(post => `
    <div class="card" id="card-${post.id}" data-type="social">
      <div class="card-header">
        <span class="badge brand-${post.brand}">${post.brand}</span>
        <span class="badge platform">${post.platform}</span>
        <span class="badge template">${post.template_type}</span>
      </div>
      ${post.image_url ? `<img src="/output/${post.image_url}" class="preview" alt="preview">` : ''}
      ${post.video_url ? `<div class="video-wrap"><video src="/output/${post.video_url}" class="preview" controls muted preload="metadata"></video><span class="video-badge">MP4</span></div>` : ''}
      <div class="copy">
        <strong>${escapeHtml(post.copy_headline || '')}</strong>
        <p>${escapeHtml(post.copy_body || '')}</p>
        ${post.copy_cta ? `<p class="cta">${escapeHtml(post.copy_cta)}</p>` : ''}
      </div>
      <div class="actions">
        <button class="btn approve" onclick="action('${post.id}','approve','social')">Approve</button>
        <button class="btn reject" onclick="action('${post.id}','reject','social')">Reject</button>
      </div>
    </div>
  `).join('');

  const filteredBlogPosts = (filter === 'blog') ? blogPosts.filter(p => (p.post_type || 'blog') === 'blog')
    : (filter === 'guide') ? blogPosts.filter(p => p.post_type === 'guide')
    : blogPosts;

  const blogCards = filteredBlogPosts.map(post => {
    const postType = post.post_type || 'blog';
    const brandLabel = post.brand === 'bridgematch' ? 'bridgematch' : 'auctionbrain';
    const preview = (post.summary || post.meta_description || '').slice(0, 200);
    return `
    <div class="card" id="card-${post.id}" data-type="${postType}">
      <div class="card-header">
        <span class="badge brand-${brandLabel}">${brandLabel}</span>
        <span class="badge type-badge">${postType}</span>
        ${post.evaluation_score ? `<span class="badge score">${post.evaluation_score}/10</span>` : ''}
      </div>
      <div class="copy">
        <strong>${escapeHtml(post.title || '')}</strong>
        ${post.word_count || post.content ? `<p class="meta-info">${post.content ? Math.round(post.content.split(/\\s+/).length) + ' words' : ''}</p>` : ''}
        <p>${escapeHtml(preview)}</p>
        ${post.tags && post.tags.length ? `<p class="tags">${post.tags.map(t => '#' + t).join(' ')}</p>` : ''}
      </div>
      <div class="actions">
        <button class="btn approve" onclick="action('${post.id}','approve','blog')">Approve</button>
        <button class="btn reject" onclick="action('${post.id}','reject','blog')">Reject</button>
      </div>
    </div>
  `;
  }).join('');

  const totalCount = socialPosts.length + filteredBlogPosts.length;
  const filterParam = (f) => f === 'all' ? '/' : `/?type=${f}`;
  const activeClass = (f) => f === filter ? 'tab active' : 'tab';

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ContentBrain — Review</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 24px; }
  h1 { font-size: 28px; color: #1a2b4b; margin-bottom: 8px; }
  .subtitle { color: #666; margin-bottom: 16px; }
  .tabs { display: flex; gap: 8px; margin-bottom: 24px; }
  .tab { padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 600; text-decoration: none; color: #666; background: #e8e8e8; transition: all 0.2s; }
  .tab:hover { background: #ddd; }
  .tab.active { background: #1a2b4b; color: #faf8f4; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 24px; }
  .card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); transition: opacity 0.3s; }
  .card.done { opacity: 0.3; pointer-events: none; }
  .card-header { padding: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.03em; }
  .brand-auctionbrain { background: #1a2b4b; color: #faf8f4; }
  .brand-bridgematch { background: #0f8a5f; color: #fff; }
  .platform { background: #e8e8e8; color: #333; }
  .template { background: #fdf2e9; color: #C0392B; }
  .type-badge { background: #e8f4fd; color: #1a6fb5; }
  .score { background: #e8fdf0; color: #0f8a5f; }
  .preview { width: 100%; aspect-ratio: 1; object-fit: cover; }
  .video-wrap { position: relative; }
  .video-wrap video { width: 100%; aspect-ratio: 1; object-fit: cover; background: #000; }
  .video-badge { position: absolute; top: 8px; right: 8px; background: #C0392B; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .copy { padding: 16px; }
  .copy strong { display: block; font-size: 18px; color: #1a2b4b; margin-bottom: 8px; }
  .copy p { color: #555; line-height: 1.5; margin-bottom: 8px; white-space: pre-line; }
  .copy .cta { color: #0f8a5f; font-weight: 500; }
  .copy .meta-info { font-size: 13px; color: #999; }
  .copy .tags { font-size: 12px; color: #888; }
  .actions { padding: 16px; display: flex; gap: 12px; border-top: 1px solid #eee; }
  .btn { flex: 1; padding: 10px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn.approve { background: #0f8a5f; color: #fff; }
  .btn.approve:hover { background: #0d7a54; }
  .btn.reject { background: #f5f5f5; color: #C0392B; border: 1px solid #eee; }
  .btn.reject:hover { background: #fde8e8; }
  .empty { text-align: center; color: #999; padding: 80px; font-size: 18px; }
</style>
</head><body>
  <h1>ContentBrain</h1>
  <p class="subtitle">${totalCount} draft${totalCount !== 1 ? 's' : ''} awaiting review</p>
  <div class="tabs">
    <a class="${activeClass('all')}" href="${filterParam('all')}">All</a>
    <a class="${activeClass('social')}" href="${filterParam('social')}">Social</a>
    <a class="${activeClass('blog')}" href="${filterParam('blog')}">Blog</a>
    <a class="${activeClass('guide')}" href="${filterParam('guide')}">Guide</a>
  </div>
  <div class="grid">
    ${totalCount ? socialCards + blogCards : '<div class="empty">No drafts to review. All clear.</div>'}
  </div>
  <script>
    async function action(id, type, contentKind) {
      const card = document.getElementById('card-' + id);
      const endpoint = contentKind === 'blog' ? '/api/blog-posts/' : '/api/posts/';
      try {
        const res = await fetch(endpoint + id + '/' + type, { method: 'POST' });
        if (res.ok) {
          card.classList.add('done');
          setTimeout(() => card.remove(), 500);
          const remaining = document.querySelectorAll('.card:not(.done)').length;
          document.querySelector('.subtitle').textContent = remaining + ' draft' + (remaining !== 1 ? 's' : '') + ' awaiting review';
        }
      } catch (err) { alert('Error: ' + err.message); }
    }
  </script>
</body></html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── CRON JOBS ──

// Track last generation date to avoid duplicates after PC wake
let lastGenerateDate = null;

// Generate new content daily at 7am (with wake-up resilience)
cron.schedule('0 7 * * *', runGenerate);

// Promote high-engagement Reddit threads to briefs daily at 06:30 UTC,
// 30 minutes before the content engines kick off — so any newly-promoted
// briefs are picked up by that day's generation runs.
cron.schedule('30 6 * * *', async () => {
  try {
    const { promoteRedditThreadsToBriefs } = require('./lib/reddit-briefs');
    const result = await promoteRedditThreadsToBriefs();
    console.log(`[cron:reddit-briefs] ${result.promoted} promoted, ${result.evaluated} evaluated (${result.reason})`);
  } catch (err) {
    console.warn('[cron:reddit-briefs] failed:', err.message);
  }
});

// Check on wake — if we missed today's generation, run it now
cron.schedule('*/30 * * * *', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const hour = new Date().getHours();
  if (hour >= 7 && lastGenerateDate !== today) {
    console.log(`[${new Date().toISOString()}] Wake recovery: missed today's generation, running now...`);
    await runGenerate();
  }
});

async function runGenerate({ force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && lastGenerateDate === today) {
    console.log(`[${new Date().toISOString()}] Cron: already generated today, skipping.`);
    return;
  }
  lastGenerateDate = today;

  console.log(`[${new Date().toISOString()}] Cron: generating content...`);
  try {
    const { generateBatch } = require('./lib/generate');
    const { renderPost } = require('./lib/renderer');
    const { renderVideo } = require('./lib/video-renderer');
    const { insertPost } = require('./lib/supabase');

    const posts = await generateBatch();
    const savedPosts = [];
    const failedSends = [];

    for (const post of posts) {
      try {
        const { filename } = await renderPost(post.template_type, post.brand, post);

        let videoFilename = null;
        try {
          const video = await renderVideo(post.template_type, post.brand, post);
          videoFilename = video.filename;
        } catch (videoErr) {
          console.warn(`  Video render skipped: ${videoErr.message}`);
        }

        const daysAhead = Math.floor(savedPosts.length / 2);
        const hour = savedPosts.length % 2 === 0 ? 9 : 14;
        const scheduledFor = new Date();
        scheduledFor.setDate(scheduledFor.getDate() + daysAhead + 1);
        scheduledFor.setHours(hour, 0, 0, 0);

        // meta carries generation-time fields (hook_pattern, cta_pattern,
        // author) so future generations can rotate properly and the
        // admin can chart pattern-/author-level performance once
        // Facebook insights have caught up.
        const meta = {};
        if (post.hook_pattern) meta.hook_pattern = post.hook_pattern;
        if (post.cta_pattern) meta.cta_pattern = post.cta_pattern;
        if (post.author) meta.author = post.author;
        if (post.visual_style) meta.visual_style = post.visual_style;

        const saved = await insertPost({
          brand: post.brand,
          platform: post.platform,
          template_type: post.template_type,
          copy_headline: post.copy_headline,
          copy_body: post.copy_body,
          copy_cta: post.copy_cta,
          image_url: filename,
          video_url: videoFilename,
          status: 'draft',
          scheduled_for: scheduledFor.toISOString(),
          meta
        });

        savedPosts.push(saved);

        // Send to Telegram with video preview + approve/reject buttons
        const result = await sendPostForReview(saved);
        if (!result.ok) {
          failedSends.push({ id: saved.id, error: result.error });
        }
      } catch (err) {
        console.error(`  Error processing ${post.brand}/${post.template_type}: ${err.message}`);
      }
    }

    const msg = `${savedPosts.length} posts generated` +
      (failedSends.length ? ` (${failedSends.length} failed to send to Telegram)` : '');
    console.log(`[${new Date().toISOString()}] Cron: ${msg}`);

    // If any Telegram sends failed, send a summary notification
    if (failedSends.length) {
      await sendNotification(`Generated ${savedPosts.length} posts but ${failedSends.length} failed to send previews. Check the review UI to approve them.`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron generate error:`, err.message);
    await sendNotification(`Content generation failed: ${err.message}`);
  }
}

// Publish approved posts every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    const posts = await getApprovedPosts();
    if (!posts.length) return;

    console.log(`[${new Date().toISOString()}] Cron: publishing ${posts.length} approved posts...`);
    for (const post of posts) {
      try {
        const result = await publish(post);
        await updatePostStatus(post.id, 'published');
        // Store Facebook post ID for insights tracking
        if (result.postId) {
          const { supabase } = require('./lib/supabase');
          // Supabase query builder isn't a real Promise — .catch() before await throws TypeError
          try {
            await supabase.from('posts').update({ fb_post_id: result.postId }).eq('id', post.id);
          } catch (e) { console.warn(`  fb_post_id save failed: ${e.message}`); }
        }
        console.log(`  Published: ${post.id} (${post.brand}/${post.platform}) fb:${result.postId || 'n/a'}`);
      } catch (err) {
        console.error(`  Error publishing ${post.id}: ${err.message}`);
        // Notify on publish failure so it doesn't silently fail
        await sendNotification(`Failed to publish ${post.brand}/${post.template_type}: ${err.message.slice(0, 100)}`);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron publish error:`, err.message);
  }
});

// Scheduled-publish cron — every 5 minutes, promote any blog/guide whose
// scheduled_for has arrived to status='published'. Runs against BOTH the
// primary Supabase project AND the optional bridgematch project so that
// posts in either project flip on time.
cron.schedule('*/5 * * * *', async () => {
  const nowIso = new Date().toISOString();
  const { supabase, supabaseBridgematch } = require('./lib/supabase');
  const clients = [
    { name: 'primary', client: supabase },
    ...(supabaseBridgematch ? [{ name: 'bridgematch', client: supabaseBridgematch }] : [])
  ];

  for (const { name, client } of clients) {
    try {
      // Two cases publish:
      //   1. status='approved' AND scheduled_for IS NULL   (= "approve now",
      //      no specific time chosen — most Telegram approvals)
      //   2. status='approved' AND scheduled_for <= now    (= delayed schedule)
      //
      // Previously this only handled case 2, so case-1 posts sat in 'approved'
      // forever. We tried .or('scheduled_for.is.null,scheduled_for.lte.<iso>')
      // but the ISO timestamp's colons/dots tripped PostgREST's filter parser
      // (returned "column does not exist"). Two separate updates are reliable.

      const allPublished = [];

      // Case 1: approved + no schedule → publish immediately
      const r1 = await client
        .from('blog_posts')
        .update({ status: 'published', published_at: nowIso })
        .eq('status', 'approved')
        .is('scheduled_for', null)
        .select('id, title, brand, slug, summary, image_url, fb_post_id');
      if (r1.error) {
        console.error(`[scheduled-publish:${name}] no-schedule update error: ${r1.error.message}`);
      } else if (r1.data?.length) {
        allPublished.push(...r1.data);
      }

      // Case 2: approved + scheduled time has passed
      const r2 = await client
        .from('blog_posts')
        .update({ status: 'published', published_at: nowIso })
        .eq('status', 'approved')
        .lte('scheduled_for', nowIso)
        .select('id, title, brand, slug, summary, image_url, fb_post_id');
      if (r2.error) {
        console.error(`[scheduled-publish:${name}] scheduled update error: ${r2.error.message}`);
      } else if (r2.data?.length) {
        allPublished.push(...r2.data);
      }

      if (allPublished.length) {
        console.log(`[scheduled-publish:${name}] published ${allPublished.length} blog/guide post(s):`);
        const { publishBlogToFacebook } = require('./lib/publish');
        for (const p of allPublished) {
          console.log(`  - ${p.brand || '?'}: ${p.title}`);
          try {
            await sendNotification(`<b>Published</b> (${p.brand || 'unknown'}): ${p.title}`);
          } catch {}

          // Cross-post to the brand's Facebook Page. Best-effort: a Facebook outage
          // must not roll back the blog publish. Skip if already cross-posted (re-runs).
          if (p.fb_post_id || !p.slug || !p.brand) continue;
          try {
            const result = await publishBlogToFacebook(p);
            if (result?.postId) {
              await client.from('blog_posts').update({ fb_post_id: result.postId }).eq('id', p.id);
              console.log(`  [scheduled-publish:${name}] FB cross-post ok: ${p.brand}/${p.id} → ${result.postId}`);
            }
          } catch (err) {
            console.error(`[scheduled-publish:${name}] FB cross-post failed for ${p.id}: ${err.message}`);
            try {
              await sendNotification(`<b>FB cross-post failed</b> (${p.brand}): ${p.title} — ${err.message.slice(0, 80)}`);
            } catch {}
          }
        }
      }
    } catch (err) {
      console.error(`[scheduled-publish:${name}] cron error: ${err.message}`);
    }
  }
});

// Collect Facebook insights daily at 8pm (gives posts time to accumulate engagement)
cron.schedule('0 20 * * *', async () => {
  try {
    const { collectInsights } = require('./lib/insights');
    const result = await collectInsights();
    if (result.fetched > 0) {
      console.log(`[${new Date().toISOString()}] Insights: fetched metrics for ${result.fetched}/${result.total} posts`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Insights cron error: ${err.message}`);
  }
});

// Daily Lot of the Day at 07:00 UTC — picks today's archetype, generates
// caption + voiceover script, inserts a draft, and pings Simon to record.
// The voice-memo reply (handled in pollTelegram below) drives the rest of
// the flow: audio cleanup, render, review, publish.
cron.schedule('0 7 * * *', async () => {
  try {
    const { runLotOfTheDay } = require('./lib/lot-flow');
    await runLotOfTheDay();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Lot of the Day cron error: ${err.message}`);
    try {
      await sendNotification(`<b>Lot of the Day cron failed:</b> ${err.message.slice(0, 200)}`);
    } catch {}
  }
});

// ── TELEGRAM BOT POLLING ──
// Listen for approve/reject button presses

let telegramOffset = 0;
// Polling heartbeat — exposed via /diag so we can prove from outside
// whether the loop is actually alive on the deployed instance.
// pollLastAt: ms timestamp of last getUpdates response (success OR error).
// pollCount:  total iterations since process start.
// pollLastError: most recent error message (or null if last poll was OK).
let pollLastAt = 0;
let pollCount = 0;
let pollLastError = null;
let pendingRevision = null; // { postId, messageId, chatId, contentType?, brand? }
let pendingSchedule = null; // { type: 'social'|'blog'|'guide', postId, chatId, messageId, brand?, originalCaption? }
let pendingRejection = null; // { type: 'social'|'blog'|'guide', postId, chatId, messageId, brand?, originalCaption?, contentType? }
let pendingBrief = null; // { messages: [], startedAt: number }

// ── CHAT MEMORY ──
const chatHistory = [];
const MAX_HISTORY = 10;

function addToHistory(role, text) {
  chatHistory.push({ role, text, timestamp: Date.now() });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
}

function getHistoryContext() {
  if (!chatHistory.length) return '';
  return 'RECENT CONVERSATION:\n' + chatHistory.map(m =>
    `${m.role === 'user' ? 'Owner' : 'ContentBrain'}: ${m.text}`
  ).join('\n') + '\n\n';
}

/**
 * Locate a post by ID, searching social posts then blog posts in both projects.
 * Returns { kind: 'social' | 'blog', brand, post } or null. Used by smart-intent
 * routing so a chat-typed "revise post X" command can dispatch to the correct
 * table/project even when the user doesn't specify which.
 */
async function findPostAnywhere(postId) {
  if (!postId) return null;
  // Try social first (primary project)
  try {
    const social = await getPostById(postId);
    if (social) return { kind: 'social', brand: social.brand || 'auctionbrain', post: social };
  } catch {}
  // Try blog in both projects
  for (const brand of ['auctionbrain', 'bridgematch']) {
    try {
      const { getBlogPostById } = require('./lib/supabase');
      const blog = await getBlogPostById(postId, brand);
      if (blog) return { kind: 'blog', brand: blog.brand || brand, post: blog };
    } catch {}
  }
  return null;
}

/**
 * Apply an editor instruction to a blog/guide post using the same writer
 * context (voice rules, source articles, existing posts) the original
 * generator had. Updates the blog_posts row, optionally clears the original
 * Telegram review buttons, and sends a fresh review card with the new title.
 *
 * Used from both the Revise button callback and the natural-language
 * smart-intent revise path. originalCaption / messageId are optional —
 * when absent (smart-intent), we skip the "stamp REVISED" step.
 */
async function reviseBlogPost(opts) {
  const { postId, brand, contentType, editorText, chatId, messageId, originalCaption } = opts;
  const {
    getBlogClient,
    getBlogPostById,
    getSourceArticlesForPost,
    getPublishedPostsForBrand
  } = require('./lib/supabase');
  const { getVoiceForBrand } = require('./lib/voice');

  await sendNotification('Reading the draft, your feedback, and the source articles...');

  // Fetch the post + source articles + existing posts in parallel
  const [post, sourceArticles, existingPosts] = await Promise.all([
    getBlogPostById(postId, brand),
    getSourceArticlesForPost(postId, brand),
    getPublishedPostsForBrand(brand, 30)
  ]);

  // Persist the editor feedback for traceability (best-effort)
  try {
    const client = getBlogClient(brand);
    await client.from('blog_posts').update({ revision_feedback: editorText }).eq('id', postId);
  } catch (e) { console.warn(`  revision_feedback save failed: ${e.message}`); }

  const Anthropic = require('@anthropic-ai/sdk');
  const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

  const sysPrompt = getVoiceForBrand(brand);
  const baseDomain = brand === 'bridgematch' ? 'bridgematch.co.uk' : 'auctionbrain.co.uk';

  const sourceMaterialBlock = sourceArticles.length === 0
    ? '(Source material no longer linked to this post — work from the draft and editor instruction. Do not invent facts.)'
    : sourceArticles
        .map(a => `### ${a.title || 'Untitled'}${a.url ? ` (${a.url})` : ''}\n${(a.content || '').slice(0, 1500)}`)
        .join('\n\n---\n\n');

  const existingPostsBlock = existingPosts.length === 0
    ? '(No published posts available for internal linking yet.)'
    : existingPosts
        .map(p => `- "${p.title}" — ${p.summary || 'No summary'} [/blog/${p.slug}]${p.cluster ? ` [cluster: ${p.cluster}]` : ''}`)
        .join('\n');

  const userPrompt = `You wrote the draft below. The editor wants changes. Apply faithfully — and feel free to pull deeper from the source articles or add internal links where genuinely useful.

ORIGINAL DRAFT
TITLE: ${post.title}
SUMMARY: ${post.summary || ''}
CLUSTER: ${post.cluster || '(untagged)'}

MARKDOWN BODY:
${post.content || ''}

---

SOURCE MATERIAL (the same articles you originally drew from)

${sourceMaterialBlock}

---

EXISTING PUBLISHED POSTS (candidates for internal linking — anchor text must be descriptive, only link if genuinely relevant; full URL is https://${baseDomain}/blog/<slug>)

${existingPostsBlock}

---

EDITOR INSTRUCTION:
"${editorText}"

---

Apply the editor's instruction. Keep the voice rules. Use the source material for any fresh facts/quotes — do not fabricate. Return the FULL revised post — do not truncate.

Return ONLY this JSON (no commentary, no markdown fences):
{
  "title": "Updated title (or unchanged)",
  "summary": "Updated 1-2 sentence summary",
  "content": "Full revised markdown body — keep H1/H2/H3 hierarchy, end with the --- divider + author byline",
  "change_note": "One sentence describing what you changed and why"
}`;

  const resp = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 8000,
    system: sysPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });
  const txt = resp.content[0].text;
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('Claude did not return JSON');
  const revised = JSON.parse(m[0]);

  // Re-render markdown to HTML for the live blog page
  const { marked } = require('marked');
  const sanitizeHtml = require('sanitize-html');
  const newHtml = sanitizeHtml(await marked.parse(revised.content || post.content), {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3', 'h4', 'img']),
    allowedAttributes: { ...sanitizeHtml.defaults.allowedAttributes, img: ['src', 'alt', 'title'] }
  });

  // Build the update object with only columns that definitely exist
  // across both Supabase projects. updated_at lives on AB's table but
  // not BM's, so omit it.
  const updateRow = {
    title: revised.title || post.title,
    summary: revised.summary || post.summary,
    content: revised.content || post.content,
    content_html: newHtml,
    iteration_count: (post.iteration_count || 1) + 1
  };
  const client = getBlogClient(brand);
  const { error: updateErr } = await client.from('blog_posts').update(updateRow).eq('id', postId);
  if (updateErr) throw new Error(updateErr.message);

  // Mark the original review message as superseded (only if we have it)
  if (chatId && messageId) {
    try {
      await removeButtons(chatId, messageId, `${(originalCaption || post.title)}\n\nREVISED · ${revised.change_note || 'edits applied'}`);
    } catch {}
  }

  // Re-send a fresh review message with the new title/summary
  const { sendBlogForReview } = require('./lib/telegram');
  const wordCount = (revised.content || '').split(/\s+/).filter(Boolean).length;
  await sendBlogForReview({
    content_type: contentType,
    brand,
    source: 'revision',
    post_id: postId,
    title: revised.title || post.title,
    summary: revised.summary || post.summary,
    score: post.evaluation_score,
    word_count: wordCount
  });
  console.log(`[Telegram] Revised ${contentType} ${postId}: ${revised.change_note || 'edits applied'}`);
}

async function pollTelegram() {
  if (!BOT_TOKEN) return;

  pollCount++;
  pollLastAt = Date.now();
  pollLastError = null;

  try {
    const res = await fetch(`${API}/getUpdates?offset=${telegramOffset}&timeout=30&allowed_updates=["callback_query","message"]`);
    if (!res.ok) {
      // Don't bare-return here — that skips the setTimeout(pollTelegram, 1000)
      // at the bottom and PERMANENTLY kills the poll loop. Process is alive
      // (Express still answers /health) but no callback_query / message
      // updates ever get processed again. This stale-poll-loop bug had us
      // chasing "the buttons don't work" for hours. Telegram returns non-OK
      // for plenty of recoverable reasons: 502/504 transients, 409 Conflict
      // when another poller briefly overlaps a redeploy, 429 rate-limit on
      // bursty traffic. All of those should just retry on the next tick.
      console.warn(`[Telegram] getUpdates HTTP ${res.status}; will retry`);
      throw new Error(`getUpdates HTTP ${res.status}`);
    }

    const { result } = await res.json();
    for (const update of result) {
      telegramOffset = update.update_id + 1;

      // Handle approve/reject button presses
      const cb = update.callback_query;
      if (cb && cb.data) {
        const parts = cb.data.split(':');

        // rv:<type>:<brandCode>:<action>:<id>  — review hub callbacks with brand routing
        // rv:<type>:<action>:<id>              — legacy 4-part format (AB only), kept for backward compat
        if (parts[0] === 'rv' && (parts.length === 4 || parts.length === 5)) {
          let contentType, brandCode, rvAction, rvId;
          if (parts.length === 5) {
            [, contentType, brandCode, rvAction, rvId] = parts;
          } else {
            [, contentType, rvAction, rvId] = parts;
            brandCode = 'ab'; // legacy messages default to AuctionBrain
          }
          const brand = brandCode === 'bm' ? 'bridgematch' : 'auctionbrain';

          if (rvId && rvAction === 'approve') {
            try {
              await updateBlogPostStatus(rvId, 'approved', {}, brand);
              const originalCaption = cb.message?.caption || cb.message?.text || '';
              await removeButtons(cb.message.chat.id, cb.message.message_id, `${originalCaption}\n\nAPPROVED`);
              await answerCallback(cb.id, `${contentType} approved`);

              // Cross-pollinate: create seed from approved blog/guide
              try {
                const blogPost = await getBlogPostById(rvId, brand);
                await saveSeed({
                  source: 'blog_approved',
                  summary: `New ${contentType}: ${blogPost.title}`,
                  key_points: blogPost.summary || blogPost.meta_description || '',
                  brand: blogPost.brand || brand,
                  tags: blogPost.tags || []
                });
                console.log(`[Cross-pollinate] Seed created from ${contentType}: ${blogPost.title}`);
              } catch (seedErr) {
                console.error(`[Cross-pollinate] Seed creation failed: ${seedErr.message}`);
              }

              console.log(`[Telegram] ${brand} ${contentType} ${rvId} approved`);
            } catch (err) {
              console.error(`[Telegram] Error handling approve: ${err.message}`);
              await answerCallback(cb.id, 'Error — try again');
            }
          }

          if (rvId && rvAction === 'reject') {
            // Don't reject immediately — ask for a reason first so future
            // generations can avoid the same failure mode. The text-message
            // handler below sees pendingRejection and processes the reply.
            pendingRejection = {
              type: contentType,
              postId: rvId,
              chatId: cb.message.chat.id,
              messageId: cb.message.message_id,
              brand,
              contentType,
              originalCaption: cb.message?.caption || cb.message?.text || ''
            };
            await answerCallback(cb.id, 'Why?');
            await sendNotification("Why are you rejecting this? A sentence or two helps the next round avoid the same mistake.\n\nReply with your reason, or send <i>'skip'</i> to reject without feedback.");
            console.log(`[Telegram] Rejection reason requested for ${brand} ${contentType} ${rvId}`);
          }

          if (rvId && rvAction === 'revise') {
            pendingRevision = { postId: rvId, chatId: cb.message.chat.id, messageId: cb.message.message_id, contentType, brand };
            await answerCallback(cb.id, 'Send your feedback');
            await sendNotification('What would you like changed? Reply with your feedback.');
            console.log(`[Telegram] Revision requested for ${brand} ${contentType} ${rvId}`);
          }

          if (rvId && rvAction === 'schedule') {
            pendingSchedule = {
              type: contentType,
              postId: rvId,
              chatId: cb.message.chat.id,
              messageId: cb.message.message_id,
              brand,
              originalCaption: cb.message?.caption || cb.message?.text || ''
            };
            await answerCallback(cb.id, 'When?');
            await sendNotification("When should this go live?\n\nExamples: <i>'tomorrow 9am'</i>, <i>'next Tuesday at 10:30'</i>, <i>'in 3 hours'</i>, <i>'2026-05-12 14:00'</i>");
            console.log(`[Telegram] Schedule prompt for ${brand} ${contentType} ${rvId}`);
          }

          continue;
        }

        // cb:<action>:<id> or legacy <action>:<id> — social post callbacks
        let action, postId;
        if (parts.length === 3 && parts[0] === 'cb') {
          action = parts[1];
          postId = parts[2];
        } else {
          action = parts[0];
          postId = parts[1];
        }

        if (postId && action === 'approve') {
          try {
            await updatePostStatus(postId, 'approved');
            const originalCaption = cb.message?.caption || cb.message?.text || '';
            await removeButtons(cb.message.chat.id, cb.message.message_id, `${originalCaption}\n\nAPPROVED`);
            await answerCallback(cb.id, 'Post approved');
            console.log(`[Telegram] Post ${postId} approved`);
          } catch (err) {
            console.error(`[Telegram] Error handling approve: ${err.message}`);
            await answerCallback(cb.id, 'Error — try again');
          }
        }

        if (postId && action === 'reject') {
          // Same as blog/guide reject — capture a reason so future generation
          // learns from this failure mode. Text-message handler processes the reply.
          pendingRejection = {
            type: 'social',
            postId,
            chatId: cb.message.chat.id,
            messageId: cb.message.message_id,
            originalCaption: cb.message?.caption || cb.message?.text || ''
          };
          await answerCallback(cb.id, 'Why?');
          await sendNotification("Why are you rejecting this? A sentence or two helps the next round avoid the same mistake.\n\nReply with your reason, or send <i>'skip'</i> to reject without feedback.");
          console.log(`[Telegram] Rejection reason requested for social ${postId}`);
        }

        if (postId && action === 'revise') {
          pendingRevision = { postId, chatId: cb.message.chat.id, messageId: cb.message.message_id };
          await answerCallback(cb.id, 'Send your feedback');
          await sendNotification('What would you like changed? Reply with your feedback.');
          console.log(`[Telegram] Revision requested for ${postId}`);
        }

        if (postId && action === 'schedule') {
          pendingSchedule = {
            type: 'social',
            postId,
            chatId: cb.message.chat.id,
            messageId: cb.message.message_id,
            originalCaption: cb.message?.caption || cb.message?.text || ''
          };
          await answerCallback(cb.id, 'When?');
          await sendNotification("When should this go live?\n\nExamples: <i>'tomorrow 9am'</i>, <i>'next Tuesday at 10:30'</i>, <i>'in 3 hours'</i>, <i>'2026-05-12 14:00'</i>");
          console.log(`[Telegram] Schedule prompt for social ${postId}`);
        }

        continue;
      }

      // Handle video uploads — generate caption and create draft post
      const msg = update.message;
      if (msg && (msg.video || msg.video_note) && String(msg.chat.id) === String(CHAT_ID)) {
        try {
          await sendNotification('Got your video — generating a caption...');

          const video = msg.video || msg.video_note;
          const fileId = video.file_id;
          const userCaption = msg.caption || '';
          const filename = `uploaded-${Date.now()}.mp4`;

          // Download from Telegram
          const rawFilename = `uploaded-raw-${Date.now()}.mp4`;
          await downloadTelegramFile(fileId, rawFilename);
          console.log(`[Telegram] Downloaded video: ${rawFilename}`);

          // Watermark with AuctionBrain logo
          const { execSync } = require('child_process');
          const ffmpeg = require('ffmpeg-static');
          const logoPath = path.join(__dirname, 'LOGOS', 'auctionbrain-logo-transparent.png');
          const rawPath = path.join(__dirname, 'output', rawFilename);
          const outPath = path.join(__dirname, 'output', filename);

          try {
            execSync(
              `"${ffmpeg}" -i "${rawPath}" -i "${logoPath}" -filter_complex "[1:v]scale=700:-1,format=rgba,colorchannelmixer=aa=0.9[logo];[0:v][logo]overlay=W-w-50:H-h-50" -c:a copy -y "${outPath}"`,
              { stdio: 'pipe' }
            );
            // Clean up raw file
            const fsSync = require('fs');
            if (fsSync.existsSync(rawPath)) fsSync.unlinkSync(rawPath);
            console.log(`[Telegram] Watermarked video: ${filename}`);
          } catch (ffErr) {
            console.warn(`[Telegram] Watermark failed, using raw: ${ffErr.message}`);
            // Fall back to raw file without watermark
            const fsSync = require('fs');
            if (fsSync.existsSync(rawPath)) fsSync.renameSync(rawPath, outPath);
          }

          // Generate caption with Claude
          const Anthropic = require('@anthropic-ai/sdk');
          const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
          const { brands } = require('./lib/config');
          const b = brands.auctionbrain;

          const prompt = userCaption
            ? `The content owner sent a video with this note: "${userCaption}"\n\nWrite a short, engaging Facebook post caption for this video. The brand is ${b.name} (${b.url}) targeting ${b.audience}. Tone: ${b.tone}. British English, no hashtags in the caption. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }`
            : `Write a short, engaging Facebook post caption for a video posted by ${b.name} (${b.url}) targeting ${b.audience}. Tone: ${b.tone}. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }`;

          const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }]
          });

          const text = response.content[0].text;
          const match = text.match(/\{[\s\S]*\}/);
          const copy = match ? JSON.parse(match[0]) : { copy_headline: userCaption || 'New video', copy_body: '', copy_cta: b.url };

          // Schedule for next available slot
          const scheduledFor = new Date();
          scheduledFor.setDate(scheduledFor.getDate() + 1);
          scheduledFor.setHours(12, 0, 0, 0);

          const saved = await insertPost({
            brand: 'auctionbrain',
            platform: 'facebook',
            template_type: 'uploaded',
            copy_headline: copy.copy_headline,
            copy_body: copy.copy_body || '',
            copy_cta: copy.copy_cta || '',
            image_url: null,
            video_url: filename,
            status: 'draft',
            scheduled_for: scheduledFor.toISOString()
          });

          await sendPostForReview(saved);
          console.log(`[Telegram] Uploaded video post created: ${saved.id}`);
        } catch (err) {
          console.error(`[Telegram] Error processing video: ${err.message}`);
          await sendNotification(`Error processing video: ${err.message}`);
        }
        continue;
      }

      // Handle photo uploads — extract text/key points and save as content seed
      if (msg && msg.photo && String(msg.chat.id) === String(CHAT_ID)) {
        try {
          await sendNotification('Got that image — extracting content...');

          // Get highest resolution photo
          const photo = msg.photo[msg.photo.length - 1];
          const fileId = photo.file_id;
          const userCaption = msg.caption || '';

          // Download from Telegram
          const imgFilename = `seed-photo-${Date.now()}.jpg`;
          await downloadTelegramFile(fileId, imgFilename);
          const imgPath = path.join(__dirname, 'output', imgFilename);

          // Read image and send to Claude Vision
          const fs = require('fs');
          const imageData = fs.readFileSync(imgPath).toString('base64');

          const Anthropic = require('@anthropic-ai/sdk');
          const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

          const visionResponse = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
                { type: 'text', text: `Extract all text and key points from this image. It's likely a photo of an article, screenshot, or document.${userCaption ? ` The sender added this note: "${userCaption}"` : ''}\n\nReturn JSON:\n{\n  "extracted_text": "All readable text from the image",\n  "summary": "One-line summary of what this is about",\n  "key_points": "3-5 bullet points of the most useful info",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "tags": ["tag1", "tag2"]\n}` }
              ]
            }]
          });

          const visionText = visionResponse.content[0].text;
          const visionMatch = visionText.match(/\{[\s\S]*\}/);
          const extracted = visionMatch ? JSON.parse(visionMatch[0]) : { extracted_text: '', summary: 'Could not extract content', key_points: '', tags: [] };

          await saveSeed({
            source: 'telegram_photo',
            raw_input: userCaption || null,
            extracted_text: extracted.extracted_text || '',
            summary: extracted.summary || '',
            key_points: extracted.key_points || '',
            brand: extracted.brand || null,
            tags: extracted.tags || []
          });

          // Clean up image file
          if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);

          await sendNotification(`Got it — extracted from that image: "${extracted.summary}". Saved for future content.`);
          console.log(`[Telegram] Photo seed saved: ${extracted.summary}`);
        } catch (err) {
          console.error(`[Telegram] Error processing photo: ${err.message}`);
          await sendNotification(`Error processing that image: ${err.message}`);
        }
        continue;
      }

      // Handle voice memo replies — route to the pending Lot of the Day if one is awaiting voice.
      // msg.voice is Telegram's "press-to-talk" recording; msg.audio is an attached audio file.
      // We accept either since the user's recording habit may vary.
      if (msg && (msg.voice || msg.audio) && String(msg.chat.id) === String(CHAT_ID)) {
        try {
          const audio = msg.voice || msg.audio;
          const { findPendingLotPost, processVoiceForLot } = require('./lib/lot-flow');
          const pending = await findPendingLotPost();
          if (!pending) {
            await sendNotification('Got a voice memo but no Lot of the Day is currently awaiting a recording. Trigger one first.');
            continue;
          }
          await sendNotification(`Got your voice — processing audio + rendering video for post ${pending.id}…`);
          await processVoiceForLot(pending, audio.file_id);
        } catch (err) {
          console.error(`[Telegram] Error processing lot voice memo: ${err.message}`);
          await sendNotification(`Error processing voice memo: ${err.message.slice(0, 200)}`);
        }
        continue;
      }

      // Handle text messages
      if (msg && msg.text && String(msg.chat.id) === String(CHAT_ID)) {
        const text = msg.text.trim();

        // Handle pending schedule input — user clicked Schedule and is now telling us when
        if (pendingSchedule && !text.startsWith('/')) {
          const sch = pendingSchedule;
          pendingSchedule = null;
          try {
            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
            const nowIso = new Date().toISOString();
            const dayName = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

            const parseResp = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              messages: [{ role: 'user', content: `Parse this scheduling request into an ISO 8601 timestamp.

Current time: ${nowIso} (${dayName}, UK time).
User wants to schedule a post for: "${text}"

Rules:
- Output a single ISO 8601 string in UTC (e.g. 2026-05-12T14:00:00Z)
- If the user says a time without specifying AM/PM and it's ambiguous, prefer 9am-6pm
- If only a date is given without a time, use 09:00 UTC
- "tomorrow" = next day, "next Tuesday" = upcoming Tuesday
- Refuse if the request is in the past or unparseable

Return JSON only:
{ "iso": "2026-05-12T14:00:00Z", "human": "Tuesday 12 May at 14:00 UK", "ok": true }
or
{ "ok": false, "error": "short reason" }` }]
            });
            const parseText = parseResp.content[0].text;
            const m = parseText.match(/\{[\s\S]*\}/);
            if (!m) throw new Error('Could not interpret your time');
            const parsed = JSON.parse(m[0]);
            if (!parsed.ok) {
              await sendNotification(`I couldn't schedule that: ${parsed.error || 'try a different format'}.`);
              continue;
            }
            const scheduledIso = parsed.iso;
            if (new Date(scheduledIso).getTime() < Date.now() - 60000) {
              await sendNotification("That time is in the past. Try again.");
              continue;
            }

            // Update DB — social posts use the primary client directly; blog/guide
            // route through updateBlogPostStatus so the column-drop retry handles
            // BM's missing approved_at/published_at columns gracefully.
            const { supabase, updateBlogPostStatus } = require('./lib/supabase');
            if (sch.type === 'social') {
              const { error } = await supabase.from('posts').update({
                status: 'approved',
                scheduled_for: scheduledIso,
                approved_at: new Date().toISOString()
              }).eq('id', sch.postId);
              if (error) throw new Error(error.message);
            } else {
              await updateBlogPostStatus(sch.postId, 'approved', { scheduled_for: scheduledIso }, sch.brand || 'auctionbrain');
            }

            // Mark the original review message as scheduled
            try {
              await removeButtons(sch.chatId, sch.messageId, `${sch.originalCaption}\n\nSCHEDULED · ${parsed.human}`);
            } catch {}
            await sendNotification(`Scheduled for ${parsed.human}. It will publish automatically.`);
            console.log(`[Telegram] Scheduled ${sch.type} ${sch.postId} for ${scheduledIso}`);
          } catch (err) {
            console.error(`[Telegram] Schedule error: ${err.message}`);
            await sendNotification(`Couldn't schedule: ${err.message}. Try again — type a time or click another button.`);
          }
          continue;
        }

        // Handle pending rejection reason — user clicked Reject and is now telling
        // us why. Save the reason to revision_feedback (the same column we use for
        // edit feedback — it's the editor's voice either way) and finalise the
        // status to 'rejected'. The reason gets surfaced to the LLM next time it
        // generates a post in the same cluster, so future drafts learn from this.
        if (pendingRejection && !text.startsWith('/')) {
          const rej = pendingRejection;
          pendingRejection = null;
          const reason = text.trim().toLowerCase() === 'skip' ? null : text.trim();
          try {
            const stamp = reason
              ? `${rej.originalCaption}\n\nREJECTED · ${reason.slice(0, 200)}`
              : `${rej.originalCaption}\n\nREJECTED`;

            if (rej.type === 'social') {
              const { supabase } = require('./lib/supabase');
              const { error } = await supabase.from('posts').update({
                status: 'rejected',
                rejection_feedback: reason,
              }).eq('id', rej.postId);
              if (error) throw new Error(error.message);
            } else {
              // Blog/guide — route through updateBlogPostStatus so the
              // missing-column retry handles BM's schema gaps.
              const { updateBlogPostStatus } = require('./lib/supabase');
              await updateBlogPostStatus(rej.postId, 'rejected',
                reason ? { revision_feedback: reason } : {},
                rej.brand || 'auctionbrain');
            }

            try {
              await removeButtons(rej.chatId, rej.messageId, stamp);
            } catch {}
            await sendNotification(reason
              ? `Rejected. Feedback captured — the next ${rej.contentType || rej.type} draft will avoid this.`
              : 'Rejected (no feedback).');
            console.log(`[Telegram] ${rej.type} ${rej.postId} rejected${reason ? ' with feedback' : ''}`);
          } catch (err) {
            console.error(`[Telegram] Reject error: ${err.message}`);
            await sendNotification(`Couldn't save the rejection: ${err.message}. Try clicking Reject again.`);
          }
          continue;
        }

        // Handle pending revision feedback
        if (pendingRevision && !text.startsWith('/')) {
          const rev = pendingRevision;
          pendingRevision = null;

          // ── Blog / guide revision branch ──
          // Delegates to reviseBlogPost() so both the button-press path here
          // and the smart-intent natural-language path can share one implementation.
          if (rev.contentType === 'blog' || rev.contentType === 'guide') {
            try {
              await reviseBlogPost({
                postId: rev.postId,
                brand: rev.brand || 'auctionbrain',
                contentType: rev.contentType,
                editorText: text,
                chatId: rev.chatId,
                messageId: rev.messageId,
                originalCaption: rev.originalCaption
              });
            } catch (err) {
              console.error(`[Telegram] Blog revision error: ${err.message}`);
              await sendNotification(`Couldn't revise: ${err.message}. The draft is unchanged — try Revise again with different wording.`);
            }
            continue;
          }

          // ── Social post revision branch (existing flow) ──
          try {
            await sendNotification('Interpreting your feedback...');
            const post = await getPostById(rev.postId);

            // Store feedback for rejection learning (even if post gets revised and approved)
            const { supabase: sb } = require('./lib/supabase');
            // Supabase query builder isn't a real Promise — .catch() before await throws TypeError
            try {
              await sb.from('posts').update({ rejection_feedback: text }).eq('id', rev.postId);
            } catch (e) { console.warn(`  rejection_feedback save failed: ${e.message}`); }

            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
            const { brands } = require('./lib/config');
            const b = brands[post.brand] || brands.auctionbrain;

            // Step 1: Classify the feedback — what kind of change is needed?
            const classifyResponse = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 300,
              messages: [{ role: 'user', content: `You manage a social media content pipeline. A post has a graphic/video and this copy:

Headline: ${post.copy_headline}
Body: ${post.copy_body}
CTA: ${post.copy_cta}
Template: ${post.template_type}
Has video: ${!!post.video_url}

The content owner sent this revision request: "${text}"

Classify this request. Return JSON:
{
  "type": "copy_change" | "video_change" | "both" | "cannot_do",
  "copy_action": "rewrite" | "none",
  "video_action": "re-render" | "extend_duration" | "none",
  "video_duration_seconds": null or number if they specified a duration,
  "summary": "One line explaining what you understood they want",
  "copy_instructions": "Specific instructions for rewriting copy, or null"
}` }]
            });

            const classText = classifyResponse.content[0].text;
            const classMatch = classText.match(/\{[\s\S]*\}/);
            if (!classMatch) throw new Error('Could not interpret feedback');
            const classification = JSON.parse(classMatch[0]);

            console.log(`[Telegram] Revision classified: ${classification.type} — ${classification.summary}`);
            await sendNotification(`Understood: ${classification.summary}`);

            let revised = { copy_headline: post.copy_headline, copy_body: post.copy_body, copy_cta: post.copy_cta };
            let needsVideoRerender = false;
            let videoDuration = null;

            // Step 2: Handle copy changes
            if (classification.copy_action === 'rewrite') {
              const copyInstructions = classification.copy_instructions || text;
              const copyResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                messages: [{ role: 'user', content: `You wrote this social media post for ${b.name}:\n\nHeadline: ${post.copy_headline}\nBody: ${post.copy_body}\nCTA: ${post.copy_cta}\n\nRevision needed: ${copyInstructions}\n\nRewrite the post. Keep the same format and tone. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }` }]
              });

              const aiText = copyResponse.content[0].text;
              const match = aiText.match(/\{[\s\S]*\}/);
              if (match) revised = JSON.parse(match[0]);
            }

            // Step 3: Handle video changes
            if (classification.video_action === 'extend_duration' || classification.video_action === 're-render') {
              needsVideoRerender = true;
              videoDuration = classification.video_duration_seconds || 30;
            }

            // Apply copy changes
            const { supabase } = require('./lib/supabase');
            const { error: copyErr } = await supabase.from('posts').update({
              copy_headline: revised.copy_headline,
              copy_body: revised.copy_body || '',
              copy_cta: revised.copy_cta || ''
            }).eq('id', rev.postId);
            if (copyErr) throw new Error(`Copy update failed: ${copyErr.message}`);

            // Re-render video if needed
            if (needsVideoRerender && post.video_url) {
              try {
                await sendNotification(`Re-rendering video (${videoDuration}s)...`);
                const { renderVideo, ensureBundle } = require('./lib/video-renderer');
                await ensureBundle();

                const updatedPost = {
                  ...post,
                  ...revised,
                  overrideDurationSeconds: videoDuration,
                };
                const video = await renderVideo(post.template_type, post.brand, updatedPost);

                await supabase.from('posts').update({ video_url: video.filename }).eq('id', rev.postId);
                post.video_url = video.filename;
                console.log(`[Telegram] Re-rendered video: ${video.filename} (${videoDuration}s)`);
              } catch (videoErr) {
                console.error(`[Telegram] Video re-render failed: ${videoErr.message}`);
                await sendNotification(`Video re-render failed: ${videoErr.message}. Copy was updated.`);
              }
            }

            // Send revised post for review
            await sendPostForReview({ ...post, ...revised });
            console.log(`[Telegram] Post ${rev.postId} revised (${classification.type})`);
          } catch (err) {
            console.error(`[Telegram] Revision error: ${err.message}`);
            await sendNotification(`Revision failed: ${err.message}`);
          }
          continue;
        }

        // Handle pending brief conversation
        if (pendingBrief && !text.startsWith('/')) {
          const cancel = text.toLowerCase().match(/^(cancel|never ?mind|forget it|nah|skip)$/);
          if (cancel) {
            pendingBrief = null;
            const reply = 'No worries, brief cancelled.';
            await sendNotification(reply);
            addToHistory('user', text);
            addToHistory('assistant', reply);
            continue;
          }

          pendingBrief.messages.push(text);
          addToHistory('user', text);

          // After 2 messages from user (initial + follow-up), extract and save
          if (pendingBrief.messages.length >= 2) {
            try {
              const Anthropic = require('@anthropic-ai/sdk');
              const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

              const extractResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 400,
                messages: [{ role: 'user', content: `The content owner briefed a social media post across these messages:\n${pendingBrief.messages.map((m, i) => `Message ${i + 1}: "${m}"`).join('\n')}\n\nExtract a structured brief. Return JSON:\n{\n  "topic": "2-5 word topic summary",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "angle": "The specific angle or hook to take",\n  "data_points": "Any stats, facts, or stories mentioned, or null",\n  "full_brief": "A single paragraph combining all the info into a clear content brief"\n}` }]
              });

              const extractText = extractResponse.content[0].text;
              const extractMatch = extractText.match(/\{[\s\S]*\}/);
              if (!extractMatch) throw new Error('Could not parse brief');
              const structured = JSON.parse(extractMatch[0]);

              const { saveBrief } = require('./lib/supabase');
              await saveBrief(structured);

              const reply = `Got it — saved a brief about "${structured.topic}"${structured.brand ? ` for ${structured.brand}` : ''}. I'll work it into tomorrow's posts.`;
              await sendNotification(reply);
              addToHistory('assistant', reply);
              console.log(`[Telegram] Structured brief saved: ${structured.topic}`);
            } catch (err) {
              console.error(`[Telegram] Brief extraction error: ${err.message}`);
              const { saveBrief } = require('./lib/supabase');
              await saveBrief(pendingBrief.messages.join(' '));
              const reply = 'Saved your brief for tomorrow.';
              await sendNotification(reply);
              addToHistory('assistant', reply);
            }
            pendingBrief = null;
          } else {
            // Ask one follow-up question
            try {
              const Anthropic = require('@anthropic-ai/sdk');
              const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

              const followUpResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                messages: [{ role: 'user', content: `You are ContentBrain. The content owner wants to brief a future social media post.\n\nThey said: "${pendingBrief.messages.join(' ')}"\n\nAsk ONE short follow-up question to make this brief more actionable. Focus on: what angle or hook? Any specific data points or stories to include? Which brand (AuctionBrain or BridgeMatch)?\n\nKeep it casual, one sentence. British English.` }]
              });

              const reply = followUpResponse.content[0].text.trim();
              await sendNotification(reply);
              addToHistory('assistant', reply);
            } catch (err) {
              // If follow-up fails, just save what we have
              const { saveBrief } = require('./lib/supabase');
              await saveBrief(pendingBrief.messages.join(' '));
              pendingBrief = null;
              await sendNotification('Saved your brief for tomorrow.');
            }
          }
          continue;
        }

        // Timeout pending brief after 10 minutes
        if (pendingBrief && Date.now() - pendingBrief.startedAt > 10 * 60 * 1000) {
          const { saveBrief } = require('./lib/supabase');
          await saveBrief(pendingBrief.messages.join(' '));
          pendingBrief = null;
          console.log('[Telegram] Brief timed out, saved as-is');
        }

        // /generate — create new posts now
        if (text === '/generate') {
          try {
            await sendNotification('Generating posts now...');
            const { generateBatch } = require('./lib/generate');
            const { renderPost } = require('./lib/renderer');
            const { renderVideo } = require('./lib/video-renderer');

            const posts = await generateBatch();
            for (const post of posts) {
              try {
                const { filename } = await renderPost(post.template_type, post.brand, post);
                let videoFilename = null;
                try {
                  const video = await renderVideo(post.template_type, post.brand, post);
                  videoFilename = video.filename;
                } catch (videoErr) {
                  console.warn(`  Video render skipped: ${videoErr.message}`);
                }

                const scheduledFor = new Date();
                scheduledFor.setHours(scheduledFor.getHours() + 1, 0, 0, 0);

                const meta = {};
                if (post.hook_pattern) meta.hook_pattern = post.hook_pattern;
                if (post.cta_pattern) meta.cta_pattern = post.cta_pattern;
                if (post.author) meta.author = post.author;
                if (post.visual_style) meta.visual_style = post.visual_style;

                const saved = await insertPost({
                  brand: post.brand,
                  platform: post.platform,
                  template_type: post.template_type,
                  copy_headline: post.copy_headline,
                  copy_body: post.copy_body,
                  copy_cta: post.copy_cta,
                  image_url: filename,
                  video_url: videoFilename,
                  status: 'draft',
                  scheduled_for: scheduledFor.toISOString(),
                  meta
                });
                await sendPostForReview(saved);
              } catch (err) {
                console.error(`  Error: ${err.message}`);
              }
            }
            console.log(`[Telegram] /generate completed: ${posts.length} posts`);
          } catch (err) {
            await sendNotification(`Generate failed: ${err.message}`);
          }
          continue;
        }

        // /publish — publish all approved posts now
        if (text === '/publish') {
          try {
            const approved = await getApprovedPosts();
            if (!approved.length) {
              await sendNotification('No approved posts to publish.');
              continue;
            }
            await sendNotification(`Publishing ${approved.length} post(s)...`);
            let published = 0;
            for (const post of approved) {
              try {
                await publish(post);
                await updatePostStatus(post.id, 'published');
                published++;
              } catch (err) {
                console.error(`  Error publishing ${post.id}: ${err.message}`);
                await sendNotification(`Failed: ${post.brand}/${post.template_type} — ${err.message.slice(0, 100)}`);
              }
            }
            await sendNotification(`Done — ${published}/${approved.length} posts published.`);
          } catch (err) {
            await sendNotification(`Publish failed: ${err.message}`);
          }
          continue;
        }

        // /status — quick overview + active levers summary
        if (text === '/status') {
          try {
            const drafts = await getDraftPosts();
            const approved = await getApprovedPosts();
            const { getPendingBriefs } = require('./lib/supabase');
            const briefs = await getPendingBriefs();
            const pubMethod = process.env.FB_PAGE_ACCESS_TOKEN ? 'Facebook Direct' : process.env.MAKE_WEBHOOK_URL ? 'Make.com' : 'NOT CONFIGURED';

            // Lever summary — single round-trip, no Promise.all so a
            // failure on one read doesn't sink the whole status output.
            let leverBlock = '';
            try {
              const [activeBrands, weights, hooks, ctas, authors] = await Promise.all([
                runtimeConfig.getActiveBrands(),
                runtimeConfig.getTemplateWeights(),
                runtimeConfig.getHookPatterns(),
                runtimeConfig.getCtaPatterns(),
                authorsLib.listAuthors(),
              ]);
              const weightLine = templateTypes.map(t => `${t}=${weights[t] ?? 0}`).join(' ');
              const activeAuthors = authors.filter(a => a.active).length;
              leverBlock =
                `\n\n<b>Levers</b>\n` +
                `Active: ${escapeHtml(activeBrands.join(', ') || '(none)')}\n` +
                `Templates: ${weightLine}\n` +
                `Patterns: ${hooks.length} hooks, ${ctas.length} CTAs\n` +
                `Ghost-writers: ${activeAuthors} active / ${authors.length} total\n` +
                `<i>/levers for full snapshot · /help for commands</i>`;
            } catch (e) {
              console.warn(`[/status] lever read failed: ${e.message}`);
            }

            await sendNotification(
              `<b>ContentBrain Status</b>\n\n` +
              `Drafts awaiting review: ${drafts.length}\n` +
              `Approved (ready to publish): ${approved.length}\n` +
              `Pending briefs: ${briefs.length}\n` +
              `Publishing via: ${pubMethod}` +
              leverBlock
            );
          } catch (err) {
            await sendNotification(`Status check failed: ${err.message}`);
          }
          continue;
        }

        // /help
        if (text === '/help') {
          await sendNotification(
            `<b>ContentBrain Commands</b>\n\n` +
            `<b>Operations</b>\n` +
            `/generate — create new posts now\n` +
            `/regen [brand] — alias for /generate\n` +
            `/publish — publish all approved posts now\n` +
            `/status — drafts, approved, briefs + active levers\n` +
            `/levers — full snapshot of every tunable lever\n\n` +
            `<b>Brand voice</b> (brand = auctionbrain | bridgematch)\n` +
            `/tone &lt;brand&gt; [new tone…]\n` +
            `/audience &lt;brand&gt; [new audience…]\n` +
            `/messages &lt;brand&gt; [list | add &lt;text&gt; | rm &lt;n&gt; | reset]\n` +
            `/directive &lt;brand&gt; [show | clear | &lt;text…&gt;]\n` +
            `/visual &lt;brand&gt; [show | clear | themes | &lt;text…&gt;]\n\n` +
            `<b>Pattern menus</b>\n` +
            `/hooks [list | add &lt;text&gt; | rm &lt;n&gt; | reset]\n` +
            `/ctas  [list | add &lt;text&gt; | rm &lt;n&gt; | reset]\n\n` +
            `<b>Mix</b>\n` +
            `/active [list | add &lt;brand&gt; | rm &lt;brand&gt;]\n` +
            `/templates [show | &lt;type&gt; &lt;weight&gt;]   types: stat hook list reel\n\n` +
            `<b>Ghost-writers</b> (roaming personas)\n` +
            `/authors [list | show &lt;Name&gt;]\n` +
            `/authors add &lt;Name&gt; &lt;voice description…&gt;\n` +
            `/authors tone &lt;Name&gt; &lt;text&gt;\n` +
            `/authors directive &lt;Name&gt; &lt;text | clear&gt;\n` +
            `/authors weight &lt;Name&gt; &lt;n&gt;     (0 = disabled)\n` +
            `/authors brand &lt;Name&gt; &lt;brand | all&gt;\n` +
            `/authors pause &lt;Name&gt; · resume &lt;Name&gt; · rm &lt;Name&gt;\n\n` +
            `Or just chat — send text ideas, photos of articles, or URLs and I'll save them as content seeds for future posts. Send a video to create a watermarked post.`
          );
          continue;
        }

        // ── RUNTIME CONFIG LEVERS ─────────────────────────────────
        // All of the following commands mutate rows in app_config (see
        // migrations/006-app-config.sql) and bust the runtime-config
        // cache so the next /generate picks them up immediately.
        // Defined here, *before* the unknown-command guard, so unknown
        // /commands still get silently dropped.

        if (text.startsWith('/levers') || text.startsWith('/tone') || text.startsWith('/audience') ||
            text.startsWith('/messages') || text.startsWith('/hooks') || text.startsWith('/ctas') ||
            text.startsWith('/active') || text.startsWith('/templates') ||
            text.startsWith('/directive') || text.startsWith('/visual') || text.startsWith('/regen') ||
            text.startsWith('/authors') || text.startsWith('/author ') || text === '/author') {
          try {
            const handled = await handleLeverCommand(text, msg);
            if (handled) continue;
          } catch (err) {
            console.error(`[Telegram] Lever command error: ${err.message}`);
            await sendNotification(`<b>Error</b>\n${escapeHtml(err.message)}`);
            continue;
          }
        }

        // Unknown command
        if (text.startsWith('/')) continue;

        // Smart intent classification — route message to the right action
        try {
          const Anthropic = require('@anthropic-ai/sdk');
          const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

          // Get recent drafts for context
          const recentDrafts = await getDraftPosts().catch(() => []);
          const draftsContext = recentDrafts.slice(0, 5).map(p =>
            `- ID:${p.id} | ${p.brand}/${p.template_type} | "${p.copy_headline}" | has_video:${!!p.video_url}`
          ).join('\n');

          addToHistory('user', text);

          const intentResponse = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            messages: [{ role: 'user', content: `You are ContentBrain, a friendly social media content assistant on Telegram. You manage content generation and publishing for the owner's brands.

${getHistoryContext()}The owner's latest message:
"${text}"

Current draft posts awaiting review:
${draftsContext || '(none)'}

Respond naturally as a helpful assistant. Return JSON:
{
  "reply": "Your conversational response to the owner",
  "action": "revise_post" | "save_brief" | "save_seed" | "scrape_url" | null,
  "post_id": "only if action is revise_post — the draft ID they're referring to, or null",
  "url": "only if action is scrape_url — the URL to scrape",
  "summary": "one-line summary of what they want (only if action is not null)"
}

Guidelines:
- MOST messages need no action — just reply naturally. Chat, answer questions, be helpful.
- Only set action to "save_brief" if the owner is CLEARLY giving you a specific topic or idea for future posts (e.g. "do a post about bridging loan rates rising")
- Only set action to "revise_post" if they're giving specific feedback on a draft (e.g. "make the headline shorter", "change the CTA")
- Set action to "save_seed" if the owner is sharing research, knowledge, facts, or article content — not a direct social brief but useful raw material for future content
- Set action to "scrape_url" if the message contains a URL they want you to read and store (e.g. "read this: https://...")
- When in doubt, just reply — don't trigger an action. It's always better to chat than to wrongly save a brief or revise a post.
- Keep replies short, friendly, British English.` }]
          });

          const intentText = intentResponse.content[0].text;
          const intentMatch = intentText.match(/\{[\s\S]*\}/);
          if (!intentMatch) throw new Error('Could not classify message');
          const intent = JSON.parse(intentMatch[0]);

          console.log(`[Telegram] Action: ${intent.action || 'chat'} — ${intent.summary || intent.reply?.slice(0, 50)}`);

          // Always send the conversational reply
          if (intent.reply) {
            await sendNotification(intent.reply);
            addToHistory('assistant', intent.reply);
          }

          if (intent.action === 'revise_post' && intent.post_id) {
            // Look up the post in social posts OR blog posts (both projects)
            // so a chat-typed revision routes to the correct table/brand.
            const found = await findPostAnywhere(intent.post_id);
            if (!found) {
              await sendNotification(`Couldn't find that post. Use the Revise button on a specific post, or try again.`);
              continue;
            }

            // Blog/guide posts get the full writer-context revision flow.
            if (found.kind === 'blog') {
              try {
                const contentType = found.post.post_type === 'guide' ? 'guide' : 'blog';
                await reviseBlogPost({
                  postId: intent.post_id,
                  brand: found.brand,
                  contentType,
                  editorText: text,
                  chatId: null,        // no original review card to update — send fresh card only
                  messageId: null,
                  originalCaption: null
                });
              } catch (err) {
                console.error(`[Telegram] Blog revision (intent) error: ${err.message}`);
                await sendNotification(`Couldn't revise: ${err.message}.`);
              }
              continue;
            }

            // Social post — fall through to existing classify-then-rewrite flow.
            const rev = { postId: intent.post_id, chatId: msg.chat.id, messageId: msg.message_id };
            const post = found.post;

            const { brands } = require('./lib/config');
            const b = brands[post.brand] || brands.auctionbrain;

            const classifyResponse = await anthropic.messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 300,
              messages: [{ role: 'user', content: `You manage a social media content pipeline. A post has a graphic/video and this copy:

Headline: ${post.copy_headline}
Body: ${post.copy_body}
CTA: ${post.copy_cta}
Template: ${post.template_type}
Has video: ${!!post.video_url}

The content owner sent this revision request: "${text}"

Classify this request. Return JSON:
{
  "type": "copy_change" | "video_change" | "both" | "cannot_do",
  "copy_action": "rewrite" | "none",
  "video_action": "re-render" | "extend_duration" | "none",
  "video_duration_seconds": null or number if they specified a duration,
  "summary": "One line explaining what you understood they want",
  "copy_instructions": "Specific instructions for rewriting copy, or null"
}` }]
            });

            const classText = classifyResponse.content[0].text;
            const classMatch = classText.match(/\{[\s\S]*\}/);
            if (!classMatch) throw new Error('Could not interpret feedback');
            const classification = JSON.parse(classMatch[0]);

            await sendNotification(`Understood: ${classification.summary}`);

            let revised = { copy_headline: post.copy_headline, copy_body: post.copy_body, copy_cta: post.copy_cta };
            let needsVideoRerender = false;
            let videoDuration = null;

            if (classification.copy_action === 'rewrite') {
              const copyInstructions = classification.copy_instructions || text;
              const copyResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                messages: [{ role: 'user', content: `You wrote this social media post for ${b.name}:\n\nHeadline: ${post.copy_headline}\nBody: ${post.copy_body}\nCTA: ${post.copy_cta}\n\nRevision needed: ${copyInstructions}\n\nRewrite the post. Keep the same format and tone. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }` }]
              });
              const aiText = copyResponse.content[0].text;
              const match = aiText.match(/\{[\s\S]*\}/);
              if (match) revised = JSON.parse(match[0]);
            }

            if (classification.video_action === 'extend_duration' || classification.video_action === 're-render') {
              needsVideoRerender = true;
              videoDuration = classification.video_duration_seconds || 30;
            }

            const { supabase } = require('./lib/supabase');
            const { error: copyErr } = await supabase.from('posts').update({
              copy_headline: revised.copy_headline,
              copy_body: revised.copy_body || '',
              copy_cta: revised.copy_cta || ''
            }).eq('id', rev.postId);
            if (copyErr) throw new Error(`Copy update failed: ${copyErr.message}`);

            if (needsVideoRerender && post.video_url) {
              try {
                await sendNotification(`Re-rendering video (${videoDuration}s)...`);
                const { renderVideo, ensureBundle } = require('./lib/video-renderer');
                await ensureBundle();
                const updatedPost = { ...post, ...revised, overrideDurationSeconds: videoDuration };
                const video = await renderVideo(post.template_type, post.brand, updatedPost);
                await supabase.from('posts').update({ video_url: video.filename }).eq('id', rev.postId);
                post.video_url = video.filename;
              } catch (videoErr) {
                console.error(`[Telegram] Video re-render failed: ${videoErr.message}`);
                await sendNotification(`Video re-render failed: ${videoErr.message}. Copy was updated.`);
              }
            }

            await sendPostForReview({ ...post, ...revised });
            console.log(`[Telegram] Smart revision: post ${rev.postId} (${classification.type})`);

          } else if (intent.action === 'revise_post' && !intent.post_id) {
            await sendNotification(`Tap the Revise button on the post you want to change, then send your feedback.`);

          } else if (intent.action === 'save_brief') {
            // Start conversational brief — ask a follow-up before saving
            pendingBrief = { messages: [text], startedAt: Date.now() };
            try {
              const followUpResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                messages: [{ role: 'user', content: `You are ContentBrain. The content owner wants to brief a future social media post.\n\nThey said: "${text}"\n\nAsk ONE short follow-up question to make this brief more actionable. Focus on: what angle or hook? Any specific data points or stories to include? Which brand (AuctionBrain or BridgeMatch)?\n\nKeep it casual, one sentence. British English.` }]
              });
              const followUp = followUpResponse.content[0].text.trim();
              await sendNotification(followUp);
              addToHistory('assistant', followUp);
            } catch (err) {
              // If follow-up fails, just save immediately
              await saveBrief(text);
              pendingBrief = null;
              await sendNotification(`Saved as a brief for tomorrow's posts.`);
            }
            console.log(`[Telegram] Brief conversation started: ${text.slice(0, 50)}...`);

          } else if (intent.action === 'save_seed') {
            // Save as content seed — raw material, not a direct brief
            try {
              const seedResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 400,
                messages: [{ role: 'user', content: `The content owner shared this knowledge/research:\n"${text}"\n\nExtract structured content seed. Return JSON:\n{\n  "summary": "One-line summary",\n  "key_points": "3-5 bullet points of useful info",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "tags": ["tag1", "tag2"]\n}` }]
              });

              const seedText = seedResponse.content[0].text;
              const seedMatch = seedText.match(/\{[\s\S]*\}/);
              const seed = seedMatch ? JSON.parse(seedMatch[0]) : { summary: text.slice(0, 100), key_points: '', tags: [] };

              await saveSeed({
                source: 'telegram_text',
                raw_input: text,
                summary: seed.summary || '',
                key_points: seed.key_points || '',
                brand: seed.brand || null,
                tags: seed.tags || []
              });

              console.log(`[Telegram] Text seed saved: ${seed.summary}`);
            } catch (seedErr) {
              console.error(`[Telegram] Seed save error: ${seedErr.message}`);
              // Still save raw text
              await saveSeed({ source: 'telegram_text', raw_input: text, summary: text.slice(0, 200) });
            }

          } else if (intent.action === 'scrape_url' && intent.url) {
            // Scrape URL and save as content seed
            try {
              const urlToScrape = intent.url;

              // Validate URL — scheme + DNS-resolved IP range to prevent SSRF
              let parsedUrl;
              try {
                parsedUrl = new URL(urlToScrape);
              } catch {
                await sendNotification(`That doesn't look like a valid URL.`);
                continue;
              }
              if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                await sendNotification(`Only http/https URLs are supported.`);
                continue;
              }

              // Resolve the host and reject loopback / private / link-local
              // ranges before fetching. Blocks AWS metadata (169.254.169.254),
              // intra-VPC services, and the local network. (Best-effort: there
              // is a TOCTOU window between resolution and connect, but the
              // endpoint is owner-authenticated so the residual risk is low.)
              try {
                const dns = require('dns').promises;
                const addrs = await dns.lookup(parsedUrl.hostname, { all: true });
                const isBlocked = (ip, family) => {
                  if (family === 4) {
                    const [a, b] = ip.split('.').map(Number);
                    if (a === 0 || a === 10 || a === 127) return true;
                    if (a === 169 && b === 254) return true;
                    if (a === 172 && b >= 16 && b <= 31) return true;
                    if (a === 192 && b === 168) return true;
                    return false;
                  }
                  if (family === 6) {
                    const lower = ip.toLowerCase();
                    if (lower === '::1' || lower === '::') return true;
                    if (lower.startsWith('fe80:') || lower.startsWith('fec0:')) return true;
                    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
                    if (lower.startsWith('::ffff:')) {
                      // IPv4-mapped — recurse on the v4 part
                      const v4 = lower.slice(7);
                      return isBlocked(v4, 4);
                    }
                  }
                  return false;
                };
                if (addrs.some(a => isBlocked(a.address, a.family))) {
                  await sendNotification(`That URL resolves to a private/internal address — blocked for safety.`);
                  continue;
                }
              } catch (e) {
                await sendNotification(`Couldn't resolve that hostname.`);
                continue;
              }

              let pageContent = '';

              // Fetch the page content
              const pageRes = await fetch(parsedUrl.href, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentBrain/1.0)' },
                signal: AbortSignal.timeout(15000),
                redirect: 'manual' // don't auto-follow; a redirect to 169.254.x.x would bypass the check
              });
              // If the server redirected, follow ONCE after re-checking the new URL
              if (pageRes.status >= 300 && pageRes.status < 400) {
                await sendNotification(`That URL redirected — refusing to follow automatically. Send the final URL directly.`);
                continue;
              }
              if (pageRes.ok) {
                const html = await pageRes.text();
                // Strip HTML tags for a rough text extraction
                pageContent = html
                  .replace(/<script[\s\S]*?<\/script>/gi, '')
                  .replace(/<style[\s\S]*?<\/style>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 8000);
              }

              if (!pageContent) {
                await sendNotification(`Couldn't read that URL. The page may be behind a paywall or blocking bots.`);
                continue;
              }

              // Summarise with Claude
              const scrapeResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                messages: [{ role: 'user', content: `Summarise this article content for a UK property content team. Source URL: ${urlToScrape}\n\nContent:\n${pageContent.slice(0, 6000)}\n\nReturn JSON:\n{\n  "summary": "One-line summary",\n  "key_points": "3-5 bullet points of the most useful info",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "tags": ["tag1", "tag2"]\n}` }]
              });

              const scrapeText = scrapeResponse.content[0].text;
              const scrapeMatch = scrapeText.match(/\{[\s\S]*\}/);
              const scraped = scrapeMatch ? JSON.parse(scrapeMatch[0]) : { summary: 'Could not summarise', key_points: '', tags: [] };

              await saveSeed({
                source: 'telegram_url',
                raw_input: text,  // full message including user commentary + URL
                extracted_text: pageContent.slice(0, 5000),
                summary: scraped.summary || '',
                key_points: scraped.key_points || '',
                brand: scraped.brand || null,
                tags: scraped.tags || []
              });

              await sendNotification(`Read that article — ${scraped.summary}. Saved for future content.`);
              console.log(`[Telegram] URL seed saved: ${urlToScrape}`);
            } catch (scrapeErr) {
              console.error(`[Telegram] URL scrape error: ${scrapeErr.message}`);
              // Save the URL as a raw seed even if scraping failed
              await saveSeed({ source: 'telegram_url', raw_input: intent.url, summary: 'Scrape failed — URL saved for manual review' });
              await sendNotification(`Couldn't fully read that page, but I've saved the URL for later.`);
            }
          }
          // No else needed — conversational reply was already sent above
        } catch (err) {
          console.error(`[Telegram] Smart routing error: ${err.message}`);
          // Fall back to a simple apology
          await sendNotification(`Sorry, something went wrong processing that. Try /help for commands.`).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Silence network errors, will retry next poll
    pollLastError = err.message;
  }

  setTimeout(pollTelegram, 1000);
}

// Resend review cards for any blog/guide drafts so a stale-poll-loop
// outage (or a Railway redeploy that landed mid-click) self-heals
// within seconds of restart. Without this, drafts can sit forever
// because Telegram doesn't queue callback_query updates the way it
// queues messages — once the bot's polling loop dies, every button
// press during the dead window is lost.
async function resendDraftReviewCards() {
  try {
    const drafts = await getDraftBlogPosts().catch(() => []);
    if (!drafts.length) return;
    const { sendBlogForReview } = require('./lib/telegram');
    const { getSourceArticlesForPost } = require('./lib/supabase');
    let sent = 0;
    for (const d of drafts) {
      try {
        const sources = await getSourceArticlesForPost(d.id, d.brand || 'auctionbrain').catch(() => []);
        await sendBlogForReview({
          post_id: d.id,
          title: d.title,
          summary: d.summary || d.meta_description || '',
          score: d.evaluation_score,
          word_count: d.word_count,
          brand: d.brand || 'auctionbrain',
          content_type: d.post_type === 'guide' ? 'guide' : 'blog',
          sources,
        });
        sent++;
      } catch (err) {
        console.warn(`[startup] resend failed for ${d.id}: ${err.message}`);
      }
    }
    if (sent) console.log(`[startup] resent ${sent} review card(s) for drafts`);
  } catch (err) {
    console.warn(`[startup] resendDraftReviewCards: ${err.message}`);
  }
}

// ── EDITORIAL DASHBOARD ──────────────────────────────────────────────────────

const Anthropic = require('@anthropic-ai/sdk');
const _anthropicForEditorial = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY });
const SUPPORTED_IMAGE_TYPES_ED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

app.get('/content', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'editorial.html'));
});

app.get('/api/content/coverage', requireAuth, async (req, res) => {
  try {
    const posts = await getPublishedBlogPostsBothBrands();
    const brand = req.query.brand; // optional filter

    const filtered = brand ? posts.filter(p => p.brand === brand) : posts;

    // Build tag frequency map
    const tagCount = {};
    for (const post of filtered) {
      const tags = Array.isArray(post.tags) ? post.tags : [];
      for (const tag of tags) {
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      }
    }

    // Classify: 0 = gap, 1-2 = covered, 3+ = saturated
    const coverage = Object.entries(tagCount)
      .map(([tag, count]) => ({
        tag,
        count,
        status: count >= 3 ? 'saturated' : 'covered'
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ posts: filtered.length, coverage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/content/queue', requireAuth, async (req, res) => {
  try {
    const drafts = await getDraftBlogPosts();
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/content/briefs', requireAuth, async (req, res) => {
  try {
    const briefs = await getPendingBriefsAll();
    res.json({ briefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/brief', requireAuth, async (req, res) => {
  try {
    const { brand, message, topic, angle } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    const brief = await saveBrief({ brand: brand || null, message: message.trim(), topic: topic || null, angle: angle || null });
    res.json({ ok: true, brief });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for the Reddit-thread → brief promotion. Same logic as
// the daily cron at 06:30 UTC, exposed so the editor can pull fresh briefs
// on demand from the Brief Queue panel.
app.post('/api/content/refresh-reddit-briefs', requireAuth, async (req, res) => {
  try {
    const { promoteRedditThreadsToBriefs } = require('./lib/reddit-briefs');
    const result = await promoteRedditThreadsToBriefs();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/brief/:id/dismiss', requireAuth, async (req, res) => {
  try {
    await dismissBrief(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/seed', requireAuth, async (req, res) => {
  try {
    const { brand, content, title } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
    const seed = await saveSeed({ brand: brand || null, content: content.trim(), title: title?.trim() || null });
    res.json({ ok: true, seed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accepts { mimeType, data (base64), filename } — extracts content via Claude
app.post('/api/content/upload', requireAuth, async (req, res) => {
  try {
    const { mimeType, data, filename } = req.body;
    if (!data) return res.status(400).json({ error: 'data (base64) is required' });

    const isPdf = mimeType === 'application/pdf';
    const isImage = SUPPORTED_IMAGE_TYPES_ED.includes(mimeType);
    if (!isPdf && !isImage) return res.status(400).json({ error: `Unsupported type: ${mimeType}` });

    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data } };

    const response = await _anthropicForEditorial.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text: 'Extract all useful editorial content from this document — headlines, article text, statistics, quotes, opinions. Format as clean markdown. Skip ads, subscription offers, navigation, and page numbers.' }
        ]
      }]
    });

    const extracted = response.content[0]?.text || '';
    if (extracted.length < 20) return res.status(422).json({ error: 'Could not extract readable content' });

    res.json({ ok: true, extracted, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch the full blog post so the editor can amend it before approving.
// Returns the row including content_md/content_html — heavier than the
// queue listing, but only fired when the editor actually opens the amend form.
app.get('/api/content/blog/:brand/:id', requireAuth, async (req, res) => {
  try {
    const { brand, id } = req.params;
    const post = await getBlogPostById(id, brand);
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Amend a draft blog post in-place. Updates whichever of title / summary /
// content_md were sent in the body. content_html is regenerated from the
// new content_md so the published version stays in sync — the landing
// site renders content_html, not content_md.
app.patch('/api/content/blog/:brand/:id', requireAuth, async (req, res) => {
  try {
    const { brand, id } = req.params;
    const { title, summary, content_md } = req.body;
    const updates = {};
    if (typeof title === 'string') {
      if (!title.trim()) return res.status(400).json({ error: 'title cannot be empty' });
      if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
      updates.title = title.trim();
    }
    if (typeof summary === 'string') {
      if (summary.length > 500) return res.status(400).json({ error: 'summary too long (max 500)' });
      updates.summary = summary.trim();
    }
    if (typeof content_md === 'string') {
      if (!content_md.trim()) return res.status(400).json({ error: 'content cannot be empty' });
      if (content_md.length > 50000) return res.status(400).json({ error: 'content too long (max 50k)' });
      updates.content_md = content_md;
      // Regenerate content_html from the amended markdown so the landing
      // site (which reads content_html) doesn't fall behind.
      try {
        const { marked } = require('marked');
        updates.content_html = marked.parse(content_md);
      } catch (mdErr) {
        return res.status(500).json({ error: `markdown render failed: ${mdErr.message}` });
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No editable fields provided' });

    const { getBlogClient } = require('./lib/supabase');
    const client = getBlogClient(brand);
    const { data, error } = await client.from('blog_posts').update(updates).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/approve/:brand/:id', requireAuth, async (req, res) => {
  try {
    const { brand, id } = req.params;
    await updateBlogPostStatus(id, 'approved', {}, brand);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/content/reject/:brand/:id', requireAuth, async (req, res) => {
  try {
    const { brand, id } = req.params;
    const { feedback } = req.body;
    await updateBlogPostStatus(id, 'rejected', { revision_feedback: feedback || '' }, brand);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── SOCIAL DASHBOARD ─────────────────────────────────────────────────────────

// Defensive: strip directory components from a render-output filename before
// it ever lands in the DB. Renderers should already produce safe basenames,
// but a future bug there must not turn into a path-traversal issue when the
// filename is later concatenated into '/output/<name>' on the client.
function safeFilename(name) {
  if (typeof name !== 'string' || !name) return null;
  return name.replace(/[\\/]/g, '').replace(/^\.+/, '');
}

app.get('/social', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'social.html'));
});

app.get('/api/social/queue', requireAuth, async (req, res) => {
  try {
    const drafts = await getDraftPosts();
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const post = await updatePostStatus(req.params.id, 'approved');
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const { feedback } = req.body;
    const { supabase } = require('./lib/supabase');
    const updates = { status: 'rejected' };
    if (feedback?.trim()) updates.rejection_feedback = feedback.trim();
    const { data, error } = await supabase.from('posts').update(updates).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/social/posts/:id/copy', requireAuth, async (req, res) => {
  try {
    const { copy_headline, copy_body, copy_cta } = req.body;
    const updates = {};
    // Headline: required to be non-empty (every post template needs one).
    // Body / CTA: intentionally allowed to be cleared to empty string —
    // some templates (e.g. stat) don't require body or CTA, so the editor
    // can blank them out.
    if (copy_headline !== undefined) {
      if (typeof copy_headline !== 'string' || !copy_headline.trim()) return res.status(400).json({ error: 'copy_headline must be a non-empty string' });
      if (copy_headline.length > 100) return res.status(400).json({ error: 'copy_headline too long (max 100)' });
      updates.copy_headline = copy_headline.trim();
    }
    if (copy_body !== undefined) {
      if (typeof copy_body !== 'string') return res.status(400).json({ error: 'copy_body must be a string' });
      if (copy_body.length > 300) return res.status(400).json({ error: 'copy_body too long (max 300)' });
      updates.copy_body = copy_body.trim();
    }
    if (copy_cta !== undefined) {
      if (typeof copy_cta !== 'string') return res.status(400).json({ error: 'copy_cta must be a string' });
      if (copy_cta.length > 80) return res.status(400).json({ error: 'copy_cta too long (max 80)' });
      updates.copy_cta = copy_cta.trim();
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No copy fields provided' });

    const { supabase } = require('./lib/supabase');
    const { data, error } = await supabase.from('posts').update(updates).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/social/posts/:id/rerender', requireAuth, async (req, res) => {
  try {
    const post = await getPostById(req.params.id);
    const { renderPost } = require('./lib/renderer');
    const { renderVideo } = require('./lib/video-renderer');

    const renderResult = await renderPost(post.template_type, post.brand, post);
    const imageFilename = safeFilename(renderResult.filename);
    let videoFilename = null;
    try {
      const video = await renderVideo(post.template_type, post.brand, post);
      videoFilename = safeFilename(video.filename);
    } catch (videoErr) {
      console.warn(`[rerender] Video render skipped for ${post.id}: ${videoErr.message}`);
    }

    // Always include video_url in the update — when the video render fails
    // we explicitly null it out so the DB doesn't keep pointing at the old
    // (now-stale) file. Otherwise a reload would still show the previous video.
    const updates = { image_url: imageFilename, video_url: videoFilename };

    const { supabase } = require('./lib/supabase');
    const { error } = await supabase.from('posts').update(updates).eq('id', post.id);
    if (error) throw new Error(error.message);

    res.json({ ok: true, image_url: imageFilename, video_url: videoFilename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── UNIFIED CONTROL PANEL (/levers) ──
//
// Surfaces every lever currently controllable via Telegram in a single web
// page so the operator doesn't have to remember command syntax. The page
// is just HTML + vanilla JS — no framework, no build step. All state lives
// in app_config; this layer is purely a UI on top of runtime-config.

app.get('/levers', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'levers.html'));
});

// Full snapshot of every lever value, plus the menus the UI needs to render
// (theme list, archetype list, template list, brand list).
app.get('/api/levers', requireAuth, async (req, res) => {
  try {
    const runtimeConfig = require('./lib/runtime-config');
    const { THEMES, THEME_NAMES, DEFAULT_THEME_NAME } = require('./lib/themes');
    const { ARCHETYPES, DEFAULT_SCHEDULE } = require('./lib/lot-picker');
    const { brands: defaultBrands, templateTypes } = require('./lib/config');

    const brandList = Object.keys(defaultBrands);

    const perBrand = {};
    for (const brand of brandList) {
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
        tone, audience, directive,
        visual_directive: visualDirective,
        messages: Array.isArray(messages) ? messages : [],
      };
    }

    const [activeBrands, templateWeights, hookPatterns, ctaPatterns] = await Promise.all([
      runtimeConfig.getActiveBrands(),
      runtimeConfig.getTemplateWeights(),
      runtimeConfig.getHookPatterns(),
      runtimeConfig.getCtaPatterns(),
    ]);

    // Schedule lever isn't exposed via runtime-config helpers — read directly.
    const { supabase } = require('./lib/supabase');
    let lotSchedule = DEFAULT_SCHEDULE;
    try {
      const { data } = await supabase
        .from('app_config')
        .select('value')
        .eq('brand', 'global')
        .eq('key', 'lot_archetype_schedule')
        .maybeSingle();
      if (Array.isArray(data?.value) && data.value.length === 7) lotSchedule = data.value;
    } catch {}

    res.json({
      brands: brandList,
      perBrand,
      global: {
        active_brands: activeBrands,
        template_weights: templateWeights,
        hook_patterns: hookPatterns,
        cta_patterns: ctaPatterns,
        lot_archetype_schedule: lotSchedule,
      },
      menus: {
        themes: THEME_NAMES.map(n => ({ name: n, label: THEMES[n].label, description: THEMES[n].description, isDefault: n === DEFAULT_THEME_NAME })),
        archetypes: ARCHETYPES,
        templateTypes,
      },
    });
  } catch (err) {
    console.error('[GET /api/levers] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Set one lever. Body: { brand: 'auctionbrain'|'bridgematch'|'global', key: '<lever key>', value: <any JSON> }
// Empty string or null clears (forwards to clearLever) so the UI can wire one save handler.
app.post('/api/levers', requireAuth, async (req, res) => {
  try {
    const { brand, key, value } = req.body || {};
    if (!brand || !key) return res.status(400).json({ error: 'brand and key required' });
    const runtimeConfig = require('./lib/runtime-config');
    const isEmpty = value == null || (typeof value === 'string' && value.trim() === '');
    if (isEmpty) {
      await runtimeConfig.clearLever(brand, key);
    } else {
      await runtimeConfig.setLever(brand, key, value);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[POST /api/levers] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Manual content-generation trigger. Bypasses the once-per-day dedupe in
// runGenerate so the operator can re-run on demand from the UI.
app.post('/api/triggers/generate', requireAuth, async (req, res) => {
  // Don't await — generation can take 30–90s. Fire-and-forget, return immediately.
  setImmediate(() => {
    runGenerate({ force: true }).catch(err => {
      console.error('[POST /api/triggers/generate] runGenerate error:', err.message);
      sendNotification(`Manual /generate failed: ${err.message.slice(0, 200)}`).catch(() => {});
    });
  });
  res.json({ ok: true, message: 'Generation started — drafts will appear in /social shortly.' });
});

// Manual Lot of the Day trigger. Same fire-and-forget pattern.
app.post('/api/triggers/lot', requireAuth, async (req, res) => {
  const { archetype } = req.body || {};
  setImmediate(async () => {
    try {
      const { runLotOfTheDay } = require('./lib/lot-flow');
      await runLotOfTheDay(archetype ? { forceArchetype: archetype } : {});
    } catch (err) {
      console.error('[POST /api/triggers/lot] runLotOfTheDay error:', err.message);
      try { await sendNotification(`Manual Lot of the Day failed: ${err.message.slice(0, 200)}`); } catch {}
    }
  });
  res.json({ ok: true, message: 'Lot of the Day started — script alert will arrive in Telegram shortly.' });
});

// ── START ──
app.listen(PORT, async () => {
  console.log(`ContentBrain review UI running on port ${PORT}`);
  console.log('Cron: generate at 7am daily, publish every 15 mins');
  console.log('Telegram: polling for approve/reject buttons');

  // Notify on startup so you know the server is alive
  const drafts = await getDraftPosts().catch(() => []);
  const approved = await getApprovedPosts().catch(() => []);
  await sendNotification(
    `<b>ContentBrain started</b>\n\n` +
    `Drafts: ${drafts.length} | Approved: ${approved.length}\n` +
    `Publishing: ${process.env.FB_PAGE_ACCESS_TOKEN ? 'Facebook Direct' : process.env.MAKE_WEBHOOK_URL ? 'Make.com' : 'NOT CONFIGURED'}`
  );

  // Defensive: if a stray webhook is set on the bot token, getUpdates
  // returns 409 Conflict on every poll and inbound callback_query
  // updates vanish. Outbound sends still work, so the bug is invisible
  // from outside (health=200, sendMessage=200, but button presses go
  // to the void). Deleting any existing webhook on startup is a no-op
  // when none is set. drop_pending_updates=false preserves any genuine
  // queued message updates that survived the webhook→polling switch.
  try {
    if (BOT_TOKEN) {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteWebhook?drop_pending_updates=false`);
      const j = await r.json();
      if (j.ok) console.log(`[startup] deleteWebhook: ${j.description || 'ok'}`);
      else console.warn(`[startup] deleteWebhook failed: ${JSON.stringify(j)}`);
    }
  } catch (err) {
    console.warn(`[startup] deleteWebhook error: ${err.message}`);
  }

  // Self-heal: if any blog/guide drafts have stale buttons (because the
  // poll loop was dead when you tried to click them), re-send fresh
  // review cards now so the next click actually fires.
  await resendDraftReviewCards();

  pollTelegram();
});
