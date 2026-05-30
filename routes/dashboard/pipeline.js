'use strict';

// routes/dashboard/pipeline.js
//
// Phase F-1 — the Pipeline tab. Visual surface for the Phase C reply
// pipeline + sequence state machine.
//
// Three sections: Needs attention (replies + paused sequences), Active
// sequences (paginated 25/page), Recent activity (interleaved sends +
// replies). Per-row quick actions map 1:1 to lib/sequence.js +
// lib/suppression.js.
//
// HTMX patterns mirror routes/dashboard/approve.js: body-parser scoped to
// THIS router only, POSTs return HTML fragments for outerHTML swap.
//
// Design source of truth: .ruflo/phase-f-pipeline-tab-design.md.

const express = require('express');
const path = require('path');
const fs = require('fs');

const router = express.Router();

// Body-parser scoped — mirrors routes/dashboard/approve.js:26.
router.use(express.urlencoded({ extended: false }));

const pipelineQueries = require('../../lib/dashboard/pipeline-queries');
const renderers = require('../../lib/dashboard/pipeline-render');
const { supabase } = require('../../lib/supabase');

// Cache the static template at module load.
const TEMPLATE_PATH = path.join(__dirname, 'pipeline.html');
let TEMPLATE_CACHE = null;
function getTemplate() {
  if (TEMPLATE_CACHE == null) {
    TEMPLATE_CACHE = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  }
  return TEMPLATE_CACHE;
}

// ── Main tab render ───────────────────────────────────────────────────────

/**
 * GET /dashboard/pipeline — Pipeline tab shell. Each section sub-loads
 * itself via hx-trigger="load".
 */
router.get('/', (_req, res) => {
  try {
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.send(getTemplate());
  } catch (err) {
    console.error('[dashboard/pipeline] template read error:', err.message);
    res.status(500).send(`<p class="error">Failed to load Pipeline tab: ${renderers.escHtml(err.message)}</p>`);
  }
});

// ── Section A: needs attention ────────────────────────────────────────────

router.get('/needs-attention', async (req, res) => {
  try {
    const intents = parseIntentParam(req.query.intent);
    const windowDays = parseWindowDays(req.query.window, 7);
    const items = await pipelineQueries.getNeedsAttention({ windowDays, intents });
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!items.length) {
      return res.send('<p class="empty pipeline-empty">No replies need your attention right now.</p>');
    }
    const rows = items.map(item => {
      if (item.kind === 'reply') {
        return renderers.renderReplyCard(item, { state: 'default' });
      }
      return renderers.renderPausedSequenceCard(item);
    }).join('\n');
    res.send(`<div id="needs-attention-list">${rows}</div>`);
  } catch (err) {
    console.error('[dashboard/pipeline] needs-attention error:', err.message);
    res.status(500).send(`<p class="error">Failed to load needs-attention queue: ${renderers.escHtml(err.message)}</p>`);
  }
});

// ── Section B: active sequences ───────────────────────────────────────────

router.get('/active-sequences', async (req, res) => {
  try {
    const track = pipelineQueries.VALID_TRACK_FILTERS.includes(req.query.track) ? req.query.track : 'all';
    const page = Math.max(0, parseInt(req.query.page, 10) || 0);
    const result = await pipelineQueries.getActiveSequences({ track, page });
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!result.rows.length && page === 0) {
      return res.send('<p class="empty pipeline-empty">No active sequences in this view.</p>');
    }
    const cards = result.rows.map(row => renderers.renderActiveSequenceCard(row, { state: 'default' })).join('\n');
    const loadMore = result.hasMore
      ? `<button class="pipeline-load-more"
          hx-get="/dashboard/pipeline/active-sequences?track=${encodeURIComponent(track)}&amp;page=${page + 1}"
          hx-target="#active-sequences-list"
          hx-swap="beforeend"
          hx-on:htmx:after-on-load="this.remove()">Load more</button>`
      : '';
    const wrapper = page === 0
      ? `<div id="active-sequences-list">${cards}</div>${loadMore}`
      : `${cards}${loadMore}`;
    res.send(wrapper);
  } catch (err) {
    console.error('[dashboard/pipeline] active-sequences error:', err.message);
    res.status(500).send(`<p class="error">Failed to load active sequences: ${renderers.escHtml(err.message)}</p>`);
  }
});

