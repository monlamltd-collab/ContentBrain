// lib/telegram-handlers/index.js — the Telegram bot polling loop.
//
// Pure move out of server.js (decomposition step 3.3). pollTelegram() is
// moved VERBATIM with one mechanical change: module-level `let` state now
// lives on the shared `state` object from ./state (state.telegramOffset,
// state.pollLastAt/Count/Error, state.pendingRevision/Schedule/RejectionQueue/Brief)
// so /diag and the startup sequence observe live values.
//
// NEXT DECOMPOSITION STEP (not done here — needs logic surgery, not a pure
// move): split the for-loop body into callbacks.js (callback_query branch)
// and messages.js (video/photo/voice/text handlers). The body's `continue`
// statements bind to the update loop, so extraction requires converting
// them to returns inside per-update handler functions.

require('dotenv').config();
const path = require('path');
const { createLLM, parseLLMJson } = require('../llm');
const {
  getDraftPosts, getApprovedPosts, updatePostStatus, getPostById, saveBrief,
  insertPost, saveSeed, getDraftBlogPosts, updateBlogPostStatus, getBlogPostById,
} = require('../supabase');
const { publish } = require('../publish');
const {
  sendPostForReview, sendNotification, answerCallback, removeButtons,
  downloadTelegramFile, API, BOT_TOKEN, CHAT_ID,
} = require('../telegram');
const runtimeConfig = require('../runtime-config');
const authorsLib = require('../authors');
const { templateTypes } = require('../config');
const { handleLeverCommand } = require('../lever-commands');
const { state, addToHistory, getHistoryContext, getDiagnostics } = require('./state');
const { findPostAnywhere, reviseBlogPost } = require('./revise');

