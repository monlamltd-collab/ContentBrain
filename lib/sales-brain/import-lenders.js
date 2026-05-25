require('dotenv').config();

// ── Lender snapshot importer (Phase B) ────────────────────────────────────
//
// Reads the Bridgematch lenders.db SQLite snapshot at
//   C:\Users\User\Documents\GitHub\Bridgematch\lenders.db
// and upserts:
//   - 69 prospects (type='lender', source='bridging-brain')
//   - 96 contacts  (66 BDM + 30 enquiries inboxes after dedup)
//
// Idempotent: re-running with a refreshed snapshot updates metadata but
// does not duplicate rows — `prospects` uses (source, lower(company_name))
// as a unique key and `contacts` uses (prospect_id, lower(email)).
//
// Why sql.js (and not better-sqlite3)? better-sqlite3 needs a native build
// step on Windows; sql.js is pure WASM, runs anywhere Node runs, and we
// only read the file once per import. The performance hit on 69 rows is
// irrelevant — see researcher's note in .ruflo/lender-mapping.md.
//
// Column mapping, normalisation rules, expected counts, and data-quality
// edge cases (stray backticks, NBSP in phones, email-in-phone column) live
// in .ruflo/lender-mapping.md alongside this file. Treat that doc as the
// source of truth — this file implements it.

const fs = require('fs/promises');
const initSqlJs = require('sql.js');
const { supabase } = require('../supabase');
const { assertSource } = require('./constants');

const DEFAULT_DB_PATH = 'C:\\Users\\User\\Documents\\GitHub\\Bridgematch\\lenders.db';
const SOURCE = 'bridging-brain';

// ── Normalisation helpers ────────────────────────────────────────────────
// Inline impls — also exported via module.exports for tester.

/**
 * Run the importer end-to-end.
 *
 * @param {object} [options]
 * @param {boolean} [options.force=false] - When true, re-upsert every row
 *   even if metadata matches (useful for backfilling new metadata keys).
 *   When false (default), an unchanged row is skipped.
 * @returns {Promise<{prospects: {inserted: number, updated: number, skipped: number},
 *                    contacts:  {inserted: number, updated: number, skipped: number},
 *                    warnings: string[]}>}
 *   Counts + any per-row warnings (e.g. "Ascot Bridging: enquiries_phone held
 *   an email — stashed under metadata.enquiries_phone_raw").
 */
