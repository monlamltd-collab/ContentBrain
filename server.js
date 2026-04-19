require('dotenv').config();
const express = require('express');
const path = require('path');
const cron = require('node-cron');
const { getDraftPosts, getApprovedPosts, updatePostStatus, getPostById } = require('./lib/supabase');
const { publish } = require('./lib/publish');
const { sendPostForReview, sendNotification, answerCallback, removeButtons, downloadTelegramFile, API, BOT_TOKEN, CHAT_ID } = require('./lib/telegram');
const { saveBrief, insertPost } = require('./lib/supabase');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.REVIEW_UI_PASSWORD;

app.use(express.json());
app.use('/output', express.static(path.join(__dirname, 'output')));

// Health check (no auth — used by Railway)
app.get('/health', (req, res) => res.json({ ok: true }));

// ── AUTH MIDDLEWARE ──
function requireAuth(req, res, next) {
  // Check session cookie or query param
  const token = req.cookies?.auth || req.query.token || req.headers['x-auth-token'];
  if (token === PASSWORD) return next();

  // Show login form
  if (req.method === 'GET' && req.path === '/') {
    return res.send(loginPage());
  }
  return res.status(401).json({ error: 'Unauthorized' });
}

// Simple cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(c => {
      const [key, val] = c.trim().split('=');
      req.cookies[key] = val;
    });
  }
  next();
});

// ── LOGIN ──
app.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  if (req.body.password === PASSWORD) {
    res.setHeader('Set-Cookie', `auth=${PASSWORD}; HttpOnly; Path=/; Max-Age=86400`);
    return res.redirect('/');
  }
  res.status(401).send(loginPage('Wrong password'));
});

// ── DASHBOARD ──
app.get('/', requireAuth, async (req, res) => {
  try {
    const posts = await getDraftPosts();
    res.send(dashboardPage(posts));
  } catch (err) {
    res.status(500).send(`Error: ${err.message}`);
  }
});

