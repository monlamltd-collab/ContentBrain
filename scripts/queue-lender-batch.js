#!/usr/bin/env node
//
// scripts/queue-lender-batch.js
//
// Generate N cold-open outbound emails for BDM contacts and queue them in
// Telegram for review. N defaults to the warming day-1 cap (10) — running
// once a day until the steady-state cap kicks in (day 30+).
//
// Selection: BDM contacts (confidence_score=80) at lender prospects, ordered
// by company_name. Excludes already-queued contacts (any post with
// meta.contact_id = this contact's id) so re-running this script is safe.
//
// Usage:
//   node scripts/queue-lender-batch.js          (uses today's warming cap)
//   node scripts/queue-lender-batch.js 5        (queue exactly 5)
//
// Outputs a one-line summary per queued post and a totals tally.

require('dotenv').config();

const { supabase } = require('../lib/supabase');
const { generateOutbound } = require('../lib/generate-outbound');
const { sendPostForReview } = require('../lib/telegram');
const { getRemainingBudget } = require('../lib/warming');

async function getAlreadyQueuedContactIds() {
  // Any post whose meta.contact_id is set — draft, approved, published,
  // suppressed all count (we don't want to re-queue).
  const { data, error } = await supabase
    .from('posts')
    .select('meta')
    .eq('track', 'outbound')
    .not('meta', 'is', null);
  if (error) throw new Error(`getAlreadyQueued failed: ${error.message}`);
  const ids = new Set();
  for (const row of data || []) {
    if (row.meta && row.meta.contact_id) ids.add(row.meta.contact_id);
  }
  return ids;
}

async function pickBatch(count) {
  const seen = await getAlreadyQueuedContactIds();

  const { data, error } = await supabase
    .from('contacts')
    .select(`
      id, name, role, email, confidence_score, prospect_id,
      prospect:prospects!inner ( id, type, company_name, website, metadata )
    `)
    .eq('confidence_score', 80)
    .order('email')
    .limit(count + seen.size + 5);  // overshoot to skip seen
  if (error) throw new Error(`pickBatch failed: ${error.message}`);

  const fresh = (data || []).filter(c => !seen.has(c.id) && c.prospect && c.prospect.type === 'lender');
  return fresh.slice(0, count);
}

async function queueOne(contact) {
  const prospect = contact.prospect;
  console.log(`\n[${contact.email}] generating cold open for ${prospect.company_name}...`);

  const generated = await generateOutbound(
    'lender',
    { id: contact.id, name: contact.name, role: contact.role, email: contact.email, prospect_id: prospect.id },
    prospect,
    1
  );

  console.log(`  subject: ${generated.subject}`);

  const post = {
    brand: 'bridgematch',
    template_type: 'outbound',
    status: 'draft',
    track: 'outbound',
    channel: 'resend',
    platform: null,
    copy_headline: generated.subject,
    copy_body: generated.body,
    copy_cta: '',
    meta: {
      track: 'lender',
      contact_id: contact.id,
      prospect_id: prospect.id,
      contact_email: contact.email,
      contact_name: contact.name,
      company_name: prospect.company_name,
      sequence_step: 1,
      generated_reasoning: generated.reasoning,
      // Phase C: full contact + prospect snapshots so publishToResend can
      // call createSequenceOnPublish without a separate Supabase round-trip.
      contact: {
        id: contact.id,
        name: contact.name,
        role: contact.role,
        email: contact.email,
        prospect_id: prospect.id,
      },
      prospect: {
        id: prospect.id,
        type: prospect.type,
        company_name: prospect.company_name,
        website: prospect.website,
        metadata: prospect.metadata,
      },
    },
  };

  const { data: inserted, error } = await supabase
    .from('posts')
    .insert(post)
    .select()
    .single();
  if (error) throw new Error(`insert post failed: ${error.message}`);

  console.log(`  inserted post ${inserted.id}, queuing in Telegram...`);

  // Customise the Telegram review caption so the OUTBOUND callback path is hit
  // (cb:outbound-approve / cb:outbound-reject) rather than the social one.
  // sendPostForReview reads from post.id + post.copy_*; outbound callbacks
  // are wired in server.js's cmdTokens dispatcher.
  await sendOutboundForReview(inserted);

  return inserted.id;
}

// Direct copy of sendPostForReview shape but uses cb:outbound-approve /
// cb:outbound-reject so the Telegram handler routes via publishToResend.
async function sendOutboundForReview(post) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('  [Telegram] not configured — review queue skipped');
    return;
  }

  const meta = post.meta || {};
  const caption = [
    `<b>LENDER OUTBOUND</b> — ${meta.company_name || '?'}`,
    `to: ${meta.contact_name || ''} &lt;${meta.contact_email}&gt;`,
    '',
    `<b>${post.copy_headline}</b>`,
    '',
    post.copy_body,
  ].join('\n');

  const buttons = {
    inline_keyboard: [[
      { text: 'Approve & send', callback_data: `cb:outbound-approve:${post.id}` },
      { text: 'Reject',         callback_data: `cb:outbound-reject:${post.id}` },
    ]],
  };

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: CHAT_ID, text: caption, parse_mode: 'HTML', reply_markup: buttons }),
  });
  if (!res.ok) {
    const err = await res.text();
    console.warn(`  [Telegram] sendMessage failed (${res.status}): ${err.slice(0, 200)}`);
  }
}

(async () => {
  const argCount = parseInt(process.argv[2], 10);
  let count;
  if (Number.isFinite(argCount) && argCount > 0) {
    count = argCount;
  } else {
    const budget = await getRemainingBudget('lender');
    count = budget.remaining;
    console.log(`Today's lender warming budget: day ${budget.day}, cap ${budget.cap}, sent ${budget.sentToday}, remaining ${budget.remaining}`);
  }

  if (count <= 0) {
    console.log('Nothing to queue (budget exhausted).');
    return;
  }

  const batch = await pickBatch(count);
  if (!batch.length) {
    console.log('Nothing to queue (no unqueued BDM contacts left).');
    return;
  }

  console.log(`Queuing ${batch.length} lender cold opens...`);
  let ok = 0;
  let fail = 0;
  for (const c of batch) {
    try {
      await queueOne(c);
      ok++;
    } catch (err) {
      console.error(`  [${c.email}] FAILED: ${err.message}`);
      fail++;
    }
  }
  console.log(`\nDone. ${ok} queued, ${fail} failed. Check your Telegram for review.`);
})();
