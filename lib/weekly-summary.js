const LABELS = {
  'cheapest-week': 'Cheapest of the Week',
  'dearest-week': 'Dearest of the Week',
  'best-deal-week': 'Best Deal of the Week',
  'biggest-discount-week': 'Biggest Discount of the Week',
  'worst-lot-week': 'Worst Lot of the Week',
};

const EMOJI = {
  'cheapest-week': '💷',
  'dearest-week': '🏰',
  'best-deal-week': '⭐',
  'biggest-discount-week': '📉',
  'worst-lot-week': '🙈',
};

function escHtml(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function formatWeeklySummary(results = [], failures = [], { willRetry = failures.length > 0 } = {}) {
  const lines = [
    `📸 <b>Weekly auction posts</b> — ${results.length} ready to review`,
    ...results.map(result => `${EMOJI[result.superlative] || '•'} ${escHtml(LABELS[result.superlative] || result.superlative)}`),
  ];

  if (failures.length) {
    lines.push('', `⚠ ${failures.length} failed:`);
    for (const failure of failures) {
      const reason = String(failure.error || 'unknown error').replace(/\s+/g, ' ').slice(0, 180);
      lines.push(`• ${escHtml(failure.superlative)} — ${escHtml(reason)}`);
    }
  }

  if (results.length) {
    lines.push('', 'Approve each preview above — they publish one per weekday.');
  } else if (willRetry) {
    lines.push('', 'No previews were created; the weekly cron will retry.');
  } else {
    lines.push('', 'No new previews were created; there is nothing to review.');
  }

  return lines.join('\n');
}

module.exports = { formatWeeklySummary };
