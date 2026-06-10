// Runtime config layer — Telegram-tunable levers backed by Supabase.
//
// Why a separate layer?
//   - lib/config.js holds DEFAULTS (brand voice fields, template list).
//   - This module resolves the LIVE values: defaults overlaid with rows
//     from the `app_config` table (see migrations/006-app-config.sql).
//   - All read paths in lib/generate.js + server.js call helpers here so
//     that flipping a Telegram lever takes effect on the next generation
//     without redeploying. Rows survive Railway redeploys; the in-memory
//     cache below survives only the process.
//
// Cache strategy:
//   - 30-second TTL keyed on `${brand}::${key}`.
//   - setLever()/clearLever() bust the cache for that key immediately so
//     a Telegram edit is visible on the next /generate without waiting.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { brands: defaultBrands, templateTypes } = require('./config');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// ── Defaults ──────────────────────────────────────────────────────────
//
// Hook + CTA pattern menus mirror the structures the LLM expects so
// runtime edits stay in lockstep with the prompt format. Each entry is
// `{ label, body }`. Labels for hooks are 1..N; CTAs are A..Z.
//
// To preserve "rotate against the recently used patterns" semantics we
// keep label strings stable; if the operator removes a default and adds
// a new one, the new entry takes the next available label rather than
// reshuffling existing labels (which would break the meta.hook_pattern
// counts already stored on past posts).

const DEFAULT_HOOK_PATTERNS = [
  { label: '1',  body: 'SPECIFIC-NUMBER FLEX — concrete £/% with oddly precise figure (e.g. "Made £47,300 on a £93k auction lot")' },
  { label: '2',  body: 'MISTAKE-COST — a concrete loss + identifiable cause (e.g. "This legal pack gap cost a buyer £8,400")' },
  { label: '3',  body: 'CONTRARIAN TRUTH — challenges an assumption the audience holds (e.g. "Most auction lots aren\'t bargains")' },
  { label: '4',  body: 'CURIOSITY GAP — Q with a non-obvious A withheld for the body (e.g. "Why a £45k Hartlepool terrace just sold for £128k")' },
  { label: '5',  body: 'INSIDER KNOWLEDGE — what the audience suspects but can\'t prove (e.g. "What auctioneers don\'t tell you about reserve prices")' },
  { label: '6',  body: 'TIME / URGENCY — calendar-anchored, scrollable timeline (e.g. "Bidding starts Tuesday. 3 lots to watch.")' },
  { label: '7',  body: 'PATTERN REVEAL — numbered list, "three things…", "every X has…" (e.g. "Three things every winning bid has in common")' },
  { label: '8',  body: 'SCARY STAT → HOPE — fear opener + a way out (e.g. "Half of auction lots never reach Rightmove. Here\'s where to find them.")' },
  { label: '9',  body: 'STATUS THREAT — flips identity ("smart people don\'t…") (e.g. "Brokers are missing the best lots — nobody checks the EPC band first")' },
  { label: '10', body: 'IDENTITY REVEAL — named role + opinion (e.g. "I\'m a bridging broker — here\'s the auction trap I won\'t fund")' },
];

const DEFAULT_CTA_PATTERNS = [
  { label: 'A', body: 'CAPABILITY + BRAND  — "Search 168 auction houses → auctionbrain.co.uk"' },
  { label: 'B', body: 'FILTER-LED         — "Unsold lots under £100k → auctionbrain.co.uk"' },
  { label: 'C', body: 'FREE + HIDDEN COST — "Free. We check flood + EPC for you. → auctionbrain.co.uk"' },
  { label: 'D', body: 'COMPARISON         — "Faster than EIG. Free. → auctionbrain.co.uk"' },
  { label: 'E', body: 'CALENDAR / EVENT   — "Tuesday\'s catalogues are live → auctionbrain.co.uk"' },
  { label: 'F', body: 'QUESTION-LED       — "Looking for a sub-£80k flip? → auctionbrain.co.uk"' },
  { label: 'G', body: 'SCORE + SCORING    — "Every lot scored 0–10 → auctionbrain.co.uk"' },
  { label: 'H', body: 'CROSS-SELL         — only when bridging is in the post: "Bridging too? → bridgematch.co.uk"' },
];

