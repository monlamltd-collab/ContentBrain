'use strict';

// routes/api-social.js — the /api/social/* JSON endpoints, extracted
// verbatim from server.js (pure move; behavior identical). Consumed by the
// dashboard Studio tab and shared with Telegram-side flows. Auth is applied
// at the mount: app.use('/api/social', requireAuth, router).

const express = require('express');
const router = express.Router();

const { getDraftPosts, updatePostStatus, getPostById } = require('../lib/supabase');

// Defensive: strip directory components from a render-output filename before
// it ever lands in the DB. Renderers should already produce safe basenames,
// but a future bug there must not turn into a path-traversal issue when the
// filename is later concatenated into '/output/<name>' on the client.
function safeFilename(name) {
  if (typeof name !== 'string' || !name) return null;
  return name.replace(/[\\/]/g, '').replace(/^\.+/, '');
}

router.get('/queue', async (req, res) => {
  try {
    const drafts = await getDraftPosts();
    res.json({ drafts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/posts/:id/approve', async (req, res) => {
  try {
    const post = await updatePostStatus(req.params.id, 'approved');
    res.json({ ok: true, post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/posts/:id/reject', async (req, res) => {
  try {
    const { feedback } = req.body;
    const { supabase } = require('../lib/supabase');
    const updates = { status: 'rejected' };
    if (feedback?.trim()) updates.rejection_feedback = feedback.trim();
    const { data, error } = await supabase.from('posts').update(updates).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/posts/:id/copy', async (req, res) => {
  try {
    const { copy_headline, copy_body, copy_cta } = req.body;
    const updates = {};
    // Headline: required to be non-empty (every post template needs one).
    // Body / CTA: intentionally allowed to be cleared to empty string —
    // some templates (e.g. stat) don't require body or CTA, so the editor
    // can blank them out.
    if (copy_headline !== undefined) {
      if (typeof copy_headline !== 'string' || !copy_headline.trim()) return res.status(400).json({ error: 'copy_headline must be a non-empty string' });
      if (copy_headline.length > 100) return res.status(400).json({ error: 'copy_headline too long (max 100)' });
      updates.copy_headline = copy_headline.trim();
    }
    if (copy_body !== undefined) {
      if (typeof copy_body !== 'string') return res.status(400).json({ error: 'copy_body must be a string' });
      if (copy_body.length > 300) return res.status(400).json({ error: 'copy_body too long (max 300)' });
      updates.copy_body = copy_body.trim();
    }
    if (copy_cta !== undefined) {
      if (typeof copy_cta !== 'string') return res.status(400).json({ error: 'copy_cta must be a string' });
      if (copy_cta.length > 80) return res.status(400).json({ error: 'copy_cta too long (max 80)' });
      updates.copy_cta = copy_cta.trim();
    }
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No copy fields provided' });

    const { supabase } = require('../lib/supabase');
    const { data, error } = await supabase.from('posts').update(updates).eq('id', req.params.id).select().single();
    if (error) throw new Error(error.message);
    res.json({ ok: true, post: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/posts/:id/rerender', async (req, res) => {
  try {
    const post = await getPostById(req.params.id);
    const { renderPost } = require('../lib/renderer');
    const { renderVideo } = require('../lib/video-renderer');

    const renderResult = await renderPost(post.template_type, post.brand, post);
    const imageFilename = safeFilename(renderResult.filename);
    let videoFilename = null;
    try {
      const video = await renderVideo(post.template_type, post.brand, post);
      videoFilename = safeFilename(video.filename);
    } catch (videoErr) {
      console.warn(`[rerender] Video render skipped for ${post.id}: ${videoErr.message}`);
    }

    // Always include video_url in the update — when the video render fails
    // we explicitly null it out so the DB doesn't keep pointing at the old
    // (now-stale) file. Otherwise a reload would still show the previous video.
    const updates = { image_url: imageFilename, video_url: videoFilename };

    const { supabase } = require('../lib/supabase');
    const { error } = await supabase.from('posts').update(updates).eq('id', post.id);
    if (error) throw new Error(error.message);

    res.json({ ok: true, image_url: imageFilename, video_url: videoFilename });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
