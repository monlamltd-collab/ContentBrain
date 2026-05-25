require('dotenv').config();

// ── Resend send/events wrapper (Phase B) ──────────────────────────────────
//
// Two responsibilities:
//   1. sendOutbound(...)  — fire one outbound email via Resend's SDK.
//      Returns the Resend message id which the caller persists on
//      posts.meta.resend_id so webhook events can be matched back.
//      Suppression is checked HERE, not by the caller — belt-and-braces
//      so any future code path that ends up at sendOutbound gets the
//      same guarantee.
//
//   2. handleWebhook(event, headers, rawBody)
//      - Verifies the HMAC signature using RESEND_WEBHOOK_SECRET
//        (Resend signs every event with HMAC-SHA256 over the raw body
//        and sends the hex digest in `svix-signature` / `resend-signature`).
//      - Dispatches by event.type:
//          email.delivered  -> bump posts.meta.delivered_at
//          email.opened     -> bump posts.meta.opens
//          email.bounced    -> addSuppression(recipient, 'bounce')
//          email.complained -> addSuppression(recipient, 'complaint')
//          email.clicked    -> bump posts.meta.clicks (bonus)
//      - Throws on invalid signature (route handler returns 401).
//
// Required env: RESEND_API_KEY (send), RESEND_WEBHOOK_SECRET (verify).

const crypto = require('crypto');
const { Resend } = require('resend');
const { supabase } = require('./supabase');
const { isSuppressed, addSuppression, invalidateCache: invalidateSuppressionCache } = require('./suppression');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

// Lazy-instantiate so a missing key only errors when something tries to send,
// not on module load. The social cron path doesn't touch Resend.
let _client = null;
function getClient() {
  if (!RESEND_API_KEY) {
    throw new Error('Set RESEND_API_KEY in .env');
  }
  if (!_client) _client = new Resend(RESEND_API_KEY);
  return _client;
}

/**
 * Send one outbound email via Resend.
 *
 * @param {object} params
 * @param {string} params.to        recipient address
 * @param {string} params.from      from-address (with display name optional)
 * @param {string} params.subject
 * @param {string} params.body      plain-text body (Resend wraps to HTML)
 * @param {string} [params.replyTo]
 * @param {object} [params.headers] custom headers (List-Unsubscribe etc.)
 * @returns {Promise<{id: string, status: string}>}
 * @throws {Error} 'Suppressed: <to>' when recipient is on the block list;
 *   'Set RESEND_API_KEY in .env' if env missing; Resend errors otherwise.
 */