// ── APPROVE / REJECT ──
app.post('/api/posts/:id/approve', requireAuth, async (req, res) => {
  try {
    const post = await updatePostStatus(req.params.id, 'approved');
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/posts/:id/reject', requireAuth, async (req, res) => {
  try {
    const post = await updatePostStatus(req.params.id, 'rejected');
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── HTML PAGES ──

function loginPage(error) {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ContentBrain — Login</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .login { background: #fff; border-radius: 12px; padding: 48px; box-shadow: 0 2px 12px rgba(0,0,0,0.08); width: 360px; }
  h1 { font-size: 24px; color: #1a2b4b; margin-bottom: 24px; }
  input { width: 100%; padding: 12px 16px; border: 1px solid #ddd; border-radius: 8px; font-size: 16px; margin-bottom: 16px; }
  button { width: 100%; padding: 12px; background: #0f8a5f; color: #fff; border: none; border-radius: 8px; font-size: 16px; cursor: pointer; }
  button:hover { background: #0d7a54; }
  .error { color: #C0392B; font-size: 14px; margin-bottom: 12px; }
</style>
</head><body>
<div class="login">
  <h1>ContentBrain</h1>
  ${error ? `<div class="error">${error}</div>` : ''}
  <form method="POST" action="/login">
    <input type="password" name="password" placeholder="Password" autofocus>
    <button type="submit">Sign in</button>
  </form>
</div>
</body></html>`;
}

function dashboardPage(posts) {
  const cards = posts.map(post => `
    <div class="card" id="card-${post.id}">
      <div class="card-header">
        <span class="badge brand-${post.brand}">${post.brand}</span>
        <span class="badge platform">${post.platform}</span>
        <span class="badge template">${post.template_type}</span>
      </div>
      ${post.image_url ? `<img src="/output/${post.image_url}" class="preview" alt="preview">` : ''}
      ${post.video_url ? `<div class="video-wrap"><video src="/output/${post.video_url}" class="preview" controls muted preload="metadata"></video><span class="video-badge">MP4</span></div>` : ''}
      <div class="copy">
        <strong>${escapeHtml(post.copy_headline || '')}</strong>
        <p>${escapeHtml(post.copy_body || '')}</p>
        ${post.copy_cta ? `<p class="cta">${escapeHtml(post.copy_cta)}</p>` : ''}
      </div>
      <div class="actions">
        <button class="btn approve" onclick="action('${post.id}','approve')">Approve</button>
        <button class="btn reject" onclick="action('${post.id}','reject')">Reject</button>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ContentBrain — Review</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f5f5f5; padding: 24px; }
  h1 { font-size: 28px; color: #1a2b4b; margin-bottom: 8px; }
  .subtitle { color: #666; margin-bottom: 32px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 24px; }
  .card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.06); transition: opacity 0.3s; }
  .card.done { opacity: 0.3; pointer-events: none; }
  .card-header { padding: 16px; display: flex; gap: 8px; flex-wrap: wrap; }
  .badge { font-size: 12px; font-weight: 600; padding: 4px 10px; border-radius: 20px; text-transform: uppercase; letter-spacing: 0.03em; }
  .brand-auctionbrain { background: #1a2b4b; color: #faf8f4; }
  .brand-bridgematch { background: #0f8a5f; color: #fff; }
  .platform { background: #e8e8e8; color: #333; }
  .template { background: #fdf2e9; color: #C0392B; }
  .preview { width: 100%; aspect-ratio: 1; object-fit: cover; }
  .video-wrap { position: relative; }
  .video-wrap video { width: 100%; aspect-ratio: 1; object-fit: cover; background: #000; }
  .video-badge { position: absolute; top: 8px; right: 8px; background: #C0392B; color: #fff; font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 4px; }
  .copy { padding: 16px; }
  .copy strong { display: block; font-size: 18px; color: #1a2b4b; margin-bottom: 8px; }
  .copy p { color: #555; line-height: 1.5; margin-bottom: 8px; white-space: pre-line; }
  .copy .cta { color: #0f8a5f; font-weight: 500; }
  .actions { padding: 16px; display: flex; gap: 12px; border-top: 1px solid #eee; }
  .btn { flex: 1; padding: 10px; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
  .btn.approve { background: #0f8a5f; color: #fff; }
  .btn.approve:hover { background: #0d7a54; }
  .btn.reject { background: #f5f5f5; color: #C0392B; border: 1px solid #eee; }
  .btn.reject:hover { background: #fde8e8; }
  .empty { text-align: center; color: #999; padding: 80px; font-size: 18px; }
</style>
</head><body>
  <h1>ContentBrain</h1>
  <p class="subtitle">${posts.length} draft${posts.length !== 1 ? 's' : ''} awaiting review</p>
  <div class="grid">
    ${posts.length ? cards : '<div class="empty">No drafts to review. All clear.</div>'}
  </div>
  <script>
    async function action(id, type) {
      const card = document.getElementById('card-' + id);
      try {
        const res = await fetch('/api/posts/' + id + '/' + type, { method: 'POST' });
        if (res.ok) {
          card.classList.add('done');
          setTimeout(() => card.remove(), 500);
          // Update count
          const remaining = document.querySelectorAll('.card:not(.done)').length;
          document.querySelector('.subtitle').textContent = remaining + ' draft' + (remaining !== 1 ? 's' : '') + ' awaiting review';
        }
      } catch (err) { alert('Error: ' + err.message); }
    }
  </script>
</body></html>`;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── CRON JOBS ──

// Track last generation date to avoid duplicates after PC wake
let lastGenerateDate = null;

// Generate new content daily at 7am (with wake-up resilience)
cron.schedule('0 7 * * *', runGenerate);

// Check on wake — if we missed today's generation, run it now
cron.schedule('*/30 * * * *', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const hour = new Date().getHours();
  if (hour >= 7 && lastGenerateDate !== today) {
    console.log(`[${new Date().toISOString()}] Wake recovery: missed today's generation, running now...`);
    await runGenerate();
  }
});

async function runGenerate() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastGenerateDate === today) {
    console.log(`[${new Date().toISOString()}] Cron: already generated today, skipping.`);
    return;
  }
  lastGenerateDate = today;

  console.log(`[${new Date().toISOString()}] Cron: generating content...`);
  try {
    const { generateBatch } = require('./lib/generate');
    const { renderPost } = require('./lib/renderer');
    const { renderVideo } = require('./lib/video-renderer');
    const { insertPost } = require('./lib/supabase');

    const posts = await generateBatch();
    const savedPosts = [];
    const failedSends = [];

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

        const daysAhead = Math.floor(savedPosts.length / 2);
        const hour = savedPosts.length % 2 === 0 ? 9 : 14;
        const scheduledFor = new Date();
        scheduledFor.setDate(scheduledFor.getDate() + daysAhead + 1);
        scheduledFor.setHours(hour, 0, 0, 0);

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
          scheduled_for: scheduledFor.toISOString()
        });

        savedPosts.push(saved);

        // Send to Telegram with video preview + approve/reject buttons
        const result = await sendPostForReview(saved);
        if (!result.ok) {
          failedSends.push({ id: saved.id, error: result.error });
        }
      } catch (err) {
        console.error(`  Error processing ${post.brand}/${post.template_type}: ${err.message}`);
      }
    }

    const msg = `${savedPosts.length} posts generated` +
      (failedSends.length ? ` (${failedSends.length} failed to send to Telegram)` : '');
    console.log(`[${new Date().toISOString()}] Cron: ${msg}`);

    // If any Telegram sends failed, send a summary notification
    if (failedSends.length) {
      await sendNotification(`Generated ${savedPosts.length} posts but ${failedSends.length} failed to send previews. Check the review UI to approve them.`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron generate error:`, err.message);
    await sendNotification(`Content generation failed: ${err.message}`);
  }
}

// Publish approved posts every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    const posts = await getApprovedPosts();
    if (!posts.length) return;

    console.log(`[${new Date().toISOString()}] Cron: publishing ${posts.length} approved posts...`);
    for (const post of posts) {
      try {
        const result = await publish(post);
        await updatePostStatus(post.id, 'published');
        // Store Facebook post ID for insights tracking
        if (result.postId) {
          const { supabase } = require('./lib/supabase');
          await supabase.from('posts').update({ fb_post_id: result.postId }).eq('id', post.id).catch(() => {});
        }
        console.log(`  Published: ${post.id} (${post.brand}/${post.platform}) fb:${result.postId || 'n/a'}`);
      } catch (err) {
        console.error(`  Error publishing ${post.id}: ${err.message}`);
        // Notify on publish failure so it doesn't silently fail
        await sendNotification(`Failed to publish ${post.brand}/${post.template_type}: ${err.message.slice(0, 100)}`);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron publish error:`, err.message);
  }
});

// Collect Facebook insights daily at 8pm (gives posts time to accumulate engagement)
cron.schedule('0 20 * * *', async () => {
  try {
    const { collectInsights } = require('./lib/insights');
    const result = await collectInsights();
    if (result.fetched > 0) {
      console.log(`[${new Date().toISOString()}] Insights: fetched metrics for ${result.fetched}/${result.total} posts`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Insights cron error: ${err.message}`);
  }
});

// ── TELEGRAM BOT POLLING ──
// Listen for approve/reject button presses

let telegramOffset = 0;
let pendingRevision = null; // { postId, messageId, chatId }
let pendingBrief = null; // { messages: [], startedAt: number }

// ── CHAT MEMORY ──
const chatHistory = [];
const MAX_HISTORY = 10;

function addToHistory(role, text) {
  chatHistory.push({ role, text, timestamp: Date.now() });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
}

function getHistoryContext() {
  if (!chatHistory.length) return '';
  return 'RECENT CONVERSATION:\n' + chatHistory.map(m =>
    `${m.role === 'user' ? 'Owner' : 'ContentBrain'}: ${m.text}`
  ).join('\n') + '\n\n';
}

async function pollTelegram() {
  if (!BOT_TOKEN) return;

  try {
    const res = await fetch(`${API}/getUpdates?offset=${telegramOffset}&timeout=30&allowed_updates=["callback_query","message"]`);
    if (!res.ok) return;

    const { result } = await res.json();
    for (const update of result) {
      telegramOffset = update.update_id + 1;

      // Handle approve/reject button presses
      const cb = update.callback_query;
      if (cb && cb.data) {
        // Support both prefixed (cb:approve:id) and legacy (approve:id) formats
        const parts = cb.data.split(':');
        let action, postId;
        if (parts.length === 3 && parts[0] === 'cb') {
          action = parts[1];
          postId = parts[2];
        } else {
          action = parts[0];
          postId = parts[1];
        }

        if (postId && ['approve', 'reject'].includes(action)) {
          try {
            const status = action === 'approve' ? 'approved' : 'rejected';
            await updatePostStatus(postId, status);

            const emoji = action === 'approve' ? 'APPROVED' : 'REJECTED';
            const originalCaption = cb.message?.caption || cb.message?.text || '';
            await removeButtons(cb.message.chat.id, cb.message.message_id, `${originalCaption}\n\n${emoji}`);
            await answerCallback(cb.id, `Post ${status}`);

            console.log(`[Telegram] Post ${postId} ${status}`);
          } catch (err) {
            console.error(`[Telegram] Error handling callback: ${err.message}`);
            await answerCallback(cb.id, 'Error — try again');
          }
        }

        if (postId && action === 'revise') {
          pendingRevision = { postId, chatId: cb.message.chat.id, messageId: cb.message.message_id };
          await answerCallback(cb.id, 'Send your feedback');
          await sendNotification('What would you like changed? Reply with your feedback.');
          console.log(`[Telegram] Revision requested for ${postId}`);
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
          const { execSync } = require('child_process');
          const ffmpeg = require('ffmpeg-static');
          const logoPath = path.join(__dirname, 'LOGOS', 'auctionbrain-logo-transparent.png');
          const rawPath = path.join(__dirname, 'output', rawFilename);
          const outPath = path.join(__dirname, 'output', filename);

          try {
            execSync(
              `"${ffmpeg}" -i "${rawPath}" -i "${logoPath}" -filter_complex "[1:v]scale=700:-1,format=rgba,colorchannelmixer=aa=0.9[logo];[0:v][logo]overlay=W-w-50:H-h-50" -c:a copy -y "${outPath}"`,
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
          const Anthropic = require('@anthropic-ai/sdk');
          const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
          const { brands } = require('./lib/config');
          const b = brands.auctionbrain;

          const prompt = userCaption
            ? `The content owner sent a video with this note: "${userCaption}"\n\nWrite a short, engaging Facebook post caption for this video. The brand is ${b.name} (${b.url}) targeting ${b.audience}. Tone: ${b.tone}. British English, no hashtags in the caption. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }`
            : `Write a short, engaging Facebook post caption for a video posted by ${b.name} (${b.url}) targeting ${b.audience}. Tone: ${b.tone}. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }`;

          const response = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 500,
            messages: [{ role: 'user', content: prompt }]
          });

          const text = response.content[0].text;
          const match = text.match(/\{[\s\S]*\}/);
          const copy = match ? JSON.parse(match[0]) : { copy_headline: userCaption || 'New video', copy_body: '', copy_cta: b.url };

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

      // Handle text messages
      if (msg && msg.text && String(msg.chat.id) === String(CHAT_ID)) {
        const text = msg.text.trim();

        // Handle pending revision feedback
        if (pendingRevision && !text.startsWith('/')) {
          const rev = pendingRevision;
          pendingRevision = null;
          try {
            await sendNotification('Interpreting your feedback...');
            const post = await getPostById(rev.postId);

            // Store feedback for rejection learning (even if post gets revised and approved)
            const { supabase: sb } = require('./lib/supabase');
            await sb.from('posts').update({ rejection_feedback: text }).eq('id', rev.postId).catch(() => {});

            const Anthropic = require('@anthropic-ai/sdk');
            const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
            const { brands } = require('./lib/config');
            const b = brands[post.brand] || brands.auctionbrain;

            // Step 1: Classify the feedback — what kind of change is needed?
            const classifyResponse = await anthropic.messages.create({
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
            const classMatch = classText.match(/\{[\s\S]*\}/);
            if (!classMatch) throw new Error('Could not interpret feedback');
            const classification = JSON.parse(classMatch[0]);

            console.log(`[Telegram] Revision classified: ${classification.type} — ${classification.summary}`);
            await sendNotification(`Understood: ${classification.summary}`);

            let revised = { copy_headline: post.copy_headline, copy_body: post.copy_body, copy_cta: post.copy_cta };
            let needsVideoRerender = false;
            let videoDuration = null;

            // Step 2: Handle copy changes
            if (classification.copy_action === 'rewrite') {
              const copyInstructions = classification.copy_instructions || text;
              const copyResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                messages: [{ role: 'user', content: `You wrote this social media post for ${b.name}:\n\nHeadline: ${post.copy_headline}\nBody: ${post.copy_body}\nCTA: ${post.copy_cta}\n\nRevision needed: ${copyInstructions}\n\nRewrite the post. Keep the same format and tone. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }` }]
              });

              const aiText = copyResponse.content[0].text;
              const match = aiText.match(/\{[\s\S]*\}/);
              if (match) revised = JSON.parse(match[0]);
            }

            // Step 3: Handle video changes
            if (classification.video_action === 'extend_duration' || classification.video_action === 're-render') {
              needsVideoRerender = true;
              videoDuration = classification.video_duration_seconds || 30;
            }

            // Apply copy changes
            const { supabase } = require('./lib/supabase');
            await supabase.from('posts').update({
              copy_headline: revised.copy_headline,
              copy_body: revised.copy_body || '',
              copy_cta: revised.copy_cta || ''
            }).eq('id', rev.postId);

            // Re-render video if needed
            if (needsVideoRerender && post.video_url) {
              try {
                await sendNotification(`Re-rendering video (${videoDuration}s)...`);
                const { renderVideo, ensureBundle } = require('./lib/video-renderer');
                await ensureBundle();

                const updatedPost = {
                  ...post,
                  ...revised,
                  overrideDurationSeconds: videoDuration,
                };
                const video = await renderVideo(post.template_type, post.brand, updatedPost);

                await supabase.from('posts').update({ video_url: video.filename }).eq('id', rev.postId);
                post.video_url = video.filename;
                console.log(`[Telegram] Re-rendered video: ${video.filename} (${videoDuration}s)`);
              } catch (videoErr) {
                console.error(`[Telegram] Video re-render failed: ${videoErr.message}`);
                await sendNotification(`Video re-render failed: ${videoErr.message}. Copy was updated.`);
              }
            }

            // Send revised post for review
            await sendPostForReview({ ...post, ...revised });
            console.log(`[Telegram] Post ${rev.postId} revised (${classification.type})`);
          } catch (err) {
            console.error(`[Telegram] Revision error: ${err.message}`);
            await sendNotification(`Revision failed: ${err.message}`);
          }
          continue;
        }

        // Handle pending brief conversation
        if (pendingBrief && !text.startsWith('/')) {
          const cancel = text.toLowerCase().match(/^(cancel|never ?mind|forget it|nah|skip)$/);
          if (cancel) {
            pendingBrief = null;
            const reply = 'No worries, brief cancelled.';
            await sendNotification(reply);
            addToHistory('user', text);
            addToHistory('assistant', reply);
            continue;
          }

          pendingBrief.messages.push(text);
          addToHistory('user', text);

          // After 2 messages from user (initial + follow-up), extract and save
          if (pendingBrief.messages.length >= 2) {
            try {
              const Anthropic = require('@anthropic-ai/sdk');
              const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

              const extractResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 400,
                messages: [{ role: 'user', content: `The content owner briefed a social media post across these messages:\n${pendingBrief.messages.map((m, i) => `Message ${i + 1}: "${m}"`).join('\n')}\n\nExtract a structured brief. Return JSON:\n{\n  "topic": "2-5 word topic summary",\n  "brand": "auctionbrain" or "bridgematch" or null,\n  "angle": "The specific angle or hook to take",\n  "data_points": "Any stats, facts, or stories mentioned, or null",\n  "full_brief": "A single paragraph combining all the info into a clear content brief"\n}` }]
              });

              const extractText = extractResponse.content[0].text;
              const extractMatch = extractText.match(/\{[\s\S]*\}/);
              if (!extractMatch) throw new Error('Could not parse brief');
              const structured = JSON.parse(extractMatch[0]);

              const { saveBrief } = require('./lib/supabase');
              await saveBrief(structured);

              const reply = `Got it — saved a brief about "${structured.topic}"${structured.brand ? ` for ${structured.brand}` : ''}. I'll work it into tomorrow's posts.`;
              await sendNotification(reply);
              addToHistory('assistant', reply);
              console.log(`[Telegram] Structured brief saved: ${structured.topic}`);
            } catch (err) {
              console.error(`[Telegram] Brief extraction error: ${err.message}`);
              const { saveBrief } = require('./lib/supabase');
              await saveBrief(pendingBrief.messages.join(' '));
              const reply = 'Saved your brief for tomorrow.';
              await sendNotification(reply);
              addToHistory('assistant', reply);
            }
            pendingBrief = null;
          } else {
            // Ask one follow-up question
            try {
              const Anthropic = require('@anthropic-ai/sdk');
              const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

              const followUpResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 150,
                messages: [{ role: 'user', content: `You are ContentBrain. The content owner wants to brief a future social media post.\n\nThey said: "${pendingBrief.messages.join(' ')}"\n\nAsk ONE short follow-up question to make this brief more actionable. Focus on: what angle or hook? Any specific data points or stories to include? Which brand (AuctionBrain or BridgeMatch)?\n\nKeep it casual, one sentence. British English.` }]
              });

              const reply = followUpResponse.content[0].text.trim();
              await sendNotification(reply);
              addToHistory('assistant', reply);
            } catch (err) {
              // If follow-up fails, just save what we have
              const { saveBrief } = require('./lib/supabase');
              await saveBrief(pendingBrief.messages.join(' '));
              pendingBrief = null;
              await sendNotification('Saved your brief for tomorrow.');
            }
          }
          continue;
        }

        // Timeout pending brief after 10 minutes
        if (pendingBrief && Date.now() - pendingBrief.startedAt > 10 * 60 * 1000) {
          const { saveBrief } = require('./lib/supabase');
          await saveBrief(pendingBrief.messages.join(' '));
          pendingBrief = null;
          console.log('[Telegram] Brief timed out, saved as-is');
        }

        // /generate — create new posts now
        if (text === '/generate') {
          try {
            await sendNotification('Generating posts now...');
            const { generateBatch } = require('./lib/generate');
            const { renderPost } = require('./lib/renderer');
            const { renderVideo } = require('./lib/video-renderer');

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
                  scheduled_for: scheduledFor.toISOString()
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

        // /status — quick overview
        if (text === '/status') {
          try {
            const drafts = await getDraftPosts();
            const approved = await getApprovedPosts();
            const { getPendingBriefs } = require('./lib/supabase');
            const briefs = await getPendingBriefs();
            const pubMethod = process.env.FB_PAGE_ACCESS_TOKEN ? 'Facebook Direct' : process.env.MAKE_WEBHOOK_URL ? 'Make.com' : 'NOT CONFIGURED';
            await sendNotification(
              `<b>ContentBrain Status</b>\n\n` +
              `Drafts awaiting review: ${drafts.length}\n` +
              `Approved (ready to publish): ${approved.length}\n` +
              `Pending briefs: ${briefs.length}\n` +
              `Publishing via: ${pubMethod}`
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
            `/generate — create new posts now\n` +
            `/publish — publish all approved posts now\n` +
            `/status — check drafts, approved, briefs\n` +
            `/help — show this message\n\n` +
            `Or just send a text message to brief tomorrow's posts, or send a video to create a watermarked post.`
          );
          continue;
        }

        // Unknown command
        if (text.startsWith('/')) continue;

        // Smart intent classification — route message to the right action
        try {
          const Anthropic = require('@anthropic-ai/sdk');
          const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

          // Get recent drafts for context
          const recentDrafts = await getDraftPosts().catch(() => []);
          const draftsContext = recentDrafts.slice(0, 5).map(p =>
            `- ID:${p.id} | ${p.brand}/${p.template_type} | "${p.copy_headline}" | has_video:${!!p.video_url}`
          ).join('\n');

          addToHistory('user', text);

          const intentResponse = await anthropic.messages.create({
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
  "action": "revise_post" | "save_brief" | null,
  "post_id": "only if action is revise_post — the draft ID they're referring to, or null",
  "summary": "one-line summary of what they want (only if action is not null)"
}

Guidelines:
- MOST messages need no action — just reply naturally. Chat, answer questions, be helpful.
- Only set action to "save_brief" if the owner is CLEARLY giving you a specific topic or idea for future posts (e.g. "do a post about bridging loan rates rising")
- Only set action to "revise_post" if they're giving specific feedback on a draft (e.g. "make the headline shorter", "change the CTA")
- When in doubt, just reply — don't trigger an action. It's always better to chat than to wrongly save a brief or revise a post.
- Keep replies short, friendly, British English.` }]
          });

          const intentText = intentResponse.content[0].text;
          const intentMatch = intentText.match(/\{[\s\S]*\}/);
          if (!intentMatch) throw new Error('Could not classify message');
          const intent = JSON.parse(intentMatch[0]);

          console.log(`[Telegram] Action: ${intent.action || 'chat'} — ${intent.summary || intent.reply?.slice(0, 50)}`);

          // Always send the conversational reply
          if (intent.reply) {
            await sendNotification(intent.reply);
            addToHistory('assistant', intent.reply);
          }

          if (intent.action === 'revise_post' && intent.post_id) {
            // Route to revision flow
            pendingRevision = { postId: intent.post_id, chatId: msg.chat.id, messageId: msg.message_id };
            const rev = pendingRevision;
            pendingRevision = null;
            const post = await getPostById(rev.postId);
            if (!post) {
              await sendNotification(`Couldn't find that post. Use the Revise button on a specific post, or try again.`);
              continue;
            }

            const { brands } = require('./lib/config');
            const b = brands[post.brand] || brands.auctionbrain;

            const classifyResponse = await anthropic.messages.create({
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
            const classMatch = classText.match(/\{[\s\S]*\}/);
            if (!classMatch) throw new Error('Could not interpret feedback');
            const classification = JSON.parse(classMatch[0]);

            await sendNotification(`Understood: ${classification.summary}`);

            let revised = { copy_headline: post.copy_headline, copy_body: post.copy_body, copy_cta: post.copy_cta };
            let needsVideoRerender = false;
            let videoDuration = null;

            if (classification.copy_action === 'rewrite') {
              const copyInstructions = classification.copy_instructions || text;
              const copyResponse = await anthropic.messages.create({
                model: 'claude-haiku-4-5-20251001',
                max_tokens: 500,
                messages: [{ role: 'user', content: `You wrote this social media post for ${b.name}:\n\nHeadline: ${post.copy_headline}\nBody: ${post.copy_body}\nCTA: ${post.copy_cta}\n\nRevision needed: ${copyInstructions}\n\nRewrite the post. Keep the same format and tone. British English, no hashtags. Return JSON: { "copy_headline": "...", "copy_body": "...", "copy_cta": "..." }` }]
              });
              const aiText = copyResponse.content[0].text;
              const match = aiText.match(/\{[\s\S]*\}/);
              if (match) revised = JSON.parse(match[0]);
            }

            if (classification.video_action === 'extend_duration' || classification.video_action === 're-render') {
              needsVideoRerender = true;
              videoDuration = classification.video_duration_seconds || 30;
            }

            const { supabase } = require('./lib/supabase');
            await supabase.from('posts').update({
              copy_headline: revised.copy_headline,
              copy_body: revised.copy_body || '',
              copy_cta: revised.copy_cta || ''
            }).eq('id', rev.postId);

            if (needsVideoRerender && post.video_url) {
              try {
                await sendNotification(`Re-rendering video (${videoDuration}s)...`);
                const { renderVideo, ensureBundle } = require('./lib/video-renderer');
                await ensureBundle();
                const updatedPost = { ...post, ...revised, overrideDurationSeconds: videoDuration };
                const video = await renderVideo(post.template_type, post.brand, updatedPost);
                await supabase.from('posts').update({ video_url: video.filename }).eq('id', rev.postId);
                post.video_url = video.filename;
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
            pendingBrief = { messages: [text], startedAt: Date.now() };
            try {
              const followUpResponse = await anthropic.messages.create({
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
              pendingBrief = null;
              await sendNotification(`Saved as a brief for tomorrow's posts.`);
            }
            console.log(`[Telegram] Brief conversation started: ${text.slice(0, 50)}...`);
          }
          // No else needed — conversational reply was already sent above
        } catch (err) {
          console.error(`[Telegram] Smart routing error: ${err.message}`);
          // Fall back to a simple apology
          await sendNotification(`Sorry, something went wrong processing that. Try /help for commands.`).catch(() => {});
        }
      }
    }
  } catch (err) {
    // Silence network errors, will retry next poll
  }

  setTimeout(pollTelegram, 1000);
}

// ── START ──
app.listen(PORT, async () => {
  console.log(`ContentBrain review UI running on port ${PORT}`);
  console.log('Cron: generate at 7am daily, publish every 15 mins');
  console.log('Telegram: polling for approve/reject buttons');

  // Notify on startup so you know the server is alive
  const drafts = await getDraftPosts().catch(() => []);
  const approved = await getApprovedPosts().catch(() => []);
  await sendNotification(
    `<b>ContentBrain started</b>\n\n` +
    `Drafts: ${drafts.length} | Approved: ${approved.length}\n` +
    `Publishing: ${process.env.FB_PAGE_ACCESS_TOKEN ? 'Facebook Direct' : process.env.MAKE_WEBHOOK_URL ? 'Make.com' : 'NOT CONFIGURED'}`
  );

  pollTelegram();
});
