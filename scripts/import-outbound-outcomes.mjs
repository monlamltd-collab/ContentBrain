#!/usr/bin/env node
// ── PHASE E — CSV → outbound_outcomes importer ────────────────────────────
//
// Usage: node scripts/import-outbound-outcomes.mjs ./outcomes.csv
//
// Reads a CSV of funded-deal facts and inserts rows into the
// outbound_outcomes table (migration 017). Designed for Simon to drop a
// hand-curated CSV every so often; Stripe-webhook + BridgeMatch
// deal-events ingestion is deferred to Phase F.
//
// CSV header row is REQUIRED and must include these columns (order does
// not matter, additional columns are ignored but logged once per run):
//
//   prospect_company   free-text company name. Matched case-insensitive
//                      against prospects.company_name. Misses skipped
//                      with a console warning.
//   deal_amount        numeric — empty means NULL.
//   deal_type          free text.
//   closed_at          ISO date or datetime — validated via new Date().
//   claude_fact        REQUIRED non-empty. The only string the model
//                      ever sees from this row.
//
// Optional columns recognised (others are ignored):
//   contact_email      matched against contacts.email; resolves contact_id.
//   property_location  free text.
//   days_to_close      int.
//   raw_notes          free text; never shown to the model.
//
// Idempotency: before inserting a row the script checks for an existing
// outcome with the same (prospect_id, closed_at, deal_amount). Duplicates
// are skipped. Re-running on the same CSV is safe.
//
// NB the database doesn't currently enforce a UNIQUE (prospect_id,
// closed_at, deal_amount) constraint — the migration didn't add one. The
// pre-insert SELECT is the only dedupe gate; concurrent imports could
// race. Single-operator workflow, low concern; flag for migration 018.
//
// Streaming parse via Node's `readline` — avoids loading large CSVs into
// memory and keeps the dep count at zero (no `csv-parser` needed). The
// parser handles double-quoted fields with embedded commas + escaped
// quotes per RFC 4180; the design doc's sample CSV uses these and the
// importer has to read it.

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REQUIRED_COLUMNS = ['prospect_company', 'deal_amount', 'deal_type', 'closed_at', 'claude_fact'];
const KNOWN_OPTIONAL  = ['contact_email', 'property_location', 'days_to_close', 'raw_notes'];

// ── CSV parsing ────────────────────────────────────────────────────────────
// Minimal RFC 4180-ish line parser. Handles double-quoted fields with
// embedded commas and "" → " escape. Doesn't handle line-breaks inside
// quoted fields — the importer's input is hand-curated and the design
// doc sample CSV doesn't use multi-line cells, so we don't pay the
// complexity cost for an edge case Simon won't produce.

function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur === '') { inQuotes = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out;
}

/**
 * Validate + normalise a CSV row. Throws on missing required columns or
 * unparseable numerics — caller catches and increments skipped_invalid.
 *
 * @param {object} csvRow  string-valued (column header → cell value)
 * @param {number} lineNo  1-indexed line number for error messages
 */