// ── Section C: recent activity ────────────────────────────────────────────

router.get('/recent-activity', async (req, res) => {
  try {
    const windowHours = parseWindowHours(req.query.window, 24);
    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) ? rawLimit : 40;
    const items = await pipelineQueries.getRecentActivity({ windowHours, limit });
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!items.length) {
      return res.send('<p class="empty pipeline-empty">No recent activity in this window.</p>');
    }
    const rows = items.map(renderers.renderActivityRow).join('\n');
    res.send(`<div id="recent-activity-list">${rows}</div>`);
  } catch (err) {
    console.error('[dashboard/pipeline] recent-activity error:', err.message);
    res.status(500).send(`<p class="error">Failed to load recent activity: ${renderers.escHtml(err.message)}</p>`);
  }
});

// ── Reply quick actions ───────────────────────────────────────────────────

/**
 * POST /reply/:id/resolve — flip requires_human=false, preserve processed_at.
 */
router.post('/reply/:id/resolve', async (req, res) => {
  const id = req.params.id;
  try {
    const ctx = await pipelineQueries.getReplyByIdWithContext(id);
    if (!ctx) {
      return res.status(404).send(`<div class="error">Reply ${renderers.escHtml(id)} not found.</div>`);
    }

    await resolveReply(id, ctx.reply.processed_at);

    // Re-render the card in resolved state.
    const item = {
      kind: 'reply',
      ts: ctx.reply.created_at,
      reply: { ...ctx.reply, requires_human: false },
      sequence: ctx.sequence,
      contact: ctx.contact,
      prospect: ctx.prospect,
      jump_url: pipelineQueries.buildBridgematchJumpUrl(ctx.prospect, ctx.contact),
    };
    res.set('HX-Trigger', 'pipeline-card-changed');
    res.send(renderers.renderReplyCard(item, { state: 'resolved' }));
  } catch (err) {
    console.error(`[dashboard/pipeline] resolve ${id}: ${err.message}`);
    res.status(500).send(`<div class="error">Resolve failed: ${renderers.escHtml(err.message)}</div>`);
  }
});

/**
 * POST /reply/:id/meeting-booked — set contacts.metadata.meeting_booked_at
 * and resolve the reply. Does NOT terminate the sequence (design §5.3).
 */
router.post('/reply/:id/meeting-booked', async (req, res) => {
  const id = req.params.id;
  try {
    const ctx = await pipelineQueries.getReplyByIdWithContext(id);
    if (!ctx) {
      return res.status(404).send(`<div class="error">Reply ${renderers.escHtml(id)} not found.</div>`);
    }
    if (!ctx.contact) {
      return res.status(500).send('<div class="error">Reply has no linked contact — cannot record meeting.</div>');
    }

    const nowIso = new Date().toISOString();
    const newMeta = { ...(ctx.contact.metadata || {}), meeting_booked_at: nowIso };
    const { error: cErr } = await supabase
      .from('contacts')
      .update({ metadata: newMeta })
      .eq('id', ctx.contact.id);
    if (cErr) throw new Error(`contact metadata update failed: ${cErr.message}`);

    await resolveReply(id, ctx.reply.processed_at);

    const item = {
      kind: 'reply',
      ts: ctx.reply.created_at,
      reply: { ...ctx.reply, requires_human: false },
      sequence: ctx.sequence,
      contact: { ...ctx.contact, metadata: newMeta },
      prospect: ctx.prospect,
      jump_url: pipelineQueries.buildBridgematchJumpUrl(ctx.prospect, ctx.contact),
    };
    res.set('HX-Trigger', 'pipeline-card-changed');
    res.send(renderers.renderReplyCard(item, { state: 'meeting-booked' }));
  } catch (err) {
    console.error(`[dashboard/pipeline] meeting-booked ${id}: ${err.message}`);
    res.status(500).send(`<div class="error">Mark meeting booked failed: ${renderers.escHtml(err.message)}</div>`);
  }
});

/**
 * POST /reply/:id/wrong-contact — suppress email + complete sequence +
 * resolve reply. Each step wrapped so one failure doesn't poison the others.
 */
