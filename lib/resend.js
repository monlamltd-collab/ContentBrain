require('dotenv').config();

// ── Resend send/events wrapper (Phase B) ──────────────────────────────────
//
// Two responsibilities:
//   1. sendOutbound(...)  — fire one outbound email via Resend's REST API
//      (or the `resend` npm SDK; coder picks — npm sdk is the cleaner choice).
//      Returns the Resend message id, which the caller persists on
//      posts.meta.resend_id so webhook events can be matched back.
//
//   2. handleWebhook(event) — normalise a Resend event payload into a
//      shape the rest of ContentBrain can consume:
//        - 'email.delivered'  -> increment posts.meta.delivered_at
//        - 'email.opened'     -> increment posts.meta.opens
//        - 'email.clicked'    -> increment posts.meta.clicks
//        - 'email.bounced'    -> mark contact undeliverable +
//                                suppression.addSuppression(email, 'hard_bounce')
//        - 'email.complained' -> suppression.addSuppression(domain, 'spam_complaint')
//                                + pause every active sequence to that prospect
//                                + Telegram alert
//        - 'email.replied'    -> Phase C: store in replies table + classify
//
// Required env: RESEND_API_KEY, RESEND_FROM_DEFAULT (e.g.
// "Simon @ BridgeMatch <simon@outreach.bridgematch.co.uk>"),
// RESEND_WEBHOOK_SECRET (HMAC verification — Resend signs every event).
//
// Deliverability auto-pause (Quality Control rule from GROWTH_BRAIN_BUILD.md
// line 116) lives in this module: a rolling counter of spam/bounce rates
// per track triggers a track-wide pause. The counter implementation is
// the coder's call (in-memory rolling window or a Supabase view).

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_DEFAULT = process.env.RESEND_FROM_DEFAULT;
const RESEND_WEBHOOK_SECRET = process.env.RESEND_WEBHOOK_SECRET;

/**
 * Send one outbound email via Resend. Caller is responsible for filter
 * checks (lib/outbound-filters.runFilters) and suppression checks
 * (lib/suppression.isSuppressed) BEFORE calling this — sendOutbound assumes
 * the message is approved-to-send.
 *
 * @param {object} params
 * @param {string} params.to        - Recipient email address.
 * @param {string} [params.from]    - Override the default from-address.
 *                                    Defaults to RESEND_FROM_DEFAULT.
 * @param {string} params.subject
 * @param {string} params.body      - Plain text. HTML wrapper is added by
 *                                    Resend; we keep outbound plain-text-first
 *                                    for deliverability.
 * @param {string} [params.replyTo] - Inbox we want replies routed to (so
 *                                    replies land on the Resend webhook, not
 *                                    the from-address inbox).
 * @param {object} [params.headers] - Extra custom headers (e.g. List-Unsubscribe).
 * @returns {Promise<{
 *   id: string,           // Resend message id — persist on posts.meta.resend_id
 *   to: string,
 *   from: string,
 *   created_at: string
 * }>}
 * @throws {Error} if RESEND_API_KEY is unset, Resend returns a non-2xx, or
 *   `to` is missing.
 */
async function sendOutbound({ to, from, subject, body, replyTo, headers } = {}) {
  // TODO(coder):
  //   1. Validate RESEND_API_KEY set and `to` non-empty.
  //   2. Resolve `from` from arg → RESEND_FROM_DEFAULT.
  //   3. Build Resend payload — { from, to, subject, text: body, reply_to,
  //      headers: { 'List-Unsubscribe': '<mailto:...>, <https://...>', ...headers } }.
  //   4. POST to Resend (`resend` SDK preferred — cleaner than raw fetch).
  //   5. Add a List-Unsubscribe-Post header so Gmail one-click works.
  //   6. Return the shape above.
  void to; void from; void subject; void body; void replyTo; void headers;
  void RESEND_API_KEY; void RESEND_FROM_DEFAULT;
  throw new Error('sendOutbound not implemented yet — see TODO(coder)');
}

/**
 * Process one Resend webhook event. The HTTP route should:
 *   1. Verify the HMAC signature with RESEND_WEBHOOK_SECRET (do this in the
 *      route handler before calling this function, so we can return 401
 *      without parsing the body).
 *   2. Call handleWebhook(event).
 *   3. Always return 200 once handleWebhook resolves — Resend retries on
 *      non-2xx, so swallow internal errors and log them. handleWebhook
 *      never throws on a recognised event.
 *
 * @param {object} event - Resend event payload.
 *   { type: 'email.opened'|'email.clicked'|..., data: { email_id, to, ... } }
 * @returns {Promise<{
 *   handled: boolean,        // false for unrecognised event types
 *   type: string,
 *   resendMessageId: string|null,
 *   actions: string[]        // human-readable trace of what we did
 * }>}
 */
async function handleWebhook(event) {
  // TODO(coder):
  //   - Match event.type against the list in this file's header comment.
  //   - For each handled type, perform the documented side-effect:
  //     opens/clicks  -> update posts.meta counters by resend_id
  //     bounced       -> contacts.verified_at = NULL + suppression
  //     complained    -> suppression + pause sequences + Telegram alert
  //     replied       -> Phase C only; for Phase B log + ignore
  //   - Update the deliverability rolling counter (track-level).
  //   - Return the shape above; never throw on an unknown event.type.
  void event;
  void RESEND_WEBHOOK_SECRET;
  throw new Error('handleWebhook not implemented yet — see TODO(coder)');
}

module.exports = { sendOutbound, handleWebhook };
