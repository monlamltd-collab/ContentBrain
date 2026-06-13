'use strict';

// ── Pipeline tab HTML renderers (Phase F-1) ───────────────────────────────
//
// Pure render helpers — no I/O, no DB. Consumed by routes/dashboard/pipeline.js
// for both the section GETs and the post-action card swaps. Extracted from
// the route file to keep that under 500 lines (per CLAUDE.md house style).
//
// Card class taxonomy (matches public/dashboard/styles.css lines 401–425):
//   .card.pipeline.reply-card.intent-<intent>[.resolved|.meeting-booked|.wrong-contact]
//   .card.pipeline.sequence-card.paused
//   .card.pipeline.sequence-card.active
//   .activity-row.outbound | .activity-row.reply
//
// All user-facing strings are British English.

const { escHtml, escAttr } = require('./html');

/**
 * Compact relative-time formatter — "3m ago", "2h ago", "5d ago".
 * Never throws; returns "—" for non-date input.
 */
function relativeTime(iso) {
  if (!iso) return '—';
  let then;
  try { then = new Date(iso).getTime(); } catch { return '—'; }
  if (!Number.isFinite(then)) return '—';
  const deltaSec = Math.round((Date.now() - then) / 1000);
  if (deltaSec < 60) return `${Math.max(0, deltaSec)}s ago`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ago`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ago`;
  if (deltaSec < 86400 * 14) return `${Math.floor(deltaSec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString('en-GB');
}

/**
 * Confidence badge — "conf 0.87" with a tier class for colour. Returns
 * an empty string when confidence is null (pre-mig-018 row or fallback).
 */
function renderConfidenceBadge(confidence) {
  if (confidence == null) return '';
  const n = Number(confidence);
  if (!Number.isFinite(n)) return '';
  let tier = '';
  if (n >= 0.85) tier = ' conf-high';
  else if (n < 0.6) tier = ' conf-low';
  return `<span class="badge confidence${tier}" title="classifier confidence">conf ${n.toFixed(2)}</span>`;
}

function renderStepDots(currentStep, maxStep = 4) {
  const step = Number.isFinite(currentStep) ? currentStep : 0;
  const dots = [];
  for (let i = 1; i <= maxStep; i++) {
    let cls = 'future';
    if (i < step) cls = 'done';
    else if (i === step) cls = 'current';
    dots.push(`<span class="dot ${cls}" title="step ${i}"></span>`);
  }
  return `<div class="step-dots step-${step}">${dots.join('')}</div>`;
}

// ── Section A reply card ──────────────────────────────────────────────────

/**
 * Render a reply card.
 *
 * @param {object} item   { reply, sequence, contact, prospect, jump_url }
 * @param {object} [opts]
 * @param {'default'|'resolved'|'meeting-booked'|'wrong-contact'} [opts.state]
 * @returns {string}
 */
function renderReplyCard(item, opts) {
  const state = (opts && opts.state) || 'default';
  const reply = item.reply || {};
  const sequence = item.sequence || null;
  const contact = item.contact || {};
  const prospect = item.prospect || {};
  const intent = reply.classified_intent || 'questions';
  const stateClass = state !== 'default' ? ` ${state}` : '';
  const cardId = `reply-card-${reply.id}`;

  const headerBadges = [
    `<span class="badge intent-badge intent-${escAttr(intent)}">${escHtml(intent)}</span>`,
    renderConfidenceBadge(reply.confidence),
  ];
  if (sequence && sequence.track) {
    headerBadges.push(`<span class="badge track-badge">${escHtml(sequence.track)}</span>`);
  }
  if (sequence && sequence.current_step != null) {
    headerBadges.push(`<span class="badge step-badge">step ${escHtml(String(sequence.current_step))}</span>`);
  }

  const contactName = contact.name || '?';
  const contactEmail = contact.email || '(no email)';
  const company = prospect.company_name || '(unknown company)';

  const headerLine = `<span class="muted">${escHtml(relativeTime(reply.created_at))}</span>
    <span class="muted">from ${escHtml(contactName)} &lt;${escHtml(contactEmail)}&gt;</span>
    <span class="muted">at ${escHtml(company)}</span>`;

  const reasoning = reply.classifier_reasoning
    ? `<p class="muted classifier-reasoning"><em>Classifier:</em> ${escHtml(reply.classifier_reasoning)}</p>`
    : '';

  // hx-preserve on the details element so the action-button swap doesn't
  // collapse it after the user expanded it (architect's flagged decision #3).
  const body = `<details id="reply-body-${escAttr(reply.id)}" hx-preserve="true">
      <summary>Reply body</summary>
      ${reasoning}
      <pre class="reply-body">${escHtml(reply.raw_body || '')}</pre>
    </details>`;

  const actions = renderReplyActions(reply, intent, item.jump_url, state, contact);

  let footer = '';
  if (state === 'resolved') {
    const stamp = reply.processed_at || new Date().toISOString();
    footer = `<p class="muted resolved-footer">Resolved at ${escHtml(relativeTime(stamp))}.</p>`;
  } else if (state === 'meeting-booked') {
    footer = `<p class="muted meeting-booked-footer"><strong>Meeting booked.</strong> Recorded against ${escHtml(contactEmail)}.</p>`;
  } else if (state === 'wrong-contact') {
    footer = `<p class="muted wrong-contact-footer">Marked as wrong contact — suppressed and sequence closed.</p>`;
  }

  return `<div class="card pipeline reply-card intent-${escAttr(intent)}${stateClass}" id="${escAttr(cardId)}">
  <div class="card-header">
    ${headerBadges.filter(Boolean).join('\n    ')}
    ${headerLine}
  </div>
  <div class="copy">${body}</div>
  ${actions}
  ${footer}
</div>`;
}

function renderReplyActions(reply, intent, jumpUrl, state, contact) {
  // No actions in non-default states — the user has already acted.
  if (state !== 'default') return '<div class="actions"></div>';

  const id = reply.id;
  const cardTarget = `#reply-card-${id}`;
  const buttons = [];

  buttons.push(`<button class="btn"
      hx-post="/dashboard/pipeline/reply/${escAttr(id)}/resolve"
      hx-target="${cardTarget}"
      hx-swap="outerHTML"
      hx-disabled-elt="this">Mark resolved</button>`);

  // Gate meeting-booked by intent (design §5.7 default (b)).
  if (intent === 'interested' || intent === 'questions') {
    buttons.push(`<button class="btn"
      hx-post="/dashboard/pipeline/reply/${escAttr(id)}/meeting-booked"
      hx-target="${cardTarget}"
      hx-swap="outerHTML"
      hx-disabled-elt="this"
      hx-confirm="Mark meeting booked for ${escAttr(contact && contact.email || '(this contact)')}?">Mark meeting booked</button>`);
  }

  // Gate wrong-contact away from intents the classifier already handled.
  if (intent !== 'wrong_person' && intent !== 'unsubscribe') {
    buttons.push(`<button class="btn"
      hx-post="/dashboard/pipeline/reply/${escAttr(id)}/wrong-contact"
      hx-target="${cardTarget}"
      hx-swap="outerHTML"
      hx-disabled-elt="this"
      hx-confirm="Suppress this email and close the sequence?">Wrong contact</button>`);
  }

  if (jumpUrl) {
    buttons.push(`<a class="btn jump"
      href="${escAttr(jumpUrl)}"
      target="_blank"
      rel="noopener">Jump to BridgeMatch</a>`);
  }

  return `<div class="actions">${buttons.join('\n      ')}</div>`;
}