router.post('/reply/:id/wrong-contact', async (req, res) => {
  const id = req.params.id;
  try {
    const ctx = await pipelineQueries.getReplyByIdWithContext(id);
    if (!ctx) {
      return res.status(404).send(`<div class="error">Reply ${renderers.escHtml(id)} not found.</div>`);
    }
    if (!ctx.contact || !ctx.contact.email) {
      return res.status(500).send('<div class="error">Reply has no contact email — cannot suppress.</div>');
    }

    // Lazy require so test isolates can stub each module independently.
    const { addSuppression } = require('../../lib/suppression');
    const { completeSequence } = require('../../lib/sequence');

    const stepErrors = [];

    // 1. Suppress.
    try {
      await addSuppression(ctx.contact.email, 'wrong_person');
    } catch (e) {
      stepErrors.push(`suppression: ${e.message}`);
      console.warn(`[dashboard/pipeline] wrong-contact ${id} suppression: ${e.message}`);
    }

    // 2. Complete sequence if linked.
    if (ctx.sequence && ctx.sequence.id) {
      try {
        await completeSequence(ctx.sequence.id, 'wrong_person');
      } catch (e) {
        stepErrors.push(`sequence: ${e.message}`);
        console.warn(`[dashboard/pipeline] wrong-contact ${id} sequence: ${e.message}`);
      }
    }

    // 3. Resolve the reply.
    try {
      await resolveReply(id, ctx.reply.processed_at);
    } catch (e) {
      stepErrors.push(`reply: ${e.message}`);
      console.warn(`[dashboard/pipeline] wrong-contact ${id} reply: ${e.message}`);
    }

    if (stepErrors.length === 3) {
      throw new Error(`all three steps failed: ${stepErrors.join('; ')}`);
    }

    res.set('HX-Trigger', 'pipeline-refresh');
    res.send('');
  } catch (err) {
    console.error(`[dashboard/pipeline] wrong-contact ${id}: ${err.message}`);
    res.status(500).send(`<div class="error">Mark wrong contact failed: ${renderers.escHtml(err.message)}</div>`);
  }
});

// ── Sequence quick actions ────────────────────────────────────────────────

/**
 * POST /sequence/:id/pause — calls pauseSequence(id, 'manual_pause').
 */
router.post('/sequence/:id/pause', async (req, res) => {
  const id = req.params.id;
  try {
    const { pauseSequence } = require('../../lib/sequence');
    await pauseSequence(id, 'manual_pause');

    const ctx = await pipelineQueries.getSequenceByIdWithContext(id);
    res.set('HX-Trigger', 'pipeline-card-changed');
    if (!ctx) {
      return res.send(`<div class="card pipeline sequence-card paused" id="seq-card-${renderers.escHtml(id)}"><span class="badge status-badge status-paused">paused</span> <span class="muted">Sequence paused.</span></div>`);
    }
    const item = {
      kind: 'paused-sequence',
      ts: ctx.sequence.last_sent_at || ctx.sequence.created_at,
      sequence: { ...ctx.sequence, status: 'paused', ended_reason: 'manual_pause' },
      contact: ctx.contact,
      prospect: ctx.prospect,
      jump_url: pipelineQueries.buildBridgematchJumpUrl(ctx.prospect, ctx.contact),
    };
    res.send(renderers.renderPausedSequenceCard(item));
  } catch (err) {
    console.error(`[dashboard/pipeline] pause sequence ${id}: ${err.message}`);
    res.status(500).send(`<div class="error">Pause failed: ${renderers.escHtml(err.message)}</div>`);
  }
});

/**
 * POST /sequence/:id/force-next — bypass next_scheduled_at guard and call
 * advanceSequence directly. Idempotent enough via the helper's status check.
 */
