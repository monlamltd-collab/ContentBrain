// Phase G — daily orchestrator. Single function the cron at server.js:1393
// calls. Decides today's mode + type, calls picker, calls copy.js, renders
// via lib/renderer.js, inserts the post row, sends to Telegram.
//
// Every other module is a leaf — orchestrator is THE control flow.
//
// Lot-of-day-traffic fast-path delegates to the existing runLotOfTheDay
// (lib/lot-flow.js) verbatim, then monkey-patches social_mode/social_type
// onto the inserted row so mode-mix counts stay accurate.
//
// Re-entry: module-level _lastRunDate gate. Pilot ships 1 post/day.

const {
  SOCIAL_MODES,
  SOCIAL_TYPES,
  SOCIAL_TYPE_LIST,
  TYPE_MODE_BIAS,
  TARGET_MONET_RATIO,
  MODE_MIX_HYSTERESIS,
  MODE_MIX_WINDOW_DAYS,
  BREAKOUT_AMPLIFY_WEIGHT,
  SOCIAL_BRAND,
  SOCIAL_PLATFORM,
  SOCIAL_CHANNEL,
  SOCIAL_TRACK,
  PUBLISH_SLOTS,
} = require('./constants');

const {
  getSocialModeCounts,
  isBreakoutActive,
  getBreakoutTags,
} = require('./helpers');

const picker = require('./picker');
const copyMod = require('./copy');

// Lazy imports — these have side effects (puppeteer, supabase client) so
// only loaded when the orchestrator actually runs.
function getRenderer() { return require('../renderer'); }
function getSupabase() { return require('../supabase'); }
function getTelegram() { return require('../telegram'); }
function getLotFlow() { return require('../lot-flow'); }

// Re-entry guard (YYYY-MM-DD)
let _lastRunDate = null;
function _today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Pure functions: decideMode / decideType / computeScheduledFor ──────

/**
 * Decide today's social mode given current rolling-7d counts.
 * @param {{monet: number, traffic: number, total: number}} counts
 * @param {object} opts  { rng?, breakoutActive?: bool, forceMode?: 'monet'|'traffic' }
 * @returns {'monet' | 'traffic'}
 */
function decideMode(counts, opts = {}) {
  const rng = opts.rng || Math.random;

  // 1. Explicit override (Telegram lever / forced re-run).
  if (opts.forceMode === SOCIAL_MODES.MONET || opts.forceMode === SOCIAL_MODES.TRAFFIC) {
    return opts.forceMode;
  }

  // 2. Breakout override — 48h window after a breakout, force monet.
  if (opts.breakoutActive) {
    return SOCIAL_MODES.MONET;
  }

  // 3. Cold-start guard — until window has >=3 posts, default to monet
  // (the desired bias direction anyway).
  if (!counts || (counts.total || 0) < 3) {
    return SOCIAL_MODES.MONET;
  }

  const ratio = counts.monet / counts.total;

  // 4. Below target → catch up via monet.
  if (ratio < TARGET_MONET_RATIO) {
    return SOCIAL_MODES.MONET;
  }

  // 5. Above target + hysteresis → correct via traffic.
  if (ratio > TARGET_MONET_RATIO + MODE_MIX_HYSTERESIS) {
    return SOCIAL_MODES.TRAFFIC;
  }

  // 6. Inside the hysteresis band → weighted random 70/30.
  return rng() < TARGET_MONET_RATIO ? SOCIAL_MODES.MONET : SOCIAL_MODES.TRAFFIC;
}

/**
 * Weighted-random pick over SOCIAL_TYPE_LIST honouring the chosen mode
 * and any active breakout amplification.
 * @param {string} mode
 * @param {Array<{type: string, niche_tag: string, weight_multiplier: number}>} breakoutTags
 * @param {object} opts  { rng?, forceType? }
 * @returns {string}  one of SOCIAL_TYPES
 */
