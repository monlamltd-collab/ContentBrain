const express = require('express');
const { timingSafeEqual } = require('crypto');
const { sendNotification, sendBlogForReview } = require('./telegram');
const { getRecentBlogPostTitles } = require('./supabase');
const router = express.Router();

// Stopwords — filtered before comparing titles for theme similarity
const STOPWORDS = new Set([
  'a','an','the','and','or','but','in','on','at','to','for','of','with',
  'by','from','up','about','into','how','what','why','when','where','who',
  'is','are','was','were','be','been','has','have','had','do','does','did',
  'will','would','could','should','may','might','can','your','our','their',
  'its','it','this','that','these','those','you','we','they','he','she',
  'i','me','my','us','as','if','not','no','so','than','then','there',
]);

/**
 * Extract significant words from a title for theme comparison.
 * Returns a Set of lowercase alpha words that aren't stopwords.
 */
function titleWords(title) {
  return new Set(
    (title || '').toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

/**
 * Jaccard similarity between two word sets. Returns 0–1.
 */
function jaccardSimilarity(a, b) {
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Check a new title against recent blog posts for this brand.
 * Returns the matching post if the theme is too similar, else null.
 * Threshold: Jaccard ≥ 0.40 (40% word overlap = same story, different headline).
 */
function findThemeMatch(newTitle, recentPosts, threshold = 0.40) {
  const newWords = titleWords(newTitle);
  if (!newWords.size) return null;
  for (const post of recentPosts) {
    const sim = jaccardSimilarity(newWords, titleWords(post.title));
    if (sim >= threshold) return { post, similarity: sim };
  }
  return null;
}

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

  // ── THEME DEDUP — blog and guide posts only ──────────────────────────────
  // Check the incoming title against recent posts for this brand (last 45 days).
  // If the theme is too similar (Jaccard ≥ 0.40), reject to prevent the review
  // queue filling up with repeated angles (BoE rate, buyer guides, etc.).
  // Pass ?force=true to bypass this check for editorial overrides.
  if (content_type !== 'social' && req.query.force !== 'true') {
    try {
      const recentPosts = await getRecentBlogPostTitles(brand, 45);
      const match = findThemeMatch(title, recentPosts);
      if (match) {
        const coveredThemes = recentPosts.slice(0, 20).map(p => `"${p.title}" (${p.status})`);
        console.log(`[Review API] THEME DUPLICATE rejected: "${title}" ≈ "${match.post.title}" (similarity ${match.similarity.toFixed(2)}) for ${brand}`);
        return res.status(409).json({
          error: 'theme_duplicate',
          message: `Theme too similar to a recent post: "${match.post.title}" (${(match.similarity * 100).toFixed(0)}% overlap). Choose a fresh angle.`,
          matched_post: { id: match.post.id, title: match.post.title, status: match.post.status },
          recently_covered_themes: coveredThemes,
          hint: 'Add ?force=true to bypass this check for editorial overrides.',
        });
      }
    } catch (dedupErr) {
      // Non-fatal — if the dedup check fails, let the post through rather than
      // silently dropping valid content. Log for diagnostics.
      console.warn(`[Review API] Theme dedup check failed: ${dedupErr.message}`);
    }
  }

  try {
    // Pull source articles from the right Supabase project so the editor can
    // see (and click into) the original sources alongside the draft. The FK
    // is scraped_articles.used_in_post = blog_posts.id, set by the content
    // engines after savePost(). Older posts may have none — we just skip
    // showing the Sources block in that case.
    const { getSourceArticlesForPost } = require('./supabase');
    const sources = await getSourceArticlesForPost(post_id, brand).catch(() => []);

    await sendBlogForReview({
      content_type,
      brand,
      source: source || 'unknown',
      post_id,
      title,
      summary: summary || '',
      score: score || null,
      word_count: word_count || null,
      sources, // [{ title, url, content }] — telegram.js renders the first 5
    });

    console.log(`[Review API] ${content_type} from ${source}: "${title}" (${sources.length} sources)`);
    res.json({ ok: true, message: 'Sent for review' });
  } catch (err) {
    console.error(`[Review API] Error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/review/recent-themes?brand=auctionbrain&days=45
// Returns titles of recently submitted posts so external generators can
// avoid repeating covered themes. Authenticated via the same API key.
router.get('/review/recent-themes', requireApiKey, async (req, res) => {
  const brand = req.query.brand || 'auctionbrain';
  const days = Math.min(parseInt(req.query.days, 10) || 45, 90);

  try {
    const posts = await getRecentBlogPostTitles(brand, days);
    const themes = posts.map(p => ({
      title: p.title,
      status: p.status,
      tags: p.tags || [],
      keywords: [...titleWords(p.title)],
    }));
    res.json({ brand, days, count: themes.length, themes });
  } catch (err) {
    console.error(`[Review API] recent-themes error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
