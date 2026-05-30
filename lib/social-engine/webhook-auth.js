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
// Plus a third helper:
//   verifyOutbound — used by routes that act as the read endpoint Make
//                    POLLS (e.g. GET /api/social-boost-active). Make signs
//                    with MAKE_WEBHOOK_SECRET (the outbound-from-CB secret)
//                    and sends X-CB-Signature. This is the mirror image of
//                    verifyInbound — same shape, different secret + header.
//                    Supports a query-string ?sig= fallback because Make's
//                    HTTP module is easier to configure with a query param
//                    on a GET than a custom header.
//
// All digests are hex-encoded SHA-256, header format
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

'use strict';

const crypto = require('crypto');

function computeHexDigest(secret, body) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : body);
  return crypto.createHmac('sha256', secret).update(buf).digest('hex');
}

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
  const secret = process.env.MAKE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('Set MAKE_WEBHOOK_SECRET in env — refuse to send unsigned webhook');
  }
  return `sha256=${computeHexDigest(secret, body)}`;
}

/**
 * Shared verifier — reads an `sha256=<hex>` header and timing-safe-compares
 * against the expected digest computed with the provided secret.
 *
 * @param {string} secret             the HMAC secret
 * @param {Buffer|string} rawBody     raw body bytes
 * @param {string|undefined} sigHeader  the candidate header value
 * @returns {true} on match
 * @throws {Error} on missing header / length mismatch / digest mismatch
 */
function verifyDigestHeader(secret, rawBody, sigHeader) {
  if (!sigHeader) {
    throw new Error('Webhook verification: missing signature header');
  }
  const expectedHeader = `sha256=${computeHexDigest(secret, rawBody)}`;
  const a = Buffer.from(expectedHeader);
  const b = Buffer.from(String(sigHeader));
  if (a.length !== b.length) {
    throw new Error('Webhook verification: signature mismatch');
  }
  if (!crypto.timingSafeEqual(a, b)) {
    throw new Error('Webhook verification: signature mismatch');
  }
  return true;
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
  const secret = process.env.MAKE_CALLBACK_SECRET;
  if (!secret) {
    throw new Error('Set MAKE_CALLBACK_SECRET in env — refuse to accept unverified callback');
  }
  if (rawBody == null) {
    throw new Error('Webhook verification: rawBody is required (configure express.raw on this route)');
  }
  const sigHeader = headers && (headers['x-make-signature'] || headers['X-Make-Signature']);
  return verifyDigestHeader(secret, rawBody, sigHeader);
}

/**
 * Verify a request from Make to a CB endpoint where Make is the CLIENT
 * (e.g. Make's reconcile scenario pulling /api/social-boost-active). Make
 * signs with the outbound-from-CB secret (MAKE_WEBHOOK_SECRET) so the
 * Make-side config can reuse the same Data Store key for both the
 * outbound-verify-from-CB step AND this outbound-sign-to-CB step.
 *
 * Looks up `x-cb-signature` header first, falling back to a query-string
 * sig parameter. Empty body is fine — pass Buffer.alloc(0) for GETs.
 *
 * @param {Buffer|string} rawBody     raw body bytes (empty Buffer for GETs)
 * @param {object} headers            request headers
 * @param {string|undefined} querySig optional query-string ?sig= value
 * @returns {true} on match
 * @throws {Error} on missing secret / missing signature / mismatch
 */
function verifyOutbound(rawBody, headers, querySig) {
  const secret = process.env.MAKE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('Set MAKE_WEBHOOK_SECRET in env — refuse to accept unverified outbound poll');
  }
  if (rawBody == null) {
    throw new Error('Webhook verification: rawBody is required (pass Buffer.alloc(0) for empty GETs)');
  }
  const headerSig = headers && (headers['x-cb-signature'] || headers['X-CB-Signature']);
  const sig = headerSig || querySig;
  return verifyDigestHeader(secret, rawBody, sig);
}

module.exports = { signOutbound, verifyInbound, verifyOutbound };
