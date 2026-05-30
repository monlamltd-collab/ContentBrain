'use strict';

// ── Pipeline tab query helpers (Phase F-1) ────────────────────────────────
//
// Backs the three /dashboard/pipeline/* section endpoints + the per-row
// action handlers in routes/dashboard/pipeline.js. Read-only — every
// mutation goes through lib/sequence.js or lib/suppression.js.
//
// Design source of truth: .ruflo/phase-f-pipeline-tab-design.md.

const { supabase } = require('../supabase');

// Window strings the dashboard accepts. Matches the Pipeline tab's
// window selector (24h / 7d / 30d / all) and the design doc §1.4 default.
const VALID_WINDOWS = Object.freeze(['24h', '7d', '30d', 'all']);

// Tracks the Pipeline tab filters by. 'all' is the dashboard-only no-op.
const VALID_TRACK_FILTERS = Object.freeze(['all', 'lender', 'broker', 'auction_house']);

// Section A defaults — see design doc §1.1.
const DEFAULT_ATTENTION_INTENTS = Object.freeze([
  'interested',
  'questions',
  'hostile',
  'complaint',
]);

// Section B pagination defaults.
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 50;

// Section C defaults.
const DEFAULT_RECENT_LIMIT = 40;
const MAX_RECENT_LIMIT = 100;

// Section A cap: never render more than this many cards regardless of
// window. If we ever exceed it something's gone wrong upstream and Simon
// should be looking at that, not scrolling Pipeline.
const NEEDS_ATTENTION_CAP = 50;

const EPOCH_ISO = '1970-01-01T00:00:00.000Z';

/**
 * Parse a window argument into ISO bounds.
 *
 * Accepts either:
 *   - `windowDays` (number or 'all') — days back
 *   - `windowHours` (number or 'all') — hours back
 *
 * If both are omitted, defaults to 7 days. `'all'` returns the epoch as
 * the lower bound so callers can pass `from` straight into `.gte()`.
 *
 * @param {object} [args]
 * @param {number|'all'} [args.windowDays]
 * @param {number|'all'} [args.windowHours]
 * @returns {{from: string, to: string, label: string}}
 */
function parseWindow(args) {
  const opts = args || {};
  const hasDays = opts.windowDays !== undefined && opts.windowDays !== null;
  const hasHours = opts.windowHours !== undefined && opts.windowHours !== null;

  const to = new Date().toISOString();

  // 'all' on either argument means "since the epoch".
  if (opts.windowDays === 'all' || opts.windowHours === 'all') {
    return { from: EPOCH_ISO, to, label: 'all' };
  }

  if (!hasDays && !hasHours) {
    // Default — 7 days.
    const ms = 7 * 86400 * 1000;
    return { from: new Date(Date.now() - ms).toISOString(), to, label: '7d' };
  }

  if (hasHours) {
    const hours = Number(opts.windowHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      throw new Error(`parseWindow: invalid windowHours=${opts.windowHours}`);
    }
    const ms = hours * 3600 * 1000;
    return { from: new Date(Date.now() - ms).toISOString(), to, label: `${hours}h` };
  }

  const days = Number(opts.windowDays);
  if (!Number.isFinite(days) || days <= 0) {
    throw new Error(`parseWindow: invalid windowDays=${opts.windowDays}`);
  }
  const ms = days * 86400 * 1000;
  return { from: new Date(Date.now() - ms).toISOString(), to, label: `${days}d` };
}

// ── Section A — needs attention ──────────────────────────────────────────

/**
 * Replies needing a human + sequences paused awaiting human input.
 * Two reads merged in JS; capped at NEEDS_ATTENTION_CAP.
 */
