// Phase G-3 — outbound + inbound HMAC for the Make boost integration.
//
// Mirrors the lib/resend.js verifySignature pattern (timing-safe compare,
// fails closed when secret unset). Two secrets used:
//
//   MAKE_WEBHOOK_SECRET   — outbound CB -> Make
//                            (signOutbound here; Make scenario step 2
//                             recomputes and compares to X-CB-Signature)
//   MAKE_CALLBACK_SECRET  — inbound Make -> CB
//                            (Make signs the body with this; verifyInbound
//                             here recomputes and timing-safe-compares to
//                             X-Make-Signature)
//
// Both digests are hex-encoded SHA-256, header format
//   X-CB-Signature: sha256=<hex>
//   X-Make-Signature: sha256=<hex>
// — matching the GitHub Webhooks convention so Make's webhook header
// inspector renders the value sensibly in the execution log.
//
// PR3 does NOT include replay protection (no timestamp / nonce). Both
// ends are TLS, callbacks carry a unique request_id (== boost_runs.id),
// and the reconcile endpoint is UPDATE-by-campaign-id so replay just
// overwrites with the same data. PR4 may add X-CB-Timestamp + ±5min
// tolerance if needed.
//
// Test surface — tests/social-engine/webhook-auth.test.js (coder writes):
//   - signOutbound throws when MAKE_WEBHOOK_SECRET unset
//   - signOutbound returns sha256=<hex of correct length> for known input
//   - verifyInbound throws when MAKE_CALLBACK_SECRET unset
//   - verifyInbound throws on missing header
//   - verifyInbound throws on signature mismatch
//   - verifyInbound returns true on match
//   - verifyInbound uses crypto.timingSafeEqual (length-mismatched header
//     does NOT throw via timingSafeEqual's RangeError — we pre-check length)

'use strict';

const crypto = require('crypto');

/**
 * Compute the X-CB-Signature header value for an outbound payload bound
 * for a Make webhook. The Make scenario re-computes the same digest
 * using its own MAKE_WEBHOOK_SECRET (set in the Data Store or as a
 * scenario encrypted variable) and rejects on mismatch.
 *
 * @param {string|Buffer} body  raw body bytes — must be the EXACT bytes
 *                              that go on the wire (no whitespace re-format
 *                              between sign and POST).
 * @returns {string}  e.g. "sha256=abc123..."
 * @throws {Error}  when MAKE_WEBHOOK_SECRET is unset
 */
function signOutbound(body) {
  // Stub for coder — read MAKE_WEBHOOK_SECRET, throw if unset,
  // crypto.createHmac('sha256', secret).update(body).digest('hex'),
  // return `sha256=${hex}`.
  throw new Error('NOT_IMPLEMENTED: signOutbound');
}

/**
 * Verify an inbound webhook callback from Make against the raw request
 * body. Fails closed (throws) when MAKE_CALLBACK_SECRET is unset so an
 * unconfigured deployment cannot accept forged callbacks.
 *
 * @param {Buffer|string} rawBody  the request body bytes — caller MUST
 *                                 register express.raw on the route so
 *                                 the bytes are not re-serialised.
 * @param {object} headers         express-lowercased request headers; the
 *                                 function looks up 'x-make-signature' (or
 *                                 'X-Make-Signature' as a fallback).
 * @returns {true}  on signature match
 * @throws {Error}  on missing secret / missing header / length mismatch /
 *                  digest mismatch — message includes "signature" or
 *                  "verification" so route handlers can 401 vs 500.
 */
function verifyInbound(rawBody, headers) {
  // Stub for coder — read MAKE_CALLBACK_SECRET, throw on unset.
  // Look up x-make-signature header (lowercase + capitalised fallback).
  // Compute expected = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`.
  // Pre-check length parity, then crypto.timingSafeEqual. Throw with
  // message containing 'signature mismatch' on either failure.
  throw new Error('NOT_IMPLEMENTED: verifyInbound');
}

module.exports = { signOutbound, verifyInbound };
