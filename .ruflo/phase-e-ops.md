# Phase E — Ops record

**Branch:** `growth-brain/phase-e-closed-loop`
**Applied:** 2026-05-25
**Project:** `pohrbfhftbprlfzsozyj` (ContentBrain Supabase, prod)

## Migration 017 — applied

```
mcp__supabase-authed__apply_migration
  name: phase_e_017_outbound_outcomes
  project_id: pohrbfhftbprlfzsozyj
  result: { success: true }
```

Schema (verified post-apply via information_schema.columns):

| column            | type        | nullable |
| ----------------- | ----------- | -------- |
| id                | uuid        | NO       |
| prospect_id       | uuid        | YES      |
| contact_id        | uuid        | YES      |
| deal_amount       | numeric     | YES      |
| deal_type         | text        | YES      |
| property_location | text        | YES      |
| closed_at         | timestamptz | NO       |
| days_to_close     | integer     | YES      |
| source            | text        | YES      |
| raw_notes         | text        | YES      |
| claude_fact       | text        | NO       |
| created_at        | timestamptz | NO       |

Indexes:
- `idx_outbound_outcomes_prospect_closed` on `(prospect_id, closed_at DESC) WHERE prospect_id IS NOT NULL`
- `idx_outbound_outcomes_closed` on `(closed_at DESC)`

## app_config seed — applied

Two rows inserted via `ON CONFLICT (brand, key) DO NOTHING`:

| brand  | key                              | value  |
| ------ | -------------------------------- | ------ |
| global | dashboard.bulk_approve_cap       | 10     |
| global | dashboard.send_telegram_receipt  | true   |

Both rows confirmed via RETURNING — no prior conflict (these are
genuinely new keys for Phase E).

## What this unlocks for the coder

- `outbound_outcomes` is queryable. Stub bodies in
  `lib/closed-loop/funded-deals.js` can be filled in immediately.
- `getOutcomesByDomain` requires a join through `prospects.website` —
  the index on `closed_at DESC` covers the order-by half; the
  prospect-website lookup is uncovered by design (low-volume fallback).
- `dashboard.bulk_approve_cap` is the value to read in the bulk-approve
  route handler (`routes/dashboard/approve.js` — `POST /outbound/bulk`).
- `dashboard.send_telegram_receipt` is the value
  `lib/outbound-receipt.js#isReceiptEnabled` reads. To turn the receipt
  off later: `UPDATE app_config SET value='false'::jsonb WHERE brand='global' AND key='dashboard.send_telegram_receipt';`

## Rollback (if needed)

```sql
DROP TABLE IF EXISTS outbound_outcomes;
DELETE FROM app_config
WHERE brand='global'
  AND key IN ('dashboard.bulk_approve_cap','dashboard.send_telegram_receipt');
```