async function getNeedsAttention(opts) {
  const o = opts || {};
  const intents = Array.isArray(o.intents) && o.intents.length
    ? o.intents
    : DEFAULT_ATTENTION_INTENTS.slice();
  const win = parseWindow({ windowDays: o.windowDays === undefined ? 7 : o.windowDays });

  const repliesQuery = supabase
    .from('replies')
    .select(`
      id, contact_id, sequence_id, raw_body, classified_intent,
      requires_human, processed_at, created_at, confidence, classifier_reasoning,
      contact:contacts!inner (
        id, name, email, role, metadata,
        prospect:prospects!inner ( id, type, company_name, website, metadata )
      ),
      sequence:sequences ( id, track, current_step, status, ended_reason, last_sent_at )
    `)
    .in('classified_intent', intents)
    .gte('created_at', win.from)
    .order('created_at', { ascending: false })
    .limit(NEEDS_ATTENTION_CAP);

  const { data: replyRows, error: replyErr } = await repliesQuery;
  if (replyErr) throw new Error(`getNeedsAttention replies failed: ${replyErr.message}`);

  // 2. Paused sequences — awaiting_human / hostile_pause.
  const pausedQuery = supabase
    .from('sequences')
    .select(`
      id, contact_id, track, current_step, status, ended_reason,
      last_sent_at, next_scheduled_at, created_at,
      contact:contacts!inner (
        id, name, email, role, metadata,
        prospect:prospects!inner ( id, type, company_name, website, metadata )
      )
    `)
    .eq('status', 'paused')
    .in('ended_reason', ['awaiting_human', 'hostile_pause'])
    .gte('created_at', win.from)
    .order('created_at', { ascending: false })
    .limit(NEEDS_ATTENTION_CAP);

  const { data: pausedRows, error: pausedErr } = await pausedQuery;
  if (pausedErr) throw new Error(`getNeedsAttention paused failed: ${pausedErr.message}`);

  const items = [];

  for (const r of replyRows || []) {
    const contact = r.contact || null;
    const prospect = contact && contact.prospect ? contact.prospect : null;
    if (!contact || !prospect) continue;
    items.push({
      kind: 'reply',
      ts: r.created_at,
      reply: {
        id: r.id,
        sequence_id: r.sequence_id,
        raw_body: r.raw_body,
        classified_intent: r.classified_intent,
        requires_human: r.requires_human,
        processed_at: r.processed_at,
        created_at: r.created_at,
        confidence: r.confidence,
        classifier_reasoning: r.classifier_reasoning,
      },
      sequence: r.sequence || null,
      contact: stripJoin(contact),
      prospect,
      jump_url: buildBridgematchJumpUrl(prospect, contact),
    });
  }

  for (const s of pausedRows || []) {
    const contact = s.contact || null;
    const prospect = contact && contact.prospect ? contact.prospect : null;
    if (!contact || !prospect) continue;
    items.push({
      kind: 'paused-sequence',
      // COALESCE(last_sent_at, created_at) — design doc §5.5(a) default.
      ts: s.last_sent_at || s.created_at,
      sequence: {
        id: s.id,
        track: s.track,
        current_step: s.current_step,
        status: s.status,
        ended_reason: s.ended_reason,
        last_sent_at: s.last_sent_at,
        next_scheduled_at: s.next_scheduled_at,
        created_at: s.created_at,
      },
      contact: stripJoin(contact),
      prospect,
      jump_url: buildBridgematchJumpUrl(prospect, contact),
    });
  }

  // Architect's sort: COALESCE(reply.created_at, seq.last_sent_at, seq.created_at) DESC.
  // We've already stored that COALESCE result in `ts` per row.
  items.sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
  return items.slice(0, NEEDS_ATTENTION_CAP);
}

// ── Section B — active sequences ──────────────────────────────────────────

/**
 * Active sequences, paginated. Returns {rows, page, pageSize, hasMore}.
 * `track='all'` disables the filter. `is_overdue` flag derived from
 * next_scheduled_at < now.
 */