function decideType(mode, breakoutTags = [], opts = {}) {
  const rng = opts.rng || Math.random;

  // 1. Explicit override.
  if (opts.forceType && SOCIAL_TYPE_LIST.includes(opts.forceType)) {
    return opts.forceType;
  }

  // 2. Filter candidates to those whose TYPE_MODE_BIAS matches the chosen
  // mode (or 'either').
  const candidates = SOCIAL_TYPE_LIST.filter(t => {
    const bias = TYPE_MODE_BIAS[t];
    return bias === 'either' || bias === mode;
  });

  if (!candidates.length) {
    // Should not happen — TYPE_MODE_BIAS covers every type. Fall back to
    // hero-album (the 'either' type) as a sane default.
    return SOCIAL_TYPES.HERO_ALBUM;
  }

  // 3. Base weights — uniform 1.0 per candidate.
  const weights = {};
  for (const t of candidates) weights[t] = 1.0;

  // 4. Breakout amplification — 2x weight on matching types.
  for (const bt of breakoutTags) {
    if (weights[bt.type] != null) {
      weights[bt.type] *= bt.weight_multiplier || BREAKOUT_AMPLIFY_WEIGHT;
    }
  }

  // 5. Weighted random pick.
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (const [type, w] of Object.entries(weights)) {
    r -= w;
    if (r <= 0) return type;
  }
  return candidates[candidates.length - 1];
}

/**
 * Compute today's scheduled_for ISO timestamp from PUBLISH_SLOTS.
 * Pilot uses slot 0 (09:00); future ramp uses slot 1 too (17:00).
 * @param {number} slotIndex  default 0
 * @returns {string}
 */
function computeScheduledFor(slotIndex = 0) {
  const slot = PUBLISH_SLOTS[slotIndex] || PUBLISH_SLOTS[0];
  const d = new Date();
  d.setUTCHours(slot.hour, slot.minute, 0, 0);
  // If the slot has already passed today, schedule for now+1min so the
  // 15-min publish cron picks it up on the next tick. Don't push to
  // tomorrow — pilot is 1/day and operators expect a same-day publish.
  if (d.getTime() <= Date.now()) {
    return new Date(Date.now() + 60_000).toISOString();
  }
  return d.toISOString();
}

// ── Boost-eligibility (pure function, no I/O) ──────────────────────────

/**
 * @param {object} args  { mode, type, meta, copy, pickResult }
 * @returns {boolean}
 */
function isBoostEligible({ mode, type, meta, copy, pickResult }) {
  // Traffic mode → no boosting of CTA-heavy posts (decision rule).
  if (mode !== SOCIAL_MODES.MONET) return false;
  // Must have a niche tag.
  const tag = (pickResult && pickResult.meta_payload && pickResult.meta_payload.niche_tag)
    || (meta && meta.niche_tag);
  if (!tag) return false;
  // Must have an image (single or album).
  const hasImage = !!(meta && (meta.album_images || meta.lot_image_url || meta.hero_image_url));
  const hasCopyImage = !!(copy && copy.filterBlocks); // proxy: if copy ran and filter passed, OK
  if (!hasImage && !hasCopyImage) {
    // Not necessarily fatal — niche-hook always has hero from picker, but
    // be conservative: require explicit image surface on the post meta.
    return !!(pickResult && pickResult.visual_hints && pickResult.visual_hints.hero_image_url);
  }
  return true;
}

// ── Template selection per type ────────────────────────────────────────

function templateNameForType(type) {
  switch (type) {
    case SOCIAL_TYPES.HERO_ALBUM:        return 'social-engine/hero-album';
    case SOCIAL_TYPES.NICHE_HOOK:        return 'social-engine/niche-hook';
    case SOCIAL_TYPES.REGIONAL_ROUNDUP:  return 'social-engine/regional-roundup';
    case SOCIAL_TYPES.CURIOSITY_GAP:     return 'social-engine/curiosity-gap';
    case SOCIAL_TYPES.DATA_SHOCK:        return 'social-engine/data-shock';
    // lot-of-day-traffic + superlative-reel delegate elsewhere
    default:
      return null;
  }
}

// ── Main entry ─────────────────────────────────────────────────────────

/**
 * Daily entry. Decides what to post today, renders it, inserts a draft
 * post, sends to Telegram. Returns the inserted post row.
 *
 * @param {object} opts
 *   - forceType: SOCIAL_TYPES value (override mode-mix selection)
 *   - forceArchetype: string (passed through to runLotOfTheDay when type
 *     is lot-of-day-traffic)
 *   - forceMode: 'monet'|'traffic' (override mode-mix balance)
 *   - dryRun: bool (skip insert + Telegram; return proposed pick + copy)
 *   - force: bool (bypass _lastRunDate gate — for manual reruns)
 * @returns {Promise<{post: object, decisions: object}>}
 */
