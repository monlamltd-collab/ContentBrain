-- Migration 010: contacts table for outbound (Phase B)
--
-- A `contact` is a person (or a generic inbox) we may email at a `prospect`.
-- One prospect has many contacts — e.g. a lender has a named BDM contact AND
-- a generic enquiries inbox contact. FK to prospects with cascade-delete: if
-- a prospect is removed, its contacts go with it (no orphan reach-outs).
--
-- `name` is nullable on purpose: generic inboxes ("enquiries@…") don't have
-- a person attached and we MUST NOT guess one — the outbound filter blocks
-- "Hi [first_name]" templating. The bridging-brain importer leaves `name`
-- NULL for enquiries-inbox rows by design (see .ruflo/lender-mapping.md §2b).
--
-- `email` is required — without it there's nothing to outbound to. The
-- (prospect_id, lower(email)) unique index makes re-imports idempotent and
-- prevents Hunter.io enrichment from creating duplicates if it returns an
-- email we already have under a different casing.
--
-- `confidence_score` is a 0-100 int set by the source: 80 for manually-curated
-- BDM emails, 60 for generic inboxes, set by Hunter.io for enriched contacts.
-- `verified_at` is non-NULL once an email has been verified (Hunter verify,
-- bounce, or a successful Resend send-and-no-bounce window).
--
-- No CHECK on role/source — application code enforces the allowed set so new
-- contact types ('Decision maker' etc.) don't need a migration.

CREATE TABLE IF NOT EXISTS contacts (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  prospect_id      uuid        NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  name             text,
  role             text,
  email            text        NOT NULL,
  linkedin_url     text,
  confidence_score int,
  source           text,
  verified_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);

-- Idempotent per-prospect email uniqueness. Case-insensitive because email
-- addresses are case-insensitive in practice and we want "BDM@x.co" and
-- "bdm@x.co" treated as the same contact.
CREATE UNIQUE INDEX IF NOT EXISTS uq_contacts_prospect_email
  ON contacts (prospect_id, lower(email));

-- FK lookups: "show me every contact at prospect X".
CREATE INDEX IF NOT EXISTS idx_contacts_prospect
  ON contacts (prospect_id);

-- Reverse lookup: "is this incoming email address one of our outbound targets?"
-- Used by the Resend webhook reply matcher.
CREATE INDEX IF NOT EXISTS idx_contacts_email
  ON contacts (lower(email));