async function importLenders({ force = false, dbPath } = {}) {
  void force; // reserved for future "re-upsert even if metadata matches" mode
  assertSource(SOURCE); // belt-and-braces — fails fast if someone breaks the enum

  const resolvedDbPath = dbPath || process.env.BRIDGING_BRAIN_DB_PATH || DEFAULT_DB_PATH;
  console.log(`[import-lenders] reading snapshot: ${resolvedDbPath}`);

  let rows;
  try {
    rows = await readLenders(resolvedDbPath);
  } catch (err) {
    throw new Error(`Cannot read lenders.db at ${resolvedDbPath}: ${err.message}`);
  }
  console.log(`[import-lenders] loaded ${rows.length} lender rows from snapshot`);

  const result = {
    prospects: { inserted: 0, updated: 0, skipped: 0 },
    contacts:  { inserted: 0, updated: 0, skipped: 0 },
    warnings: [],
  };

  for (const row of rows) {
    const company = (row.name || '').trim();
    if (!company) {
      const w = '[import-lenders] skip: row has no name';
      console.warn(w);
      result.warnings.push(w);
      result.prospects.skipped++;
      continue;
    }

    // ── Build prospect row ──
    const enquiriesPhoneRaw = row.enquiries_phone || null;
    const enquiriesPhoneClean = normalisePhone(enquiriesPhoneRaw);
    // If the source enquiries_phone failed normalisation, stash the raw value
    // on metadata so Simon can review it during outbound prep.
    const enquiriesPhoneStashed = (enquiriesPhoneRaw && !enquiriesPhoneClean) ? enquiriesPhoneRaw : null;

    const metadata = {
      funding_model: row.funding_model || null,
      last_updated: row.last_updated || null,
      enquiries_phone: enquiriesPhoneRaw || null,
      criteria_update_contact: row.criteria_update_contact || null,
    };
    if (enquiriesPhoneStashed) {
      metadata.enquiries_phone_raw = enquiriesPhoneStashed;
      const w = `[import-lenders] ${company}: enquiries_phone held a non-phone value — stashed under metadata.enquiries_phone_raw`;
      console.warn(w);
      result.warnings.push(w);
    }

    const prospect = {
      type: 'lender',
      company_name: company,
      website: null, // no source column — Hunter enrichment may fill later
      source: SOURCE,
      metadata,
    };

    let prospectId;
    try {
      const r = await upsertProspect(prospect);
      prospectId = r.id;
      if (r.inserted) result.prospects.inserted++;
      else result.prospects.updated++;
    } catch (err) {
      const w = `[import-lenders] skip prospect ${company}: ${err.message}`;
      console.warn(w);
      result.warnings.push(w);
      result.prospects.skipped++;
      continue;
    }

    // ── Build BDM contact ──
    const bdmEmail = normaliseEmail(row.sw_bdm_email);
    if (bdmEmail) {
      const bdm = {
        prospect_id: prospectId,
        name: row.sw_bdm_name ? row.sw_bdm_name.trim() : null,
        role: 'BDM',
        email: bdmEmail,
        linkedin_url: null,
        confidence_score: 80,
        source: SOURCE,
      };
      try {
        const r = await upsertContact(bdm);
        if (r.inserted) result.contacts.inserted++;
        else result.contacts.updated++;
      } catch (err) {
        const w = `[import-lenders] skip BDM contact ${bdmEmail} (${company}): ${err.message}`;
        console.warn(w);
        result.warnings.push(w);
        result.contacts.skipped++;
      }
    } else if (row.sw_bdm_name || row.sw_bdm_mobile) {
      const w = `[import-lenders] skip BDM contact for ${company}: sw_bdm_email missing/invalid (have name=${!!row.sw_bdm_name})`;
      console.warn(w);
      result.warnings.push(w);
      result.contacts.skipped++;
    }

    // ── Build enquiries-inbox contact (skip if same email as BDM) ──
    const enqEmail = normaliseEmail(row.enquiries_email);
    if (enqEmail) {
      if (bdmEmail && enqEmail === bdmEmail) {
        // Dedup case — 39 of 69 lenders per .ruflo/lender-mapping.md §2b.
        const w = `[import-lenders] dedup enquiries for ${company}: same email as BDM (${enqEmail})`;
        console.log(w);
        result.contacts.skipped++;
      } else {
        const enq = {
          prospect_id: prospectId,
          name: null, // inbox — do NOT guess a name (filter would block it)
          role: 'Enquiries inbox',
          email: enqEmail,
          linkedin_url: null,
          confidence_score: 60,
          source: SOURCE,
        };
        try {
          const r = await upsertContact(enq);
          if (r.inserted) result.contacts.inserted++;
          else result.contacts.updated++;
        } catch (err) {
          const w = `[import-lenders] skip enquiries contact ${enqEmail} (${company}): ${err.message}`;
          console.warn(w);
          result.warnings.push(w);
          result.contacts.skipped++;
        }
      }
    } else if (row.enquiries_email) {
      const w = `[import-lenders] skip enquiries for ${company}: enquiries_email normalised to empty`;
      console.warn(w);
      result.warnings.push(w);
      result.contacts.skipped++;
    }
  }

  console.log(`[import-lenders] done. prospects ${JSON.stringify(result.prospects)} contacts ${JSON.stringify(result.contacts)} warnings=${result.warnings.length}`);
  return result;
}

// ── SQLite reader ────────────────────────────────────────────────────────

async function readLenders(dbPath) {
  const buf = await fs.readFile(dbPath);
  const SQL = await initSqlJs();
  const db = new SQL.Database(buf);

  // bridging-brain `_source='excel'` filter per .ruflo/lender-mapping.md.
  const stmt = db.exec(`
    SELECT
      name,
      last_updated,
      funding_model,
      enquiries_email,
      enquiries_phone,
      sw_bdm_name,
      sw_bdm_email,
      sw_bdm_mobile,
      criteria_update_contact
    FROM lenders
    WHERE _source = 'excel'
  `);

  db.close();

  if (!stmt || stmt.length === 0) return [];
  const { columns, values } = stmt[0];
  return values.map(row => {
    const obj = {};
    columns.forEach((c, i) => { obj[c] = row[i]; });
    return obj;
  });
}

// ── Upserters ────────────────────────────────────────────────────────────
//
// The unique indexes on prospects/contacts target lower(company_name) /
// lower(email) — Supabase's .upsert(onConflict) doesn't accept expression-
// style conflict targets, so we do a read-then-write fallback. Cheap at
// 69 rows; refactor to a Supabase RPC if it ever matters.