// HTML-escape user-supplied strings before echoing them in Telegram
// notifications (sendNotification uses parse_mode HTML).
function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function pollTelegram() {
  if (!BOT_TOKEN) return;

  state.pollCount++;
  state.pollLastAt = Date.now();
  state.pollLastError = null;

  try {
    const res = await fetch(`${API}/getUpdates?offset=${state.telegramOffset}&timeout=30&allowed_updates=["callback_query","message"]`);
    if (!res.ok) {
      // Don't bare-return here — that skips the setTimeout(pollTelegram, 1000)
      // at the bottom and PERMANENTLY kills the poll loop. Process is alive
      // (Express still answers /health) but no callback_query / message
      // updates ever get processed again. This stale-poll-loop bug had us
      // chasing "the buttons don't work" for hours. Telegram returns non-OK
      // for plenty of recoverable reasons: 502/504 transients, 409 Conflict
      // when another poller briefly overlaps a redeploy, 429 rate-limit on
      // bursty traffic. All of those should just retry on the next tick.
      console.warn(`[Telegram] getUpdates HTTP ${res.status}; will retry`);
      throw new Error(`getUpdates HTTP ${res.status}`);
    }

    const { result } = await res.json();
    const offsetBeforeBatch = state.telegramOffset;
    for (const update of result) {
      state.telegramOffset = update.update_id + 1;

      // Handle approve/reject button presses
      const cb = update.callback_query;
      if (cb && cb.data) {
        const parts = cb.data.split(':');

        // rv:<type>:<brandCode>:<action>:<id>  — review hub callbacks with brand routing
        // rv:<type>:<action>:<id>              — legacy 4-part format (AB only), kept for backward compat
        if (parts[0] === 'rv' && (parts.length === 4 || parts.length === 5)) {
          let contentType, brandCode, rvAction, rvId;
          if (parts.length === 5) {
            [, contentType, brandCode, rvAction, rvId] = parts;
          } else {
            [, contentType, rvAction, rvId] = parts;
            brandCode = 'ab'; // legacy messages default to AuctionBrain
          }
          const brand = brandCode === 'bm' ? 'bridgematch' : 'auctionbrain';

          if (rvId && rvAction === 'approve') {
            try {
              // Idempotency guard — double-click or replayed update must not
              // re-approve (and must not create a duplicate cross-pollinate seed).
              const existing = await getBlogPostById(rvId, brand).catch(() => null);
              if (existing && existing.status && existing.status !== 'draft') {
                await answerCallback(cb.id, `Already ${existing.status}`);
                continue;
              }

              await updateBlogPostStatus(rvId, 'approved', {}, brand);
              const originalCaption = cb.message?.caption || cb.message?.text || '';
              await removeButtons(cb.message.chat.id, cb.message.message_id, `${originalCaption}\n\nAPPROVED`);
              await answerCallback(cb.id, `${contentType} approved`);

              // Cross-pollinate: create seed from approved blog/guide
              try {
                const blogPost = await getBlogPostById(rvId, brand);
                await saveSeed({
                  source: 'blog_approved',
                  summary: `New ${contentType}: ${blogPost.title}`,
                  key_points: blogPost.summary || blogPost.meta_description || '',
                  brand: blogPost.brand || brand,
                  tags: blogPost.tags || []
                });
                console.log(`[Cross-pollinate] Seed created from ${contentType}: ${blogPost.title}`);
              } catch (seedErr) {
                console.error(`[Cross-pollinate] Seed creation failed: ${seedErr.message}`);
              }

              console.log(`[Telegram] ${brand} ${contentType} ${rvId} approved`);
            } catch (err) {
              console.error(`[Telegram] Error handling approve: ${err.message}`);
              await answerCallback(cb.id, 'Error — try again');
            }
          }

          if (rvId && rvAction === 'reject') {
            // Push to queue — rapid multi-reject no longer overwrites the first.
            // Only prompt for a reason when the queue was empty (i.e. this is the
            // first pending rejection); subsequent ones prompt after each answer.
            // Dedupe: a double-click on the same post must not queue it twice.
            if (state.pendingRejectionQueue.some(r => r.postId === rvId)) {
              await answerCallback(cb.id, 'Already queued — reply with your reason');
              continue;
            }
            const wasEmpty = state.pendingRejectionQueue.length === 0;
            state.pendingRejectionQueue.push({
              type: contentType,
              postId: rvId,
              chatId: cb.message.chat.id,
              messageId: cb.message.message_id,
              brand,
              contentType,
              originalCaption: cb.message?.caption || cb.message?.text || ''
            });
            await answerCallback(cb.id, 'Why?');
            if (wasEmpty) {
              await sendNotification("Why are you rejecting this? A sentence or two helps the next round avoid the same mistake.\n\nReply with your reason, or send <i>'skip'</i> to reject without feedback.");
            }
            console.log(`[Telegram] Rejection reason requested for ${brand} ${contentType} ${rvId}`);
          }

          if (rvId && rvAction === 'revise') {
            state.pendingRevision = { postId: rvId, chatId: cb.message.chat.id, messageId: cb.message.message_id, contentType, brand };
            await answerCallback(cb.id, 'Send your feedback');
            await sendNotification('What would you like changed? Reply with your feedback.');
            console.log(`[Telegram] Revision requested for ${brand} ${contentType} ${rvId}`);
          }

          if (rvId && rvAction === 'schedule') {
            state.pendingSchedule = {
              type: contentType,
              postId: rvId,
              chatId: cb.message.chat.id,
              messageId: cb.message.message_id,
              brand,
              originalCaption: cb.message?.caption || cb.message?.text || ''
            };
            await answerCallback(cb.id, 'When?');
            await sendNotification("When should this go live?\n\nExamples: <i>'tomorrow 9am'</i>, <i>'next Tuesday at 10:30'</i>, <i>'in 3 hours'</i>, <i>'2026-05-12 14:00'</i>");
            console.log(`[Telegram] Schedule prompt for ${brand} ${contentType} ${rvId}`);
          }

          continue;
        }

        // cb:<action>:<id> or legacy <action>:<id> — social post callbacks
        let action, postId;
        if (parts.length === 3 && parts[0] === 'cb') {
          action = parts[1];
          postId = parts[2];
        } else {
          action = parts[0];
          postId = parts[1];
        }

        // Phase B — outbound (Resend) approve/reject. Routed BEFORE the
        // social approve/reject branch so the outbound-specific publish
        // path (cb:outbound-approve = approve AND send immediately, no
        // scheduling delay) wins over the generic social one.
        if (postId && action === 'outbound-approve') {
          try {
            const { publish } = require('../publish');
            const post = await getPostById(postId);
            if (!post) throw new Error(`post ${postId} not found`);
            // Idempotency guard — a double-click or replayed update here would
            // SEND A DUPLICATE EMAIL to a prospect. Only drafts may proceed.
            if (post.status && post.status !== 'draft') {
              await answerCallback(cb.id, `Already ${post.status} — no email sent`);
              continue;
            }
            await updatePostStatus(postId, 'approved');
            // Re-read post so the publish path sees status=approved + the
            // meta we approved on.
            const approvedPost = await getPostById(postId);
            const result = await publish(approvedPost);
            const originalCaption = cb.message?.caption || cb.message?.text || '';
            let trailer;
            let toast;
            if (result.suppressed) {
              trailer = `\n\nAPPROVED · SUPPRESSED (${result.reason})`;
              toast = 'Suppressed';
            } else if (result.deferred) {
              const b = result.budget;
              const detail = b ? ` (day ${b.day}, cap ${b.cap}, sent ${b.sentToday})` : '';
              trailer = `\n\nAPPROVED · DEFERRED — ${result.reason}${detail} · cron retries tomorrow`;
              toast = 'Deferred (warming)';
            } else {
              trailer = `\n\nAPPROVED · SENT (resend_id=${result.resendId || 'n/a'})`;
              toast = 'Sent';
            }
            await removeButtons(cb.message.chat.id, cb.message.message_id, `${originalCaption}${trailer}`);
            await answerCallback(cb.id, toast);
            console.log(`[Telegram] Outbound post ${postId} approved+sent`);
          } catch (err) {
            console.error(`[Telegram] Outbound approve failed for ${postId}: ${err.message}`);
            await answerCallback(cb.id, 'Error — see logs');
            try { await sendNotification(`Outbound send failed for ${postId}: ${err.message.slice(0, 200)}`); } catch {}
          }
          continue;
        }

        if (postId && action === 'outbound-reject') {
          // Reuse the same rejection-reason capture flow as social — the
          // text-message handler downstream already updates posts.status='rejected'
          // with the captured feedback. Outbound posts share the posts table
          // so the existing branch handles them.
          if (state.pendingRejectionQueue.some(r => r.postId === postId)) {
            await answerCallback(cb.id, 'Already queued — reply with your reason');
            continue;
          }
          const wasEmptyOutbound = state.pendingRejectionQueue.length === 0;
          state.pendingRejectionQueue.push({
            type: 'social', // reuses the social rejection branch (posts table)
            postId,
            chatId: cb.message.chat.id,
            messageId: cb.message.message_id,
            originalCaption: cb.message?.caption || cb.message?.text || ''
          });
          await answerCallback(cb.id, 'Why?');
          if (wasEmptyOutbound) {
            await sendNotification("Why are you rejecting this outbound message? A sentence or two helps the next round avoid the same mistake.\n\nReply with your reason, or send <i>'skip'</i> to reject without feedback.");
          }
          console.log(`[Telegram] Outbound rejection reason requested for ${postId}`);
          continue;
        }

        if (postId && action === 'approve') {
          try {
            // Idempotency guard — double-click must not re-approve.
            const existing = await getPostById(postId).catch(() => null);
            if (existing && existing.status && existing.status !== 'draft') {
              await answerCallback(cb.id, `Already ${existing.status}`);
              continue;
            }
            await updatePostStatus(postId, 'approved');
            const originalCaption = cb.message?.caption || cb.message?.text || '';
            await removeButtons(cb.message.chat.id, cb.message.message_id, `${originalCaption}\n\nAPPROVED`);
            await answerCallback(cb.id, 'Post approved');
            console.log(`[Telegram] Post ${postId} approved`);
          } catch (err) {
            console.error(`[Telegram] Error handling approve: ${err.message}`);
            await answerCallback(cb.id, 'Error — try again');
          }
        }

        if (postId && action === 'reject') {
          // Same as blog/guide reject — capture a reason so future generation
          // learns from this failure mode. Text-message handler processes the reply.
          if (state.pendingRejectionQueue.some(r => r.postId === postId)) {
            await answerCallback(cb.id, 'Already queued — reply with your reason');
            continue;
          }
          const wasEmptySocial = state.pendingRejectionQueue.length === 0;
          state.pendingRejectionQueue.push({
            type: 'social',
            postId,
            chatId: cb.message.chat.id,
            messageId: cb.message.message_id,
            originalCaption: cb.message?.caption || cb.message?.text || ''
          });
          await answerCallback(cb.id, 'Why?');
          if (wasEmptySocial) {
            await sendNotification("Why are you rejecting this? A sentence or two helps the next round avoid the same mistake.\n\nReply with your reason, or send <i>'skip'</i> to reject without feedback.");
          }
          console.log(`[Telegram] Rejection reason requested for social ${postId}`);
        }

        if (postId && action === 'revise') {
          state.pendingRevision = { postId, chatId: cb.message.chat.id, messageId: cb.message.message_id };
          await answerCallback(cb.id, 'Send your feedback');
          await sendNotification('What would you like changed? Reply with your feedback.');
          console.log(`[Telegram] Revision requested for ${postId}`);
        }

        if (postId && action === 'schedule') {
          state.pendingSchedule = {
            type: 'social',
            postId,
            chatId: cb.message.chat.id,
            messageId: cb.message.message_id,
            originalCaption: cb.message?.caption || cb.message?.text || ''
          };
          await answerCallback(cb.id, 'When?');
          await sendNotification("When should this go live?\n\nExamples: <i>'tomorrow 9am'</i>, <i>'next Tuesday at 10:30'</i>, <i>'in 3 hours'</i>, <i>'2026-05-12 14:00'</i>");
          console.log(`[Telegram] Schedule prompt for social ${postId}`);
        }

        continue;
      }

      // Handle video uploads — generate caption and create draft post
      const msg = update.message;
      if (msg && (msg.video || msg.video_note) && String(msg.chat.id) === String(CHAT_ID)) {
        try {
          await sendNotification('Got your video — generating a caption...');

          const video = msg.video || msg.video_note;
          const fileId = video.file_id;
          const userCaption = msg.caption || '';
          const filename = `uploaded-${Date.now()}.mp4`;

          // Download from Telegram
          const rawFilename = `uploaded-raw-${Date.now()}.mp4`;
          await downloadTelegramFile(fileId, rawFilename);
          console.log(`[Telegram] Downloaded video: ${rawFilename}`);

          // Watermark with AuctionBrain logo
          const { execFileSync } = require('child_process');
          const ffmpeg = require('ffmpeg-static');
          const logoPath = path.join(__dirname, 'LOGOS', 'auctionbrain-logo-transparent.png');
          const rawPath = path.join(__dirname, 'output', rawFilename);
          const outPath = path.join(__dirname, 'output', filename);

          try {
            // argv array — no shell, so paths can't inject commands
            execFileSync(
              ffmpeg,
              ['-i', rawPath, '-i', logoPath,
               '-filter_complex', '[1:v]scale=700:-1,format=rgba,colorchannelmixer=aa=0.9[logo];[0:v][logo]overlay=W-w-50:H-h-50',
               '-c:a', 'copy', '-y', outPath],
              { stdio: 'pipe' }
            );
            // Clean up raw file
            const fsSync = require('fs');
            if (fsSync.existsSync(rawPath)) fsSync.unlinkSync(rawPath);
            console.log(`[Telegram] Watermarked video: ${filename}`);
          } catch (ffErr) {
            console.warn(`[Telegram] Watermark failed, using raw: ${ffErr.message}`);
            // Fall back to raw file without watermark
            const fsSync = require('fs');
            if (fsSync.existsSync(rawPath)) fsSync.renameSync(rawPath, outPath);
          }

          // Generate caption with Claude
          const { brands } = require('../config');
          const b = brands.auctionbrain;

          const prompt = userCaption
            ? `The content owner sent a video with this note: "${userCaption}"\n\nWrite a short, engaging Facebook post caption for this video. The brand is ${b.name} (${b.url}) targeting ${b.audience}. Tone: ${b.tone}. British English, no hashtags in the caption. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }`
            : `Write a short, engaging Facebook post caption for a video posted by ${b.name} (${b.url}) targeting ${b.audience}. Tone: ${b.tone}. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }`;

          const response = await createLLM().messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }]
          });

          const text = response.content[0].text;
          let copy;
          try {
            copy = parseLLMJson(text, { label: 'video-caption' });
          } catch {
            copy = { copy_headline: userCaption || 'New video', copy_body: '', copy_cta: b.url };
          }

          // Schedule for next available slot
          const scheduledFor = new Date();
          scheduledFor.setDate(scheduledFor.getDate() + 1);
          scheduledFor.setHours(12, 0, 0, 0);

          const saved = await insertPost({
            brand: 'auctionbrain',
            platform: 'facebook',
            template_type: 'uploaded',
            copy_headline: copy.copy_headline,
            copy_body: copy.copy_body || '',
            copy_cta: copy.copy_cta || '',
            image_url: null,
            video_url: filename,
            status: 'draft',
            scheduled_for: scheduledFor.toISOString()
          });

          await sendPostForReview(saved);
          console.log(`[Telegram] Uploaded video post created: ${saved.id}`);
        } catch (err) {
          console.error(`[Telegram] Error processing video: ${err.message}`);
          await sendNotification(`Error processing video: ${err.message}`);
        }
        continue;
      }

      // Handle photo uploads — extract text/key points and save as content seed
      if (msg && msg.photo && String(msg.chat.id) === String(CHAT_ID)) {
        try {
          await sendNotification('Got that image — extracting content...');

          // Get highest resolution photo
          const photo = msg.photo[msg.photo.length - 1];
          const fileId = photo.file_id;
          const userCaption = msg.caption || '';

          // Download from Telegram
          const imgFilename = `seed-photo-${Date.now()}.jpg`;
          await downloadTelegramFile(fileId, imgFilename);
          const imgPath = path.join(__dirname, 'output', imgFilename);

          // Read image and send to Claude Vision
          const fs = require('fs');
          const imageData = fs.readFileSync(imgPath).toString('base64');

          const visionResponse = await createLLM().messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            messages: [{
              role: 'user',
              content: [
                { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imageData } },
                { type: 'text', text: `Extract all text and key points from this image. It's likely a photo of an article, screenshot, or document.${userCaption ? ` The sender added this note: "${userCaption}"` : ''}\n\nReturn JSON:\n{\n  "extracted_text": "All readable text from the image",\n  "summary": "One-line summary of what this is about",\n  "key_points": "3-5 bullet points of the most useful info",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "tags": ["tag1", "tag2"]\n}` }
              ]
            }]
          });

          const visionText = visionResponse.content[0].text;
          let extracted;
          try {
            extracted = parseLLMJson(visionText, { label: 'photo-vision' });
          } catch {
            extracted = { extracted_text: '', summary: 'Could not extract content', key_points: '', tags: [] };
          }

          await saveSeed({
            source: 'telegram_photo',
            raw_input: userCaption || null,
            extracted_text: extracted.extracted_text || '',
            summary: extracted.summary || '',
            key_points: extracted.key_points || '',
            brand: extracted.brand || null,
            tags: extracted.tags || []
          });

          // Clean up image file
          if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);

          await sendNotification(`Got it — extracted from that image: "${extracted.summary}". Saved for future content.`);
          console.log(`[Telegram] Photo seed saved: ${extracted.summary}`);
        } catch (err) {
          console.error(`[Telegram] Error processing photo: ${err.message}`);
          await sendNotification(`Error processing that image: ${err.message}`);
        }
        continue;
      }

      // Handle voice memo replies — route to the pending Lot of the Day if one is awaiting voice.
      // msg.voice is Telegram's "press-to-talk" recording; msg.audio is an attached audio file.
      // We accept either since the user's recording habit may vary.
      if (msg && (msg.voice || msg.audio) && String(msg.chat.id) === String(CHAT_ID)) {
        try {
          const audio = msg.voice || msg.audio;
          const { findPendingLotPost, processVoiceForLot } = require('../lot-flow');
          const pending = await findPendingLotPost();
          if (!pending) {
            await sendNotification('Got a voice memo but no Lot of the Day is currently awaiting a recording. Trigger one first.');
            continue;
          }
          await sendNotification(`Got your voice — processing audio + rendering video for post ${pending.id}…`);
          await processVoiceForLot(pending, audio.file_id);
        } catch (err) {
          console.error(`[Telegram] Error processing lot voice memo: ${err.message}`);
          await sendNotification(`Error processing voice memo: ${err.message.slice(0, 200)}`);
        }
        continue;
      }

      // Handle text messages
      if (msg && msg.text && String(msg.chat.id) === String(CHAT_ID)) {
        const text = msg.text.trim();

        // Handle pending schedule input — user clicked Schedule and is now telling us when
        if (state.pendingSchedule && !text.startsWith('/')) {
          const sch = state.pendingSchedule;
          state.pendingSchedule = null;
          try {
            const nowIso = new Date().toISOString();
            const dayName = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

            const parseResp = await createLLM().messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 200,
              messages: [{ role: 'user', content: `Parse this scheduling request into an ISO 8601 timestamp.

Current time: ${nowIso} (${dayName}, UK time).
User wants to schedule a post for: "${text}"

Rules:
- Output a single ISO 8601 string in UTC (e.g. 2026-05-12T14:00:00Z)
- If the user says a time without specifying AM/PM and it's ambiguous, prefer 9am-6pm
- If only a date is given without a time, use 09:00 UTC
- "tomorrow" = next day, "next Tuesday" = upcoming Tuesday
- Refuse if the request is in the past or unparseable

Return JSON only:
{ "iso": "2026-05-12T14:00:00Z", "human": "Tuesday 12 May at 14:00 UK", "ok": true }
or
{ "ok": false, "error": "short reason" }` }]
            });
            const parseText = parseResp.content[0].text;
            let parsed;
            try {
              parsed = parseLLMJson(parseText, { label: 'schedule-time' });
            } catch {
              throw new Error('Could not interpret your time');
            }
            if (!parsed.ok) {
              await sendNotification(`I couldn't schedule that: ${parsed.error || 'try a different format'}.`);
              continue;
            }
            const scheduledIso = parsed.iso;
            if (new Date(scheduledIso).getTime() < Date.now() - 60000) {
              await sendNotification("That time is in the past. Try again.");
              continue;
            }

            // Update DB — social posts use the primary client directly; blog/guide
            // route through updateBlogPostStatus so the column-drop retry handles
            // BM's missing approved_at/published_at columns gracefully.
            const { supabase, updateBlogPostStatus } = require('../supabase');
            if (sch.type === 'social') {
              const { error } = await supabase.from('posts').update({
                status: 'approved',
                scheduled_for: scheduledIso,
                approved_at: new Date().toISOString()
              }).eq('id', sch.postId);
              if (error) throw new Error(error.message);
            } else {
              await updateBlogPostStatus(sch.postId, 'approved', { scheduled_for: scheduledIso }, sch.brand || 'auctionbrain');
            }

            // Mark the original review message as scheduled
            try {
              await removeButtons(sch.chatId, sch.messageId, `${sch.originalCaption}\n\nSCHEDULED · ${parsed.human}`);
            } catch {}
            await sendNotification(`Scheduled for ${parsed.human}. It will publish automatically.`);
            console.log(`[Telegram] Scheduled ${sch.type} ${sch.postId} for ${scheduledIso}`);
          } catch (err) {
            console.error(`[Telegram] Schedule error: ${err.message}`);
            await sendNotification(`Couldn't schedule: ${err.message}. Try again — type a time or click another button.`);
          }
          continue;
        }

        // Handle pending rejection reason — user clicked Reject and is now telling
        // us why. Save the reason to revision_feedback (the same column we use for
        // edit feedback — it's the editor's voice either way) and finalise the
        // status to 'rejected'. The reason gets surfaced to the LLM next time it
        // generates a post in the same cluster, so future drafts learn from this.
        if (state.pendingRejectionQueue.length > 0 && !text.startsWith('/')) {
          const rej = state.pendingRejectionQueue.shift();
          const reason = text.trim().toLowerCase() === 'skip' ? null : text.trim();
          try {
            const stamp = reason
              ? `${rej.originalCaption}\n\nREJECTED · ${reason.slice(0, 200)}`
              : `${rej.originalCaption}\n\nREJECTED`;

            if (rej.type === 'social') {
              const { supabase } = require('../supabase');
              // Idempotency — already rejected (replayed update)? Acknowledge and move on.
              const { data: cur } = await supabase.from('posts').select('status').eq('id', rej.postId).maybeSingle();
              if (cur && cur.status === 'rejected') {
                const left = state.pendingRejectionQueue.length;
                await sendNotification(left > 0
                  ? `Already rejected — skipping. <b>${left} more pending</b> — why are you rejecting the next one?`
                  : 'Already rejected — skipping.');
                continue;
              }
              const { error } = await supabase.from('posts').update({
                status: 'rejected',
                rejection_feedback: reason,
              }).eq('id', rej.postId);
              if (error) throw new Error(error.message);
            } else {
              // Blog/guide — route through updateBlogPostStatus so the
              // missing-column retry handles BM's schema gaps.
              const { updateBlogPostStatus } = require('../supabase');
              await updateBlogPostStatus(rej.postId, 'rejected',
                reason ? { revision_feedback: reason } : {},
                rej.brand || 'auctionbrain');
            }

            try {
              await removeButtons(rej.chatId, rej.messageId, stamp);
            } catch {}
            const remaining = state.pendingRejectionQueue.length;
            const doneMsg = reason
              ? `Rejected. Feedback captured — the next ${rej.contentType || rej.type} draft will avoid this.`
              : 'Rejected (no feedback).';
            if (remaining > 0) {
              await sendNotification(`${doneMsg}\n\n<b>${remaining} more pending.</b> Why are you rejecting the next one?\n\nReply with your reason, or send <i>'skip'</i> to reject without feedback.`);
            } else {
              await sendNotification(doneMsg);
            }
            console.log(`[Telegram] ${rej.type} ${rej.postId} rejected${reason ? ' with feedback' : ''} (${remaining} remaining in queue)`);
          } catch (err) {
            console.error(`[Telegram] Reject error: ${err.message}`);
            // Keep the queue intact — don't shift on error so the user can retry
            state.pendingRejectionQueue.unshift(rej);
            await sendNotification(`Couldn't save the rejection: ${err.message}. Try clicking Reject again.`);
          }
          continue;
        }

        // Handle pending revision feedback
        if (state.pendingRevision && !text.startsWith('/')) {
          const rev = state.pendingRevision;
          state.pendingRevision = null;

          // ── Blog / guide revision branch ──
          // Delegates to reviseBlogPost() so both the button-press path here
          // and the smart-intent natural-language path can share one implementation.
          if (rev.contentType === 'blog' || rev.contentType === 'guide') {
            try {
              await reviseBlogPost({
                postId: rev.postId,
                brand: rev.brand || 'auctionbrain',
                contentType: rev.contentType,
                editorText: text,
                chatId: rev.chatId,
                messageId: rev.messageId,
                originalCaption: rev.originalCaption
              });
            } catch (err) {
              console.error(`[Telegram] Blog revision error: ${err.message}`);
              await sendNotification(`Couldn't revise: ${err.message}. The draft is unchanged — try Revise again with different wording.`);
            }
            continue;
          }

          // ── Social post revision branch (existing flow) ──
          try {
            await sendNotification('Interpreting your feedback...');
            const post = await getPostById(rev.postId);

            // Store feedback for rejection learning (even if post gets revised and approved)
            const { supabase: sb } = require('../supabase');
            // Supabase query builder isn't a real Promise — .catch() before await throws TypeError
            try {
              await sb.from('posts').update({ rejection_feedback: text }).eq('id', rev.postId);
            } catch (e) { console.warn(`  rejection_feedback save failed: ${e.message}`); }

            const { brands } = require('../config');
            const b = brands[post.brand] || brands.auctionbrain;

            // Step 1: Interpret the edit request — what needs changing?
                        const classifyResponse = await createLLM().messages.create({
                          max_tokens: 300,
                          messages: [{ role: 'user', content: `You manage a social media content pipeline. A post has this copy:\n\nHeadline: ${post.copy_headline}\nBody: ${post.copy_body}\nCTA: ${post.copy_cta}\nType: ${post.template_type}\n\nThe content owner sent this edit request: "${text}"\n\nClassify this request. Return JSON:\n{\n  "type": "copy_change" | "cannot_do",\n  "summary": "One line explaining what you understood they want",\n  "copy_instructions": "Specific instructions for rewriting the copy — the exact changes requested, or null"\n}` }]
                        });

                        const classText = classifyResponse.content[0].text;
                        // Previous regex here was double-escaped (/[\\s\\S]/ matches only
                        // literal \, s, S chars) so this branch ALWAYS threw — the social
                        // Revise button was broken. parseLLMJson fixes it.
                        let classification;
                        try {
                          classification = parseLLMJson(classText, { label: 'revise-classify' });
                        } catch {
                          throw new Error('Could not interpret feedback');
                        }

                        console.log(`[Telegram] Revision classified: ${classification.type} — ${classification.summary}`);
                        await sendNotification(`Understood: ${classification.summary}`);

                        if (classification.type === 'cannot_do') {
                          await sendNotification(`Can't action that request: ${classification.summary}. Try phrasing it differently.`);
                          continue;
                        }

                        let revised = { copy_headline: post.copy_headline, copy_body: post.copy_body, copy_cta: post.copy_cta };

                        // Step 2: Rewrite the copy
                        const copyInstructions = classification.copy_instructions || text;
                        const copyResponse = await createLLM().messages.create({
                          max_tokens: 500,
                          messages: [{ role: 'user', content: `You manage social posts for ${b.name}. Current copy:\n\nHeadline: ${post.copy_headline}\nBody: ${post.copy_body}\nCTA: ${post.copy_cta}\n\nEdit request: ${copyInstructions}\n\nRewrite to match the request. Keep the same format and tone. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }` }]
                        });

                        const aiText = copyResponse.content[0].text;
                        try {
                          revised = parseLLMJson(aiText, { label: 'revise-copy' });
                        } catch {} // keep original copy on parse failure

                        // Apply copy changes to DB
                        const { supabase } = require('../supabase');
                        const { error: copyErr } = await supabase.from('posts').update({
                          copy_headline: revised.copy_headline,
                          copy_body: revised.copy_body || '',
                          copy_cta: revised.copy_cta || ''
                        }).eq('id', rev.postId);
                        if (copyErr) throw new Error(`Copy update failed: ${copyErr.message}`);

                        // Send revised post back for review
                        await sendPostForReview({ ...post, ...revised });
                        console.log(`[Telegram] Post ${rev.postId} revised (${classification.type})`);
                      } catch (err) {
                        console.error(`[Telegram] Revision error: ${err.message}`);
                        await sendNotification(`Revision failed: ${err.message}`);
                      }
                      continue;
        }

        // Handle pending brief conversation
        if (state.pendingBrief && !text.startsWith('/')) {
          const cancel = text.toLowerCase().match(/^(cancel|never ?mind|forget it|nah|skip)$/);
          if (cancel) {
            state.pendingBrief = null;
            const reply = 'No worries, brief cancelled.';
            await sendNotification(reply);
            addToHistory('user', text);
            addToHistory('assistant', reply);
            continue;
          }

          state.pendingBrief.messages.push(text);
          addToHistory('user', text);

          // After 2 messages from user (initial + follow-up), extract and save
          if (state.pendingBrief.messages.length >= 2) {
            try {

              const extractResponse = await createLLM().messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 400,
                messages: [{ role: 'user', content: `The content owner briefed a social media post across these messages:\n${state.pendingBrief.messages.map((m, i) => `Message ${i + 1}: "${m}"`).join('\n')}\n\nExtract a structured brief. Return JSON:\n{\n  "topic": "2-5 word topic summary",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "angle": "The specific angle or hook to take",\n  "data_points": "Any stats, facts, or stories mentioned, or null",\n  "full_brief": "A single paragraph combining all the info into a clear content brief"\n}` }]
              });

              const extractText = extractResponse.content[0].text;
              let structured;
              try {
                structured = parseLLMJson(extractText, { label: 'brief-extract' });
              } catch {
                throw new Error('Could not parse brief');
              }

              const { saveBrief } = require('../supabase');
              await saveBrief(structured);

              const reply = `Got it — saved a brief about "${structured.topic}"${structured.brand ? ` for ${structured.brand}` : ''}. I'll work it into tomorrow's posts.`;
              await sendNotification(reply);
              addToHistory('assistant', reply);
              console.log(`[Telegram] Structured brief saved: ${structured.topic}`);
            } catch (err) {
              console.error(`[Telegram] Brief extraction error: ${err.message}`);
              const { saveBrief } = require('../supabase');
              await saveBrief(state.pendingBrief.messages.join(' '));
              const reply = 'Saved your brief for tomorrow.';
              await sendNotification(reply);
              addToHistory('assistant', reply);
            }
            state.pendingBrief = null;
          } else {
            // Ask one follow-up question
            try {

              const followUpResponse = await createLLM().messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                messages: [{ role: 'user', content: `You are ContentBrain. The content owner wants to brief a future social media post.\n\nThey said: "${state.pendingBrief.messages.join(' ')}"\n\nAsk ONE short follow-up question to make this brief more actionable. Focus on: what angle or hook? Any specific data points or stories to include? Which brand (AuctionBrain or BridgeMatch)?\n\nKeep it casual, one sentence. British English.` }]
              });

              const reply = followUpResponse.content[0].text.trim();
              await sendNotification(reply);
              addToHistory('assistant', reply);
            } catch (err) {
              // If follow-up fails, just save what we have
              const { saveBrief } = require('../supabase');
              await saveBrief(state.pendingBrief.messages.join(' '));
              state.pendingBrief = null;
              await sendNotification('Saved your brief for tomorrow.');
            }
          }
          continue;
        }

        // Timeout pending brief after 10 minutes
        if (state.pendingBrief && Date.now() - state.pendingBrief.startedAt > 10 * 60 * 1000) {
          const { saveBrief } = require('../supabase');
          await saveBrief(state.pendingBrief.messages.join(' '));
          state.pendingBrief = null;
          console.log('[Telegram] Brief timed out, saved as-is');
        }

        // /generate — create new posts now
        if (text === '/generate') {
          try {
            await sendNotification('Generating posts now...');
            const { generateBatch } = require('../generate');
            const { renderPost } = require('../renderer');
            const { renderVideo } = require('../video-renderer');

            const posts = await generateBatch();
            for (const post of posts) {
              try {
                const { filename } = await renderPost(post.template_type, post.brand, post);
                let videoFilename = null;
                try {
                  const video = await renderVideo(post.template_type, post.brand, post);
                  videoFilename = video.filename;
                } catch (videoErr) {
                  console.warn(`  Video render skipped: ${videoErr.message}`);
                }

                const scheduledFor = new Date();
                scheduledFor.setHours(scheduledFor.getHours() + 1, 0, 0, 0);

                const meta = {};
                if (post.hook_pattern) meta.hook_pattern = post.hook_pattern;
                if (post.cta_pattern) meta.cta_pattern = post.cta_pattern;
                if (post.author) meta.author = post.author;
                if (post.visual_style) meta.visual_style = post.visual_style;
                if (post.duration_seconds) meta.duration_seconds = post.duration_seconds;

                const saved = await insertPost({
                  brand: post.brand,
                  platform: post.platform,
                  template_type: post.template_type,
                  copy_headline: post.copy_headline,
                  copy_body: post.copy_body,
                  copy_cta: post.copy_cta,
                  image_url: filename,
                  video_url: videoFilename,
                  status: 'draft',
                  scheduled_for: scheduledFor.toISOString(),
                  meta
                });
                await sendPostForReview(saved);
              } catch (err) {
                console.error(`  Error: ${err.message}`);
              }
            }
            console.log(`[Telegram] /generate completed: ${posts.length} posts`);
          } catch (err) {
            await sendNotification(`Generate failed: ${err.message}`);
          }
          continue;
        }

        // /publish — publish all approved posts now
        if (text === '/publish') {
          try {
            const approved = await getApprovedPosts();
            if (!approved.length) {
              await sendNotification('No approved posts to publish.');
              continue;
            }
            await sendNotification(`Publishing ${approved.length} post(s)...`);
            let published = 0;
            for (const post of approved) {
              try {
                await publish(post);
                await updatePostStatus(post.id, 'published');
                published++;
              } catch (err) {
                console.error(`  Error publishing ${post.id}: ${err.message}`);
                await sendNotification(`Failed: ${post.brand}/${post.template_type} — ${err.message.slice(0, 100)}`);
              }
            }
            await sendNotification(`Done — ${published}/${approved.length} posts published.`);
          } catch (err) {
            await sendNotification(`Publish failed: ${err.message}`);
          }
          continue;
        }

        // /status — quick overview + active levers summary
        if (text === '/status') {
          try {
            const drafts = await getDraftPosts();
            const approved = await getApprovedPosts();
            const { getPendingBriefs } = require('../supabase');
            const briefs = await getPendingBriefs();
            const pubMethod = process.env.FB_PAGE_ACCESS_TOKEN ? 'Facebook Direct' : process.env.MAKE_WEBHOOK_URL ? 'Make.com' : 'NOT CONFIGURED';

            // Lever summary — single round-trip, no Promise.all so a
            // failure on one read doesn't sink the whole status output.
            let leverBlock = '';
            try {
              const [activeBrands, weights, hooks, ctas, authors] = await Promise.all([
                runtimeConfig.getActiveBrands(),
                runtimeConfig.getTemplateWeights(),
                runtimeConfig.getHookPatterns(),
                runtimeConfig.getCtaPatterns(),
                authorsLib.listAuthors(),
              ]);
              const weightLine = templateTypes.map(t => `${t}=${weights[t] ?? 0}`).join(' ');
              const activeAuthors = authors.filter(a => a.active).length;
              leverBlock =
                `\n\n<b>Levers</b>\n` +
                `Active: ${escapeHtml(activeBrands.join(', ') || '(none)')}\n` +
                `Templates: ${weightLine}\n` +
                `Patterns: ${hooks.length} hooks, ${ctas.length} CTAs\n` +
                `Ghost-writers: ${activeAuthors} active / ${authors.length} total\n` +
                `<i>/levers for full snapshot · /help for commands</i>`;
            } catch (e) {
              console.warn(`[/status] lever read failed: ${e.message}`);
            }

            await sendNotification(
              `<b>ContentBrain Status</b>\n\n` +
              `Drafts awaiting review: ${drafts.length}\n` +
              `Approved (ready to publish): ${approved.length}\n` +
              `Pending briefs: ${briefs.length}\n` +
              `Publishing via: ${pubMethod}` +
              leverBlock
            );
          } catch (err) {
            await sendNotification(`Status check failed: ${err.message}`);
          }
          continue;
        }

        // /help
        if (text === '/help') {
          await sendNotification(
            `<b>ContentBrain Commands</b>\n\n` +
            `<b>Operations</b>\n` +
            `/generate — create new posts now\n` +
            `/regen [brand] — alias for /generate\n` +
            `/publish — publish all approved posts now\n` +
            `/status — drafts, approved, briefs + active levers\n` +
            `/levers — full snapshot of every tunable lever\n\n` +
            `<b>Brand voice</b> (brand = auctionbrain | bridgematch)\n` +
            `/tone &lt;brand&gt; [new tone…]\n` +
            `/audience &lt;brand&gt; [new audience…]\n` +
            `/messages &lt;brand&gt; [list | add &lt;text&gt; | rm &lt;n&gt; | reset]\n` +
            `/directive &lt;brand&gt; [show | clear | &lt;text…&gt;]\n` +
            `/visual &lt;brand&gt; [show | clear | themes | &lt;text…&gt;]\n\n` +
            `<b>Pattern menus</b>\n` +
            `/hooks [list | add &lt;text&gt; | rm &lt;n&gt; | reset]\n` +
            `/ctas  [list | add &lt;text&gt; | rm &lt;n&gt; | reset]\n\n` +
            `<b>Mix</b>\n` +
            `/active [list | add &lt;brand&gt; | rm &lt;brand&gt;]\n` +
            `/templates [show | &lt;type&gt; &lt;weight&gt;]   types: stat hook list reel\n\n` +
            `<b>Ghost-writers</b> (roaming personas)\n` +
            `/authors [list | show &lt;Name&gt;]\n` +
            `/authors add &lt;Name&gt; &lt;voice description…&gt;\n` +
            `/authors tone &lt;Name&gt; &lt;text&gt;\n` +
            `/authors directive &lt;Name&gt; &lt;text | clear&gt;\n` +
            `/authors weight &lt;Name&gt; &lt;n&gt;     (0 = disabled)\n` +
            `/authors brand &lt;Name&gt; &lt;brand | all&gt;\n` +
            `/authors pause &lt;Name&gt; · resume &lt;Name&gt; · rm &lt;Name&gt;\n\n` +
            `Or just chat — send text ideas, photos of articles, or URLs and I'll save them as content seeds for future posts. Send a video to create a watermarked post.`
          );
          continue;
        }

        // ── RUNTIME CONFIG LEVERS ─────────────────────────────────
        // All of the following commands mutate rows in app_config (see
        // migrations/006-app-config.sql) and bust the runtime-config
        // cache so the next /generate picks them up immediately.
        // Defined here, *before* the unknown-command guard, so unknown
        // /commands still get silently dropped.

        if (text.startsWith('/levers') || text.startsWith('/tone') || text.startsWith('/audience') ||
            text.startsWith('/messages') || text.startsWith('/hooks') || text.startsWith('/ctas') ||
            text.startsWith('/active') || text.startsWith('/templates') ||
            text.startsWith('/directive') || text.startsWith('/visual') || text.startsWith('/regen') ||
            text.startsWith('/authors') || text.startsWith('/author ') || text === '/author') {
          try {
            const handled = await handleLeverCommand(text, msg);
            if (handled) continue;
          } catch (err) {
            console.error(`[Telegram] Lever command error: ${err.message}`);
            await sendNotification(`<b>Error</b>\n${escapeHtml(err.message)}`);
            continue;
          }
        }

        // Unknown command
        if (text.startsWith('/')) continue;

        // Smart intent classification — route message to the right action
        try {

          // Get recent drafts for context
          const recentDrafts = await getDraftPosts().catch(() => []);
          const draftsContext = recentDrafts.slice(0, 5).map(p =>
            `- ID:${p.id} | ${p.brand}/${p.template_type} | "${p.copy_headline}" | has_video:${!!p.video_url}`
          ).join('\n');

          addToHistory('user', text);

          const intentResponse = await createLLM().messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 400,
            messages: [{ role: 'user', content: `You are ContentBrain, a friendly social media content assistant on Telegram. You manage content generation and publishing for the owner's brands.

${getHistoryContext()}The owner's latest message:
"${text}"

Current draft posts awaiting review:
${draftsContext || '(none)'}

Respond naturally as a helpful assistant. Return JSON:
{
  "reply": "Your conversational response to the owner",
  "action": "revise_post" | "save_brief" | "save_seed" | "scrape_url" | null,
  "post_id": "only if action is revise_post — the draft ID they're referring to, or null",
  "url": "only if action is scrape_url — the URL to scrape",
  "summary": "one-line summary of what they want (only if action is not null)"
}

Guidelines:
- MOST messages need no action — just reply naturally. Chat, answer questions, be helpful.
- Only set action to "save_brief" if the owner is CLEARLY giving you a specific topic or idea for future posts (e.g. "do a post about bridging loan rates rising")
- Only set action to "revise_post" if they're giving specific feedback on a draft (e.g. "make the headline shorter", "change the CTA")
- Set action to "save_seed" if the owner is sharing research, knowledge, facts, or article content — not a direct social brief but useful raw material for future content
- Set action to "scrape_url" if the message contains a URL they want you to read and store (e.g. "read this: https://...")
- When in doubt, just reply — don't trigger an action. It's always better to chat than to wrongly save a brief or revise a post.
- Keep replies short, friendly, British English.` }]
          });

          const intentText = intentResponse.content[0].text;
          let intent;
          try {
            intent = parseLLMJson(intentText, { label: 'smart-intent' });
          } catch {
            throw new Error('Could not classify message');
          }

          console.log(`[Telegram] Action: ${intent.action || 'chat'} — ${intent.summary || intent.reply?.slice(0, 50)}`);

          // Always send the conversational reply
          if (intent.reply) {
            await sendNotification(intent.reply);
            addToHistory('assistant', intent.reply);
          }

          if (intent.action === 'revise_post' && intent.post_id) {
            // Look up the post in social posts OR blog posts (both projects)
            // so a chat-typed revision routes to the correct table/brand.
            const found = await findPostAnywhere(intent.post_id);
            if (!found) {
              await sendNotification(`Couldn't find that post. Use the Revise button on a specific post, or try again.`);
              continue;
            }

            // Blog/guide posts get the full writer-context revision flow.
            if (found.kind === 'blog') {
              try {
                const contentType = found.post.post_type === 'guide' ? 'guide' : 'blog';
                await reviseBlogPost({
                  postId: intent.post_id,
                  brand: found.brand,
                  contentType,
                  editorText: text,
                  chatId: null,        // no original review card to update — send fresh card only
                  messageId: null,
                  originalCaption: null
                });
              } catch (err) {
                console.error(`[Telegram] Blog revision (intent) error: ${err.message}`);
                await sendNotification(`Couldn't revise: ${err.message}.`);
              }
              continue;
            }

            // Social post — fall through to existing classify-then-rewrite flow.
            const rev = { postId: intent.post_id, chatId: msg.chat.id, messageId: msg.message_id };
            const post = found.post;

            const { brands } = require('../config');
            const b = brands[post.brand] || brands.auctionbrain;

            const classifyResponse = await createLLM().messages.create({
              model: 'claude-haiku-4-5-20251001',
              max_tokens: 300,
              messages: [{ role: 'user', content: `You manage a social media content pipeline. A post has a graphic/video and this copy:

Headline: ${post.copy_headline}
Body: ${post.copy_body}
CTA: ${post.copy_cta}
Template: ${post.template_type}
Has video: ${!!post.video_url}

The content owner sent this revision request: "${text}"

Classify this request. Return JSON:
{
  "type": "copy_change" | "video_change" | "both" | "cannot_do",
  "copy_action": "rewrite" | "none",
  "video_action": "re-render" | "extend_duration" | "none",
  "video_duration_seconds": null or number if they specified a duration,
  "summary": "One line explaining what you understood they want",
  "copy_instructions": "Specific instructions for rewriting copy, or null"
}` }]
            });

            const classText = classifyResponse.content[0].text;
            let classification;
            try {
              classification = parseLLMJson(classText, { label: 'smart-revise-classify' });
            } catch {
              throw new Error('Could not interpret feedback');
            }

            await sendNotification(`Understood: ${classification.summary}`);

            let revised = { copy_headline: post.copy_headline, copy_body: post.copy_body, copy_cta: post.copy_cta };
            let needsVideoRerender = false;
            let videoDuration = null;

            if (classification.copy_action === 'rewrite') {
              const copyInstructions = classification.copy_instructions || text;
              const copyResponse = await createLLM().messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                messages: [{ role: 'user', content: `You wrote this social media post for ${b.name}:\n\nHeadline: ${post.copy_headline}\nBody: ${post.copy_body}\nCTA: ${post.copy_cta}\n\nRevision needed: ${copyInstructions}\n\nRewrite the post. Keep the same format and tone. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }` }]
              });
              const aiText = copyResponse.content[0].text;
              try {
                revised = parseLLMJson(aiText, { label: 'smart-revise-copy' });
              } catch {} // keep original copy on parse failure
            }

            if (classification.video_action === 'extend_duration' || classification.video_action === 're-render') {
              needsVideoRerender = true;
              videoDuration = classification.video_duration_seconds || 30;
            }

            const { supabase } = require('../supabase');
            const { error: copyErr } = await supabase.from('posts').update({
              copy_headline: revised.copy_headline,
              copy_body: revised.copy_body || '',
              copy_cta: revised.copy_cta || ''
            }).eq('id', rev.postId);
            if (copyErr) throw new Error(`Copy update failed: ${copyErr.message}`);

            if (needsVideoRerender && post.video_url) {
              try {
                await sendNotification(`Re-rendering video (${videoDuration}s)...`);
                const { renderVideo, ensureBundle } = require('../video-renderer');
                await ensureBundle();
                const updatedPost = { ...post, ...revised, overrideDurationSeconds: videoDuration };
                const video = await renderVideo(post.template_type, post.brand, updatedPost);
                // Persist the chosen duration into meta so later Studio
                // re-renders keep it instead of snapping back to the default.
                const newMeta = { ...(post.meta || {}), duration_seconds: videoDuration };
                await supabase.from('posts').update({ video_url: video.filename, meta: newMeta }).eq('id', rev.postId);
                post.video_url = video.filename;
                post.meta = newMeta;
              } catch (videoErr) {
                console.error(`[Telegram] Video re-render failed: ${videoErr.message}`);
                await sendNotification(`Video re-render failed: ${videoErr.message}. Copy was updated.`);
              }
            }

            await sendPostForReview({ ...post, ...revised });
            console.log(`[Telegram] Smart revision: post ${rev.postId} (${classification.type})`);

          } else if (intent.action === 'revise_post' && !intent.post_id) {
            await sendNotification(`Tap the Revise button on the post you want to change, then send your feedback.`);

          } else if (intent.action === 'save_brief') {
            // Start conversational brief — ask a follow-up before saving
            state.pendingBrief = { messages: [text], startedAt: Date.now() };
            try {
              const followUpResponse = await createLLM().messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                messages: [{ role: 'user', content: `You are ContentBrain. The content owner wants to brief a future social media post.\n\nThey said: "${text}"\n\nAsk ONE short follow-up question to make this brief more actionable. Focus on: what angle or hook? Any specific data points or stories to include? Which brand (AuctionBrain or BridgeMatch)?\n\nKeep it casual, one sentence. British English.` }]
              });
              const followUp = followUpResponse.content[0].text.trim();
              await sendNotification(followUp);
              addToHistory('assistant', followUp);
            } catch (err) {
              // If follow-up fails, just save immediately
              await saveBrief(text);
              state.pendingBrief = null;
              await sendNotification(`Saved as a brief for tomorrow's posts.`);
            }
            console.log(`[Telegram] Brief conversation started: ${text.slice(0, 50)}...`);

          } else if (intent.action === 'save_seed') {
            // Save as content seed — raw material, not a direct brief
            try {
              const seedResponse = await createLLM().messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 400,
                messages: [{ role: 'user', content: `The content owner shared this knowledge/research:\n"${text}"\n\nExtract structured content seed. Return JSON:\n{\n  "summary": "One-line summary",\n  "key_points": "3-5 bullet points of useful info",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "tags": ["tag1", "tag2"]\n}` }]
              });

              const seedText = seedResponse.content[0].text;
              let seed;
              try {
                seed = parseLLMJson(seedText, { label: 'seed-extract' });
              } catch {
                seed = { summary: text.slice(0, 100), key_points: '', tags: [] };
              }

              await saveSeed({
                source: 'telegram_text',
                raw_input: text,
                summary: seed.summary || '',
                key_points: seed.key_points || '',
                brand: seed.brand || null,
                tags: seed.tags || []
              });

              console.log(`[Telegram] Text seed saved: ${seed.summary}`);
            } catch (seedErr) {
              console.error(`[Telegram] Seed save error: ${seedErr.message}`);
              // Still save raw text
              await saveSeed({ source: 'telegram_text', raw_input: text, summary: text.slice(0, 200) });
            }

          } else if (intent.action === 'scrape_url' && intent.url) {
            // Scrape URL and save as content seed
            try {
              const urlToScrape = intent.url;

              // Validate URL — scheme + DNS-resolved IP range to prevent SSRF
              let parsedUrl;
              try {
                parsedUrl = new URL(urlToScrape);
              } catch {
                await sendNotification(`That doesn't look like a valid URL.`);
                continue;
              }
              if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
                await sendNotification(`Only http/https URLs are supported.`);
                continue;
              }

              // Resolve the host and reject loopback / private / link-local
              // ranges before fetching. Blocks AWS metadata (169.254.169.254),
              // intra-VPC services, and the local network. (Best-effort: there
              // is a TOCTOU window between resolution and connect, but the
              // endpoint is owner-authenticated so the residual risk is low.)
              try {
                const dns = require('dns').promises;
                const addrs = await dns.lookup(parsedUrl.hostname, { all: true });
                const isBlocked = (ip, family) => {
                  if (family === 4) {
                    const [a, b] = ip.split('.').map(Number);
                    if (a === 0 || a === 10 || a === 127) return true;
                    if (a === 169 && b === 254) return true;
                    if (a === 172 && b >= 16 && b <= 31) return true;
                    if (a === 192 && b === 168) return true;
                    return false;
                  }
                  if (family === 6) {
                    const lower = ip.toLowerCase();
                    if (lower === '::1' || lower === '::') return true;
                    if (lower.startsWith('fe80:') || lower.startsWith('fec0:')) return true;
                    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
                    if (lower.startsWith('::ffff:')) {
                      // IPv4-mapped — recurse on the v4 part
                      const v4 = lower.slice(7);
                      return isBlocked(v4, 4);
                    }
                  }
                  return false;
                };
                if (addrs.some(a => isBlocked(a.address, a.family))) {
                  await sendNotification(`That URL resolves to a private/internal address — blocked for safety.`);
                  continue;
                }
              } catch (e) {
                await sendNotification(`Couldn't resolve that hostname.`);
                continue;
              }

              let pageContent = '';

              // Fetch the page content
              const pageRes = await fetch(parsedUrl.href, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContentBrain/1.0)' },
                signal: AbortSignal.timeout(15000),
                redirect: 'manual' // don't auto-follow; a redirect to 169.254.x.x would bypass the check
              });
              // If the server redirected, follow ONCE after re-checking the new URL
              if (pageRes.status >= 300 && pageRes.status < 400) {
                await sendNotification(`That URL redirected — refusing to follow automatically. Send the final URL directly.`);
                continue;
              }
              if (pageRes.ok) {
                const html = await pageRes.text();
                // Strip HTML tags for a rough text extraction
                pageContent = html
                  .replace(/<script[\s\S]*?<\/script>/gi, '')
                  .replace(/<style[\s\S]*?<\/style>/gi, '')
                  .replace(/<[^>]+>/g, ' ')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 8000);
              }

              if (!pageContent) {
                await sendNotification(`Couldn't read that URL. The page may be behind a paywall or blocking bots.`);
                continue;
              }

              // Summarise with Claude
              const scrapeResponse = await createLLM().messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 600,
                messages: [{ role: 'user', content: `Summarise this article content for a UK property content team. Source URL: ${urlToScrape}\n\nContent:\n${pageContent.slice(0, 6000)}\n\nReturn JSON:\n{\n  "summary": "One-line summary",\n  "key_points": "3-5 bullet points of the most useful info",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "tags": ["tag1", "tag2"]\n}` }]
              });

              const scrapeText = scrapeResponse.content[0].text;
              let scraped;
              try {
                scraped = parseLLMJson(scrapeText, { label: 'url-scrape' });
              } catch {
                scraped = { summary: 'Could not summarise', key_points: '', tags: [] };
              }

              await saveSeed({
                source: 'telegram_url',
                raw_input: text,  // full message including user commentary + URL
                extracted_text: pageContent.slice(0, 5000),
                summary: scraped.summary || '',
                key_points: scraped.key_points || '',
                brand: scraped.brand || null,
                tags: scraped.tags || []
              });

              await sendNotification(`Read that article — ${scraped.summary}. Saved for future content.`);
              console.log(`[Telegram] URL seed saved: ${urlToScrape}`);
            } catch (scrapeErr) {
              console.error(`[Telegram] URL scrape error: ${scrapeErr.message}`);
              // Save the URL as a raw seed even if scraping failed
              await saveSeed({ source: 'telegram_url', raw_input: intent.url, summary: 'Scrape failed — URL saved for manual review' });
              await sendNotification(`Couldn't fully read that page, but I've saved the URL for later.`);
            }
          }
          // No else needed — conversational reply was already sent above
        } catch (err) {
          console.error(`[Telegram] Smart routing error: ${err.message}`);
          // Fall back to a simple apology
          await sendNotification(`Sorry, something went wrong processing that. Try /help for commands.`).catch(() => {});
        }
      }
    }

    // Persist the advanced offset once per non-empty batch (fire-and-forget;
    // a Supabase blip must never stall the poll loop). On redeploy the loop
    // resumes from here instead of re-processing old updates.
    if (state.telegramOffset > offsetBeforeBatch) {
      runtimeConfig.setTelegramOffset(state.telegramOffset).catch(e =>
        console.warn(`[Telegram] offset persist failed: ${e.message}`));
    }
  } catch (err) {
    // Silence network errors, will retry next poll
    state.pollLastError = err.message;
  }

  setTimeout(pollTelegram, 1000);
}

