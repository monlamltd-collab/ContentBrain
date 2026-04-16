require('dotenv').config();
const fs = require('fs');
const path = require('path');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;

async function sendNotification(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('  Telegram not configured — skipping notification');
    return;
  }

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
    console.log(`  Telegram send failed: ${err.slice(0, 200)}`);
  }
}

// Send a post for review with video/image preview and approve/reject buttons
async function sendPostForReview(post) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('  Telegram not configured — skipping review notification');
    return;
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
        { text: 'Revise', callback_data: `cb:revise:${post.id}` },
        { text: 'Reject', callback_data: `cb:reject:${post.id}` }
      ]
    ]
  };

  // Try sending video first, fall back to image, fall back to text
  if (post.video_url) {
    const videoPath = path.join(OUTPUT_DIR, post.video_url);
    if (fs.existsSync(videoPath)) {
      const form = new FormData();
      form.append('chat_id', CHAT_ID);
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
      form.append('reply_markup', JSON.stringify(buttons));
      form.append('video', new Blob([fs.readFileSync(videoPath)]), post.video_url);

      const res = await fetch(`${API}/sendVideo`, { method: 'POST', body: form });
      if (res.ok) return;
      console.log('  Telegram sendVideo failed, trying image fallback...');
    }
  }

  if (post.image_url) {
    const imagePath = path.join(OUTPUT_DIR, post.image_url);
    if (fs.existsSync(imagePath)) {
      const form = new FormData();
      form.append('chat_id', CHAT_ID);
      form.append('caption', caption);
      form.append('parse_mode', 'HTML');
      form.append('reply_markup', JSON.stringify(buttons));
      form.append('photo', new Blob([fs.readFileSync(imagePath)]), post.image_url);

      const res = await fetch(`${API}/sendPhoto`, { method: 'POST', body: form });
      if (res.ok) return;
      console.log('  Telegram sendPhoto failed, falling back to text...');
    }
  }

  // Text fallback
  await fetch(`${API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: caption,
      parse_mode: 'HTML',
      reply_markup: buttons
    })
  });
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

module.exports = { sendNotification, sendPostForReview, answerCallback, removeButtons, downloadTelegramFile, API, BOT_TOKEN, CHAT_ID };
