-- Content seeds: raw material from Telegram (text ideas, photos, URLs)
-- Shared across ContentBrain (social), AuctionBrain Landing (blog), BridgeMatch (blog)
CREATE TABLE content_seeds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,          -- 'telegram_text', 'telegram_photo', 'telegram_url'
  raw_input text,                -- original message or URL
  extracted_text text,           -- OCR/scraped content
  summary text,                  -- AI-generated summary
  key_points text,               -- bullet points of useful info
  brand text,                    -- 'auctionbrain', 'bridgematch', or null (both)
  tags text[],                   -- topic tags for retrieval
  used_for_social boolean DEFAULT false,
  used_for_blog boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);
