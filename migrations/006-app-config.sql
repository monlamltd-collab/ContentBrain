-- App config: runtime-tunable levers driving social content generation.
-- Tweak via Telegram (/tone, /messages, /hooks, /ctas, /active, /templates,
-- /directive, /audience). Falls back to lib/config.js + lib/generate.js
-- defaults when a row is absent so the system stays bootable on a fresh DB.
--
-- brand = 'global' for non-brand-scoped keys (hook_patterns, cta_patterns,
-- active_brands, template_weights). Otherwise the brand slug.
CREATE TABLE IF NOT EXISTS app_config (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brand text NOT NULL,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_at timestamptz DEFAULT now(),
  updated_by text DEFAULT 'telegram',
  UNIQUE (brand, key)
);

CREATE INDEX IF NOT EXISTS app_config_brand_key_idx ON app_config (brand, key);