async function sendOutbound({ to, from, subject, body, replyTo, headers } = {}) {
  if (!to) throw new Error('sendOutbound: `to` is required');
  if (!from) throw new Error('sendOutbound: `from` is required');
  if (!subject) throw new Error('sendOutbound: `subject` is required');
  if (!body) throw new Error('sendOutbound: `body` is required');

  // Suppression check — belt-and-braces. publishToResend also checks (so we
  // can mark the post `suppressed` cleanly), but anyone who ends up here
  // via a different path still gets blocked.
  const supp = await isSuppressed(to);
  if (supp.suppressed) {
    throw new Error(`Suppressed: ${to} (matched ${supp.level} '${supp.match}' — ${supp.reason})`);
  }

  const client = getClient();

  // Standard List-Unsubscribe header so Gmail/Outlook show a one-click
  // unsubscribe option. Caller can override via headers param.
  const mergedHeaders = {
    'List-Unsubscribe': `<mailto:unsubscribe@${(from.match(/@([^>]+)>?$/) || [, 'bridgematch.co.uk'])[1]}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    ...(headers || {}),
  };

  const payload = {
    from,
    to: [to],
    subject,
    text: body,
    headers: mergedHeaders,
  };
  if (replyTo) payload.reply_to = replyTo;

  const { data, error } = await client.emails.send(payload);
  if (error) {
    // Don't log payload (contains body) — just the error.
    throw new Error(`Resend send failed for ${to}: ${error.message || JSON.stringify(error)}`);
  }
  console.log(`[resend] sent to ${to} (id=${data && data.id ? data.id : 'unknown'})`);
  return { id: data && data.id ? data.id : null, status: 'queued' };
}

// ── Webhook verification ────────────────────────────────────────────────
//
// Resend uses HMAC-SHA256 over the raw request body. The signature header
// is one of: `resend-signature` (older) or `svix-signature` (newer, since
// Resend moved to Svix). Both accepted — compare with timing-safe equality.
//
// If RESEND_WEBHOOK_SECRET isn't set, verification is treated as failed:
// fail-closed prevents an unconfigured deployment from accepting forged
// events (which would let an attacker mark contacts as bounced).

function verifySignature(rawBody, headers) {
  if (!RESEND_WEBHOOK_SECRET) {
    throw new Error('Set RESEND_WEBHOOK_SECRET in .env (webhook verification fails closed when missing)');
  }
  if (!rawBody) {
    throw new Error('Webhook verification: rawBody is required (configure express.raw on this route)');
  }

  const sigHeader = (headers && (headers['resend-signature'] || headers['svix-signature'])) || '';
  if (!sigHeader) {
    throw new Error('Webhook verification: missing resend-signature/svix-signature header');
  }

  const buf = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const expected = crypto.createHmac('sha256', RESEND_WEBHOOK_SECRET).update(buf).digest('hex');

  // Svix-style headers can carry multiple "v1,sig v1,sig2" parts; check each.
  const candidates = String(sigHeader)
    .split(/[\s,]+/)
    .map(part => part.includes('=') ? part.split('=').pop() : part)
    .filter(Boolean);

  for (const cand of candidates) {
    const candBuf = Buffer.from(cand, 'hex');
    const expBuf = Buffer.from(expected, 'hex');
    if (candBuf.length === expBuf.length && crypto.timingSafeEqual(candBuf, expBuf)) {
      return true;
    }
  }
  throw new Error('Webhook verification: signature mismatch');
}

/**
 * Process one Resend webhook event.
 *
 * @param {Buffer|string} rawBody  - the raw request body (Buffer ideally)
 * @param {object} headers         - request headers (lowercase keys)
 * @returns {Promise<{handled: boolean, type: string, actions: string[]}>}
 * @throws {Error} on signature mismatch / missing secret
 */
async function handleWebhook(rawBody, headers) {
  verifySignature(rawBody, headers);

  let event;
  try {
    const txt = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);
    event = JSON.parse(txt);
  } catch (err) {
    throw new Error(`Webhook body is not JSON: ${err.message}`);
  }

  const type = (event && event.type) || 'unknown';
  const data = (event && event.data) || {};
  // Resend's payload uses `email_id` (the message id we stored as resend_id).
  const resendId = data.email_id || data.id || null;
  const recipients = Array.isArray(data.to) ? data.to : (data.to ? [data.to] : []);
  const actions = [];

  switch (type) {
    case 'email.delivered': {
      if (resendId) {
        await mergeMetaByResendId(resendId, { delivered_at: new Date().toISOString() });
        actions.push(`marked post delivered_at for resend_id=${resendId}`);
      } else {
        actions.push('email.delivered without email_id — ignored');
      }
      break;
    }
    case 'email.opened': {
      if (resendId) {
        await incrementMetaCounter(resendId, 'opens');
        actions.push(`incremented opens for resend_id=${resendId}`);
      }
      break;
    }
    case 'email.clicked': {
      if (resendId) {
        await incrementMetaCounter(resendId, 'clicks');
        actions.push(`incremented clicks for resend_id=${resendId}`);
      }
      break;
    }
    case 'email.bounced': {
      for (const to of recipients) {
        try {
          await addSuppression(to, 'bounce');
          actions.push(`suppressed ${to} (bounce)`);
        } catch (err) {
          actions.push(`suppression add failed for ${to}: ${err.message}`);
        }
      }
      invalidateSuppressionCache();
      break;
    }
    case 'email.complained': {
      for (const to of recipients) {
        try {
          await addSuppression(to, 'complaint');
          actions.push(`suppressed ${to} (complaint)`);
        } catch (err) {
          actions.push(`suppression add failed for ${to}: ${err.message}`);
        }
      }
      invalidateSuppressionCache();
      break;
    }
    default:
      actions.push(`unhandled event type '${type}' — ignored`);
      console.log(`[resend webhook] unhandled type: ${type}`);
      return { handled: false, type, actions };
  }

  console.log(`[resend webhook] ${type}: ${actions.join('; ')}`);
  return { handled: true, type, actions };
}

// ── Helpers: post.meta mutations keyed on resend_id ─────────────────────

async function findPostByResendId(resendId) {
  const { data, error } = await supabase
    .from('posts')
    .select('id, meta')
    .filter('meta->>resend_id', 'eq', resendId)
    .maybeSingle();
  if (error) {
    console.warn(`[resend] findPostByResendId(${resendId}) failed: ${error.message}`);
    return null;
  }
  return data || null;
}

async function mergeMetaByResendId(resendId, patch) {
  const post = await findPostByResendId(resendId);
  if (!post) {
    console.warn(`[resend] no post found for resend_id=${resendId} — skipping meta patch`);
    return;
  }
  const meta = { ...(post.meta || {}), ...patch };
  const { error } = await supabase.from('posts').update({ meta }).eq('id', post.id);
  if (error) {
    console.warn(`[resend] meta patch failed for post ${post.id}: ${error.message}`);
  }
}

async function incrementMetaCounter(resendId, field) {
  const post = await findPostByResendId(resendId);
  if (!post) {
    console.warn(`[resend] no post found for resend_id=${resendId} — skipping ${field} increment`);
    return;
  }
  const meta = { ...(post.meta || {}) };
  meta[field] = (typeof meta[field] === 'number' ? meta[field] : 0) + 1;
  const { error } = await supabase.from('posts').update({ meta }).eq('id', post.id);
  if (error) {
    console.warn(`[resend] ${field} increment failed for post ${post.id}: ${error.message}`);
  }
}

module.exports = { sendOutbound, handleWebhook, verifySignature };
