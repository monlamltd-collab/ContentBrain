require('dotenv').config();

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendNotification(message) {
  if (!BOT_TOKEN || !CHAT_ID) {
    console.log('  Telegram not configured — skipping notification');
    return;
  }

  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const res = await fetch(url, {
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

module.exports = { sendNotification };
