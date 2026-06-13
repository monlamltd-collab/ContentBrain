// lib/higgsfield.js — thin Higgsfield platform API client (plain fetch, no SDK).
//
// Higgsfield aggregates generative image/video models behind one async API:
//   submit:  POST https://platform.higgsfield.ai/{model-id}  → { request_id }
//   status:  GET  https://platform.higgsfield.ai/requests/{request_id}/status
//            → queued | in_progress | completed | nsfw | failed
//            (nsfw and failed refund credits per the API contract)
//
// Consumers: lib/dashboard/studio-higgsfield.js (Studio tab generation
// buttons) and scripts/higgsfield-smoke.js (manual one-shot check).
//
// Auth uses BOTH env vars: HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET,
// sent as `Authorization: Key {key}:{secret}`.

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const API_BASE = 'https://platform.higgsfield.ai';
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Model ids are env-overridable so a model swap is config-only.
// soul = text-to-image; dop = Higgsfield's own image-to-video.
const MODELS = {
  soulImage: process.env.HIGGSFIELD_SOUL_MODEL || 'higgsfield-ai/soul/standard',
  imageToVideo: process.env.HIGGSFIELD_I2V_MODEL || 'higgsfield-ai/dop/standard',
};

function isHiggsfieldConfigured() {
  return !!(process.env.HIGGSFIELD_API_KEY && process.env.HIGGSFIELD_API_SECRET);
}

function authHeader() {
  return `Key ${process.env.HIGGSFIELD_API_KEY}:${process.env.HIGGSFIELD_API_SECRET}`;
}

