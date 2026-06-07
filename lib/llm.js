// lib/llm.js — LLM client
//
// Primary: OpenRouter (OPENROUTER_API_KEY + OPENROUTER_MODEL).
// Fallback: Gemini direct (GEMINI_API_KEY) when OpenRouter is not configured.
//
// Usage — drop-in replacement for Anthropic SDK calls:
//
//   const { createLLM } = require('./llm');
//   const llm = createLLM();
//   const resp = await llm.messages.create({
//     model: MODEL,
//     max_tokens: 800,
//     system: 'You are a helpful...',
//     messages: [{ role: 'user', content: 'Hello' }]
//   });
//   const text = (resp.content || []).find(b => b.type === 'text')?.text || '';

require('dotenv').config();

// Free model routed via OpenRouter. Override with OPENROUTER_MODEL env var.
const MODEL = process.env.OPENROUTER_MODEL || 'google/gemini-2.0-flash-exp:free';
const GEMINI_DIRECT_MODEL = 'gemini-2.0-flash';

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ── Claude (Sonnet) provider — content generation only ───────────────────
// All social post copy runs on Claude with extended thinking for quality.
// Everything else (classify, enrich, outbound drafts) uses createLLM().
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const CLAUDE_THINKING_BUDGET = (() => {
  const n = parseInt(process.env.CLAUDE_THINKING_BUDGET, 10);
  return Number.isFinite(n) && n >= 0 ? n : 8000;
})();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── OpenRouter ────────────────────────────────────────────────────────────
async function _callOpenRouter({ system, messages, maxOutputTokens }) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set');

  const body = {
    model: MODEL,
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...messages,
    ],
    max_tokens: maxOutputTokens || 800,
    temperature: 0.7,
  };

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
      'HTTP-Referer': 'https://contentbrain.local',
      'X-Title': 'ContentBrain',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const choice = (data.choices || [])[0];
  if (!choice) throw new Error('OpenRouter returned no choices');

  return {
    content: [{ type: 'text', text: choice.message?.content || '' }],
    model: MODEL,
    usage: data.usage || null,
  };
}

// ── Gemini direct (fallback when OPENROUTER_API_KEY is unset) ────────────
async function _callGeminiDirect({ system, messages, maxOutputTokens }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY not set');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_DIRECT_MODEL}:generateContent?key=${key}`;

  const contents = messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: typeof m.content === 'string' ? m.content : m.content }],
  }));

  const reqBody = {
    contents,
    generationConfig: { maxOutputTokens: maxOutputTokens || 800, temperature: 0.7 },
  };
  if (system) reqBody.system_instruction = { parts: [{ text: system }] };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(reqBody),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
  }

  const data = await res.json();
  const candidate = (data.candidates || [])[0];
  if (!candidate) throw new Error('Gemini returned no candidates');
  const text = (candidate.content?.parts || []).map(p => p.text || '').join('');

  return {
    content: [{ type: 'text', text }],
    model: GEMINI_DIRECT_MODEL,
    usage: data.usageMetadata
      ? { input_tokens: data.usageMetadata.promptTokenCount || 0, output_tokens: data.usageMetadata.candidatesTokenCount || 0 }
      : null,
  };
}

// ── Router: OpenRouter primary, Gemini direct fallback ───────────────────
async function _callLLM({ system, messages, maxOutputTokens }) {
  if (process.env.OPENROUTER_API_KEY) {
    return _callOpenRouter({ system, messages, maxOutputTokens });
  }
  if (process.env.GEMINI_API_KEY) {
    console.warn('[llm] OPENROUTER_API_KEY not set — falling back to Gemini direct');
    return _callGeminiDirect({ system, messages, maxOutputTokens });
  }
  throw new Error('No LLM key configured. Set OPENROUTER_API_KEY in Railway env vars.');
}

/**
 * Drop-in replacement for Anthropic SDK client (cheap calls: classify,
 * enrich, outbound drafts). Routes through OpenRouter by default.
 */
function createLLM() {
  return {
    messages: {
      async create({ model, system, messages, max_tokens }) {
        let lastErr;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            return await _callLLM({ system, messages, maxOutputTokens: max_tokens || 800 });
          } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) {
              console.warn(`[llm] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err.message} — retrying in ${RETRY_DELAY_MS}ms`);
              await sleep(RETRY_DELAY_MS);
            }
          }
        }
        throw lastErr;
      },
    },
  };
}

// ── Claude (Anthropic) — content generation ──────────────────────────────

let _anthropicClient = null;
function _getAnthropic() {
  if (_anthropicClient) return _anthropicClient;
  const SDK = require('@anthropic-ai/sdk');
  const Anthropic = SDK.Anthropic || SDK.default || SDK;
  _anthropicClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropicClient;
}

async function _callClaude({ system, messages, maxOutputTokens }) {
  const client = _getAnthropic();
  const outputTokens = maxOutputTokens || 1500;
  const thinking = CLAUDE_THINKING_BUDGET > 0
    ? { type: 'enabled', budget_tokens: CLAUDE_THINKING_BUDGET }
    : undefined;
  const maxTokens = thinking ? CLAUDE_THINKING_BUDGET + outputTokens : outputTokens;

  const resp = await client.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: maxTokens,
    ...(thinking ? { thinking } : {}),
    ...(system ? { system } : {}),
    messages: messages.map(m => ({
      role: m.role === 'model' ? 'assistant' : m.role,
      content: typeof m.content === 'string' ? m.content : m.content,
    })),
  });

  const text = (resp.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text || '')
    .join('');

  return {
    content: [{ type: 'text', text }],
    model: resp.model || CLAUDE_MODEL,
    usage: resp.usage
      ? { input_tokens: resp.usage.input_tokens || 0, output_tokens: resp.usage.output_tokens || 0 }
      : null,
  };
}

/**
 * Claude Sonnet with extended thinking for content generation.
 * Falls back to createLLM() (OpenRouter) when CLAUDE_API_KEY is unset.
 */
function createClaudeLLM() {
  if (!process.env.CLAUDE_API_KEY) {
    console.warn('[llm] CLAUDE_API_KEY not set — falling back to OpenRouter for generation.');
    return createLLM();
  }
  return {
    messages: {
      async create({ system, messages, max_tokens }) {
        let lastErr;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            return await _callClaude({ system, messages, maxOutputTokens: max_tokens || 1500 });
          } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) {
              console.warn(`[llm:claude] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err.message} — retrying in ${RETRY_DELAY_MS}ms`);
              await sleep(RETRY_DELAY_MS);
            }
          }
        }
        throw lastErr;
      },
    },
  };
}

module.exports = { createLLM, createClaudeLLM, MODEL, CLAUDE_MODEL };