// ── Section A paused-sequence card ────────────────────────────────────────

function renderPausedSequenceCard(item) {
  const sequence = item.sequence || {};
  const contact = item.contact || {};
  const prospect = item.prospect || {};
  const id = sequence.id;
  const cardId = `seq-card-${id}`;

  const reasonText = humaniseEndedReason(sequence.ended_reason);
  const contactName = contact.name || '?';
  const contactEmail = contact.email || '(no email)';
  const company = prospect.company_name || '(unknown company)';

  const stepBadge = sequence.current_step != null
    ? `<span class="badge step-badge">step ${escHtml(String(sequence.current_step))}/4</span>`
    : '';

  const actions = item.jump_url
    ? `<div class="actions"><a class="btn jump" href="${escAttr(item.jump_url)}" target="_blank" rel="noopener">Jump to BridgeMatch</a></div>`
    : '<div class="actions"></div>';

  return `<div class="card pipeline sequence-card paused" id="${escAttr(cardId)}">
  <div class="card-header">
    <span class="badge status-badge status-paused">paused</span>
    <span class="badge ended-reason">${escHtml(sequence.ended_reason || '—')}</span>
    <span class="badge track-badge">${escHtml(sequence.track || '—')}</span>
    ${stepBadge}
    <span class="muted">${escHtml(relativeTime(sequence.last_sent_at || sequence.created_at))}</span>
    <span class="muted">${escHtml(contactName)} &lt;${escHtml(contactEmail)}&gt; at ${escHtml(company)}</span>
  </div>
  <div class="copy">
    <p class="muted">${escHtml(reasonText)}</p>
    ${renderStepDots(sequence.current_step)}
  </div>
  ${actions}
</div>`;
}

function humaniseEndedReason(reason) {
  switch (reason) {
    case 'awaiting_human': return 'Awaiting your input.';
    case 'hostile_pause':  return 'Paused — hostile reply at this company.';
    case 'manual_pause':   return 'Paused manually.';
    default:               return reason ? `Paused (${reason}).` : 'Paused.';
  }
}

