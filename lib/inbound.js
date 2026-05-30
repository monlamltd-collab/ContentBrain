require('dotenv').config();

// ── Inbound email handler (Phase C) ───────────────────────────────────────
//
// Wires Resend's native inbound (`email.received` webhook event) through to
// our reply-classifier and the sequence/suppression action dispatcher.
//
// Called from lib/resend.js#handleWebhook — see the `case 'email.received'`
// branch. The webhook payload is metadata only; the full body is fetched
// in-flight via Resend's emails-receiving endpoint.
//
// End-to-end flow (matches .ruflo/phase-c-design.md §3):
//
//   1. Pull `email_id`, `from`, `subject` from the event.
//   2. Fetch full body via Resend HTTP API (no SDK method exposed for this).
//   3. Look up the contact by `fromEmail` (case-insensitive). No contact
//      → log + Telegram-alert and stop (replies.contact_id is NOT NULL).
//   4. Match the reply to a sequence — In-Reply-To/References → resend_id
//      → post.meta.sequence_id; fallback to the contact's most-recent
//      active sequence; final fallback NULL (FK is ON DELETE SET NULL).
//   5. INSERT into `replies` with `ON CONFLICT (resend_email_id) DO NOTHING`
//      (migration 015) — idempotent on Resend webhook retries.
//   6. classifyReply → {intent, confidence, reasoning}.
//   7. lookupAction(intent, confidence) — adds the confidence-floor override.
//   8. OOO 2-cap: if intent='out_of_office' and this contact already has
//      >=2 prior OOO replies, force pause + ended_reason='awaiting_human'.
//   9. Dispatch: sequence action, suppression, Telegram alert.
//   10. UPDATE replies row with classified_intent, requires_human, processed_at.
//
// Errors at any post-insert step leave the row with processed_at=NULL so
// migration 013's idx_replies_unprocessed surfaces them for retry.
//
// House style: lazy-load Telegram + sequence + suppression so the module
// is requireable in tests without the full env. NEVER log raw_body at info
// level — privacy + spam in CloudWatch. British English in logs.

const { supabase } = require('./supabase');

// OOO 2-cap (researcher's design doc §5.3). After this many prior OOO
// replies from the same contact, force the next OOO into pause+human.
const OOO_CAP = 2;

