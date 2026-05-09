// Lot of the Day — orchestration layer.
//
// Two stages:
//   1. runLotOfTheDay()        Pick lot, generate caption + voiceover script,
//                              insert posts row, send Telegram alert with the
//                              script and "reply with voice memo".
//   2. processVoiceForLot()    Triggered when Simon's voice reply arrives.
//                              Downloads, cleans, renders the LotVideo, sends
//                              the rendered MP4 back for the standard
//                              approve/revise/reject review.
//
// The state between stage 1 and stage 2 is tracked in posts.meta.awaiting_voice
// so a Railway redeploy in the gap doesn't lose the in-flight lot.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pickLotOfTheDay } = require('./lot-picker');
const { generateLotContent, ARCHETYPE_FRAMES } = require('./lot-content');
const { insertPost, supabase, getLot, findLotsByArchetype, hasFeaturedLot } = require('./supabase');
const { processVoiceover } = require('./audio-processor');
const { renderVideo } = require('./video-renderer');
const { sendNotification, sendPostForReview, downloadTelegramFile } = require('./telegram');

const VOICEOVER_DIR = path.join(__dirname, '..', 'public', 'voiceover');

const ARCHETYPE_EMOJI = {
  'best-yield': '\u{1F4C8}',
  'deepest-discount': '\u{1F3AF}',
  'dev-or-refurb': '\u{1F528}',
  'urgent': '\u{23F0}',
};

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[c]);
}

async function pickFromArchetype(archetype) {
  const candidates = await findLotsByArchetype(archetype, { limit: 30 });
  for (const lot of candidates) {
    if (await hasFeaturedLot(lot.id)) continue;
    return { lot, archetype, fallbackUsed: false };
  }
  throw new Error(`No qualifying candidate for forced archetype '${archetype}'`);
}

/**
 * Stage 1: pick a lot, generate content, insert a draft post, send the
 * Telegram script alert. Returns the inserted post row.
 */
async function runLotOfTheDay({ forceArchetype } = {}) {
  console.log('[lot-flow] runLotOfTheDay starting...');

  const pick = forceArchetype
    ? await pickFromArchetype(forceArchetype)
    : await pickLotOfTheDay();

  console.log(`[lot-flow] picked ${pick.lot.id} for archetype ${pick.archetype}${pick.fallbackUsed ? ' (fallback)' : ''}`);

  const content = await generateLotContent({ lot: pick.lot, archetype: pick.archetype });

  const post = await insertPost({
    brand: 'auctionbrain',
    platform: 'facebook',
    template_type: 'lot',
    copy_headline: content.hook_headline,
    copy_body: content.key_bullets.join('\n'),
    copy_cta: 'auctionbrain.co.uk',
    status: 'draft',
    meta: {
      lot_id: pick.lot.id,
      lot_address: pick.lot.address,
      lot_image_url: pick.lot.image_url,
      archetype: pick.archetype,
      fallback_used: pick.fallbackUsed,
      hook_headline: content.hook_headline,
      key_bullets: content.key_bullets,
      voiceover_script: content.voiceover_script,
      caption_facebook: content.caption_facebook,
      visual_style: content.visual_style,
      awaiting_voice: true,
    },
  });

  const archetypeLabel = ARCHETYPE_FRAMES[pick.archetype]?.label || pick.archetype;
  const facts = [
    pick.lot.price ? `Guide £${Math.round(pick.lot.price).toLocaleString('en-GB')}` : null,
    pick.lot.score ? `Score ${pick.lot.score}` : null,
    pick.lot.below_market ? `${pick.lot.below_market}% below market` : null,
    pick.lot.est_gross_yield ? `${Number(pick.lot.est_gross_yield).toFixed(1)}% yield` : null,
  ].filter(Boolean).join(' · ');

  const message = [
    `${ARCHETYPE_EMOJI[pick.archetype] || '\u{1F3AC}'} <b>Lot of the Day — ${escHtml(archetypeLabel)}</b>`,
    `${escHtml(pick.lot.address || '')}${pick.lot.postcode ? ' (' + escHtml(pick.lot.postcode) + ')' : ''}`,
    facts ? facts : null,
    '',
    `<b>Hook:</b> ${escHtml(content.hook_headline)}`,
    '',
    '<b>Voiceover script (60–90s):</b>',
    escHtml(content.voiceover_script),
    '',
    '\u{1F399} Reply to this message with a voice memo when you’re ready.',
    `Post id: <code>${post.id}</code>`,
  ].filter(line => line !== null).join('\n');

  await sendNotification(message);
  console.log(`[lot-flow] post ${post.id} inserted, awaiting voice memo`);
  return post;
}

