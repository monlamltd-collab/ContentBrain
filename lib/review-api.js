const express = require('express');
const { timingSafeEqual } = require('crypto');
const { sendNotification, sendBlogForReview } = require('./telegram');
const router = express.Router();

const REVIEW_API_KEY = process.env.REVIEW_API_KEY;

// Constant-time string compare — prevents timing side-channels on the
// internet-facing /api/review endpoint. Returns false on length mismatch
// without comparing bytes (length itself isn't a secret).
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// Auth middleware for review API
function requireApiKey(req, res, next) {
  const auth = req.headers.authorization;
  if (!REVIEW_API_KEY) {
    return res.status(500).json({ error: 'REVIEW_API_KEY not configured' });
  }
  if (!auth || !safeEqual(auth, `Bearer ${REVIEW_API_KEY}`)) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  next();
}

// POST /api/review — receive a draft from blog generators
router.post('/review', requireApiKey, async (req, res) => {
  const { content_type, brand, source, post_id, title, summary, score, word_count } = req.body;

  // Validate required fields
  if (!content_type || !brand || !post_id || !title) {
    return res.status(400).json({ error: 'Missing required fields: content_type, brand, post_id, title' });
  }

  if (!['blog', 'guide', 'social'].includes(content_type)) {
    return res.status(400).json({ error: 'content_type must be blog, guide, or social' });
  }

  try {
    await sendBlogForReview({
      content_type,
      brand,
      source: source || 'unknown',
      post_id,
      title,
      summary: summary || '',
      score: score || null,
      word_count: word_count || null
    });

    console.log(`[Review API] ${content_type} from ${source}: "${title}"`);
    res.json({ ok: true, message: 'Sent for review' });
  } catch (err) {
    console.error(`[Review API] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