// Naive HTML → text: strip tags + collapse whitespace. The classifier is
// tolerant of stray whitespace; we don't need a real DOM parser.
function stripHtml(html) {
  if (!html || typeof html !== 'string') return '';
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Fetch the full inbound body via Resend's receiving endpoint.
 *
 * Resend's JS SDK doesn't expose receiving.get — call the REST endpoint
 * directly with the API key. Returns `{body, html, headers, raw}` where
 * `body` is preferred-text and falls back to a basic HTML strip when only
 * `html` is present.
 *
 * @param {string} emailId
 * @returns {Promise<{body: string, html: string|null, headers: object|null, raw: object}>}
 */
async function fetchInboundBody(emailId) {
  if (!emailId) throw new Error('fetchInboundBody: emailId required');
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('fetchInboundBody: set RESEND_API_KEY in .env');

  // Resend inbound storage endpoint (per docs). Using HTTP directly because
  // the SDK doesn't yet expose receiving.get on our pinned version.
  const url = `https://api.resend.com/emails/${encodeURIComponent(emailId)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`fetchInboundBody ${emailId} failed (${res.status}): ${errText.slice(0, 200)}`);
  }
  const raw = await res.json();
  const text = typeof raw.text === 'string' ? raw.text : '';
  const html = typeof raw.html === 'string' ? raw.html : null;
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers : null;
  const body = text || (html ? stripHtml(html) : '');
  return { body, html, headers, raw };
}

// Headers from Resend may be an object or an array of {name, value} pairs.
// Normalise to a flat lowercase-keyed object so In-Reply-To/References lookup
// is one indexed read.
function normaliseHeaders(headers) {
  if (!headers) return {};
  if (Array.isArray(headers)) {
    const out = {};
    for (const h of headers) {
      if (h && h.name) out[String(h.name).toLowerCase()] = h.value;
    }
    return out;
  }
  if (typeof headers === 'object') {
    const out = {};
    for (const k of Object.keys(headers)) out[k.toLowerCase()] = headers[k];
    return out;
  }
  return {};
}

// Extract a list of candidate resend_ids from an In-Reply-To / References
// header value. The message-id format from Resend is
// `<resend_id@email.eu-west-1.amazonaws.com>` (or similar). We split on
// whitespace + strip angle brackets + take the part before '@'.
function extractResendIdsFromHeader(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(/\s+/)
    .map(s => s.replace(/^[<\s]+|[>\s]+$/g, ''))
    .filter(Boolean)
    .map(s => {
      const at = s.indexOf('@');
      return at > -1 ? s.slice(0, at) : s;
    })
    .filter(s => s.length > 0);
}

/**
 * Match a reply to a sequence using message-id headers, falling back to the
 * contact's most-recent active sequence.
 *
 * @param {object} params
 * @param {string} params.contactId
 * @param {object} params.headers   normalised lowercase-keyed headers
 * @returns {Promise<{sequenceId: string|null}>}
 */
async function matchSequenceForReply({ contactId, headers } = {}) {
  // Try the In-Reply-To / References path first.
  const candidates = [
    ...extractResendIdsFromHeader(headers && headers['in-reply-to']),
    ...extractResendIdsFromHeader(headers && headers['references']),
  ];

  for (const resendId of candidates) {
    const { data, error } = await supabase
      .from('posts')
      .select('meta')
      .filter('meta->>resend_id', 'eq', resendId)
      .maybeSingle();
    if (error) {
      console.warn(`[inbound] post lookup for resend_id=${resendId} failed: ${error.message}`);
      continue;
    }
    if (data && data.meta && data.meta.sequence_id) {
      return { sequenceId: data.meta.sequence_id };
    }
  }

  // Fallback: contact's most-recent active sequence.
  if (contactId) {
    const { data, error } = await supabase
      .from('sequences')
      .select('id')
      .eq('contact_id', contactId)
      .eq('status', 'active')
      .order('last_sent_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!error && data && data.id) return { sequenceId: data.id };
  }

  return { sequenceId: null };
}

// Count prior `out_of_office` replies for this contact — used for the OOO 2-cap.
async function countPriorOooReplies(contactId) {
  const { count, error } = await supabase
    .from('replies')
    .select('id', { count: 'exact', head: true })
    .eq('contact_id', contactId)
    .eq('classified_intent', 'out_of_office');
  if (error) {
    console.warn(`[inbound] OOO count failed for contact ${contactId}: ${error.message}`);
    return 0;
  }
  return count || 0;
}

// Domain extractor — '@x.co' suffix from a full address. Lowercased.
function domainOf(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * Process one `email.received` event from Resend.
 *
 * @param {object} eventData  the `data` field from the webhook envelope
 * @returns {Promise<object>}
 */
async function handleInboundEmail(eventData) {
  if (!eventData) throw new Error('handleInboundEmail: eventData required');

  const emailId = eventData.email_id || eventData.id;
  if (!emailId) throw new Error('handleInboundEmail: email_id required');

  const fromAddress = Array.isArray(eventData.from) ? eventData.from[0] : eventData.from;
  const fromEmailLower = (fromAddress && typeof fromAddress === 'string') ? fromAddress.trim().toLowerCase() : null;
  const subject = eventData.subject || null;
  const actions = [];

  // Fetch the full body + headers from Resend.
  let fetched;
  try {
    fetched = await fetchInboundBody(emailId);
  } catch (err) {
    console.error(`[inbound] body fetch failed for ${emailId}: ${err.message}`);
    return { ok: false, skipped: false, replyId: null, contactId: null, sequenceId: null, intent: null, requires_human: true, actions: [`body fetch failed: ${err.message}`] };
  }
  const headers = normaliseHeaders(fetched.headers);
  const body = fetched.body || '';

  // Contact lookup. Required — migration 013 has contact_id NOT NULL.
  let contact = null;
  if (fromEmailLower) {
    const { data: contactRows, error: cErr } = await supabase
      .from('contacts')
      .select('id, name, email, prospect_id, prospect:prospects ( id, type, company_name )')
      .ilike('email', fromEmailLower)
      .limit(1);
    if (cErr) {
      console.warn(`[inbound] contact lookup failed: ${cErr.message}`);
    } else if (contactRows && contactRows.length) {
      contact = contactRows[0];
    }
  }

  if (!contact) {
    // No contact → can't insert a replies row. Telegram-alert Simon and
    // bail. This is rare (we only get inbound on addresses we wrote to);
    // a stray @auctionbrain.co.uk forward is the realistic case.
    console.warn(`[inbound] no contact match for ${fromEmailLower || '(no from)'} — alerting`);
    try {
      const { sendNotification } = require('./telegram');
      await sendNotification(`Inbound from <code>${fromEmailLower || 'unknown'}</code> didn't match any contact. Subject: ${subject || '(none)'}`);
    } catch (err) {
      console.warn(`[inbound] Telegram alert failed: ${err.message}`);
    }
    return { ok: false, skipped: true, replyId: null, contactId: null, sequenceId: null, intent: null, requires_human: true, actions: ['no contact match'] };
  }

  // Match the reply to a sequence.
  const { sequenceId } = await matchSequenceForReply({ contactId: contact.id, headers });

  // INSERT the replies row. ON CONFLICT (resend_email_id) DO NOTHING via
  // an upsert + ignoreDuplicates: a Resend webhook redelivery becomes a
  // no-op. raw_body must be NOT NULL — we pass the (possibly empty) body
  // and trust migration 015's UNIQUE index to dedupe.
  const insertRow = {
    contact_id: contact.id,
    sequence_id: sequenceId || null,
    raw_body: body || '(empty body)',
    resend_email_id: emailId,
  };
  const { data: inserted, error: insErr } = await supabase
    .from('replies')
    .upsert(insertRow, { onConflict: 'resend_email_id', ignoreDuplicates: true })
    .select('id')
    .maybeSingle();
  if (insErr) {
    console.error(`[inbound] replies insert failed for ${emailId}: ${insErr.message}`);
    return { ok: false, skipped: false, replyId: null, contactId: contact.id, sequenceId, intent: null, requires_human: true, actions: [`insert failed: ${insErr.message}`] };
  }
  if (!inserted || !inserted.id) {
    // Duplicate — ignoreDuplicates returned no row. Log and exit clean.
    actions.push('duplicate (ON CONFLICT) — no-op');
    console.log(`[inbound] duplicate email_id=${emailId} — skipping`);
    return { ok: true, skipped: true, replyId: null, contactId: contact.id, sequenceId, intent: null, requires_human: false, actions };
  }
  const replyId = inserted.id;
  actions.push(`inserted reply ${replyId}`);

  // Classify (Haiku call — graceful fallback to questions/0.5 on any error).
  const { classifyReply, lookupAction } = require('./classify');
  const companyName = contact.prospect ? contact.prospect.company_name : null;
  const classification = await classifyReply({
    subject,
    body,
    fromEmail: fromEmailLower,
    contactName: contact.name,
    companyName,
  });
  let intent = classification.intent;
  const confidence = classification.confidence;
  let action = lookupAction(intent, confidence);
  actions.push(`classified intent=${intent} confidence=${confidence.toFixed(2)}`);

  // OOO 2-cap (researcher's design §5.3). If this is the 3rd+ OOO from
  // this contact, force pause + awaiting_human + Telegram alert. We count
  // PRIOR OOO replies — the current one is already inserted with no
  // classified_intent yet, so it isn't counted.
  if (intent === 'out_of_office') {
    const prior = await countPriorOooReplies(contact.id);
    if (prior >= OOO_CAP) {
      console.log(`[inbound] OOO cap hit for contact ${contact.id} (${prior} prior); forcing pause`);
      action = { ...action, sequence_action: 'pause', ended_reason: 'awaiting_human', requires_human: true, telegram_alert: true, urgent: false };
      actions.push(`OOO cap (${prior} prior) — forcing pause+human`);
    }
  }

  // Dispatch — suppression, sequence action, Telegram. Each step is wrapped
  // so a single failure doesn't poison the others.
  const seq = require('./sequence');
  const { addSuppression } = require('./suppression');

  // Suppression
  if (action.suppression && action.suppression_reason && fromEmailLower) {
    const target = action.suppression === 'domain' ? domainOf(fromEmailLower) : fromEmailLower;
    if (target) {
      try {
        await addSuppression(target, action.suppression_reason);
        actions.push(`suppressed ${target} (${action.suppression_reason})`);
      } catch (err) {
        actions.push(`suppression failed for ${target}: ${err.message}`);
      }
    }
  }

  // Sequence action
  if (sequenceId) {
    try {
      switch (action.sequence_action) {
        case 'pause':
          await seq.pauseSequence(sequenceId, action.ended_reason || 'awaiting_human');
          actions.push(`paused sequence ${sequenceId}`);
          break;
        case 'complete':
          await seq.completeSequence(sequenceId, action.ended_reason || 'completed');
          actions.push(`completed sequence ${sequenceId}`);
          break;
        case 'opt_out':
          await seq.optOutSequence(sequenceId);
          actions.push(`opted-out sequence ${sequenceId}`);
          break;
        case 'continue':
          // OOO auto-defer 7d.
          await seq.deferSequence(sequenceId, 7);
          actions.push(`deferred sequence ${sequenceId} +7d`);
          break;
      }
    } catch (err) {
      actions.push(`sequence action ${action.sequence_action} failed: ${err.message}`);
    }
  }

  // Sibling-pause for hostile/complaint at company level.
  if (action.flip_siblings && contact.prospect && contact.prospect.id) {
    try {
      const res = await seq.pauseSiblingsForCompany(contact.prospect.id, action.ended_reason || 'hostile_pause', sequenceId || null);
      actions.push(`flipped ${res.paused} sibling sequence(s) at prospect ${contact.prospect.id}`);
    } catch (err) {
      actions.push(`flip-siblings failed: ${err.message}`);
    }
  }

  // Telegram alert.
  if (action.telegram_alert) {
    try {
      const { sendNotification } = require('./telegram');
      const prefix = action.urgent ? '🚨 URGENT' : '📥';
      const headline = `${prefix} reply: <b>${intent}</b> (confidence ${confidence.toFixed(2)})`;
      const lines = [
        headline,
        `from: <code>${fromEmailLower || 'unknown'}</code>`,
        companyName ? `company: ${companyName}` : null,
        subject ? `subject: ${subject}` : null,
        '',
        body ? body.slice(0, 600) : '(empty body)',
      ].filter(v => v !== null).join('\n');
      await sendNotification(lines);
      actions.push('Telegram alert sent');
    } catch (err) {
      actions.push(`Telegram alert failed: ${err.message}`);
    }
  }

  // Final UPDATE: mark replies row processed. Migration 018 added
  // `confidence` + `classifier_reasoning` — persist them here so the
  // Pipeline tab can render a confidence badge without re-classifying.
  const { error: updErr } = await supabase
    .from('replies')
    .update({
      classified_intent: intent,
      requires_human: !!action.requires_human,
      processed_at: new Date().toISOString(),
      confidence: classification.confidence,
      classifier_reasoning: classification.reasoning,
    })
    .eq('id', replyId);
  if (updErr) {
    actions.push(`replies update failed: ${updErr.message}`);
    console.warn(`[inbound] replies update failed for ${replyId}: ${updErr.message}`);
  }

  console.log(`[inbound] reply ${replyId} processed: ${actions.join('; ')}`);
  return {
    ok: true,
    skipped: false,
    replyId,
    contactId: contact.id,
    sequenceId: sequenceId || null,
    intent,
    requires_human: !!action.requires_human,
    actions,
  };
}

module.exports = {
  handleInboundEmail,
  fetchInboundBody,
  matchSequenceForReply,
  OOO_CAP,
  _internals: { stripHtml, normaliseHeaders, extractResendIdsFromHeader, domainOf },
};