async function hfFetch(pathname, { method = 'GET', body, timeoutMs = 30000 } = {}) {
  if (!isHiggsfieldConfigured()) {
    throw new Error('Higgsfield not configured — set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${API_BASE}${pathname}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Authorization': authHeader(),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Higgsfield ${res.status} for ${pathname}: ${errText.slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Submit a generation job.
 * @param {string} modelId  e.g. MODELS.soulImage
 * @param {object} params   model params (prompt, aspect_ratio, image_url, duration, ...)
 * @returns {Promise<{request_id: string}>}
 */
async function submitGeneration(modelId, params, { timeoutMs = 30000 } = {}) {
  const payload = await hfFetch(`/${modelId}`, { method: 'POST', body: params, timeoutMs });
  const requestId = payload.request_id || payload.id;
  if (!requestId) {
    throw new Error(`Higgsfield submit returned no request_id: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return { request_id: requestId };
}

// Pull asset URLs out of a completed status payload. Different models nest
// results differently (images[], video, results[].url ...) — collect every
// plausible URL with a kind tag.
function extractAssets(raw) {
  const assets = [];
  const push = (kind, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) assets.push({ kind, url });
  };
  const visit = (node, hintKind) => {
    if (!node) return;
    if (Array.isArray(node)) return node.forEach(n => visit(n, hintKind));
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          if (/^(url|image_url|video_url|raw_url)$/i.test(k)) {
            const kind = /video/i.test(k) ? 'video'
              : /image/i.test(k) ? 'image'
              : hintKind || (/\.(mp4|webm|mov)(\?|$)/i.test(v) ? 'video' : 'image');
            push(kind, v);
          }
        } else if (/video/i.test(k)) visit(v, 'video');
        else if (/image/i.test(k)) visit(v, 'image');
        else if (/result|output|asset|media|data/i.test(k)) visit(v, hintKind);
      }
    }
  };
  visit(raw, null);
  // Dedupe by URL, first kind wins.
  const seen = new Set();
  return assets.filter(a => !seen.has(a.url) && seen.add(a.url));
}

/**
 * Poll a job once.
 * @returns {Promise<{status: string, assets: Array<{kind,url}>, raw: object}>}
 *   status normalized to queued | in_progress | completed | nsfw | failed
 */
async function getStatus(requestId, { timeoutMs = 15000 } = {}) {
  const raw = await hfFetch(`/requests/${requestId}/status`, { timeoutMs });
  const s = String(raw.status || '').toLowerCase();
  let status;
  if (['completed', 'complete', 'succeeded', 'success'].includes(s)) status = 'completed';
  else if (s === 'nsfw') status = 'nsfw';
  else if (['failed', 'error', 'canceled', 'cancelled'].includes(s)) status = 'failed';
  else if (['in_progress', 'processing', 'running'].includes(s)) status = 'in_progress';
  else status = 'queued';
  return {
    status,
    assets: status === 'completed' ? extractAssets(raw) : [],
    raw,
  };
}

/**
 * Poll until terminal status or timeout. Used by the smoke script — the
 * Studio UI polls statelessly via HTMX instead.
 */
async function waitForCompletion(requestId, { timeoutMs = 300000, pollMs = 4000, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal && signal.aborted) throw new Error('aborted');
    const result = await getStatus(requestId);
    if (result.status === 'completed' || result.status === 'nsfw' || result.status === 'failed') {
      return result;
    }
    if (Date.now() > deadline) {
      throw new Error(`Higgsfield job ${requestId} timed out after ${Math.round(timeoutMs / 1000)}s (last status: ${result.status})`);
    }
    await new Promise(r => setTimeout(r, pollMs));
  }
}

/**
 * Download a completed asset into output/ so publishing, Telegram previews
 * and the /output static mount all work exactly as for native renders.
 * @returns {Promise<{filename: string, outputPath: string}>}
 */
async function downloadAsset(url, filenamePrefix, { timeoutMs = 120000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Asset download ${res.status} for ${url.slice(0, 120)}`);

    const buf = Buffer.from(await res.arrayBuffer());
    const ext = extFromResponse(res, url);
    const safePrefix = String(filenamePrefix || 'higgsfield')
      .replace(/[\\/]/g, '').replace(/^\.+/, '').replace(/[^a-zA-Z0-9_-]/g, '-')
      .slice(0, 80) || 'higgsfield';
    const filename = `${safePrefix}-${Date.now()}.${ext}`;
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const outputPath = path.join(OUTPUT_DIR, filename);
    fs.writeFileSync(outputPath, buf);
    return { filename, outputPath };
  } finally {
    clearTimeout(timer);
  }
}

function extFromResponse(res, url) {
  const ct = String(res.headers.get('content-type') || '').toLowerCase();
  if (ct.includes('mp4')) return 'mp4';
  if (ct.includes('webm')) return 'webm';
  if (ct.includes('png')) return 'png';
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg';
  if (ct.includes('webp')) return 'webp';
  const m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(new URL(url).pathname);
  return m ? m[1].toLowerCase() : 'bin';
}

/**
 * Map a status/error to operator-facing guidance for the Studio panel.
 */
function classifyError(statusOrErr) {
  const s = typeof statusOrErr === 'string' ? statusOrErr : (statusOrErr && statusOrErr.message) || '';
  if (s === 'nsfw') {
    return { code: 'nsfw', userMessage: 'Flagged by content moderation (credits refunded) — rephrase the prompt and try again.' };
  }
  if (s === 'failed') {
    return { code: 'failed', userMessage: 'Generation failed on Higgsfield’s side (credits refunded) — try again.' };
  }
  if (/timed out/i.test(s)) {
    return { code: 'timeout', userMessage: 'Generation is taking unusually long — it may still finish; check back shortly.' };
  }
  if (/not configured/i.test(s)) {
    return { code: 'config', userMessage: 'Higgsfield keys are not configured — add HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET.' };
  }
  return { code: 'http', userMessage: `Higgsfield error: ${s.slice(0, 160)}` };
}

module.exports = {
  isHiggsfieldConfigured,
  submitGeneration,
  getStatus,
  waitForCompletion,
  downloadAsset,
  classifyError,
  extractAssets,
  MODELS,
  _internals: { authHeader, extFromResponse },
};