async function getActiveSequences(opts) {
  const o = opts || {};
  const track = VALID_TRACK_FILTERS.includes(o.track) ? o.track : 'all';
  const page = Number.isInteger(o.page) && o.page >= 0 ? o.page : 0;
  const rawSize = Number.isInteger(o.pageSize) ? o.pageSize : DEFAULT_PAGE_SIZE;
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, rawSize));

  let query = supabase
    .from('sequences')
    .select(`
      id, contact_id, track, current_step, status, last_sent_at,
      next_scheduled_at, created_at,
      contact:contacts!inner (
        id, name, email, role, metadata,
        prospect:prospects!inner ( id, type, company_name, website, metadata )
      )
    `)
    .eq('status', 'active');

  if (track !== 'all') {
    query = query.eq('track', track);
  }

  // next_scheduled_at ASC — soonest-due first within the active set.
  query = query
    .order('next_scheduled_at', { ascending: true, nullsFirst: false })
    .range(page * pageSize, page * pageSize + pageSize - 1);

  const { data, error } = await query;
  if (error) throw new Error(`getActiveSequences failed: ${error.message}`);

  const nowIso = new Date().toISOString();
  const rows = (data || []).map(s => {
    const contact = s.contact || null;
    const prospect = contact && contact.prospect ? contact.prospect : null;
    return {
      id: s.id,
      track: s.track,
      current_step: s.current_step,
      status: s.status,
      last_sent_at: s.last_sent_at,
      next_scheduled_at: s.next_scheduled_at,
      created_at: s.created_at,
      is_overdue: !!(s.next_scheduled_at && s.next_scheduled_at < nowIso),
      contact: contact ? stripJoin(contact) : null,
      prospect: prospect || null,
      jump_url: prospect ? buildBridgematchJumpUrl(prospect, contact) : '',
    };
  });

  return {
    rows,
    page,
    pageSize,
    hasMore: rows.length === pageSize,
  };
}

// ── Section C — recent activity ───────────────────────────────────────────

/**
 * Interleaved outbound sends + replies, newest first. Two reads, merged.
 */
async function getRecentActivity(opts) {
  const o = opts || {};
  const win = parseWindow({ windowHours: o.windowHours === undefined ? 24 : o.windowHours });
  const rawLimit = Number.isInteger(o.limit) ? o.limit : DEFAULT_RECENT_LIMIT;
  const limit = Math.max(10, Math.min(MAX_RECENT_LIMIT, rawLimit));
  const halfLimit = Math.min(MAX_RECENT_LIMIT, Math.max(20, limit));

  // 1. Outbound posts in window.
  const { data: sendRows, error: sErr } = await supabase
    .from('posts')
    .select('id, copy_headline, meta, published_at, track')
    .eq('track', 'outbound')
    .eq('status', 'published')
    .gte('published_at', win.from)
    .order('published_at', { ascending: false })
    .limit(halfLimit);
  if (sErr) throw new Error(`getRecentActivity posts failed: ${sErr.message}`);

  // 2. Replies in window.
  const { data: replyRows, error: rErr } = await supabase
    .from('replies')
    .select(`
      id, classified_intent, created_at,
      contact:contacts ( id, email, prospect:prospects ( company_name ) )
    `)
    .gte('created_at', win.from)
    .order('created_at', { ascending: false })
    .limit(halfLimit);
  if (rErr) throw new Error(`getRecentActivity replies failed: ${rErr.message}`);

  const merged = [];

  for (const p of sendRows || []) {
    const meta = p.meta || {};
    const step = meta.sequence_step != null ? Number(meta.sequence_step) : null;
    const contactEmail = meta.contact_email || meta.to || '';
    const company = meta.company_name || '';
    const stepText = step ? `step ${step}` : 'message';
    const companyText = company ? ` (${company})` : '';
    merged.push({
      kind: 'send',
      at: p.published_at,
      label: `Sent ${stepText} to ${contactEmail}${companyText}`,
      contact_email: contactEmail,
      subject: p.copy_headline || '',
      track: meta.track || null,
    });
  }

  for (const r of replyRows || []) {
    const contact = r.contact || null;
    const prospect = contact && contact.prospect ? contact.prospect : null;
    const contactEmail = contact ? (contact.email || '') : '';
    const company = prospect ? (prospect.company_name || '') : '';
    const companyText = company ? ` (${company})` : '';
    merged.push({
      kind: 'reply',
      at: r.created_at,
      label: `Reply from ${contactEmail}${companyText}`,
      contact_email: contactEmail,
      intent: r.classified_intent || null,
    });
  }

  merged.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
  return merged.slice(0, limit);
}

// ── Per-row context fetches (action handlers) ─────────────────────────────

