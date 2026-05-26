require('dotenv').config();

// ── Sequence engine (Phase C) ─────────────────────────────────────────────
//
// Owns the lifecycle of a `sequences` row (migration 011) — creation on the
// first successful publish, follow-up generation on each cron tick, and the
// terminal transitions driven by reply intents / bounces / suppression hits.
//
// Full state machine + design rationale: .ruflo/phase-c-design.md §1.
//
// Key decisions enforced here:
//   - Sequence row created on publish-success of step 1, NOT on approval.
//   - `current_step` advances only on publish-success (via
//     bumpSequenceOnSendSuccess), never at generate/approval time.
//   - Terminal transitions clear next_scheduled_at so the cron skips them.
//   - `ended_reason` is application-enforced (constants.js, no SQL CHECK).
//   - Follow-up intervals overridable per-track via app_config (see
//     getFollowupIntervals — same Telegram-lever pattern as getOutboundTone).
//
// House style: lazy-load supabase + sibling libs to keep the module tree
// requireable from test isolates; British English in user-facing log strings.

const { supabase } = require('./supabase');
const { assertTrack, assertEndedReason } = require('./sales-brain/constants');

// Follow-up offsets in DAYS, indexed by the step we JUST sent.
//   - step 1 sent → wait 3 days  → send step 2
//   - step 2 sent → wait 7 days  → send step 3 (= +10d from step 1)
//   - step 3 sent → wait 14 days → send step 4 (= +24d from step 1)
//   - step 4 sent → no next     → status='completed', next_scheduled_at=NULL
//
// Static default. Runtime override comes from app_config (see
// getFollowupIntervals below) — Simon can /lever set outbound.followup_intervals.lender=[2,5,10]
// to compress the cadence without a redeploy.
const FOLLOWUP_INTERVALS = Object.freeze([3, 7, 14]);

// Final cold-open step. After this, the sequence is `completed`.
const MAX_STEP = 4;

// ── Runtime override for follow-up intervals ─────────────────────────────
//
// Same Telegram-lever pattern as `getOutboundTone` in generate-outbound.js:
// loadAllLevers() scan, filter to `brand='global'`, `key='outbound.followup_intervals.<track>'`.
// Falls back to FOLLOWUP_INTERVALS on any failure or unreadable shape.
let _runtimeConfig = null;
function getRuntimeConfig() {
  if (!_runtimeConfig) _runtimeConfig = require('./runtime-config');
  return _runtimeConfig;
}

async function getFollowupIntervals(track) {
  const key = `outbound.followup_intervals.${track}`;
  try {
    const all = await getRuntimeConfig().loadAllLevers();
    const row = all.find(r => r.brand === 'global' && r.key === key);
    if (row && Array.isArray(row.value) && row.value.length === 3) {
      const arr = row.value.map(n => parseInt(n, 10));
      if (arr.every(n => Number.isFinite(n) && n > 0)) {
        return Object.freeze(arr);
      }
      console.warn(`[sequence] ignoring invalid ${key}=${JSON.stringify(row.value)} — using default`);
    }
  } catch (err) {
    console.warn(`[sequence] follow-up interval lookup for ${key} failed: ${err.message}`);
  }
  return FOLLOWUP_INTERVALS;
}

