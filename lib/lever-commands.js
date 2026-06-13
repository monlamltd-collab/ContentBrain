// lib/lever-commands.js — Telegram lever command dispatcher.
//
// Pure move out of server.js (decomposition step 3.1). handleLeverCommand
// processes every /command the operator sends in Telegram that tunes a
// runtime lever (/levers /tone /messages /audience /directive /visual
// /hooks /ctas /weights /brands /authors /schedule /regen ...). Returns
// true when the command was recognised (caller skips the conversational
// fallback), throws on user error so the caller can echo it.

require('dotenv').config();
const { sendNotification, sendPostForReview } = require('./telegram');
const { insertPost } = require('./supabase');
const runtimeConfig = require('./runtime-config');
const authorsLib = require('./authors');
const { brands: defaultBrands, templateTypes } = require('./config');

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

  // /durations [show | reset | <template> <seconds>]
  // Default video length per template type (same lever as the Design tab).
  if (head === '/durations') {
    const [, sub, rest] = cmdTokens(text, 2);
    const subLower = (sub || 'show').toLowerCase();

    if (subLower === 'show' || !sub) {
      const durations = await runtimeConfig.getTemplateDurations();
      const lines = Object.entries(durations).map(([t, s]) => `${t}: ${s}s`);
      await sendNotification(`<b>Video lengths</b>\n${lines.join('\n')}\n\nSet with <code>/durations reel 12</code>, reset with <code>/durations reset</code>.`);
      return true;
    }
    if (subLower === 'reset' || subLower === 'clear') {
      await runtimeConfig.clearLever('global', 'template_durations');
      await sendNotification('Reset video lengths to defaults (stat 6s, hook 7s, list 8s, reel 6s).');
      return true;
    }
    const template = subLower;
    if (!Object.keys(runtimeConfig.DEFAULT_TEMPLATE_DURATIONS).includes(template)) {
      throw new Error(`Unknown template "${sub}". Use one of: ${Object.keys(runtimeConfig.DEFAULT_TEMPLATE_DURATIONS).join(', ')}.`);
    }
    const seconds = parseInt(rest, 10);
    if (!Number.isFinite(seconds) || seconds < 3 || seconds > 90) {
      throw new Error('Length must be 3–90 seconds, e.g. /durations reel 12');
    }
    const current = await runtimeConfig.getTemplateDurations();
    await runtimeConfig.setLever('global', 'template_durations', { ...current, [template]: seconds });
    await sendNotification(`Set <b>${template}</b> video length to ${seconds}s. New videos use it from the next generation; re-render existing drafts from the Studio tab.`);
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
    const { THEMES, THEME_NAMES, DEFAULT_THEME_NAME } = require('./themes');
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
      const { generateBatch } = require('./generate');
      const { renderPost } = require('./renderer');
      const { renderVideo } = require('./video-renderer');

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
          if (post.duration_seconds) meta.duration_seconds = post.duration_seconds;

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

module.exports = { handleLeverCommand, cmdTokens, requireBrand };