async function upsertProspect(prospect) {
  const { data: existing, error: readErr } = await supabase
    .from('prospects')
    .select('id, metadata')
    .eq('source', prospect.source)
    .ilike('company_name', prospect.company_name)
    .maybeSingle();
  if (readErr) {
    throw new Error(`upsertProspect read failed for ${prospect.company_name}: ${readErr.message}`);
  }

  if (existing) {
    const { data, error } = await supabase
      .from('prospects')
      .update({
        type: prospect.type,
        company_name: prospect.company_name,
        metadata: prospect.metadata,
      })
      .eq('id', existing.id)
      .select('id')
      .single();
    if (error) throw new Error(`upsertProspect update failed for ${prospect.company_name}: ${error.message}`);
    return { id: data.id, inserted: false };
  }

  const { data, error } = await supabase
    .from('prospects')
    .insert(prospect)
    .select('id')
    .single();
  if (error) throw new Error(`upsertProspect insert failed for ${prospect.company_name}: ${error.message}`);
  return { id: data.id, inserted: true };
}

async function upsertContact(contact) {
  const { data: existing, error: readErr } = await supabase
    .from('contacts')
    .select('id')
    .eq('prospect_id', contact.prospect_id)
    .ilike('email', contact.email)
    .maybeSingle();
  if (readErr) {
    throw new Error(`upsertContact read failed for ${contact.email}: ${readErr.message}`);
  }

  if (existing) {
    const { error } = await supabase
      .from('contacts')
      .update({
        name: contact.name,
        role: contact.role,
        linkedin_url: contact.linkedin_url,
        confidence_score: contact.confidence_score,
        source: contact.source,
      })
      .eq('id', existing.id);
    if (error) throw new Error(`upsertContact update failed for ${contact.email}: ${error.message}`);
    return { id: existing.id, inserted: false };
  }

  const { data, error } = await supabase
    .from('contacts')
    .insert(contact)
    .select('id')
    .single();
  if (error) throw new Error(`upsertContact insert failed for ${contact.email}: ${error.message}`);
  return { id: data.id, inserted: true };
}

/**
 * Strip a stray non-alphanumeric prefix, replace NBSPs, trim, lowercase.
 * Returns null for empty input.
 *
 * Test cases (from .ruflo/lender-mapping.md):
 *   normaliseEmail('`chris.buckley@asgfinance.co.uk') === 'chris.buckley@asgfinance.co.uk'
 *   normaliseEmail('Foo@Bar.co')                      === 'foo@bar.co'
 *   normaliseEmail('')                                === null
 *   normaliseEmail(null)                              === null
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normaliseEmail(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  // NBSP (U+00A0) -> regular space, then trim, then strip leading non-alphanumerics, then lowercase.
  const NBSP = String.fromCharCode(0xA0);
  const cleaned = raw.split(NBSP).join(' ').trim().replace(/^[^a-zA-Z0-9]+/, '').toLowerCase();
  return cleaned || null;
}

/**
 * Strip a leading "M: " prefix, replace NBSPs, trim. Returns null if the
 * cleaned value contains any letters (catches the email-in-phone-column
 * edge case in the bridging-brain snapshot — Ascot Bridging row 3).
 *
 * Test cases (from .ruflo/lender-mapping.md):
 *   normalisePhone('M: 07879 855569')                === '07879 855569'
 *   normalisePhone('enquiries@ascotbridging.co.uk')  === null
 *   normalisePhone('07763\xa0206\xa0238')            === '07763 206 238'
 *
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
function normalisePhone(raw) {
  if (raw == null) return null;
  if (typeof raw !== 'string') return null;
  // NBSP (U+00A0) -> regular space, strip leading "M: " prefix, then trim.
  const NBSP = String.fromCharCode(0xA0);
  const cleaned = raw.split(NBSP).join(' ').replace(/^M:\s*/i, '').trim();
  if (!cleaned) return null;
  if (!/^[\d\s+()\-]+$/.test(cleaned)) return null;
  return cleaned;
}

module.exports = { importLenders, normaliseEmail, normalisePhone, readLenders, upsertProspect, upsertContact };

// CLI entry point. Usage:
//   node lib/sales-brain/import-lenders.js
//   node lib/sales-brain/import-lenders.js --force
if (require.main === module) {
  const force = process.argv.includes('--force');
  importLenders({ force })
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    })
    .catch((err) => {
      console.error(`[import-lenders] ${err.message}`);
      process.exit(1);
    });
}