// ── Section B active-sequence card ────────────────────────────────────────

/**
 * Render an active-sequence card.
 *
 * @param {object} sequence flat shape {id, track, current_step, status,
 *   last_sent_at, next_scheduled_at, is_overdue, contact, prospect, jump_url}
 * @param {object} [opts]
 * @param {'default'|'no-op'|'force-next-drafted'} [opts.state]
 * @param {string} [opts.message]
 */
function renderActiveSequenceCard(sequence, opts) {
  const state = (opts && opts.state) || 'default';
  const id = sequence.id;
  const cardId = `seq-card-${id}`;
  const contact = sequence.contact || {};
  const prospect = sequence.prospect || {};

  const contactName = contact.name || '?';
  const contactEmail = contact.email || '(no email)';
  const company = prospect.company_name || '(unknown company)';
  const overdueBadge = sequence.is_overdue
    ? '<span class="badge ended-reason" title="next_scheduled_at is in the past">overdue</span>'
    : '';

  const nextText = sequence.next_scheduled_at
    ? `Next: ${relativeTime(sequence.next_scheduled_at)}`
    : 'Next: —';
  const lastText = sequence.last_sent_at
    ? `last sent ${relativeTime(sequence.last_sent_at)}`
    : 'no sends yet';

  let footer = '';
  let actions = '';
  if (state === 'force-next-drafted') {
    footer = `<p class="muted force-next-footer">${escHtml((opts && opts.message) || 'Step drafted — awaiting approval on the Approve tab.')}</p>`;
    actions = '<div class="actions"></div>';
  } else if (state === 'no-op') {
    footer = `<p class="muted">${escHtml((opts && opts.message) || 'No action taken.')}</p>`;
    actions = '<div class="actions"></div>';
  } else {
    actions = renderActiveSequenceActions(id);
  }

  const stepBadge = sequence.current_step != null
    ? `<span class="badge step-badge">step ${escHtml(String(sequence.current_step))}/4</span>`
    : '';

  return `<div class="card pipeline sequence-card active" id="${escAttr(cardId)}">
  <div class="card-header">
    <span class="badge status-badge status-active">active</span>
    <span class="badge track-badge">${escHtml(sequence.track || '—')}</span>
    ${stepBadge}
    ${overdueBadge}
    <span class="muted">${escHtml(contactName)} &lt;${escHtml(contactEmail)}&gt; at ${escHtml(company)}</span>
  </div>
  <div class="copy">
    <p class="muted">${escHtml(nextText)} · ${escHtml(lastText)}</p>
    ${renderStepDots(sequence.current_step)}
  </div>
  ${actions}
  ${footer}
</div>`;
}

function renderActiveSequenceActions(id) {
  const cardTarget = `#seq-card-${id}`;
  return `<div class="actions">
    <button class="btn"
      hx-post="/dashboard/pipeline/sequence/${escAttr(id)}/pause"
      hx-target="${cardTarget}"
      hx-swap="outerHTML"
      hx-disabled-elt="this"
      hx-confirm="Pause this sequence?">Pause</button>
    <button class="btn"
      hx-post="/dashboard/pipeline/sequence/${escAttr(id)}/force-next"
      hx-target="${cardTarget}"
      hx-swap="outerHTML"
      hx-disabled-elt="this"
      hx-confirm="Draft the next step now and push it to the Approve queue?">Force next step</button>
  </div>`;
}

// ── Section C activity row ────────────────────────────────────────────────

/**
 * Render a one-line activity row. `row.kind` is 'send' or 'reply'.
 */
function renderActivityRow(row) {
  if (!row || typeof row !== 'object') return '';
  if (row.kind === 'send') {
    const trackBadge = row.track
      ? `<span class="badge track-badge">${escHtml(row.track)}</span>`
      : '';
    return `<div class="activity-row outbound" data-ts="${escAttr(row.at || '')}">
  <span class="arrow">&rarr;</span>
  <span class="muted">${escHtml(relativeTime(row.at))}</span>
  <span>${escHtml(row.label || '')}</span>
  ${trackBadge}
</div>`;
  }
  const intent = row.intent || 'reply';
  return `<div class="activity-row reply" data-ts="${escAttr(row.at || '')}">
  <span class="arrow">&larr;</span>
  <span class="muted">${escHtml(relativeTime(row.at))}</span>
  <span class="badge intent-badge intent-${escAttr(intent)}">${escHtml(intent)}</span>
  <span>${escHtml(row.label || '')}</span>
</div>`;
}

module.exports = {
  escHtml,
  relativeTime,
  renderReplyCard,
  renderPausedSequenceCard,
  renderActiveSequenceCard,
  renderActivityRow,
  renderConfidenceBadge,
  renderStepDots,
  humaniseEndedReason,
};