async function runDailySocialPost(opts = {}) {
  // 1. Re-entry guard.
  const today = _today();
  if (_lastRunDate === today && !opts.force) {
    console.log(`[social-engine] runDailySocialPost: already ran ${today}, skipping`);
    return { post: null, decisions: { skipped: 'already_ran' } };
  }

  // 2. Resolve mode.
  let counts = { monet: 0, traffic: 0, total: 0 };
  try {
    counts = await getSocialModeCounts(MODE_MIX_WINDOW_DAYS);
  } catch (err) {
    console.warn(`[social-engine] mode-mix count failed: ${err.message}`);
  }
  const breakoutActive = await isBreakoutActive().catch(() => false);
  const mode = decideMode(counts, { breakoutActive, forceMode: opts.forceMode });

  // 3. Resolve breakout amplification tags (PR2 stub = []).
  const breakoutTags = await getBreakoutTags().catch(() => []);

  // 4. Resolve type.
  const type = decideType(mode, breakoutTags, { forceType: opts.forceType });
  console.log(`[social-engine] decisions: mode=${mode} type=${type} (counts ${counts.monet}m/${counts.traffic}t/${counts.total}total)`);

  // 5. Lot-of-day fast path — delegate to existing runLotOfTheDay.
  if (type === SOCIAL_TYPES.LOT_OF_DAY_TRAFFIC) {
    const { runLotOfTheDay } = getLotFlow();
    const post = await runLotOfTheDay({ forceArchetype: opts.forceArchetype });

    // Stamp social_mode / social_type on the inserted row so mode-mix
    // counts stay accurate. Lot-flow doesn't know about Phase G fields.
    try {
      const { supabase } = getSupabase();
      const updatedMeta = { ...(post.meta || {}), social_mode: SOCIAL_MODES.TRAFFIC, social_type: SOCIAL_TYPES.LOT_OF_DAY_TRAFFIC };
      await supabase.from('posts').update({ track: SOCIAL_TRACK, meta: updatedMeta }).eq('id', post.id);
    } catch (err) {
      console.warn(`[social-engine] post-insert mode/type stamp failed for ${post.id}: ${err.message}`);
    }

    _lastRunDate = today;
    return { post, decisions: { mode, type, niche_tag: null, delegated: 'lot-of-day' } };
  }

  // 6. Pick.
  let pickResult;
  try {
    pickResult = await picker.pickForType(type, opts);
  } catch (err) {
    // Fall back to lot-of-day-traffic (always has candidates).
    console.warn(`[social-engine] picker failed for ${type}: ${err.message} — falling back to lot-of-day-traffic`);
    return runDailySocialPost({ ...opts, forceType: SOCIAL_TYPES.LOT_OF_DAY_TRAFFIC, force: true });
  }

  // 7. Copy.
  let copy;
  try {
    copy = await copyMod.generateSocialCopy({
      socialType: type,
      socialMode: mode,
      pick: pickResult.pick,
      meta_payload: pickResult.meta_payload,
      visual_hints: pickResult.visual_hints,
    });
  } catch (err) {
    // Filter-retry exhaustion → Telegram alert + abort the day.
    console.error(`[social-engine] copy generation failed: ${err.message}`);
    try {
      const { sendNotification } = getTelegram();
      const blocks = Array.isArray(err.blocks) ? err.blocks.map(b => `- ${b.rule || '?'}: ${b.reason || ''}`).join('\n') : '';
      await sendNotification(`<b>Phase G copy failed</b> for ${type}/${mode}:\n${err.message}\n${blocks}`.slice(0, 1800));
    } catch {}
    _lastRunDate = today;
    throw err;
  }

  // 8. Render.
  let renderedFilenames = [];
  const templateName = templateNameForType(type);
  const renderer = getRenderer();

  if (opts.dryRun) {
    return { post: null, decisions: { mode, type, niche_tag: pickResult.meta_payload.niche_tag || null, copy, pickResult, dryRun: true } };
  }

  if (templateName) {
    // Album vs single-image rendering decision.
    const isMultiFrame = (type === SOCIAL_TYPES.HERO_ALBUM || type === SOCIAL_TYPES.REGIONAL_ROUNDUP);
    if (isMultiFrame) {
      const frames = (pickResult.pick && Array.isArray(pickResult.pick.lots) && pickResult.pick.lots.length) || 1;
      const frameCount = Math.min(Math.max(frames, 1), 5);
      // Build frame_data array from pickResult.pick.lots for the renderer
      const frameData = (pickResult.pick.lots || []).slice(0, frameCount).map(l => ({
        lot_image_url: l.image_url,
        address_line: l.address || '',
        price_text: l.price ? `Guide £${Math.round(l.price).toLocaleString('en-GB')}` : '',
        key_fact: l.est_gross_yield ? `${Number(l.est_gross_yield).toFixed(1)}% est. yield` : (l.below_market ? `${l.below_market}% below market` : ''),
        caption: '',
      }));
      const renderPost = {
        copy_headline: copy.copy_headline,
        copy_body: copy.copy_body,
        copy_cta: copy.copy_cta,
        platform: SOCIAL_PLATFORM,
        meta: {
          ...(copy.meta_additions || {}),
          niche_tag: pickResult.meta_payload.niche_tag,
          niche_tag_label: (pickResult.visual_hints && pickResult.visual_hints.niche_tag_label) || null,
          follow_prompt: copy.follow_prompt,
          frame_data: frameData,
        },
        visual_hints: pickResult.visual_hints || {},
      };
      renderedFilenames = await renderer.renderAlbum(templateName, SOCIAL_BRAND, renderPost, frameCount);
    } else {
      const renderPost = {
        copy_headline: copy.copy_headline,
        copy_body: copy.copy_body,
        copy_cta: copy.copy_cta,
        platform: SOCIAL_PLATFORM,
        meta: {
          ...(copy.meta_additions || {}),
          niche_tag: pickResult.meta_payload.niche_tag,
          niche_tag_label: (pickResult.visual_hints && pickResult.visual_hints.niche_tag_label) || null,
          follow_prompt: copy.follow_prompt,
          micro_stat: copy.meta_additions && copy.meta_additions.micro_stat,
          micro_caption: copy.meta_additions && copy.meta_additions.micro_caption,
        },
        visual_hints: pickResult.visual_hints || {},
      };
      const { filename } = await renderer.renderPost(templateName, SOCIAL_BRAND, renderPost);
      renderedFilenames = [filename];
    }
  }

  // 9. Boost-eligibility decision.
  const boost_eligible = isBoostEligible({ mode, type, meta: pickResult.meta_payload, copy, pickResult });

  // 10. Insert.
  const { insertPost } = getSupabase();
  const insertPayload = {
    brand: SOCIAL_BRAND,
    platform: SOCIAL_PLATFORM,
    channel: SOCIAL_CHANNEL,
    track: SOCIAL_TRACK,
    template_type: type,
    copy_headline: copy.copy_headline,
    copy_body: copy.copy_body,
    copy_cta: copy.copy_cta,
    image_url: renderedFilenames[0] || null,
    video_url: null,
    status: 'draft',
    scheduled_for: computeScheduledFor(0),
    meta: {
      // Phase G discriminators
      social_mode: mode,
      social_type: type,
      niche_tag: pickResult.meta_payload.niche_tag || null,
      region_slug: pickResult.meta_payload.region_slug || null,

      // Multi-image / album support (read by publish.js extension)
      album_images: renderedFilenames.length > 1 ? renderedFilenames : null,

      // Lot reference(s)
      lot_id: pickResult.meta_payload.lot_id || null,
      lot_ids: pickResult.meta_payload.lot_ids || null,

      // Copywriter outputs
      follow_prompt: copy.follow_prompt || null,
      caption_facebook: copy.caption_facebook,
      visual_style: copy.visual_style,
      micro_stat: (copy.meta_additions && copy.meta_additions.micro_stat) || null,
      micro_caption: (copy.meta_additions && copy.meta_additions.micro_caption) || null,

      // Audit trail (Part 12 — filter_pass)
      filter_pass: true,
      filter_warnings: (copy.filterBlocks || []).filter(b => b.severity === 'warn'),

      // Boost
      boost_eligible,

      // Author overlay bypass (single-voice page)
      author: null,
    },
  };

  const post = await insertPost(insertPayload);
  console.log(`[social-engine] inserted post ${post.id} (${type}/${mode}, boost_eligible=${boost_eligible})`);

  // 11. Telegram review.
  try {
    const { sendPostForReview } = getTelegram();
    await sendPostForReview(post);
  } catch (err) {
    console.warn(`[social-engine] sendPostForReview failed for ${post.id}: ${err.message}`);
  }

  // 12. Stamp re-entry gate.
  _lastRunDate = today;

  return {
    post,
    decisions: {
      mode,
      type,
      niche_tag: pickResult.meta_payload.niche_tag || null,
      boost_eligible,
    },
  };
}

// Test hook — reset the re-entry guard.
function _resetLastRunDate() {
  _lastRunDate = null;
}

module.exports = {
  runDailySocialPost,
  decideMode,
  decideType,
  computeScheduledFor,
  isBoostEligible,
  templateNameForType,
  _resetLastRunDate,
};