// Resend review cards for any blog/guide drafts so a stale-poll-loop
// outage (or a Railway redeploy that landed mid-click) self-heals
// within seconds of restart. Without this, drafts can sit forever
// because Telegram doesn't queue callback_query updates the way it
// queues messages — once the bot's polling loop dies, every button
// press during the dead window is lost.
async function resendDraftReviewCards() {
  try {
    const drafts = await getDraftBlogPosts().catch(() => []);
    if (!drafts.length) return;

    // Only resend drafts older than 6 hours. The original purpose was to
    // self-heal lost button presses from a Telegram polling outage — but a
    // freshly-created draft is almost certainly already sitting unread in
    // Simon's chat from minutes ago, and re-pinging it (every redeploy)
    // is just spam. 6h is a generous floor that catches genuinely-stuck
    // ones without re-pinging anything fresh.
    const sixHoursAgo = Date.now() - 6 * 60 * 60 * 1000;
    const stale = drafts.filter(d => {
      const t = d.created_at ? new Date(d.created_at).getTime() : 0;
      return t > 0 && t < sixHoursAgo;
    });
    if (!stale.length) {
      if (drafts.length) console.log(`[startup] ${drafts.length} draft(s) exist but all <6h old — skipping resend`);
      return;
    }

    const { sendBlogForReview } = require('../telegram');
    const { getSourceArticlesForPost } = require('../supabase');
    let sent = 0;
    for (const d of stale) {
      try {
        const sources = await getSourceArticlesForPost(d.id, d.brand || 'auctionbrain').catch(() => []);
        await sendBlogForReview({
          post_id: d.id,
          title: d.title,
          summary: d.summary || d.meta_description || '',
          score: d.evaluation_score,
          word_count: d.word_count,
          brand: d.brand || 'auctionbrain',
          content_type: d.post_type === 'guide' ? 'guide' : 'blog',
          sources,
        });
        sent++;
      } catch (err) {
        console.warn(`[startup] resend failed for ${d.id}: ${err.message}`);
      }
    }
    if (sent) console.log(`[startup] resent ${sent} stale (>6h) review card(s)`);
  } catch (err) {
    console.warn(`[startup] resendDraftReviewCards: ${err.message}`);
  }
}

// Restore the persisted getUpdates offset, then enter the poll loop.
// Replaces the inline startup sequence that lived in server.js app.listen.
async function startTelegramPolling() {
  try {
    const saved = await runtimeConfig.getTelegramOffset();
    if (saved > state.telegramOffset) {
      state.telegramOffset = saved;
      console.log(`[startup] Telegram offset restored: ${saved}`);
    }
  } catch (err) {
    console.warn(`[startup] Telegram offset restore failed (starting from 0): ${err.message}`);
  }
  pollTelegram();
}

module.exports = { startTelegramPolling, resendDraftReviewCards, getDiagnostics };
