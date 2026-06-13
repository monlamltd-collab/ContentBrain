'use strict';

// lib/dashboard/studio-higgsfield.js — orchestration glue between the
// Studio tab and lib/higgsfield.js. Owns prompt drafting, job lifecycle
// (start → poll → variants), credit safety (daily cap + one active job
// per post) and variant selection.
//
// State lives in posts.meta (jsonb):
//   meta.higgsfield_jobs[]   { request_id, kind:'image'|'video', model,
//                              prompt, status, created_at, completed_at,
//                              error, variant_ids[] }
//   meta.media_variants[]    { id, kind, source:'higgsfield', filename,
//                              bucket_url, job_id, created_at }

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const higgsfield = require('../higgsfield');
const { getPostRow, mergePostMeta } = require('./studio-queries');
const { supabase, uploadMedia } = require('../supabase');
const runtimeConfig = require('../runtime-config');
const { getResolvedBrand } = require('../runtime-config');
const { THEMES } = require('../themes');
const { createLLM } = require('../llm');

const OUTPUT_DIR = path.join(__dirname, '..', '..', 'output');
const STALE_JOB_MS = 15 * 60 * 1000; // poller gives up after 15 min
const DEFAULT_DAILY_CAP = 20;
// DoP-style i2v models accept short clips; clamp defensively.
const I2V_MIN_SECONDS = 3;
const I2V_MAX_SECONDS = 10;

// ── Levers (app_config) ───────────────────────────────────────────────────

async function readLever(brand, key) {
  const { data } = await supabase
    .from('app_config')
    .select('value')
    .eq('brand', brand)
    .eq('key', key)
    .maybeSingle();
  return data ? data.value : null;
}

async function getDailyCap() {
  const v = Number(await readLever('global', 'higgsfield.daily_cap'));
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DAILY_CAP;
}

function todayKey() {
  return `higgsfield.usage.${new Date().toISOString().slice(0, 10)}`;
}

