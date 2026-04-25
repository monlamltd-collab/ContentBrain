require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendNotification(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('  [Telegram] Not configured — skipping notification');
    return false;
  }

  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: message,
        parse_mode: 'HTML'
      })
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`  [Telegram] sendMessage failed (${res.status}): ${err.slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`  [Telegram] sendMessage error: ${err.message}`);
    return false;
  }
}

// Send a post for review with video/image preview and approve/reject buttons
// Returns { ok: boolean, error?: string } so callers can handle failures
async function sendPostForReview(post) {
  if (!BOT_TOKEN || !CHAT_ID) {
    const msg = 'Telegram not configured';
    console.log(`  [Telegram] ${msg} — skipping review notification`);
    return { ok: false, error: msg };
  }

  const caption = [
    `<b>${post.brand}</b> — ${post.template_type} (${post.platform})`,
    '',
    `<b>${post.copy_headline || ''}</b>`,
    post.copy_body || '',
    post.copy_cta ? `\n${post.copy_cta}` : ''
  ].join('\n').trim();

  const buttons = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `cb:approve:${post.id}` },
        { text: 'Schedule', callback_data: `cb:schedule:${post.id}` }
      ],
      [
        { text: 'Revise', callback_data: `cb:revise:${post.id}` },
        { text: 'Reject', callback_data: `cb:reject:${post.id}` }
      ]
    ]
  };

  // Try sending video first, fall back to image, fall back to text
  if (post.video_url) {
    const videoPath = path.join(OUTPUT_DIR, post.video_url);
    if (fs.existsSync(videoPath)) {
      try {
        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');
        form.append('reply_markup', JSON.stringify(buttons));
        form.append('video', new Blob([fs.readFileSync(videoPath)]), post.video_url);

        const res = await fetch(`${API}/sendVideo`, { method: 'POST', body: form });
        if (res.ok) {
          console.log(`  [Telegram] Sent video for ${post.id}`);
          return { ok: true };
        }
        const err = await res.text();
        console.error(`  [Telegram] sendVideo failed (${res.status}): ${err.slice(0, 200)}`);
      } catch (err) {
        console.error(`  [Telegram] sendVideo error: ${err.message}`);
      }
      console.log('  [Telegram] Trying image fallback...');
    } else {
      console.warn(`  [Telegram] Video file missing: ${videoPath}`);
    }
  }

  if (post.image_url) {
    const imagePath = path.join(OUTPUT_DIR, post.image_url);
    if (fs.existsSync(imagePath)) {
      try {
        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('caption', caption);
        form.append('parse_mode', 'HTML');
        form.append('reply_markup', JSON.stringify(buttons));
        form.append('photo', new Blob([fs.readFileSync(imagePath)]), post.image_url);

        const res = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
        if (res.ok) {
          console.log(`  [Telegram] Sent photo for ${post.id}`);
          return { ok: true };
        }
        const err = await res.text();
        console.error(`  [Telegram] sendPhoto failed (${res.status}): ${err.slice(0, 200)}`);
      } catch (err) {
        console.error(`  [Telegram] sendPhoto error: ${err.message}`);
      }
      console.log('  [Telegram] Falling back to text...');
    } else {
      console.warn(`  [Telegram] Image file missing: ${imagePath}`);
    }
  }

  // Text fallback
  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text: caption,
        parse_mode: 'HTML',
        reply_markup: buttons
      })
    });
    if (res.ok) {
      console.log(`  [Telegram] Sent text fallback for ${post.id}`);
      return { ok: true };
    }
    const err = await res.text();
    const msg = `All send methods failed. Last: (${res.status}) ${err.slice(0, 200)}`;
    console.error(`  [Telegram] ${msg}`);
    return { ok: false, error: msg };
  } catch (err) {
    const msg = `All send methods failed: ${err.message}`;
    console.error(`  [Telegram] ${msg}`);
    return { ok: false, error: msg };
  }
}

// Answer a callback query (removes the "loading" spinner on the button)
async function answerCallback(callbackQueryId, text) {
  await fetch(`${API}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      callback_query_id: callbackQueryId,
      text
    })
  });
}

// Edit the message buttons after action is taken
async function removeButtons(chatId, messageId, newCaption) {
  await fetch(`${API}/editMessageCaption`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      message_id: messageId,
      caption: newCaption,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [] }
    })
  }).catch(() => {
    // If editMessageCaption fails (text-only message), try editMessageText
    fetch(`${API}/editMessageText`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        text: newCaption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [] }
      })
    });
  });
}

