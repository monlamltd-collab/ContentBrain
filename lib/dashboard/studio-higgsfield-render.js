'use strict';

// lib/dashboard/studio-higgsfield-render.js — HTML fragments for the
// per-card Higgsfield panel: prompt box + generate buttons, polling job
// status, and the variant strip. Pure render functions.

const { escHtml, escAttr } = require('./html');
const { isHiggsfieldConfigured } = require('../higgsfield');

function imageVariants(post) {
  return ((post.meta && post.meta.media_variants) || []).filter(v => v.kind === 'image');
}

function activeJobOf(post) {
  const jobs = (post.meta && post.meta.higgsfield_jobs) || [];
  return jobs.find(j => j.status === 'queued' || j.status === 'in_progress') || null;
}

function renderNotConfigured() {
  return `<p class="hint hf-unconfigured">AI media is not set up yet — add <code>HIGGSFIELD_API_KEY</code> and <code>HIGGSFIELD_API_SECRET</code> to the environment, then reload.</p>`;
}

/** The collapsed per-card panel. */
function renderHiggsfieldPanel(post, { activeJobHtml } = {}) {
  const id = escAttr(post.id);
  if (!isHiggsfieldConfigured()) {
    return `<details class="hf-panel" id="hf-${id}"><summary>AI media (Higgsfield)</summary>${renderNotConfigured()}</details>`;
  }
  if (activeJobHtml === undefined) {
    const running = activeJobOf(post);
    activeJobHtml = running ? renderJobStatus(post.id, running) : '';
  }

  const sources = imageVariants(post);
  const sourceOpts = [
    `<option value="current">Animate: current image</option>`,
    ...sources.map(v => `<option value="${escAttr(v.id)}">Animate: generated ${escHtml(new Date(v.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }))}</option>`),
  ].join('');

  return `<details class="hf-panel" id="hf-${id}">
  <summary>AI media (Higgsfield)</summary>
  <div class="hf-body">
    <form class="hf-prompt-form" id="hf-prompt-form-${id}">
      <textarea name="prompt" id="hf-prompt-${id}" rows="3"
        placeholder="Describe the image or motion you want — or let AI draft it from the post copy&hellip;"></textarea>
      <div class="btn-row">
        <button type="button" class="btn btn-save"
          hx-post="/dashboard/studio/posts/${id}/prompt-draft" hx-vals='{"kind":"image"}'
          hx-target="#hf-prompt-${id}" hx-swap="outerHTML">Prefill with AI</button>
        <button type="button" class="btn btn-rerender"
          hx-post="/dashboard/studio/posts/${id}/generate-image"
          hx-include="#hf-prompt-form-${id}"
          hx-target="#hf-job-${id}" hx-swap="outerHTML">Generate image</button>
        <select name="source" form="hf-prompt-form-${id}" class="hf-source">${sourceOpts}</select>
        <button type="button" class="btn btn-rerender"
          hx-post="/dashboard/studio/posts/${id}/animate"
          hx-include="#hf-prompt-form-${id}"
          hx-target="#hf-job-${id}" hx-swap="outerHTML">Animate to video</button>
      </div>
    </form>
    <div id="hf-job-${id}">${activeJobHtml}</div>
    ${renderVariantStrip(post)}
  </div>
</details>`;
}

/** Prompt textarea fragment (swap target for the prefill button). */
function renderPromptTextarea(postId, value) {
  const id = escAttr(postId);
  return `<textarea name="prompt" id="hf-prompt-${id}" rows="3"
    placeholder="Describe the image or motion you want — or let AI draft it from the post copy&hellip;">${escHtml(value || '')}</textarea>`;
}

/**
 * Job status fragment. Non-terminal: carries an hx-trigger poll every 3s.
 * Terminal responses are sent with HTTP 286 so HTMX stops polling.
 */
function renderJobStatus(postId, job) {
  const id = escAttr(postId);
  if (!job) return `<div class="hf-job" id="hf-job-${id}"></div>`;

  const rid = escAttr(job.request_id);
  if (job.status === 'queued' || job.status === 'in_progress') {
    return `<div class="hf-job hf-running" id="hf-job-${id}"
      hx-get="/dashboard/studio/posts/${id}/jobs/${rid}/status"
      hx-trigger="every 3s" hx-swap="outerHTML">
  <span class="hf-spinner"></span> Generating ${escHtml(job.kind)} (${escHtml(job.status.replace('_', ' '))})&hellip;
</div>`;
  }
  if (job.status === 'completed') {
    return `<div class="hf-job hf-done" id="hf-job-${id}">✓ ${escHtml(job.kind)} ready — pick it below.</div>`;
  }
  return `<div class="hf-job hf-error" id="hf-job-${id}">✗ ${escHtml(job.error || `Generation ${job.status}.`)}</div>`;
}

/** Thumbnails of all generated variants with "Use this" buttons. */
function renderVariantStrip(post) {
  const id = escAttr(post.id);
  const variants = (post.meta && post.meta.media_variants) || [];
  if (!variants.length) return `<div class="variant-strip" id="variants-${id}"></div>`;

  const items = variants.map(v => {
    const src = `/output/${escAttr(v.filename)}`;
    const isLive = (v.kind === 'video' && post.video_url === v.filename)
      || (v.kind === 'image' && post.image_url === v.filename);
    const media = v.kind === 'video'
      ? `<video src="${src}" muted preload="metadata"></video>`
      : `<img src="${src}" alt="" loading="lazy">`;
    return `<div class="variant${isLive ? ' live' : ''}">
  ${media}
  <button class="btn btn-save btn-tiny"
    hx-post="/dashboard/studio/posts/${id}/variants/use"
    hx-vals='{"variant":"${escAttr(v.id)}"}'
    hx-target="#card-${id}" hx-swap="outerHTML">${isLive ? 'In use ✓' : 'Use this'}</button>
</div>`;
  }).join('\n');

  return `<div class="variant-strip" id="variants-${id}">${items}</div>`;
}

module.exports = {
  renderHiggsfieldPanel,
  renderPromptTextarea,
  renderJobStatus,
  renderVariantStrip,
  renderNotConfigured,
};