async function getDailyUsage() {
  const v = Number(await readLever('global', todayKey()));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function incrementDailyUsage() {
  const next = (await getDailyUsage()) + 1;
  await runtimeConfig.setLever('global', todayKey(), next);
  return next;
}

// ── Job helpers ───────────────────────────────────────────────────────────

function activeJob(post) {
  const jobs = (post.meta && post.meta.higgsfield_jobs) || [];
  return jobs.find(j => j.status === 'queued' || j.status === 'in_progress') || null;
}

function findJob(post, requestId) {
  const jobs = (post.meta && post.meta.higgsfield_jobs) || [];
  return jobs.find(j => j.request_id === requestId) || null;
}

async function saveJob(postId, job) {
  const row = await getPostRow(postId);
  const jobs = ((row.meta && row.meta.higgsfield_jobs) || []).filter(j => j.request_id !== job.request_id);
  jobs.push(job);
  return mergePostMeta(postId, { higgsfield_jobs: jobs.slice(-12) });
}

function aspectForPost(post, brandAspect) {
  if (brandAspect && /^\d+:\d+$/.test(brandAspect)) return brandAspect;
  return post.template_type === 'reel' ? '9:16' : '1:1';
}

// ── Prompt drafting ───────────────────────────────────────────────────────

/**
 * Draft a Higgsfield prompt from the post's copy + brand + theme. kind:
 * 'image' = a scene/background still (no text in image — the copy is
 * overlaid elsewhere); 'video' = a motion description for animating the
 * current still.
 */
async function draftPrompt(post, kind) {
  const brand = await getResolvedBrand(post.brand || 'auctionbrain');
  const stylePrefix = await readLever(post.brand || 'auctionbrain', 'higgsfield.style_prefix');
  const themeName = post.meta && post.meta.visual_style;
  const theme = themeName && THEMES[themeName] ? `${themeName} — ${THEMES[themeName].description}` : null;

  const system = kind === 'image'
    ? `You write prompts for a photorealistic/cinematic AI image generator (Higgsfield Soul). The image will sit behind or beside short marketing copy for ${brand.name} (${brand.audience}). Describe ONE strong scene: subject, setting, lighting, mood, camera/lens feel. UK property context. CRITICAL: no text, words, letters, logos or watermarks in the image. Return the prompt only — no preamble, no quotes.`
    : `You write motion prompts for an AI image-to-video generator (Higgsfield DoP). It animates a still marketing graphic for ${brand.name}. Describe subtle, premium motion: slow push-in or parallax, drifting light, atmosphere. Nothing chaotic; the copy must stay readable. Return the prompt only — no preamble, no quotes.`;

  const user = [
    stylePrefix ? `House style: ${stylePrefix}` : null,
    theme ? `Visual theme: ${theme}` : null,
    `Post headline: ${post.copy_headline || ''}`,
    post.copy_body ? `Post body: ${String(post.copy_body).slice(0, 280)}` : null,
    `Write the ${kind} prompt now.`,
  ].filter(Boolean).join('\n');

  const response = await createLLM().messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 220,
    system,
    messages: [{ role: 'user', content: user }],
  });
  const text = (response.content || []).find(b => b.type === 'text')?.text || '';
  const prompt = text.trim().replace(/^["']|["']$/g, '').trim();
  if (!prompt) throw new Error('Prompt drafting returned nothing — write one manually.');
  return prompt;
}

// ── Job starters ──────────────────────────────────────────────────────────

async function assertCanStart(post) {
  if (!higgsfield.isHiggsfieldConfigured()) {
    throw new Error('Higgsfield not configured — set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET');
  }
  const running = activeJob(post);
  if (running) {
    throw new Error(`A ${running.kind} generation is already running for this post — wait for it to finish.`);
  }
  const [cap, usage] = await Promise.all([getDailyCap(), getDailyUsage()]);
  if (usage >= cap) {
    throw new Error(`Daily Higgsfield cap reached (${usage}/${cap}) — raise it in Design → AI Media if intended.`);
  }
}

async function startImageJob(postId, prompt) {
  const post = await getPostRow(postId);
  if (!post) throw new Error('Post not found');
  await assertCanStart(post);

  const brandAspect = await readLever(post.brand || 'auctionbrain', 'higgsfield.default_aspect');
  const params = {
    prompt,
    aspect_ratio: aspectForPost(post, brandAspect),
    resolution: '720p',
  };
  const { request_id } = await higgsfield.submitGeneration(higgsfield.MODELS.soulImage, params);
  await incrementDailyUsage();

  const job = {
    request_id,
    kind: 'image',
    model: higgsfield.MODELS.soulImage,
    prompt: String(prompt).slice(0, 800),
    status: 'queued',
    created_at: new Date().toISOString(),
  };
  await saveJob(postId, job);
  return job;
}

async function startVideoJob(postId, prompt, source = 'current') {
  const post = await getPostRow(postId);
  if (!post) throw new Error('Post not found');
  await assertCanStart(post);

  // Resolve the source still: the post's current image or a chosen variant.
  let filename = post.image_url;
  let bucketUrl = null;
  if (source && source !== 'current') {
    const variant = ((post.meta && post.meta.media_variants) || []).find(v => v.id === source);
    if (!variant || variant.kind !== 'image') throw new Error('Source image variant not found.');
    filename = variant.filename;
    bucketUrl = variant.bucket_url || null;
  }
  if (!filename) throw new Error('This post has no image to animate — generate or re-render one first.');

  // Higgsfield must be able to fetch the source over the public internet:
  // upload it to the public content-media bucket and pass that URL
  // (works in local dev AND survives Railway redeploys).
  let imageUrl = bucketUrl;
  if (!imageUrl) {
    const localPath = path.join(OUTPUT_DIR, path.basename(filename));
    if (!fs.existsSync(localPath)) {
      throw new Error(`Source image ${filename} is not on this server (likely a redeploy) — re-render the post first.`);
    }
    imageUrl = await uploadMedia(localPath, path.basename(filename));
  }

  const requestedSeconds = Number(post.meta && post.meta.duration_seconds) || 5;
  const duration = Math.min(I2V_MAX_SECONDS, Math.max(I2V_MIN_SECONDS, requestedSeconds));

  const { request_id } = await higgsfield.submitGeneration(higgsfield.MODELS.imageToVideo, {
    image_url: imageUrl,
    prompt,
    duration,
  });
  await incrementDailyUsage();

  const job = {
    request_id,
    kind: 'video',
    model: higgsfield.MODELS.imageToVideo,
    prompt: String(prompt).slice(0, 800),
    source_image: filename,
    duration,
    status: 'queued',
    created_at: new Date().toISOString(),
  };
  await saveJob(postId, job);
  return job;
}

// ── Polling / completion ──────────────────────────────────────────────────

/**
 * Re-check one job against the Higgsfield API and persist any transition.
 * Returns { job, post } with the updated row.
 */
async function refreshJob(postId, requestId) {
  let post = await getPostRow(postId);
  if (!post) throw new Error('Post not found');
  const job = findJob(post, requestId);
  if (!job) throw new Error('Unknown generation job for this post.');

  // Terminal already — nothing to do.
  if (['completed', 'nsfw', 'failed', 'timed_out'].includes(job.status)) {
    return { job, post };
  }

  let result;
  try {
    result = await higgsfield.getStatus(requestId);
  } catch (err) {
    // Transient status-check failure: keep polling unless the job is stale.
    if (Date.now() - new Date(job.created_at).getTime() > STALE_JOB_MS) {
      job.status = 'timed_out';
      job.error = higgsfield.classifyError('timed out').userMessage;
      post = await saveJob(postId, job);
    }
    return { job, post };
  }

  if (result.status === 'completed') {
    const variants = [];
    for (const asset of result.assets) {
      const prefix = `${post.brand || 'post'}-${post.template_type || 'media'}-hf-${asset.kind}`;
      const { filename, outputPath } = await higgsfield.downloadAsset(asset.url, prefix);
      let bucket_url = null;
      try {
        bucket_url = await uploadMedia(outputPath, filename);
      } catch (upErr) {
        console.warn(`[studio-higgsfield] bucket mirror failed for ${filename}: ${upErr.message}`);
      }
      variants.push({
        id: crypto.randomUUID(),
        kind: asset.kind,
        source: 'higgsfield',
        filename,
        bucket_url,
        job_id: requestId,
        created_at: new Date().toISOString(),
      });
    }

    job.status = variants.length ? 'completed' : 'failed';
    job.completed_at = new Date().toISOString();
    job.variant_ids = variants.map(v => v.id);
    if (!variants.length) job.error = 'Completed but returned no downloadable assets.';

    const existing = (post.meta && post.meta.media_variants) || [];
    await mergePostMeta(postId, { media_variants: [...existing, ...variants].slice(-16) });
    post = await saveJob(postId, job);
    return { job, post };
  }

  if (result.status === 'nsfw' || result.status === 'failed') {
    job.status = result.status;
    job.completed_at = new Date().toISOString();
    job.error = higgsfield.classifyError(result.status).userMessage;
    post = await saveJob(postId, job);
    return { job, post };
  }

  // queued / in_progress — persist progress transitions, time out stale jobs.
  if (Date.now() - new Date(job.created_at).getTime() > STALE_JOB_MS) {
    job.status = 'timed_out';
    job.error = higgsfield.classifyError('timed out').userMessage;
    post = await saveJob(postId, job);
  } else if (job.status !== result.status) {
    job.status = result.status;
    post = await saveJob(postId, job);
  }
  return { job, post };
}

// ── Variant selection ─────────────────────────────────────────────────────

/**
 * Make a generated variant the post's live image/video. Re-downloads from
 * the bucket mirror if the local file vanished in a redeploy.
 */
async function useVariant(postId, variantId) {
  const post = await getPostRow(postId);
  if (!post) throw new Error('Post not found');
  const variant = ((post.meta && post.meta.media_variants) || []).find(v => v.id === variantId);
  if (!variant) throw new Error('Variant not found.');

  const localPath = path.join(OUTPUT_DIR, path.basename(variant.filename));
  if (!fs.existsSync(localPath)) {
    if (!variant.bucket_url) throw new Error('File is gone and no bucket copy exists — regenerate.');
    const res = await fetch(variant.bucket_url);
    if (!res.ok) throw new Error(`Bucket re-download failed (${res.status}).`);
    fs.writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
  }

  const updates = variant.kind === 'video'
    ? { video_url: variant.filename }
    : { image_url: variant.filename };
  const { data, error } = await supabase.from('posts').update(updates).eq('id', postId).select().single();
  if (error) throw new Error(error.message);
  return { post: data, variant };
}

module.exports = {
  draftPrompt,
  startImageJob,
  startVideoJob,
  refreshJob,
  useVariant,
  activeJob,
  findJob,
  getDailyCap,
  getDailyUsage,
  _internals: { aspectForPost, todayKey, DEFAULT_DAILY_CAP, STALE_JOB_MS },
};