// Helper: compute next_scheduled_at given the step we JUST sent + intervals.
// Returns ISO string or null (when the sent step is the terminal step).
function computeNextScheduledAt(stepSent, intervals) {
  if (stepSent >= MAX_STEP) return null;
  const days = intervals[stepSent - 1];
  if (!Number.isFinite(days)) return null;
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Create a fresh `sequences` row on step-1 publish-success.
 * Idempotent — returns the existing row if one is already active/paused
 * (migration 011 partial unique index would block the insert anyway).
 *
 * @param {object} post     the posts row that just published
 * @param {object} contact  the contacts row the post was sent to
 * @param {object} prospect the prospects row (unused here; kept for symmetry)
 * @returns {Promise<{id: string|null, current_step: number, status: string, created: boolean}>}
 */
async function createSequenceOnPublish(post, contact, prospect) {
  if (!post || !post.id) throw new Error('createSequenceOnPublish: post.id required');
  if (!contact || !contact.id) throw new Error('createSequenceOnPublish: contact.id required');

  const meta = (post && post.meta) || {};
  const track = meta.track || post.track;
  assertTrack(track);

  // Idempotency: is there already an active/paused sequence for this
  // (contact, track)? Migration 011's partial unique index would block a
  // duplicate insert anyway; we look first so we can return a clean signal
  // to the caller without 23505 noise in the logs.
  const { data: existing, error: existErr } = await supabase
    .from('sequences')
    .select('id, current_step, status')
    .eq('contact_id', contact.id)
    .eq('track', track)
    .in('status', ['active', 'paused'])
    .maybeSingle();
  if (existErr) {
    throw new Error(`createSequenceOnPublish: existing-row check failed: ${existErr.message}`);
  }
  if (existing) {
    console.log(`[sequence] existing ${existing.status} sequence ${existing.id} for contact ${contact.id} track ${track} — skipping create`);
    return { id: existing.id, current_step: existing.current_step, status: existing.status, created: false };
  }

  const intervals = await getFollowupIntervals(track);
  const now = new Date();
  const nextAt = new Date(now.getTime() + intervals[0] * 24 * 60 * 60 * 1000);

  const row = {
    contact_id: contact.id,
    track,
    current_step: 1,
    status: 'active',
    last_sent_at: now.toISOString(),
    next_scheduled_at: nextAt.toISOString(),
  };

  const { data: inserted, error } = await supabase
    .from('sequences')
    .insert(row)
    .select('id, current_step, status')
    .single();
  if (error) {
    // 23505 — race with another publish path. Treat as no-op.
    if (error.code === '23505') {
      console.log(`[sequence] race-inserted by another writer for contact ${contact.id} track ${track} — no-op`);
      return { id: null, current_step: 1, status: 'active', created: false };
    }
    throw new Error(`createSequenceOnPublish: insert failed: ${error.message}`);
  }

  console.log(`[sequence] created sequence ${inserted.id} (contact ${contact.id} track ${track} step 1, next +${intervals[0]}d)`);
  return { id: inserted.id, current_step: 1, status: 'active', created: true };
}

/**
 * Generate the next step's draft + dispatch to Telegram. Cron entry point
 * when `next_scheduled_at` arrives. Does NOT advance current_step — that
 * happens on send success via bumpSequenceOnSendSuccess.
 *
 * @param {string} sequenceId
 * @returns {Promise<{ok: boolean, nextStep: number, queuedPostId: string|null, completed: boolean}>}
 */
async function advanceSequence(sequenceId) {
  if (!sequenceId) throw new Error('advanceSequence: sequenceId required');

  const { data: seq, error: seqErr } = await supabase
    .from('sequences')
    .select('id, contact_id, track, current_step, status')
    .eq('id', sequenceId)
    .maybeSingle();
  if (seqErr) throw new Error(`advanceSequence: load failed: ${seqErr.message}`);
  if (!seq) throw new Error(`advanceSequence: no sequence with id ${sequenceId}`);
  if (seq.status !== 'active') {
    console.warn(`[sequence] advanceSequence: ${sequenceId} not active (${seq.status}) — skipping`);
    return { ok: false, nextStep: seq.current_step, queuedPostId: null, completed: false };
  }

  const nextStep = seq.current_step + 1;
  if (nextStep > MAX_STEP) {
    // Already at the terminal step — flip to completed (defensive — the
    // bump path normally handles this).
    await completeSequence(sequenceId, 'completed');
    return { ok: true, nextStep: seq.current_step, queuedPostId: null, completed: true };
  }

  // Load contact + prospect for generateOutbound.
  const { data: contact, error: cErr } = await supabase
    .from('contacts')
    .select('id, name, role, email, prospect_id, prospect:prospects!inner ( id, type, company_name, website, metadata )')
    .eq('id', seq.contact_id)
    .maybeSingle();
  if (cErr) throw new Error(`advanceSequence: contact load failed: ${cErr.message}`);
  if (!contact || !contact.prospect) {
    throw new Error(`advanceSequence: contact or prospect missing for sequence ${sequenceId}`);
  }
  const prospect = contact.prospect;

  // Lazy-require generator — keeps Anthropic env-validation off the load
  // path when this module is required by tests.
  const { generateOutbound } = require('./generate-outbound');
  const generated = await generateOutbound(
    seq.track,
    { id: contact.id, name: contact.name, role: contact.role, email: contact.email, prospect_id: prospect.id },
    prospect,
    nextStep
  );

  // Insert a draft post with full meta so publishToResend can find its way
  // back to the sequence row + contact when Simon approves.
  const postRow = {
    brand: 'bridgematch',
    template_type: 'outbound',
    status: 'draft',
    track: 'outbound',
    channel: 'resend',
    platform: null,
    copy_headline: generated.subject,
    copy_body: generated.body,
    copy_cta: '',
    meta: {
      track: seq.track,
      contact_id: contact.id,
      prospect_id: prospect.id,
      contact_email: contact.email,
      contact_name: contact.name,
      company_name: prospect.company_name,
      sequence_id: sequenceId,
      sequence_step: nextStep,
      contact: { id: contact.id, name: contact.name, role: contact.role, email: contact.email, prospect_id: prospect.id },
      prospect: { id: prospect.id, type: prospect.type, company_name: prospect.company_name, website: prospect.website, metadata: prospect.metadata },
      generated_reasoning: generated.reasoning,
    },
  };

  const { data: inserted, error: insErr } = await supabase
    .from('posts')
    .insert(postRow)
    .select()
    .single();
  if (insErr) {
    throw new Error(`advanceSequence: post insert failed: ${insErr.message}`);
  }

  // Push to Telegram for human approval. Re-uses the outbound-approve
  // callback path from queue-lender-batch.js.
  try {
    await sendOutboundForReview(inserted);
  } catch (err) {
    // Don't roll back — the post is queued in DB and visible in Pipeline tab
    // even if Telegram fails. Log loudly.
    console.warn(`[sequence] Telegram dispatch failed for post ${inserted.id}: ${err.message}`);
  }

  console.log(`[sequence] queued step ${nextStep} for sequence ${sequenceId} (post ${inserted.id})`);
  return { ok: true, nextStep, queuedPostId: inserted.id, completed: false };
}

/**
 * Telegram dispatch for an outbound post awaiting review. Mirrors the
 * cb:outbound-approve callback path used by scripts/queue-lender-batch.js.
 * Silently skipped when Telegram env is absent (dev/test).
 */
async function sendOutboundForReview(post) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('[sequence] Telegram not configured — review queue skipped');
    return;
  }

  const meta = post.meta || {};
  const stepNote = meta.sequence_step ? ` (step ${meta.sequence_step})` : '';
  const caption = [
    `<b>${(meta.track || '').toUpperCase()} OUTBOUND${stepNote}</b> — ${meta.company_name || '?'}`,
    `to: ${meta.contact_name || ''} &lt;${meta.contact_email}&gt;`,
    '',
    `<b>${post.copy_headline}</b>`,
    '',
    post.copy_body,
  ].join('\n');

  const buttons = {
    inline_keyboard: [[
      { text: 'Approve & send', callback_data: `cb:outbound-approve:${post.id}` },
      { text: 'Reject',         callback_data: `cb:outbound-reject:${post.id}` },
    ]],
  };

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: caption, parse_mode: 'HTML', reply_markup: buttons }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Telegram sendMessage failed (${res.status}): ${err.slice(0, 200)}`);
  }
}

/**
 * Active sequences whose next_scheduled_at <= now. Joined with contacts +
 * prospects; ASC on next_scheduled_at (oldest-due first).
 *
 * @returns {Promise<Array<object>>}
 */
async function getDueSequences() {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('sequences')
    .select(`
      id, contact_id, track, current_step, status, next_scheduled_at, last_sent_at,
      contact:contacts!inner (
        id, name, role, email, prospect_id,
        prospect:prospects!inner ( id, type, company_name, website, metadata )
      )
    `)
    .eq('status', 'active')
    .lt('current_step', MAX_STEP)
    .lte('next_scheduled_at', nowIso)
    .order('next_scheduled_at', { ascending: true });
  if (error) throw new Error(`getDueSequences failed: ${error.message}`);

  // Flatten nested prospect onto contact for caller convenience.
  return (data || []).map(row => ({
    id: row.id,
    contact_id: row.contact_id,
    track: row.track,
    current_step: row.current_step,
    status: row.status,
    next_scheduled_at: row.next_scheduled_at,
    last_sent_at: row.last_sent_at,
    contact: row.contact ? { id: row.contact.id, name: row.contact.name, email: row.contact.email, role: row.contact.role, prospect_id: row.contact.prospect_id } : null,
    prospect: row.contact && row.contact.prospect ? row.contact.prospect : null,
  }));
}

// ── Terminal/transition helpers ──────────────────────────────────────────
//
// Each public helper validates its ended_reason and delegates to
// _setStatus. None touches suppression — the caller (handleInboundEmail /
// webhook handlers) owns suppression writes.

async function _setStatus(id, status, reason, label) {
  if (!id) throw new Error(`${label}: id required`);
  assertEndedReason(reason);
  const { error } = await supabase
    .from('sequences')
    .update({ status, ended_reason: reason, next_scheduled_at: null })
    .eq('id', id);
  if (error) throw new Error(`${label} ${id} failed: ${error.message}`);
  console.log(`[sequence] ${status} ${id} (${reason})`);
  return { ok: true };
}

/** Pause — status='paused'. Can later resume manually. */
async function pauseSequence(id, reason) {
  return _setStatus(id, 'paused', reason, 'pauseSequence');
}

/** Complete — terminal, no resume. step 4 ok / not_interested / wrong_person. */
async function completeSequence(id, reason) {
  return _setStatus(id, 'completed', reason, 'completeSequence');
}

/** Opt-out — terminal. Reply intent unsubscribe / list-unsubscribe hit. */
async function optOutSequence(id) {
  return _setStatus(id, 'opted_out', 'unsubscribe', 'optOutSequence');
}

/** Bounce — terminal. email.bounced webhook on this sequence's resend_id. */
async function bounceSequence(id, reason = 'bounced') {
  return _setStatus(id, 'bounced', reason, 'bounceSequence');
}

/**
 * Multi-contact company pause for hostile/complaint replies (brief §5.115).
 * Pauses every active sequence at the prospect, optionally skipping the
 * triggering sequence.
 *
 * @param {string} prospectId
 * @param {string} reason             ended_reason (typically 'hostile_pause')
 * @param {string} [excludeSequenceId]
 * @returns {Promise<{paused: number, ids: string[]}>}
 */
async function pauseSiblingsForCompany(prospectId, reason, excludeSequenceId) {
  if (!prospectId) throw new Error('pauseSiblingsForCompany: prospectId required');
  assertEndedReason(reason);

  // Find all contacts at this prospect, then their active sequences.
  const { data: contacts, error: cErr } = await supabase
    .from('contacts')
    .select('id')
    .eq('prospect_id', prospectId);
  if (cErr) throw new Error(`pauseSiblingsForCompany: contact load failed: ${cErr.message}`);
  const contactIds = (contacts || []).map(c => c.id);
  if (!contactIds.length) return { paused: 0, ids: [] };

  let query = supabase
    .from('sequences')
    .select('id')
    .in('contact_id', contactIds)
    .eq('status', 'active');
  if (excludeSequenceId) query = query.neq('id', excludeSequenceId);

  const { data: siblings, error: sErr } = await query;
  if (sErr) throw new Error(`pauseSiblingsForCompany: sibling load failed: ${sErr.message}`);
  const siblingIds = (siblings || []).map(s => s.id);
  if (!siblingIds.length) return { paused: 0, ids: [] };

  const { error: upErr } = await supabase
    .from('sequences')
    .update({ status: 'paused', ended_reason: reason, next_scheduled_at: null })
    .in('id', siblingIds);
  if (upErr) throw new Error(`pauseSiblingsForCompany: update failed: ${upErr.message}`);

  console.log(`[sequence] paused ${siblingIds.length} sibling sequences at prospect ${prospectId} (${reason})`);
  return { paused: siblingIds.length, ids: siblingIds };
}

/**
 * Defer the next step by N days. Used for the out_of_office intent —
 * push next_scheduled_at forward without changing status or current_step.
 *
 * @param {string} id
 * @param {number} days  positive integer
 */
async function deferSequence(id, days) {
  if (!id) throw new Error('deferSequence: id required');
  const n = parseInt(days, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error('deferSequence: days must be positive');
  const next = new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();
  const { error } = await supabase
    .from('sequences')
    .update({ next_scheduled_at: next })
    .eq('id', id);
  if (error) throw new Error(`deferSequence ${id} failed: ${error.message}`);
  console.log(`[sequence] deferred ${id} by ${n}d`);
  return { ok: true, next_scheduled_at: next };
}

/**
 * Bump a sequence on a successful send. Called from publishToResend on
 * step >= 2. If the sent step is the terminal step, flip to completed.
 *
 * @param {string} sequenceId
 * @param {number} sentStep
 */
async function bumpSequenceOnSendSuccess(sequenceId, sentStep) {
  if (!sequenceId) throw new Error('bumpSequenceOnSendSuccess: sequenceId required');
  const step = parseInt(sentStep, 10);
  if (!Number.isFinite(step) || step < 1 || step > MAX_STEP) {
    throw new Error(`bumpSequenceOnSendSuccess: invalid step ${sentStep}`);
  }

  // Need the track to read the right follow-up intervals from app_config.
  const { data: seq, error: seqErr } = await supabase
    .from('sequences')
    .select('id, track, current_step')
    .eq('id', sequenceId)
    .maybeSingle();
  if (seqErr) throw new Error(`bumpSequenceOnSendSuccess: load failed: ${seqErr.message}`);
  if (!seq) throw new Error(`bumpSequenceOnSendSuccess: no sequence ${sequenceId}`);

  const intervals = await getFollowupIntervals(seq.track);

  if (step >= MAX_STEP) {
    return completeSequence(sequenceId, 'completed');
  }

  const nowIso = new Date().toISOString();
  const nextAt = computeNextScheduledAt(step, intervals);

  const { error } = await supabase
    .from('sequences')
    .update({ current_step: step, last_sent_at: nowIso, next_scheduled_at: nextAt })
    .eq('id', sequenceId);
  if (error) throw new Error(`bumpSequenceOnSendSuccess ${sequenceId} failed: ${error.message}`);
  console.log(`[sequence] bumped ${sequenceId} to step ${step} (next ${nextAt})`);
  return { ok: true, current_step: step, next_scheduled_at: nextAt };
}

module.exports = {
  createSequenceOnPublish,
  advanceSequence,
  getDueSequences,
  pauseSequence,
  completeSequence,
  optOutSequence,
  bounceSequence,
  pauseSiblingsForCompany,
  deferSequence,
  bumpSequenceOnSendSuccess,
  sendOutboundForReview,
  getFollowupIntervals,
  FOLLOWUP_INTERVALS,
  MAX_STEP,
};