function validateRow(csvRow, lineNo) {
  if (!csvRow || typeof csvRow !== 'object') {
    throw new Error(`line ${lineNo}: row is not an object`);
  }

  const company = trimOrNull(csvRow.prospect_company);
  if (!company) {
    throw new Error(`line ${lineNo}: prospect_company is required and empty`);
  }

  const claudeFact = trimOrNull(csvRow.claude_fact);
  if (!claudeFact) {
    throw new Error(`line ${lineNo}: claude_fact is required and empty`);
  }

  const closedAtRaw = trimOrNull(csvRow.closed_at);
  if (!closedAtRaw) {
    throw new Error(`line ${lineNo}: closed_at is required and empty`);
  }
  const closedAtDate = new Date(closedAtRaw);
  if (Number.isNaN(closedAtDate.getTime())) {
    throw new Error(`line ${lineNo}: closed_at '${closedAtRaw}' is not a valid date`);
  }

  let dealAmount = null;
  const dealAmountRaw = trimOrNull(csvRow.deal_amount);
  if (dealAmountRaw !== null) {
    const n = Number(dealAmountRaw.replace(/[£,\s]/g, ''));
    if (!Number.isFinite(n)) {
      throw new Error(`line ${lineNo}: deal_amount '${dealAmountRaw}' is not numeric`);
    }
    dealAmount = n;
  }

  let daysToClose = null;
  const dttRaw = trimOrNull(csvRow.days_to_close);
  if (dttRaw !== null) {
    const n = parseInt(dttRaw, 10);
    if (!Number.isFinite(n)) {
      throw new Error(`line ${lineNo}: days_to_close '${dttRaw}' is not an integer`);
    }
    daysToClose = n;
  }

  return {
    prospect_company:  company,
    contact_email:     trimOrNull(csvRow.contact_email),
    deal_amount:       dealAmount,
    deal_type:         trimOrNull(csvRow.deal_type),
    property_location: trimOrNull(csvRow.property_location),
    closed_at:         closedAtDate.toISOString(),
    days_to_close:     daysToClose,
    raw_notes:         trimOrNull(csvRow.raw_notes),
    claude_fact:       claudeFact,
  };
}

function trimOrNull(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim();
  return t === '' ? null : t;
}

// ── Supabase lookups ──────────────────────────────────────────────────────

