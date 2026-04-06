require('dotenv').config();
const fs = require('fs');
const path = require('path');

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

async function publishToMake(post) {
  if (!MAKE_WEBHOOK_URL) {
    throw new Error('MAKE_WEBHOOK_URL not configured');
  }

  // Build caption from post fields
  const caption = [post.copy_headline, post.copy_body, post.copy_cta]
    .filter(Boolean)
    .join('\n\n');

  // Read image as base64 if it exists locally
  let imageBase64 = null;
  if (post.image_url) {
    const imagePath = path.join(OUTPUT_DIR, post.image_url);
    if (fs.existsSync(imagePath)) {
      imageBase64 = fs.readFileSync(imagePath).toString('base64');
    }
  }

  const payload = {
    id: post.id,
    brand: post.brand,
    platform: post.platform,
    template_type: post.template_type,
    caption,
    headline: post.copy_headline,
    body: post.copy_body,
    cta: post.copy_cta,
    image_filename: post.image_url,
    image_base64: imageBase64
  };

  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Make webhook failed (${res.status}): ${err.slice(0, 200)}`);
  }

  return { ok: true, platform: post.platform };
}

module.exports = { publishToMake };
