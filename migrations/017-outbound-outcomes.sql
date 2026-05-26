-- Migration 017: outbound_outcomes — funded-deal facts that feed the
-- outbound prompt's DEAL HISTORY block (Phase E closed loop).
--
-- Design notes:
-- * `claude_fact` is the ONLY string the model ever sees from this table.
--   Every other column (deal_amount, property_location, raw_notes, …) is
--   metadata for humans + the importer. The prompt block quotes
--   `claude_fact` verbatim and the outbound-filters checkInventedAmounts
--   rule blocks any £-amount in the generated body that doesn't appear in
--   one of those facts. This two-sided guard (prompt + filter) is the
--   FCA-exposure anti-hallucination contract — see .ruflo/phase-e-design.md
--   §1.2 + §1.5 for the rationale.
-- * `prospect_id` is nullable so wins can be logged before a prospect row
--   exists (a backfill matcher can wire the FK later). When NULL, the
--   outbound prompt simply omits the DEAL HISTORY block for that contact.
-- * `closed_at` is required — without a date there's nothing to order by
--   for "recent wins" lookups in lib/closed-loop/funded-deals.js.
-- * `source` is a free-text discriminator: 'manual-csv' for the Phase E
--   importer, 'bridgematch-webhook' / 'stripe-event' for Phase F sources.

CREATE TABLE IF NOT EXISTS outbound_outcomes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id       uuid REFERENCES prospects(id) ON DELETE CASCADE,
  contact_id        uuid REFERENCES contacts(id)  ON DELETE CASCADE,
  deal_amount       numeric,
  deal_type         text,
  property_location text,
  closed_at         timestamptz NOT NULL,
  days_to_close     int,
  source            text,
  raw_notes         text,
  claude_fact       text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- "Recent wins for THIS prospect" — primary lookup pattern from
-- lib/closed-loop/funded-deals.js#getProspectOutcomes. The composite
-- (prospect_id, closed_at DESC) index serves both the WHERE and the
-- ORDER BY in a single scan; partial-WHERE on NOT NULL keeps the index
-- tight (NULL prospect_id rows aren't queryable by prospect anyway).
CREATE INDEX IF NOT EXISTS idx_outbound_outcomes_prospect_closed
  ON outbound_outcomes (prospect_id, closed_at DESC)
  WHERE prospect_id IS NOT NULL;

-- Secondary index for the domain-fallback lookup (getOutcomesByDomain)
-- when prospect_id matching misses. closed_at DESC alone — domain match
-- happens at query time via prospects.website join.
CREATE INDEX IF NOT EXISTS idx_outbound_outcomes_closed
  ON outbound_outcomes (closed_at DESC);