async function resolveProspectId(supabase, companyName) {
  if (!companyName) return null;
  try {
    const { data, error } = await supabase
      .from('prospects')
      .select('id')
      .ilike('company_name', companyName)
      .maybeSingle();
    if (error) {
      console.warn(`[importer] resolveProspectId('${companyName}'): ${error.message}`);
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    console.warn(`[importer] resolveProspectId('${companyName}') threw: ${err.message}`);
    return null;
  }
}

async function resolveContactId(supabase, email) {
  if (!email) return null;
  try {
    const { data, error } = await supabase
      .from('contacts')
      .select('id')
      .ilike('email', email)
      .maybeSingle();
    if (error) {
      console.warn(`[importer] resolveContactId('${email}'): ${error.message}`);
      return null;
    }
    return data?.id ?? null;
  } catch (err) {
    console.warn(`[importer] resolveContactId('${email}') threw: ${err.message}`);
    return null;
  }
}

async function outcomeExists(supabase, prospectId, closedAt, dealAmount) {
  if (!prospectId) return false;
  try {
    let q = supabase
      .from('outbound_outcomes')
      .select('id')
      .eq('prospect_id', prospectId)
      .eq('closed_at', closedAt);
    if (dealAmount === null || dealAmount === undefined) {
      q = q.is('deal_amount', null);
    } else {
      q = q.eq('deal_amount', dealAmount);
    }
    const { data, error } = await q.maybeSingle();
    if (error) {
      // PGRST116 = "no rows found", which our maybeSingle should swallow,
      // but other errors should make us err on the side of "exists" so we
      // don't double-insert on transient failures.
      console.warn(`[importer] outcomeExists: ${error.message}`);
      return true;
    }
    return !!data;
  } catch (err) {
    console.warn(`[importer] outcomeExists threw: ${err.message}`);
    return true;
  }
}

// ── Streaming CSV iterator ────────────────────────────────────────────────

async function* streamCsvRows(csvPath) {
  const rl = createInterface({
    input: createReadStream(csvPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });
  let header = null;
  let unknownLogged = false;
  let lineNo = 0;
  for await (const rawLine of rl) {
    lineNo += 1;
    if (rawLine.trim() === '') continue;
    const cells = parseCsvLine(rawLine);
    if (!header) {
      header = cells.map(h => h.trim());
      const missing = REQUIRED_COLUMNS.filter(c => !header.includes(c));
      if (missing.length) {
        throw new Error(`CSV header missing required columns: ${missing.join(', ')}`);
      }
      const ignored = header.filter(h => !REQUIRED_COLUMNS.includes(h) && !KNOWN_OPTIONAL.includes(h));
      if (ignored.length && !unknownLogged) {
        console.warn(`[importer] ignoring unknown columns: ${ignored.join(', ')}`);
        unknownLogged = true;
      }
      continue;
    }
    const row = {};
    for (let i = 0; i < header.length; i++) {
      row[header[i]] = cells[i] ?? '';
    }
    yield { row, lineNo };
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

/**
 * Stream the CSV at csvPath and insert each valid row. Returns a stats
 * summary; the CLI wrapper prints it as JSON. Pure-function-ish: the only
 * side effects are Supabase writes and console logging.
 */
async function importOutcomes(csvPath) {
  const resolved = path.isAbsolute(csvPath) ? csvPath : path.resolve(process.cwd(), csvPath);
  if (!existsSync(resolved)) {
    throw new Error(`CSV not found: ${resolved}`);
  }

  // Lazy require — keeps dotenv / Supabase init off the import path so
  // the test suite can stub these via require.cache.
  const { supabase } = await import('../lib/supabase.js');
  const { insertOutcome } = await import('../lib/closed-loop/funded-deals.js');

  const stats = {
    rows_read:          0,
    prospects_matched:  0,
    inserted:           0,
    skipped: {
      no_prospect: 0,
      validation:  0,
      duplicate:   0,
    },
  };

  for await (const { row, lineNo } of streamCsvRows(resolved)) {
    stats.rows_read += 1;

    let validated;
    try {
      validated = validateRow(row, lineNo);
    } catch (err) {
      stats.skipped.validation += 1;
      console.warn(`[importer] validation skip — ${err.message}`);
      continue;
    }

    const prospectId = await resolveProspectId(supabase, validated.prospect_company);
    if (!prospectId) {
      stats.skipped.no_prospect += 1;
      console.warn(`[importer] no prospect for '${validated.prospect_company}' (line ${lineNo}) — skipping`);
      continue;
    }
    stats.prospects_matched += 1;

    const contactId = await resolveContactId(supabase, validated.contact_email);

    if (await outcomeExists(supabase, prospectId, validated.closed_at, validated.deal_amount)) {
      stats.skipped.duplicate += 1;
      console.log(`[importer] duplicate (prospect ${prospectId} @ ${validated.closed_at}) — skipping line ${lineNo}`);
      continue;
    }

    try {
      await insertOutcome({
        prospect_id:       prospectId,
        contact_id:        contactId,
        deal_amount:       validated.deal_amount,
        deal_type:         validated.deal_type,
        property_location: validated.property_location,
        closed_at:         validated.closed_at,
        days_to_close:     validated.days_to_close,
        source:            'manual-csv',
        raw_notes:         validated.raw_notes,
        claude_fact:       validated.claude_fact,
      });
      stats.inserted += 1;
    } catch (err) {
      stats.skipped.validation += 1;
      console.warn(`[importer] insert failed for line ${lineNo}: ${err.message}`);
    }
  }

  console.log(
    `[importer] imported ${stats.inserted}, ` +
    `skipped ${stats.skipped.no_prospect} (no prospect), ` +
    `${stats.skipped.duplicate} (duplicate), ` +
    `${stats.skipped.validation} (invalid) of ${stats.rows_read} rows.`
  );
  return stats;
}

// ── CLI entry — only runs when invoked directly ──────────────────────────

if (process.argv[1] && process.argv[1].endsWith('import-outbound-outcomes.mjs')) {
  const csvPath = process.argv[2];
  if (!csvPath) {
    console.error('Usage: node scripts/import-outbound-outcomes.mjs <path-to-csv>');
    process.exit(1);
  }
  importOutcomes(csvPath)
    .then((summary) => {
      console.log(JSON.stringify(summary, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[importer] fatal: ${err.message}`);
      process.exit(1);
    });
}

export {
  importOutcomes,
  validateRow,
  resolveProspectId,
  resolveContactId,
  outcomeExists,
  parseCsvLine,
  streamCsvRows,
};
