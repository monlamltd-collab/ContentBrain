// Authors — ghost-writer personas that ride on top of brand voice.
//
// One brand still defines audience + key messages + base tone. An author
// overlays an idiosyncratic voice (tone, mannerisms, directive) onto a
// single post. Generation picks an author at write time using weighted
// random sampling, the same way template weights work.
//
// Roaming model: an author with `brands = []` (or NULL) is eligible for
// any active brand. Scope by passing brands explicitly when creating /
// updating, e.g. `setAuthor('StoicUncle', { brands: ['auctionbrain'] })`.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// 30s in-memory cache to avoid hammering Supabase from the cron loop.
let cache = null;
let cacheFetchedAt = 0;
const TTL_MS = 30_000;

function busted() {
  cache = null;
  cacheFetchedAt = 0;
}

async function loadAuthors() {
  if (cache && Date.now() - cacheFetchedAt < TTL_MS) return cache;
  const { data, error } = await supabase
    .from('authors')
    .select('*')
    .order('name', { ascending: true });
  if (error) {
    console.warn(`[authors] load failed: ${error.message}`);
    return [];
  }
  cache = data || [];
  cacheFetchedAt = Date.now();
  return cache;
}

// ── CRUD ──────────────────────────────────────────────────────────────

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{1,29}$/;

function validateName(name) {
  if (!NAME_RE.test(name || '')) {
    throw new Error('Author name must be 2–30 chars, start with a letter, and contain only letters/digits/underscore.');
  }
}

async function createAuthor({ name, tone = null, directive = null, brands = null, weight = 1, active = true }) {
  validateName(name);
  const row = {
    name, tone, directive,
    brands: Array.isArray(brands) && brands.length ? brands : null,
    weight: Number.isFinite(+weight) && +weight >= 0 ? +weight : 1,
    active: !!active,
  };
  const { data, error } = await supabase.from('authors').insert(row).select().single();
  if (error) {
    if (error.code === '23505') throw new Error(`Author "${name}" already exists. Use /authors update or pick a new name.`);
    throw new Error(`Create author failed: ${error.message}`);
  }
  busted();
  return data;
}

async function updateAuthor(name, fields) {
  validateName(name);
  const allowed = ['tone', 'directive', 'brands', 'weight', 'active'];
  const update = { updated_at: new Date().toISOString() };
  for (const k of allowed) {
    if (k in fields) update[k] = fields[k];
  }
  if (Object.keys(update).length === 1) throw new Error('Nothing to update.');
  const { data, error } = await supabase
    .from('authors')
    .update(update)
    .eq('name', name)
    .select()
    .single();
  if (error) throw new Error(`Update author failed: ${error.message}`);
  busted();
  return data;
}

async function getAuthor(name) {
  validateName(name);
  const { data, error } = await supabase
    .from('authors')
    .select('*')
    .eq('name', name)
    .maybeSingle();
  if (error) throw new Error(`Get author failed: ${error.message}`);
  return data || null;
}

async function deleteAuthor(name) {
  validateName(name);
  const { error } = await supabase.from('authors').delete().eq('name', name);
  if (error) throw new Error(`Delete author failed: ${error.message}`);
  busted();
}

async function listAuthors() {
  return await loadAuthors();
}

// ── Picker ────────────────────────────────────────────────────────────
//
// Eligibility rules:
//   - Author must be `active`
//   - If author.brands is null/empty → eligible for every active brand
//     (roaming default)
//   - If author.brands is non-empty → must include the requested brand
//
// Returns null when no eligible author exists (callers should fall
// through to plain brand voice in that case).

async function pickAuthor(brand) {
  const all = await loadAuthors();
  const eligible = all.filter(a =>
    a.active &&
    (!a.brands || a.brands.length === 0 || a.brands.includes(brand))
  );
  if (!eligible.length) return null;

  const total = eligible.reduce((s, a) => s + (Number.isFinite(+a.weight) ? +a.weight : 0), 0);
  if (total <= 0) return null;

  let r = Math.random() * total;
  for (const a of eligible) {
    r -= +a.weight;
    if (r <= 0) return a;
  }
  return eligible[eligible.length - 1];
}

// ── Prompt overlay ────────────────────────────────────────────────────
//
// Returned snippet is appended to the system prompt produced by
// lib/generate.getSystemPrompt(). Keep it short — the brand prompt
// already establishes audience, messages and rules. The author block
// just colours how those rules get expressed.

function authorPromptBlock(author) {
  if (!author) return '';
  const lines = [
    '',
    '',
    `CURRENT GHOST-WRITER: ${author.name}`,
    'Write THIS post in this writer\'s voice while keeping the brand audience, key messages, and rules above.',
  ];
  if (author.tone) lines.push(`Voice: ${author.tone}`);
  if (author.directive) lines.push(`Directive: ${author.directive}`);
  return lines.join('\n');
}

module.exports = {
  // CRUD
  createAuthor,
  updateAuthor,
  getAuthor,
  deleteAuthor,
  listAuthors,
  // Generation hooks
  pickAuthor,
  authorPromptBlock,
  // Cache reset (used after Telegram-triggered mutation that goes via raw SQL)
  busted,
};
