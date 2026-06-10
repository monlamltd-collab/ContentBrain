// lib/telegram-handlers/state.js — shared mutable state for the Telegram
// polling loop. ONE exported object accessed by property (never destructure
// into locals — cross-module `let` bindings don't stay live).
//
// pendingRejectionQueue is an array (multi-reject queue); the rest of the
// pending* slots are single-flight by design.

const state = {
  // Poll loop position + heartbeat (exposed via /diag through getDiagnostics)
  telegramOffset: 0,
  pollLastAt: 0,     // ms timestamp of last getUpdates response (success OR error)
  pollCount: 0,      // total iterations since process start
  pollLastError: null,

  // Conversational state machines
  pendingRevision: null,        // { postId, messageId, chatId, contentType?, brand? }
  pendingSchedule: null,        // { type, postId, chatId, messageId, brand?, originalCaption? }
  pendingRejectionQueue: [],    // [{ type, postId, chatId, messageId, brand?, originalCaption?, contentType? }]
  pendingBrief: null,           // { messages: [], startedAt: number }
};

// ── Chat memory ──
const chatHistory = [];
const MAX_HISTORY = 10;

function addToHistory(role, text) {
  chatHistory.push({ role, text, timestamp: Date.now() });
  if (chatHistory.length > MAX_HISTORY) chatHistory.shift();
}

function getHistoryContext() {
  if (!chatHistory.length) return '';
  return 'RECENT CONVERSATION:\n' + chatHistory.map(m =>
    `${m.role === 'user' ? 'Owner' : 'ContentBrain'}: ${m.text}`
  ).join('\n') + '\n\n';
}

// Snapshot for the /diag endpoint.
function getDiagnostics() {
  const now = Date.now();
  return {
    last_at_iso: state.pollLastAt ? new Date(state.pollLastAt).toISOString() : null,
    seconds_since_last_poll: state.pollLastAt ? Math.round((now - state.pollLastAt) / 1000) : null,
    total_polls: state.pollCount,
    last_error: state.pollLastError,
    offset: state.telegramOffset,
  };
}

module.exports = { state, addToHistory, getHistoryContext, getDiagnostics };