const DEFAULT_ACTIVE_BRANDS = ['auctionbrain'];

// Equal weight across all 4 templates — pickTemplates() consults this so
// raising e.g. reel:3 makes reels three times more likely to land in the
// next batch.
const DEFAULT_TEMPLATE_WEIGHTS = {
  stat: 1, hook: 1, list: 1, reel: 1
};

// ── Cache ─────────────────────────────────────────────────────────────

const TTL_MS = 30_000;
const cache = new Map(); // key: `${brand}::${key}` -> { value, fetchedAt }

function cacheGet(brand, key) {
  const hit = cache.get(`${brand}::${key}`);
  if (!hit) return undefined;
  if (Date.now() - hit.fetchedAt > TTL_MS) {
    cache.delete(`${brand}::${key}`);
    return undefined;
  }
  return hit.value;
}

function cacheSet(brand, key, value) {
  cache.set(`${brand}::${key}`, { value, fetchedAt: Date.now() });
}

function cacheBust(brand, key) {
  cache.delete(`${brand}::${key}`);
}

function cacheClearAll() {
  cache.clear();
}

// ── Low-level CRUD ────────────────────────────────────────────────────

async function readRaw(brand, key) {
  const cached = cacheGet(brand, key);
  if (cached !== undefined) return cached;

  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('brand', brand)
    .eq('key', key)
    .maybeSingle();

  if (error) {
    console.warn(`[runtime-config] read ${brand}/${key} failed: ${error.message}`);
    cacheSet(brand, key, null);
    return null;
  }
  const value = data?.value ?? null;
  cacheSet(brand, key, value);
  return value;
}

async function setLever(brand, key, value) {
  const { error } = await supabase
    .from('app_config')
    .upsert(
      { brand, key, value, updated_at: new Date().toISOString() },
      { onConflict: 'brand,key' }
    );
  if (error) throw new Error(`setLever ${brand}/${key} failed: ${error.message}`);
  cacheBust(brand, key);
}

async function clearLever(brand, key) {
  const { error } = await supabase
    .from('app_config')
    .delete()
    .eq('brand', brand)
    .eq('key', key);
  if (error) throw new Error(`clearLever ${brand}/${key} failed: ${error.message}`);
  cacheBust(brand, key);
}

// ── Brand-scoped getters ──────────────────────────────────────────────

async function getBrandTone(brand) {
  const v = await readRaw(brand, 'tone');
  if (typeof v === 'string' && v.trim()) return v;
  return defaultBrands[brand]?.tone ?? '';
}

async function getBrandMessages(brand) {
  const v = await readRaw(brand, 'messages');
  if (Array.isArray(v) && v.length) return v.filter(s => typeof s === 'string');
  return defaultBrands[brand]?.messages ?? [];
}

async function getBrandAudience(brand) {
  const v = await readRaw(brand, 'audience');
  if (typeof v === 'string' && v.trim()) return v;
  return defaultBrands[brand]?.audience ?? '';
}

