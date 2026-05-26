'use strict';

// ── PHASE E — Quiet Telegram receipt for outbound sends ──────────────────
//
// Called from lib/publish.js#publishToResend on send success. Pings
// Telegram with a one-liner ("Sent: <subject> → <recipient>") so Simon
// can verify a desk-approved send from his phone. No buttons — pure
// notification. Toggleable via:
//   app_config WHERE brand='global' AND key='dashboard.send_telegram_receipt'
//   value=true (default) | false
//
// The default is TRUE. A missing row, a malformed value, or a Supabase
// read error all degrade to "send the receipt anyway" — the failure
// mode here is "Simon sees an extra notification" which is fine; the
// opposite (silently swallow the receipt when he wants it) is worse.

const { supabase } = require('./supabase');
const { sendNotification } = require('./telegram');

/**
 * Look up the app_config gate. Returns true unless the row exists AND
 * explicitly says false.
 *
 * @returns {Promise<boolean>}
 */
async function isReceiptEnabled() {
  try {
    const { data, error } = await supabase
      .from('app_config')
      .select('value')
      .eq('brand', 'global')
      .eq('key', 'dashboard.send_telegram_receipt')
      .maybeSingle();
    if (error) {
      console.warn(`[outbound-receipt] app_config read failed (defaulting ON): ${error.message}`);
      return true;
    }
    if (!data) return true;
    // value is jsonb — tolerate both bool and string forms.
    const v = data.value;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'string')  return v.trim().toLowerCase() !== 'false';
    return true;
  } catch (err) {
    console.warn(`[outbound-receipt] isReceiptEnabled threw: ${err.message}`);
    return true;
  }
}

/**
 * Send a quiet "Sent: …" receipt to Telegram. Returns the underlying
 * sendNotification truthiness (or false when the gate is off / Telegram
 * isn't configured).
 *
 * @param {{ subject: string, to: string }} payload
 * @returns {Promise<boolean>}
 */
async function sendOutboundReceipt({ subject, to }) {
  if (!(await isReceiptEnabled())) return false;
  const safeSubject = String(subject || '(no subject)').slice(0, 200);
  const safeTo = String(to || '(no recipient)');
  return sendNotification(`Sent: ${safeSubject} → ${safeTo}`);
}

module.exports = { sendOutboundReceipt, isReceiptEnabled };
