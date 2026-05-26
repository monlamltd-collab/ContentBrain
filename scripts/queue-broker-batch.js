#!/usr/bin/env node
//
// scripts/queue-broker-batch.js
//
// Generate N cold-open outbound emails for FCA-broker contacts and queue
// them in Telegram for review. N defaults to the broker-track warming
// day-1 cap (10).
//
// Selection: any contact at prospects where type='broker', ordered by
// email. Excludes already-queued contacts (any post with meta.contact_id
// = this contact's id) so re-running this script is safe.
//
// Usage:
//   node scripts/queue-broker-batch.js          (uses today's warming cap)
//   node scripts/queue-broker-batch.js 5        (queue exactly 5)

require('dotenv').config();

const { supabase } = require('../lib/supabase');
const { generateOutbound } = require('../lib/generate-outbound');
const { getRemainingBudget } = require('../lib/warming');

const TRACK = 'broker';
const TRACK_LABEL = 'BROKER OUTBOUND';

async function getAlreadyQueuedContactIds() {
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
  // Push the type filter INTO the SQL via prospects!inner(...).eq() — without
  // it the alphabetical email ordering brings other tracks' contacts in first
  // and consumes the SQL limit before any broker row is reached.
  const { data, error } = await supabase
    .from('contacts')
    .select(`
      id, name, role, email, confidence_score, prospect_id,
      prospect:prospects!inner ( id, type, company_name, website, metadata )
    `)
    .eq('prospect.type', TRACK)
    .gte('confidence_score', 50)
    .order('email')
    .limit(count + seen.size + 20);
  if (error) throw new Error(`pickBatch failed: ${error.message}`);

  const fresh = (data || []).filter(c => !seen.has(c.id));
  return fresh.slice(0, count);
}

async function queueOne(contact) {
  const prospect = contact.prospect;
  console.log(`\n[${contact.email}] generating cold open for ${prospect.company_name}...`);

  const generated = await generateOutbound(
    TRACK,
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
      track: TRACK,
      contact_id: contact.id,
      prospect_id: prospect.id,
      contact_email: contact.email,
      contact_name: contact.name,
      company_name: prospect.company_name,
      sequence_step: 1,
      generated_reasoning: generated.reasoning,
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
  await sendOutboundForReview(inserted);
  return inserted.id;
}

async function sendOutboundForReview(post) {
  const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
  const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
  if (!BOT_TOKEN || !CHAT_ID) {
    console.warn('  [Telegram] not configured — review queue skipped');
    return;
  }

  const meta = post.meta || {};
  const caption = [
    `<b>${TRACK_LABEL}</b> — ${meta.company_name || '?'}`,
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
    const budget = await getRemainingBudget(TRACK);
    count = budget.remaining;
    console.log(`Today's ${TRACK} warming budget: day ${budget.day}, cap ${budget.cap}, sent ${budget.sentToday}, remaining ${budget.remaining}`);
  }

  if (count <= 0) {
    console.log('Nothing to queue (budget exhausted).');
    return;
  }

  const batch = await pickBatch(count);
  if (!batch.length) {
    console.log(`Nothing to queue (no unqueued ${TRACK} contacts left).`);
    return;
  }

  console.log(`Queuing ${batch.length} ${TRACK} cold opens...`);
  let ok = 0, fail = 0;
  for (const c of batch) {
    try { await queueOne(c); ok++; }
    catch (err) { console.error(`  [${c.email}] FAILED: ${err.message}`); fail++; }
  }
  console.log(`\nDone. ${ok} queued, ${fail} failed. Check your Telegram for review.`);
})();