async function getBrandDirective(brand) {
  // Free-form prompt addendum. Null/empty = no directive.
  const v = await readRaw(brand, 'directive');
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

async function getBrandVisualDirective(brand) {
  // Free-form steer for the visual look ("warmer palette, less corporate").
  // Generation prompts pass this to Claude alongside the theme menu so the
  // model can pick the theme that best matches the operator's intent.
  const v = await readRaw(brand, 'visual_directive');
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// ── Global getters ────────────────────────────────────────────────────

async function getActiveBrands() {
  const v = await readRaw('global', 'active_brands');
  if (Array.isArray(v) && v.length) return v.filter(s => typeof s === 'string');
  return DEFAULT_ACTIVE_BRANDS;
}

async function getHookPatterns() {
  const v = await readRaw('global', 'hook_patterns');
  if (Array.isArray(v) && v.length) return v.filter(p => p && p.label && p.body);
  return DEFAULT_HOOK_PATTERNS;
}

async function getCtaPatterns() {
  const v = await readRaw('global', 'cta_patterns');
  if (Array.isArray(v) && v.length) return v.filter(p => p && p.label && p.body);
  return DEFAULT_CTA_PATTERNS;
}

async function getTemplateWeights() {
  const v = await readRaw('global', 'template_weights');
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    // Ensure all known template types present, defaulting to 1.
    const out = { ...DEFAULT_TEMPLATE_WEIGHTS };
    for (const t of templateTypes) {
      if (typeof v[t] === 'number' && v[t] >= 0) out[t] = v[t];
    }
    return out;
  }
  return { ...DEFAULT_TEMPLATE_WEIGHTS };
}

// ── Outbound suppression-check lever ──────────────────────────────────
// Read side of the dashboard toggle (routes/dashboard/settings.js writes
// 'outbound.suppression_check_enabled' as a literal boolean). Missing
// row / null / anything-but-false ⇒ ENABLED — the safe default.

async function isSuppressionCheckEnabled() {
  const v = await readRaw('global', 'outbound.suppression_check_enabled');
  return v !== false;
}

// ── Reddit scraper subreddit list ─────────────────────────────────────
// Operator-tunable via app_config ('global','reddit.subreddits') — an
// array of subreddit names (no r/ prefix). Falls back to the scraper's
// DEFAULT_SUBREDDITS when unset.

async function getRedditSubreddits() {
  const v = await readRaw('global', 'reddit.subreddits');
  if (Array.isArray(v) && v.length && v.every(s => typeof s === 'string')) {
    return v;
  }
  return null; // caller applies its own default list
}

// ── Telegram poll offset ──────────────────────────────────────────────
// Persisted so a Railway redeploy doesn't reset getUpdates back to 0 and
// re-process old updates (duplicate approvals/prompts). cacheBust in
// setLever keeps readRaw fresh; the boot-time read is cache-cold anyway.

async function getTelegramOffset() {
  const v = await readRaw('global', 'telegram.offset');
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

async function setTelegramOffset(offset) {
  await setLever('global', 'telegram.offset', offset);
}

// ── Brand-config resolver ─────────────────────────────────────────────
//
// Returns a brand object that mirrors lib/config.js shape but with
// runtime-overridden tone/messages/audience. Anything else (colours,
// fonts, logoPath) stays from defaults — those are baked into renderer
// templates and don't belong in operator-tweakable config.

async function getResolvedBrand(brand) {
  const base = defaultBrands[brand];
  if (!base) throw new Error(`Unknown brand: ${brand}`);
  const [tone, messages, audience, directive, visualDirective] = await Promise.all([
    getBrandTone(brand),
    getBrandMessages(brand),
    getBrandAudience(brand),
    getBrandDirective(brand),
    getBrandVisualDirective(brand),
  ]);
  return { ...base, tone, messages, audience, _directive: directive, _visualDirective: visualDirective };
}

// ── Snapshot for /levers display ──────────────────────────────────────

async function loadAllLevers() {
  const { data, error } = await supabase
    .from('app_config')
    .select('brand, key, value, updated_at')
    .order('brand', { ascending: true })
    .order('key', { ascending: true });
  if (error) {
    console.warn(`[runtime-config] loadAll failed: ${error.message}`);
    return [];
  }
  return data || [];
}

// ── Helpers for adding/removing items in array-typed levers ───────────
//
// These centralise the "read existing → mutate → upsert" loop so the
// command handlers in server.js stay short. Always operate on a copy
// to avoid surprising the caller with shared references.

async function appendArrayLever(brand, key, getDefault, item) {
  const current = (await readRaw(brand, key)) ?? getDefault();
  const next = Array.isArray(current) ? [...current, item] : [item];
  await setLever(brand, key, next);
  return next;
}

async function removeArrayLever(brand, key, getDefault, indexZeroBased) {
  const current = (await readRaw(brand, key)) ?? getDefault();
  if (!Array.isArray(current)) throw new Error(`Lever ${brand}/${key} is not a list`);
  if (indexZeroBased < 0 || indexZeroBased >= current.length) {
    throw new Error(`Index ${indexZeroBased + 1} out of range (1..${current.length})`);
  }
  const next = [...current.slice(0, indexZeroBased), ...current.slice(indexZeroBased + 1)];
  await setLever(brand, key, next);
  return next;
}

// ── Pattern-specific helpers (label assignment) ───────────────────────

function nextHookLabel(existing) {
  // Hook patterns are numbered 1..N. Find max numeric label and add 1.
  let max = 0;
  for (const p of existing) {
    const n = parseInt(p.label, 10);
    if (!Number.isNaN(n) && n > max) max = n;
  }
  return String(max + 1);
}

function nextCtaLabel(existing) {
  // CTA patterns are A..Z. Find max char code and add 1, wrapping refused.
  let max = 'A'.charCodeAt(0) - 1;
  for (const p of existing) {
    if (typeof p.label === 'string' && p.label.length === 1) {
      const c = p.label.charCodeAt(0);
      if (c > max) max = c;
    }
  }
  if (max + 1 > 'Z'.charCodeAt(0)) {
    throw new Error('CTA pattern slots exhausted (A–Z full). Remove one before adding.');
  }
  return String.fromCharCode(max + 1);
}

async function addHookPattern(body) {
  const current = await getHookPatterns();
  const label = nextHookLabel(current);
  const next = [...current, { label, body }];
  await setLever('global', 'hook_patterns', next);
  return { label, count: next.length };
}

async function addCtaPattern(body) {
  const current = await getCtaPatterns();
  const label = nextCtaLabel(current);
  const next = [...current, { label, body }];
  await setLever('global', 'cta_patterns', next);
  return { label, count: next.length };
}

async function removeHookPattern(indexZeroBased) {
  const current = await getHookPatterns();
  if (indexZeroBased < 0 || indexZeroBased >= current.length) {
    throw new Error(`Index ${indexZeroBased + 1} out of range (1..${current.length})`);
  }
  const next = [...current.slice(0, indexZeroBased), ...current.slice(indexZeroBased + 1)];
  await setLever('global', 'hook_patterns', next);
  return next;
}

async function removeCtaPattern(indexZeroBased) {
  const current = await getCtaPatterns();
  if (indexZeroBased < 0 || indexZeroBased >= current.length) {
    throw new Error(`Index ${indexZeroBased + 1} out of range (1..${current.length})`);
  }
  const next = [...current.slice(0, indexZeroBased), ...current.slice(indexZeroBased + 1)];
  await setLever('global', 'cta_patterns', next);
  return next;
}

// ── Menu rendering for prompts ────────────────────────────────────────
//
// The shape Claude is told to obey lives here so any pattern edit (add,
// remove, reset) is reflected in the next prompt without touching
// generate.js.

async function renderHookMenu() {
  const patterns = await getHookPatterns();
  const lines = patterns.map(p => `${p.label}. ${p.body}`).join('\n');
  return `HOOK PATTERN MENU — pick exactly ONE that genuinely fits the available brand facts / seeds. Do NOT freestyle outside these patterns. Rotate: do not pick the same pattern as any of the recent headlines shown to you in context.\n\n${lines}`;
}

async function renderCtaMenu() {
  const patterns = await getCtaPatterns();
  const lines = patterns.map(p => `${p.label}. ${p.body}`).join('\n');
  return `CTA PATTERN MENU — pick ONE. Bare URL is forbidden. The CTA must promise something specific.\n\n${lines}`;
}

module.exports = {
  // Defaults (also used by reset commands)
  DEFAULT_HOOK_PATTERNS,
  DEFAULT_CTA_PATTERNS,
  DEFAULT_ACTIVE_BRANDS,
  DEFAULT_TEMPLATE_WEIGHTS,

  // Low-level
  setLever,
  clearLever,
  cacheClearAll,

  // Brand-scoped
  getBrandTone,
  getBrandMessages,
  getBrandAudience,
  getBrandDirective,
  getBrandVisualDirective,
  getResolvedBrand,

  // Global
  getActiveBrands,
  getHookPatterns,
  getCtaPatterns,
  getTemplateWeights,
  getTelegramOffset,
  setTelegramOffset,
  getRedditSubreddits,
  isSuppressionCheckEnabled,

  // Mutation helpers
  appendArrayLever,
  removeArrayLever,
  addHookPattern,
  addCtaPattern,
  removeHookPattern,
  removeCtaPattern,

  // Snapshot + prompt rendering
  loadAllLevers,
  renderHookMenu,
  renderCtaMenu,
};
