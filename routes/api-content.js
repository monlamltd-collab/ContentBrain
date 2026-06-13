'use strict';

// routes/api-content.js — the /api/content/* JSON endpoints, extracted
// verbatim from server.js (pure move; behavior identical). Consumed by the
// dashboard Editorial tab. Auth is applied at the mount:
//   app.use('/api/content', requireAuth, router)

const express = require('express');
const router = express.Router();

const {
  getPublishedBlogPostsBothBrands,
  getDraftBlogPosts,
  getPendingBriefsAll,
  saveBrief,
  dismissBrief,
  saveSeed,
  getBlogPostById,
  updateBlogPostStatus,
} = require('../lib/supabase');
const { createLLM } = require('../lib/llm');

const _llmForEditorial = createLLM();
const SUPPORTED_IMAGE_TYPES_ED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

router.get('/coverage', async (req, res) => {
  try {
    const posts = await getPublishedBlogPostsBothBrands();
    const brand = req.query.brand; // optional filter

    const filtered = brand ? posts.filter(p => p.brand === brand) : posts;

    // Build tag frequency map
    const tagCount = {};
    for (const post of filtered) {
      const tags = Array.isArray(post.tags) ? post.tags : [];
      for (const tag of tags) {
        tagCount[tag] = (tagCount[tag] || 0) + 1;
      }
    }

    // Classify: 0 = gap, 1-2 = covered, 3+ = saturated
    const coverage = Object.entries(tagCount)
      .map(([tag, count]) => ({
        tag,
        count,
        status: count >= 3 ? 'saturated' : 'covered'
      }))
      .sort((a, b) => b.count - a.count);

    res.json({ posts: filtered.length, coverage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/queue', async (req, res) => {
  try {
    const drafts = await getDraftBlogPosts();
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/briefs', async (req, res) => {
  try {
    const briefs = await getPendingBriefsAll();
    res.json({ briefs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/brief', async (req, res) => {
  try {
    const { brand, message, topic, angle } = req.body;
    if (!message?.trim()) return res.status(400).json({ error: 'message is required' });
    const brief = await saveBrief({ brand: brand || null, message: message.trim(), topic: topic || null, angle: angle || null });
    res.json({ ok: true, brief });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual trigger for the Reddit-thread → brief promotion. Same logic as
// the daily cron at 06:30 UTC, exposed so the editor can pull fresh briefs
// on demand from the Brief Queue panel.
router.post('/refresh-reddit-briefs', async (req, res) => {
  try {
    const { promoteRedditThreadsToBriefs } = require('../lib/reddit-briefs');
    const result = await promoteRedditThreadsToBriefs();
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/brief/:id/dismiss', async (req, res) => {
  try {
    await dismissBrief(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/seed', async (req, res) => {
  try {
    const { brand, content, title } = req.body;
    if (!content?.trim()) return res.status(400).json({ error: 'content is required' });
    const seed = await saveSeed({ brand: brand || null, content: content.trim(), title: title?.trim() || null });
    res.json({ ok: true, seed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Accepts { mimeType, data (base64), filename } — extracts content via Claude
router.post('/upload', async (req, res) => {
  try {
    const { mimeType, data, filename } = req.body;
    if (!data) return res.status(400).json({ error: 'data (base64) is required' });

    const isPdf = mimeType === 'application/pdf';
    const isImage = SUPPORTED_IMAGE_TYPES_ED.includes(mimeType);
    if (!isPdf && !isImage) return res.status(400).json({ error: `Unsupported type: ${mimeType}` });

    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } }
      : { type: 'image', source: { type: 'base64', media_type: mimeType, data } };

    const response = await _llmForEditorial.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: [
          contentBlock,
          { type: 'text', text: 'Extract all useful editorial content from this document — headlines, article text, statistics, quotes, opinions. Format as clean markdown. Skip ads, subscription offers, navigation, and page numbers.' }
        ]
      }]
    });

    const extracted = response.content[0]?.text || '';
    if (extracted.length < 20) return res.status(422).json({ error: 'Could not extract readable content' });

    res.json({ ok: true, extracted, filename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch the full blog post so the editor can amend it before approving.
// Returns the row including content_md/content_html — heavier than the
// queue listing, but only fired when the editor actually opens the amend form.
router.get('/blog/:brand/:id', async (req, res) => {
  try {
    const { brand, id } = req.params;
    const post = await getBlogPostById(id, brand);
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Amend a draft blog post in-place. Updates whichever of title / summary /
// content_md were sent in the body. content_html is regenerated from the
// new content_md so the published version stays in sync — the landing
// site renders content_html, not content_md.
router.patch('/blog/:brand/:id', async (req, res) => {
  try {
    const { brand, id } = req.params;
    const { title, summary, content_md } = req.body;
    const updates = {};
    if (typeof title === 'string') {
      if (!title.trim()) return res.status(400).json({ error: 'title cannot be empty' });
      if (title.length > 200) return res.status(400).json({ error: 'title too long (max 200)' });
      updates.title = title.trim();
    }
    if (typeof summary === 'string') {
      if (summary.length > 500) return res.status(400).json({ error: 'summary too long (max 500)' });
      updates.summary = summary.trim();
    }
    if (typeof content_md === 'string') {
      if (!content_md.trim()) return res.status(400).json({ error: 'content cannot be empty' });
      if (content_md.length > 50000) return res.status(400).json({ error: 'content too long (max 50k)' });
      updates.content_md = content_md;
      // Regenerate content_html from the amended markdown so the landing
      // site (which reads content_html) doesn't fall behind.
      try {
        const { marked } = require('marked');
        updates.content_html = marked.parse(content_md);
      } catch (mdErr) {
        return res.status(500).json({ error: `markdown render failed: ${mdErr.message}` });
      }
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No editable fields provided' });

    const { getBlogClient } = require('../lib/supabase');
    const client = getBlogClient(brand);
    const { data, error } = await client.from('blog_posts').update(updates).eq('id', id).select().single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data, updated: Object.keys(updates) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/approve/:brand/:id', async (req, res) => {
  try {
    const { brand, id } = req.params;
    await updateBlogPostStatus(id, 'approved', {}, brand);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/reject/:brand/:id', async (req, res) => {
  try {
    const { brand, id } = req.params;
    const { feedback } = req.body;
    await updateBlogPostStatus(id, 'rejected', { revision_feedback: feedback || '' }, brand);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
