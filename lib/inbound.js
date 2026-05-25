require('dotenv').config();

// ── Inbound email handler (Phase C) ───────────────────────────────────────
//
// Wires Resend's native inbound (`email.received` webhook event) through to
// our reply-classifier and the sequence/suppression action dispatcher.
//
// Called from lib/resend.js#handleWebhook — see the `case 'email.received'`
// branch. The webhook payload is metadata only (`{email_id, from, to, subject}`);
// the full body is fetched in-flight via `resend.emails.receiving.get(email_id)`.
//
// End-to-end flow (matches .ruflo/phase-c-design.md §3):
//
//   1. Receive event metadata; pull `email_id`, `from`, `subject`.
//   2. Fetch full body via Resend SDK (text + html headers).
//   3. Look up the contact by `fromEmail` (case-insensitive). If no match,
//      the reply is still inserted (sequence_id=NULL, contact_id NOT NULL is
//      required by migration 013 — so the no-contact case skips the row
//      insert and Telegram-alerts Simon to resolve manually).
//   4. Match the reply to a sequence — preferred path is the In-Reply-To /
//      References header (extract the message-id, look up the post by
//      `meta.resend_id`, then `meta.sequence_id`). Fallback: the contact's
//      most-recent active sequence.
//   5. INSERT into `replies` with `ON CONFLICT (resend_email_id) DO NOTHING`
//      (migration 015) — guarantees idempotency on Resend webhook retries.
//   6. Call `classifyReply` → {intent, confidence, reasoning}.
//   7. Resolve `requires_human` and the action via `lookupAction(intent)`
//      (PLUS the confidence-floor override: confidence < 0.6 forces
//      requires_human = true regardless).
//   8. Dispatch:
//      - sequence action via lib/sequence.{pause,complete,optOutSequence,...}
//      - suppression via lib/suppression.addSuppression when action says so
//      - Telegram alert via lib/telegram when action says so
//   9. UPDATE the replies row with classified_intent, requires_human,
//      processed_at = now().
//
// Errors at any post-insert step (classify, dispatch) leave the replies row
// with processed_at = NULL — migration 013's `idx_replies_unprocessed`
// makes a periodic re-processor cheap (not built in Phase C; coder may
// add a 1-line retry from server.js if useful).
//
// House style: lazy-load everything (Telegram, sequence, suppression) so the
// module is requireable in tests without the full env. British English in
// logs. NEVER log raw_body at info level — privacy + spam in CloudWatch.

/**
 * Process one `email.received` event from Resend.
 *
 * @param {object} eventData  the `data` field from the webhook envelope —
 *   shape: `{email_id, from, to, subject, created_at}` per Resend's
 *   event-types reference. May also include `headers` (Resend sometimes
 *   inlines them; not relied on — we re-fetch via the SDK).
 * @returns {Promise<{
 *   ok: boolean,
 *   skipped: boolean,           // true when the webhook was a duplicate
 *                                // (ON CONFLICT hit) — caller logs and moves on
 *   replyId: string|null,        // the inserted replies.id, or null on skip
 *   contactId: string|null,
 *   sequenceId: string|null,
 *   intent: string|null,         // the classified intent, or null if classify
 *                                // failed or no contact match
 *   requires_human: boolean,
 *   actions: string[],           // human-readable trace for the log line
 * }>}
 * @throws only on programmer error (missing event_id, undefined eventData).
 *   Network / Anthropic / Supabase errors are caught, logged, and surfaced
 *   via the returned `actions` array so a single inbound failure can't take
 *   down the webhook handler for sibling events.
 */
async function handleInboundEmail(eventData) {
  throw new Error('handleInboundEmail: not yet implemented — coder');
}

/**
 * Internal helper — fetch the full inbound body via Resend's receiving API.
 *
 * The webhook payload is metadata; the body is durably stored on Resend's
 * side and fetched on demand. SDK call:
 *   `client.emails.receiving.get(email_id)` → `{text, html, headers, from,
 *   to, cc, bcc, subject, created_at}`.
 *
 * Returns `{text, html, headers}` normalised. `body` is preferred-text;
 * falls back to a basic HTML strip when only `html` is present (cheap —
 * no DOM parser, just regex tag-strip; classifier is tolerant of stray
 * whitespace).
 *
 * @param {string} emailId  Resend's email_id from the webhook payload
 * @returns {Promise<{body: string, html: string|null, headers: object|null, raw: object}>}
 * @throws when emailId is falsy, or when the Resend SDK errors out.
 */
async function fetchInboundBody(emailId) {
  throw new Error('fetchInboundBody: not yet implemented — coder');
}

/**
 * Internal helper — match a reply to a sequence.
 *
 * Strategy:
 *   1. Try `headers['In-Reply-To']` and `headers['References']` for a
 *      message-id we can look up via `findPostByResendId` (already in
 *      lib/resend.js — coder imports it). The message-id format is
 *      `<resend_id@email.eu-west-1.amazonaws.com>` or similar; strip the
 *      angle-brackets and split on '@' to get the resend_id candidate.
 *      Match returns the post; `post.meta.sequence_id` is the sequence.
 *   2. Fallback: look up the most-recent active sequence for the contact
 *      (one row per (contact_id, track) is enforced; just pick by
 *      last_sent_at DESC LIMIT 1).
 *   3. Final fallback: return `{sequenceId: null, contactId}` — migration
 *      013 has `sequence_id REFERENCES sequences(id) ON DELETE SET NULL`
 *      so NULL is a valid row, and the Pipeline tab surfaces such rows
 *      under "unmatched replies" for Simon to resolve.
 *
 * @param {object} params
 * @param {string} params.contactId
 * @param {object} params.headers      raw mail headers from Resend
 * @returns {Promise<{sequenceId: string|null}>}
 */
async function matchSequenceForReply({ contactId, headers } = {}) {
  throw new Error('matchSequenceForReply: not yet implemented — coder');
}

module.exports = {
  handleInboundEmail,
  fetchInboundBody,
  matchSequenceForReply,
};
