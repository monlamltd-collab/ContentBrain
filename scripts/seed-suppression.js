#!/usr/bin/env node
require('dotenv').config();

// ── Suppression seeder (Phase B) ─────────────────────────────────────────
//
// One-time importer for historical block-lists (e.g. Mortgage-Style's
// existing unsubscribe list, prior cold-outreach bounces, manually-
// curated do-not-contact). Run BEFORE the first outbound send so we
// don't email anyone we already know wants to be left alone.
//
// To populate this seeder, replace SEED_ENTRIES below with the actual
// list. Each entry is { emailOrDomain, reason } where:
//   - emailOrDomain : either a full address (suppresses one inbox) or a
//                     bare domain (suppresses everything @ that domain)
//   - reason        : MUST match lib/sales-brain/constants.VALID_SUPPRESSION_REASONS
//                     ('bounce', 'complaint', 'hostile_reply',
//                      'unsubscribe', 'manual', 'import')
//
// Alternatively you can shape this as a CSV reader — point process.argv[2]
// at a CSV with `email_or_domain,reason` columns and the seeder will
// iterate. CSV path is the cleaner option for >50 entries.
//
// Run:
//   node scripts/seed-suppression.js                     # uses SEED_ENTRIES below
//   node scripts/seed-suppression.js path/to/list.csv    # reads CSV (optional)
//
// Idempotent — addSuppression skips rows that already exist (and preserves
// the original `reason` for audit history).

const fs = require('fs');
const path = require('path');
const { addSuppression } = require('../lib/suppression');

// ── Put your historical block-list entries here ─────────────────────────
// Leave empty until Simon supplies the list. The seeder is safe to run
// against an empty list (it just no-ops).

const SEED_ENTRIES = [
  // Examples (delete or replace):
  // { emailOrDomain: 'unsubscribed@example.co.uk', reason: 'unsubscribe' },
  // { emailOrDomain: 'donotemail.com',             reason: 'import' },
];

async function readCsv(csvPath) {
  const abs = path.resolve(csvPath);
  const raw = fs.readFileSync(abs, 'utf8');
  const lines = raw.split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  const out = [];
  // Header detection — skip if first line is `email_or_domain,reason`.
  let start = 0;
  if (/^email[_ ]?or[_ ]?domain\s*,\s*reason/i.test(lines[0] || '')) start = 1;
  for (let i = start; i < lines.length; i++) {
    const cols = lines[i].split(',').map(s => s.trim());
    if (cols.length < 2) {
      console.warn(`[seed-suppression] line ${i + 1}: skipped — needs 'email_or_domain,reason'`);
      continue;
    }
    out.push({ emailOrDomain: cols[0], reason: cols[1] });
  }
  return out;
}

async function main() {
  const csvPath = process.argv[2];
  const entries = csvPath ? await readCsv(csvPath) : SEED_ENTRIES;

  if (!entries.length) {
    console.log('[seed-suppression] no entries to seed (SEED_ENTRIES empty and no CSV path given) — no-op.');
    return;
  }

  console.log(`[seed-suppression] seeding ${entries.length} entries…`);
  const result = { inserted: 0, skipped: 0, failed: 0 };
  for (const e of entries) {
    try {
      const r = await addSuppression(e.emailOrDomain, e.reason);
      if (r.inserted) result.inserted++;
      else result.skipped++;
    } catch (err) {
      result.failed++;
      console.error(`[seed-suppression] ${e.emailOrDomain}: ${err.message}`);
    }
  }
  console.log(`[seed-suppression] done. inserted=${result.inserted} skipped=${result.skipped} failed=${result.failed}`);
}

if (require.main === module) {
  main().catch(err => {
    console.error(`[seed-suppression] ${err.message}`);
    process.exit(1);
  });
}

module.exports = { main, readCsv, SEED_ENTRIES };