/** Fetch one reply row with joined contact + prospect + sequence. */
async function getReplyByIdWithContext(replyId) {
  if (!replyId) return null;
  const { data, error } = await supabase
    .from('replies')
    .select(`
      id, contact_id, sequence_id, raw_body, classified_intent,
      requires_human, processed_at, created_at, confidence, classifier_reasoning,
      contact:contacts!inner (
        id, name, email, role, metadata,
        prospect:prospects!inner ( id, type, company_name, website, metadata )
      ),
      sequence:sequences ( id, track, current_step, status, ended_reason, last_sent_at )
    `)
    .eq('id', replyId)
    .maybeSingle();
  if (error) throw new Error(`getReplyByIdWithContext failed: ${error.message}`);
  if (!data) return null;
  const contact = data.contact || null;
  const prospect = contact && contact.prospect ? contact.prospect : null;
  return {
    reply: {
      id: data.id,
      contact_id: data.contact_id,
      sequence_id: data.sequence_id,
      raw_body: data.raw_body,
      classified_intent: data.classified_intent,
      requires_human: data.requires_human,
      processed_at: data.processed_at,
      created_at: data.created_at,
      confidence: data.confidence,
      classifier_reasoning: data.classifier_reasoning,
    },
    sequence: data.sequence || null,
    contact: contact ? stripJoin(contact) : null,
    prospect,
  };
}

/** Fetch one sequence row with joined contact + prospect. */
async function getSequenceByIdWithContext(sequenceId) {
  if (!sequenceId) return null;
  const { data, error } = await supabase
    .from('sequences')
    .select(`
      id, contact_id, track, current_step, status, ended_reason,
      last_sent_at, next_scheduled_at, created_at,
      contact:contacts!inner (
        id, name, email, role, metadata,
        prospect:prospects!inner ( id, type, company_name, website, metadata )
      )
    `)
    .eq('id', sequenceId)
    .maybeSingle();
  if (error) throw new Error(`getSequenceByIdWithContext failed: ${error.message}`);
  if (!data) return null;
  const contact = data.contact || null;
  const prospect = contact && contact.prospect ? contact.prospect : null;
  const nowIso = new Date().toISOString();
  return {
    sequence: {
      id: data.id,
      track: data.track,
      current_step: data.current_step,
      status: data.status,
      ended_reason: data.ended_reason,
      last_sent_at: data.last_sent_at,
      next_scheduled_at: data.next_scheduled_at,
      created_at: data.created_at,
      is_overdue: !!(data.next_scheduled_at && data.next_scheduled_at < nowIso),
    },
    contact: contact ? stripJoin(contact) : null,
    prospect,
  };
}

// ── BridgeMatch jump URL ──────────────────────────────────────────────────

/**
 * Compute the "Jump to BridgeMatch" link. Reads
 * `process.env.BRIDGEMATCH_BASE_URL` at call time so tests can flip env
 * mid-process. Never throws; falls through to base URL on any odd shape.
 *
 * @param {object} prospect
 * @param {object} [_contact] reserved for future per-contact deeplinks
 * @returns {string}
 */
function buildBridgematchJumpUrl(prospect, _contact) {
  const base = (process.env.BRIDGEMATCH_BASE_URL || 'https://bridgematch.co.uk').replace(/\/+$/, '');
  if (!prospect || typeof prospect !== 'object') return base;

  if (prospect.type === 'lender' && prospect.company_name) {
    return `${base}/admin/edit?lender=${encodeURIComponent(prospect.company_name)}`;
  }
  if (prospect.type === 'broker') {
    const frn = prospect.metadata && prospect.metadata.frn;
    if (frn) {
      return `https://register.fca.org.uk/s/firm?id=${encodeURIComponent(frn)}`;
    }
    if (prospect.website) return prospect.website;
    return base;
  }
  if (prospect.type === 'auction_house' && prospect.website) {
    return prospect.website;
  }
  return base;
}

// ── Internal helpers ──────────────────────────────────────────────────────

function stripJoin(contact) {
  // Drop the nested .prospect — callers already lifted prospect to top level.
  if (!contact) return null;
  const { prospect: _drop, ...rest } = contact;
  return rest;
}

module.exports = {
  // Constants
  VALID_WINDOWS,
  VALID_TRACK_FILTERS,
  DEFAULT_ATTENTION_INTENTS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  DEFAULT_RECENT_LIMIT,
  MAX_RECENT_LIMIT,
  NEEDS_ATTENTION_CAP,
  // Window parsing
  parseWindow,
  // Queries
  getNeedsAttention,
  getActiveSequences,
  getRecentActivity,
  getReplyByIdWithContext,
  getSequenceByIdWithContext,
  // Helpers
  buildBridgematchJumpUrl,
};
