// lib/llm.js — zero-dependency Gemini Flash client
//
// Replaces @anthropic-ai/sdk across the entire codebase. Uses fetch() to
// call the Gemini REST API directly — no npm install needed.
//
// Supports two providers via env vars:
//   GEMINI_API_KEY   — Google AI Studio key (preferred, direct pricing)
//   OPENROUTER_API_KEY — OpenRouter key (fallback, OpenAI-compatible endpoint)
//
// Usage — drop-in replacement for Anthropic SDK calls:
//
//   const { createLLM } = require('./llm');
//   const llm = createLLM();
//   const resp = await llm.messages.create({
//     model: 'gemini-2.0-flash',   // ignored — always uses Flash
//     max_tokens: 800,
//     system: 'You are a helpful...',
//     messages: [{ role: 'user', content: 'Hello' }]
//   });
//   const text = (resp.content || []).find(b => b.type === 'text')?.text || '';

require('dotenv').config();

const MODEL = 'gemini-2.0-flash';
const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 1000;

// ── Claude (Sonnet) provider — used for CONTENT GENERATION only ──────────
// Outbound/classify/enrich stay on cheap Gemini Flash via createLLM(); only
// the post-copy generation path opts into Claude through createClaudeLLM()
// because content quality (and especially diversity) is the priority there.
//
// Extended ("max") thinking is enabled by default — Simon's explicit choice:
// the volume is tiny (a handful of calls/day) so the cost/latency of a large
// reasoning budget is negligible against the quality gain. Override via env.
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const CLAUDE_THINKING_BUDGET = (() => {
  const n = parseInt(process.env.CLAUDE_THINKING_BUDGET, 10);
  return Number.isFinite(n) && n >= 0 ? n : 8000; // 0 disables thinking
})();

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Call Gemini REST API (direct Google AI Studio).
 * On 429 (quota exceeded) or other transient errors, auto-falls back
 * to OpenRouter if OPENROUTER_API_KEY is configured.
 */
async function _callGemini({ system, messages, maxOutputTokens }) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  // ── Path A: Direct Gemini (cheap) ──
  if (geminiKey) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${geminiKey}`;

      // Convert Anthropic-style messages to Gemini contents array
      const contents = messages.map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: typeof m.content === 'string' ? m.content : m.content }]
      }));

      const body = {
        contents,
        generationConfig: { maxOutputTokens: maxOutputTokens || 800, temperature: 0.7 }
      };

      if (system) {
        body.system_instruction = { parts: [{ text: system }] };
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      // 429 quota-exceeded → fall through to OpenRouter (if configured)
      if (res.status === 429 && openRouterKey) {
        console.warn(`[llm] Gemini 429 quota — falling back to OpenRouter`);
        // Don't throw — fall through to Path B below
      } else if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
      } else {
        const data = await res.json();
        const candidate = (data.candidates || [])[0];
        if (!candidate) throw new Error('Gemini returned no candidates');

        const parts = candidate.content?.parts || [];
        const text = parts.map(p => p.text || '').join('');

        // Mirror Anthropic response shape
        return {
          content: [{ type: 'text', text }],
          model: MODEL,
          usage: data.usageMetadata ? {
            input_tokens: data.usageMetadata.promptTokenCount || 0,
            output_tokens: data.usageMetadata.candidatesTokenCount || 0
          } : null
        };
      }
    } catch (err) {
      // Non-429 error on Gemini: only fall through if OpenRouter is configured
      if (!openRouterKey) throw err;
      console.warn(`[llm] Gemini error — falling back to OpenRouter: ${err.message}`);
    }
  }

  // ── Path B: OpenRouter fallback ──
  if (openRouterKey) {
    const url = 'https://openrouter.ai/api/v1/chat/completions';

    const body = {
      model: `google/${MODEL}`,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...messages
      ],
      max_tokens: maxOutputTokens || 800,
      temperature: 0.7
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${openRouterKey}`,
        'HTTP-Referer': 'https://contentbrain.local',
        'X-Title': 'ContentBrain'
      },
      body: JSON.stringify(body)
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
      model: `google/${MODEL}`,
      usage: data.usage || null
    };
  }

  throw new Error('No LLM API key configured. Set GEMINI_API_KEY or OPENROUTER_API_KEY in .env');
}

/**
 * Drop-in replacement for Anthropic SDK client.
 *
 *   const llm = createLLM();
 *   const resp = await llm.messages.create({ model, system, messages, max_tokens });
 *   const text = resp.content.find(b => b.type === 'text')?.text || '';
 */
function createLLM() {
  return {
    messages: {
      async create({ model, system, messages, max_tokens }) {
        let lastErr;

        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
          try {
            return await _callGemini({
              system,
              messages,
              maxOutputTokens: max_tokens || 800
            });
          } catch (err) {
            lastErr = err;
            if (attempt < MAX_RETRIES) {
              console.warn(`[llm] attempt ${attempt + 1}/${MAX_RETRIES + 1} failed: ${err.message} — retrying in ${RETRY_DELAY_MS}ms`);
              await sleep(RETRY_DELAY_MS);
            }
          }
        }

        throw lastErr;
      }
    }
  };
}

// Lazy singleton — only constructed if/when Claude is actually used, so the
// SDK import never penalises the Gemini-only paths.
let _anthropicClient = null;
function _getAnthropic() {
  if (_anthropicClient) return _anthropicClient;
  const SDK = require('@anthropic-ai/sdk');
  const Anthropic = SDK.Anthropic || SDK.default || SDK;
  _anthropicClient = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _anthropicClient;
}

/**
 * Call Claude (Anthropic) with extended thinking. Returns the same shape as
 * _callGemini so callers can read `resp.content[0].text` unchanged — thinking
 * blocks are stripped and only the text output is surfaced.
 */
async function _callClaude({ system, messages, maxOutputTokens }) {
  const client = _getAnthropic();
  const outputTokens = maxOutputTokens || 1500;
  const thinking = CLAUDE_THINKING_BUDGET > 0
    ? { type: 'enabled', budget_tokens: CLAUDE_THINKING_BUDGET }
    : undefined;
  // With extended thinking, max_tokens must exceed the thinking budget — it
  // covers reasoning + visible output combined. Temperature must be 1 (the
  // API rejects other values when thinking is on), so we simply omit it.
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
 * Drop-in replacement for createLLM() that routes to Claude Sonnet (with
 * extended thinking) instead of Gemini Flash. Same `{ messages: { create } }`
 * surface so generate.js / lot-content.js can swap clients with one line.
 *
 * Falls back to Gemini ONLY when CLAUDE_API_KEY is unset (keeps local dev
 * working without a key). Runtime failures retry then throw, so the caller's
 * cron alerting fires rather than silently regressing to lower-quality copy.
 */
function createClaudeLLM() {
  if (!process.env.CLAUDE_API_KEY) {
    console.warn('[llm] CLAUDE_API_KEY not set — falling back to Gemini for generation.');
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