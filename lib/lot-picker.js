require('dotenv').config();
const { findLotsByArchetype, hasFeaturedLot, supabase } = require('./supabase');

// Mon→Sun rotation (Mon=0 .. Sun=6). Override at runtime via app_config:
//   brand='global', key='lot_archetype_schedule', value=[7 archetype strings].
const DEFAULT_SCHEDULE = [
  'best-yield',
  'deepest-discount',
  'dev-or-refurb',
  'urgent',
  'best-yield',
  'deepest-discount',
  'urgent'
];

const ARCHETYPES = ['best-yield', 'deepest-discount', 'dev-or-refurb', 'urgent'];

const PLACEHOLDER_IMAGE_HOSTS = new Set(['example.com', 'placeholder.com', 'placehold.co']);

function isUsableImage(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return false;
    if (PLACEHOLDER_IMAGE_HOSTS.has(u.hostname.replace(/^www\./, ''))) return false;
    return true;
  } catch {
    return false;
  }
}

async function getScheduleForToday() {
  let schedule = DEFAULT_SCHEDULE;
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('brand', 'global')
      .eq('key', 'lot_archetype_schedule')
      .maybeSingle();
    if (!error && Array.isArray(data?.value) && data.value.length === 7
        && data.value.every(s => ARCHETYPES.includes(s))) {
      schedule = data.value;
    }
  } catch (err) {
    console.warn(`[lot-picker] schedule lookup failed: ${err.message}`);
  }

  const jsDay = new Date().getDay();   // 0=Sun .. 6=Sat
  const monFirst = (jsDay + 6) % 7;    // 0=Mon .. 6=Sun
  return { archetype: schedule[monFirst], schedule, dayIndex: monFirst };
}

/**
 * Pick today's Lot of the Day.
 *
 * 1. Try today's scheduled archetype. Skip lots with placeholder images or
 *    that have been featured in the last 60 days.
 * 2. If empty, fall through the other archetypes in the canonical ARCHETYPES
 *    order until a candidate is found.
 * 3. If still nothing, throw. Caller logs and skips the day.
 */
async function pickLotOfTheDay() {
  const { archetype: primary } = await getScheduleForToday();
  const tryOrder = [primary, ...ARCHETYPES.filter(a => a !== primary)];

  for (const archetype of tryOrder) {
    const candidates = await findLotsByArchetype(archetype, { limit: 30 });
    for (const lot of candidates) {
      if (!isUsableImage(lot.image_url)) continue;
      // eslint-disable-next-line no-await-in-loop
      if (await hasFeaturedLot(lot.id)) continue;
      return { lot, archetype, fallbackUsed: archetype !== primary };
    }
  }

  throw new Error('No qualifying Lot-of-the-Day candidate across any archetype today.');
}

module.exports = { pickLotOfTheDay, getScheduleForToday, isUsableImage, DEFAULT_SCHEDULE, ARCHETYPES };