router.post('/sequence/:id/force-next', async (req, res) => {
  const id = req.params.id;
  try {
    const { advanceSequence } = require('../../lib/sequence');

    // Clear next_scheduled_at first — the cron query skips active rows
    // with a future schedule, but advanceSequence itself just checks
    // status === 'active'. Clearing brings the state into a consistent
    // shape for any concurrent cron tick that might race us.
    const { error: clearErr } = await supabase
      .from('sequences')
      .update({ next_scheduled_at: new Date().toISOString() })
      .eq('id', id)
      .eq('status', 'active');
    if (clearErr) throw new Error(`next_scheduled_at clear failed: ${clearErr.message}`);

    const result = await advanceSequence(id);

    const ctx = await pipelineQueries.getSequenceByIdWithContext(id);
    res.set('HX-Trigger', 'pipeline-card-changed');

    // advanceSequence returns { ok: false } when the sequence isn't active.
    if (result && result.ok === false) {
      const msg = result.completed
        ? 'Sequence already at terminal step — completed.'
        : 'Sequence not active — no step drafted.';
      if (!ctx) {
        return res.send(`<div class="card pipeline sequence-card" id="seq-card-${renderers.escHtml(id)}"><span class="muted">${renderers.escHtml(msg)}</span></div>`);
      }
      const item = {
        id: ctx.sequence.id,
        track: ctx.sequence.track,
        current_step: ctx.sequence.current_step,
        status: ctx.sequence.status,
        last_sent_at: ctx.sequence.last_sent_at,
        next_scheduled_at: ctx.sequence.next_scheduled_at,
        is_overdue: ctx.sequence.is_overdue,
        contact: ctx.contact,
        prospect: ctx.prospect,
        jump_url: pipelineQueries.buildBridgematchJumpUrl(ctx.prospect, ctx.contact),
      };
      return res.send(renderers.renderActiveSequenceCard(item, { state: 'no-op', message: msg }));
    }

    const nextStep = (result && result.nextStep) || (ctx && ctx.sequence.current_step + 1) || '?';
    if (!ctx) {
      return res.send(`<div class="card pipeline sequence-card" id="seq-card-${renderers.escHtml(id)}"><span class="muted">Step ${renderers.escHtml(String(nextStep))} drafted — awaiting approval on the Approve tab.</span></div>`);
    }
    const item = {
      id: ctx.sequence.id,
      track: ctx.sequence.track,
      current_step: ctx.sequence.current_step,
      status: ctx.sequence.status,
      last_sent_at: ctx.sequence.last_sent_at,
      next_scheduled_at: ctx.sequence.next_scheduled_at,
      is_overdue: ctx.sequence.is_overdue,
      contact: ctx.contact,
      prospect: ctx.prospect,
      jump_url: pipelineQueries.buildBridgematchJumpUrl(ctx.prospect, ctx.contact),
    };
    res.send(renderers.renderActiveSequenceCard(item, {
      state: 'force-next-drafted',
      message: `Step ${nextStep} drafted — awaiting approval on the Approve tab.`,
    }));
  } catch (err) {
    console.error(`[dashboard/pipeline] force-next ${id}: ${err.message}`);
    res.status(500).send(`<div class="error">Force next step failed: ${renderers.escHtml(err.message)}</div>`);
  }
});

// ── Internal helpers ──────────────────────────────────────────────────────

/**
 * Idempotent reply resolve. Preserves the original `processed_at` via
 * application-side COALESCE (Supabase JS doesn't expose RAW SQL COALESCE).
 *
 * @param {string} replyId
 * @param {string|null} existingProcessedAt
 */
async function resolveReply(replyId, existingProcessedAt) {
  const patch = { requires_human: false };
  if (!existingProcessedAt) {
    patch.processed_at = new Date().toISOString();
  }
  const { error } = await supabase
    .from('replies')
    .update(patch)
    .eq('id', replyId);
  if (error) throw new Error(`reply update failed: ${error.message}`);
}

function parseIntentParam(raw) {
  if (!raw || typeof raw !== 'string') return pipelineQueries.DEFAULT_ATTENTION_INTENTS.slice();
  if (raw === 'all') {
    // 'all' means all 8 intents — let the query lookup handle it via a
    // pass-through filter list.
    return ['interested', 'questions', 'not_interested', 'out_of_office',
      'wrong_person', 'unsubscribe', 'hostile', 'complaint'];
  }
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean);
  return parts.length ? parts : pipelineQueries.DEFAULT_ATTENTION_INTENTS.slice();
}

function parseWindowDays(raw, defaultDays) {
  if (raw === 'all') return 'all';
  if (raw === '24h') return 1;
  if (raw === '7d') return 7;
  if (raw === '30d') return 30;
  return defaultDays;
}

function parseWindowHours(raw, defaultHours) {
  if (raw === 'all') return 'all';
  if (raw === '24h') return 24;
  if (raw === '7d') return 24 * 7;
  if (raw === '30d') return 24 * 30;
  return defaultHours;
}

module.exports = router;
module.exports._internals = {
  parseIntentParam,
  parseWindowDays,
  parseWindowHours,
  resolveReply,
};