// Download a file from Telegram servers
async function downloadTelegramFile(fileId, outputFilename) {
  // Get file path from Telegram
  const fileRes = await fetch(`${API}/getFile?file_id=${fileId}`);
  if (!fileRes.ok) throw new Error('Failed to get file info from Telegram');
  const { result } = await fileRes.json();

  // Download the file
  const downloadUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${result.file_path}`;
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) throw new Error('Failed to download file from Telegram');

  const buffer = Buffer.from(await dlRes.arrayBuffer());
  const outputPath = path.join(OUTPUT_DIR, outputFilename);
  fs.writeFileSync(outputPath, buffer);

  return { outputPath, filename: outputFilename, sizeBytes: buffer.length };
}

// Send a blog/guide post for review with approve/revise/reject buttons
// Used by the review API when blog generators push drafts
async function sendBlogForReview(item) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('  [Telegram] Not configured — skipping blog review notification');
    return { ok: false, error: 'Telegram not configured' };
  }

  const brandEmoji = item.brand === 'bridgematch' ? '\u{1F3E6}' : '\u{1F3E0}';
  const brandLabel = item.brand === 'bridgematch' ? 'BridgeMatch' : 'AuctionBrain';
  const typeLabel = item.content_type === 'guide' ? 'Guide' : 'Blog';

  const escHtml = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  // Render the source articles list — link each title to its source URL so
  // the editor can verify quotes, check tone, and pull additional facts
  // when revising. Cap at 5 to keep the message readable.
  const sources = Array.isArray(item.sources) ? item.sources : [];
  let sourcesBlock = null;
  if (sources.length > 0) {
    const lines = sources.slice(0, 5).map(s => {
      const title = escHtml((s.title || 'Source').slice(0, 80));
      return s.url
        ? `• <a href="${escHtml(s.url)}">${title}</a>`
        : `• ${title}`;
    });
    if (sources.length > 5) lines.push(`<i>… +${sources.length - 5} more</i>`);
    sourcesBlock = '<b>Sources:</b>\n' + lines.join('\n');
  }

  const text = [
    `${brandEmoji} <b>${brandLabel} ${typeLabel} Draft</b>`,
    '',
    `<b>${item.title}</b>`,
    '',
    item.score ? `Score: ${item.score}/10` : null,
    item.word_count ? `Words: ${item.word_count}` : null,
    '',
    item.summary ? `${item.summary.slice(0, 200)}${item.summary.length > 200 ? '...' : ''}` : null,
    sourcesBlock ? '' : null,
    sourcesBlock
  ].filter(line => line !== null).join('\n').trim();

  // Encode brand as a 2-char code so callback_data stays under Telegram's 64-byte cap
  // (full brand names would push the string over the limit with a UUID post_id).
  const brandCode = item.brand === 'bridgematch' ? 'bm' : 'ab';

  const buttons = {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: `rv:${item.content_type}:${brandCode}:approve:${item.post_id}` },
        { text: 'Schedule', callback_data: `rv:${item.content_type}:${brandCode}:schedule:${item.post_id}` }
      ],
      [
        { text: 'Revise', callback_data: `rv:${item.content_type}:${brandCode}:revise:${item.post_id}` },
        { text: 'Reject', callback_data: `rv:${item.content_type}:${brandCode}:reject:${item.post_id}` }
      ]
    ]
  };

  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: CHAT_ID,
        text,
        parse_mode: 'HTML',
        // Sources are linked but Telegram would otherwise auto-expand a giant
        // preview card for the FIRST link, pushing the buttons off-screen.
        link_preview_options: { is_disabled: true },
        reply_markup: buttons
      })
    });

    if (res.ok) {
      console.log(`  [Telegram] Sent ${item.content_type} review for ${item.post_id}`);
      return { ok: true };
    }
    const err = await res.text();
    console.error(`  [Telegram] sendBlogForReview failed (${res.status}): ${err.slice(0, 200)}`);
    return { ok: false, error: err.slice(0, 200) };
  } catch (err) {
    console.error(`  [Telegram] sendBlogForReview error: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { sendNotification, sendPostForReview, sendBlogForReview, answerCallback, removeButtons, downloadTelegramFile, API, BOT_TOKEN, CHAT_ID };
