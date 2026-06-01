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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Call Gemini REST API (direct Google AI Studio).
 * Falls back to OpenRouter if GEMINI_API_KEY is unset but OPENROUTER_API_KEY is.
 */
async function _callGemini({ system, messages, maxOutputTokens }) {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openRouterKey = process.env.OPENROUTER_API_KEY;

  // ── Path A: Direct Gemini ──
  if (geminiKey) {
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

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Gemini API ${res.status}: ${errText.slice(0, 300)}`);
    }

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

module.exports = { createLLM, MODEL };