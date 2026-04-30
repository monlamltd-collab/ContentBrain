-- Authors: ghost-writer personas that ride on top of brand voice.
--
-- A brand still defines audience + key messages + base tone. An author
-- adds an idiosyncratic voice (tone, mannerisms, free-form directive)
-- that's overlaid onto the brand prompt for that single post. Generation
-- picks an author by weight at write time, similar to how template
-- weights bias the format mix.
--
-- Roaming default: an author with `brands = NULL` is eligible for any
-- active brand. Scope to specific brands by setting `brands` to an
-- array, e.g. ARRAY['auctionbrain'].
CREATE TABLE IF NOT EXISTS authors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  tone text,
  directive text,
  extra_messages jsonb,
  active boolean NOT NULL DEFAULT true,
  weight numeric NOT NULL DEFAULT 1,
  brands text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (weight >= 0)
);

CREATE INDEX IF NOT EXISTS authors_active_idx ON authors (active) WHERE active;
