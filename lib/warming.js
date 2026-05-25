require('dotenv').config();

// ── Warming ramp (Phase B follow-up) ─────────────────────────────────────
//
// New sending domains start cold. Even with perfect SPF/DKIM/DMARC, ISPs
// throttle a domain that goes from 0 to 200 emails/day overnight — they
// can't tell us from a spammer. Convention is a 30-day ramp: start at
// ~10/day, step up every few days, level out at the steady-state cap.
//
// State lives in `app_config` (brand='global'):
//   outbound.warming.<track>.start_date  → ISO date the track started
//   outbound.warming.<track>.steady_cap  → override the final cap (default 300)
//
// The start_date is set lazily on first call to `getCurrentCap` if missing,
// so the cron doesn't need a separate "init" path. Reading day-since-start
// from app_config (not env) means cap state survives Railway redeploys.
//
// The schedule is hard-coded because it's deliberately conservative — the
// last thing we want is a Telegram edit lifting the cap on day 2.
// Override `steady_cap` if 300/day isn't right for the steady state.

const { supabase } = require('./supabase');
const { assertTrack } = require('./sales-brain/constants');

// (daysSinceStart, cap)  -  applied as the FIRST band whose threshold is >= day.
const SCHEDULE = [
  { upTo: 2,   cap: 10  },   // days 0-2  ramp-start
  { upTo: 6,   cap: 25  },   // days 3-6
  { upTo: 13,  cap: 50  },   // days 7-13
  { upTo: 20,  cap: 100 },   // days 14-20
  { upTo: 29,  cap: 200 },   // days 21-29
];
const DEFAULT_STEADY_CAP = 300;

function capForDay(day, steadyCap = DEFAULT_STEADY_CAP) {
  for (const band of SCHEDULE) {
    if (day <= band.upTo) return band.cap;
  }
  return steadyCap;
}

// Read a single app_config row keyed on (brand='global', key=key).
// Returns the value (parsed JSON) or null when absent.
async function readConfig(key) {
  const { data, error } = await supabase
    .from('app_config')
    .select('value')
    .eq('brand', 'global')
    .eq('key', key)
    .maybeSingle();
  if (error) {
    throw new Error(`warming: app_config read failed for ${key}: ${error.message}`);
  }
  return data ? data.value : null;
}

async function writeConfig(key, value) {
  const { error } = await supabase
    .from('app_config')
    .upsert(
      { brand: 'global', key, value, updated_at: new Date().toISOString(), updated_by: 'warming' },
      { onConflict: 'brand,key' }
    );
  if (error) {
    throw new Error(`warming: app_config write failed for ${key}: ${error.message}`);
  }
}

function daysBetween(fromIso, toDate = new Date()) {
  const from = new Date(fromIso);
  if (isNaN(from.getTime())) throw new Error(`warming: invalid start_date '${fromIso}'`);
  const ms = toDate.getTime() - from.getTime();
  return Math.floor(ms / (24 * 60 * 60 * 1000));
}

/**
 * Today's send cap for the given track. Sets start_date to today on first
 * call so the ramp begins the day a track first sends, not at code deploy.
 *
 * @param {string} track  one of VALID_TRACKS (lender|broker|auction_house)
 * @returns {Promise<{cap: number, day: number, startDate: string}>}
 */
async function getCurrentCap(track) {
  assertTrack(track);

  const startKey = `outbound.warming.${track}.start_date`;
  const steadyKey = `outbound.warming.${track}.steady_cap`;

  let startVal = await readConfig(startKey);
  if (!startVal) {
    const today = new Date().toISOString().slice(0, 10);
    await writeConfig(startKey, today);
    startVal = today;
    console.log(`[warming] ${track}: initialised start_date=${today}`);
  }

  // start_date is stored as a JSON string '2026-05-25'.
  const startDate = typeof startVal === 'string' ? startVal : String(startVal);
  const steadyVal = await readConfig(steadyKey);
  const steadyCap = (typeof steadyVal === 'number' && steadyVal > 0) ? steadyVal : DEFAULT_STEADY_CAP;

  const day = daysBetween(startDate);
  const cap = capForDay(day, steadyCap);
  return { cap, day, startDate };
}

/**
 * Remaining send budget for the track today: cap - count_published_today.
 * Used by `publishToResend` to decide whether to send or defer.
 *
 * @param {string} track
 * @returns {Promise<{remaining: number, cap: number, sentToday: number, day: number}>}
 */
async function getRemainingBudget(track) {
  const { cap, day } = await getCurrentCap(track);

  // Count outbound posts already published today on this track. UTC day
  // boundary — matches Postgres `now() AT TIME ZONE 'utc'` semantics.
  const startOfToday = new Date();
  startOfToday.setUTCHours(0, 0, 0, 0);

  const { count, error } = await supabase
    .from('posts')
    .select('id', { count: 'exact', head: true })
    .eq('track', track)
    .eq('channel', 'resend')
    .eq('status', 'published')
    .gte('published_at', startOfToday.toISOString());
  if (error) {
    throw new Error(`warming: count published-today failed for ${track}: ${error.message}`);
  }

  const sentToday = count || 0;
  const remaining = Math.max(0, cap - sentToday);
  return { remaining, cap, sentToday, day };
}

/**
 * Convenience: pause the warming ramp for a track. Useful if a deliverability
 * incident hits — Simon can /pause-warming lender from Telegram and the cron
 * stops sending until /resume-warming. Storage: app_config flag.
 */
async function pauseTrack(track) {
  assertTrack(track);
  await writeConfig(`outbound.warming.${track}.paused`, true);
  console.log(`[warming] ${track}: PAUSED`);
}

async function resumeTrack(track) {
  assertTrack(track);
  await writeConfig(`outbound.warming.${track}.paused`, false);
  console.log(`[warming] ${track}: RESUMED`);
}

async function isPaused(track) {
  assertTrack(track);
  const v = await readConfig(`outbound.warming.${track}.paused`);
  return v === true;
}

module.exports = {
  SCHEDULE,
  DEFAULT_STEADY_CAP,
  capForDay,
  getCurrentCap,
  getRemainingBudget,
  pauseTrack,
  resumeTrack,
  isPaused,
  // Exposed for tests:
  _internals: { readConfig, writeConfig, daysBetween },
};
