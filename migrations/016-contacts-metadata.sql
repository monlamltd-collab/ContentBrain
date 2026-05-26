-- Migration 016: add contacts.metadata jsonb (missed in 010)
--
-- The Phase D Performance dashboard queries `contacts.metadata->>'meeting_booked_at'`
-- to surface meetings booked per track. Migration 010 created the contacts table
-- but did NOT add a metadata column; Phase D mock-tests passed because the
-- fixture invented the column. Live queries 500.
--
-- One column ADD; existing rows get the default NULL. Reads that look for
-- `meta->>'meeting_booked_at'` will see NULL until the dashboard tick-box
-- writes a value — that's the intended behaviour.

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS metadata jsonb;