/**
 * Find the most recent draft lot post awaiting a voice memo. Returns null if
 * none found. Used by the Telegram poll loop to route an inbound voice message.
 */
async function findPendingLotPost() {
  const { data, error } = await supabase
    .from('posts')
    .select('*')
    .eq('template_type', 'lot')
    .eq('status', 'draft')
    .filter('meta->>awaiting_voice', 'eq', 'true')
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw new Error(`findPendingLotPost failed: ${error.message}`);
  return data?.[0] || null;
}

/**
 * Stage 2: process Simon's voice reply.
 * - Download the voice file from Telegram
 * - Run audio-processor to clean
 * - Look up the lot row (need full lot fields for render)
 * - Render LotVideo
 * - Update posts row (video_url, awaiting_voice=false)
 * - Send rendered preview to Telegram for the standard review flow
 */
async function processVoiceForLot(post, telegramFileId) {
  console.log(`[lot-flow] processing voice for post ${post.id}, file ${telegramFileId}`);

  const rawFilename = `lot-${post.id}-raw.ogg`;
  const dl = await downloadTelegramFile(telegramFileId, rawFilename);
  console.log(`  Downloaded ${dl.sizeBytes} bytes to ${dl.outputPath}`);

  const processedFilename = `lot-${post.id}.mp3`;
  if (!fs.existsSync(VOICEOVER_DIR)) fs.mkdirSync(VOICEOVER_DIR, { recursive: true });
  const processedPath = processVoiceover(dl.outputPath, processedFilename);
  console.log(`  Processed audio: ${processedPath}`);

  const lotId = post.meta?.lot_id;
  if (!lotId) throw new Error(`post ${post.id} has no meta.lot_id — cannot render`);
  const lot = await getLot(lotId);

  const renderPost = {
    ...post,
    lot,
    archetype: post.meta?.archetype,
    hookHeadline: post.meta?.hook_headline,
    keyBullets: post.meta?.key_bullets,
    voiceoverFile: `voiceover/${processedFilename}`,
    overrideDurationSeconds: 75,
  };

  console.log('  Rendering LotVideo...');
  const rendered = await renderVideo('lot', 'auctionbrain', renderPost);
  console.log(`  Rendered: ${rendered.filename}`);

  const updatedMeta = { ...post.meta, awaiting_voice: false, voiceover_filename: processedFilename };
  const { error: updErr } = await supabase
    .from('posts')
    .update({ video_url: rendered.filename, meta: updatedMeta })
    .eq('id', post.id);
  if (updErr) throw new Error(`Failed to update post ${post.id}: ${updErr.message}`);

  const reviewPost = { ...post, video_url: rendered.filename, meta: updatedMeta };
  const sendResult = await sendPostForReview(reviewPost);
  if (!sendResult.ok) {
    console.error(`[lot-flow] sendPostForReview failed: ${sendResult.error}`);
    await sendNotification(`Render OK but couldn't send preview to Telegram: ${sendResult.error}`);
    return { ok: false, error: sendResult.error };
  }

  console.log(`[lot-flow] post ${post.id} preview sent for review`);
  return { ok: true, post: reviewPost };
}

module.exports = { runLotOfTheDay, findPendingLotPost, processVoiceForLot };
