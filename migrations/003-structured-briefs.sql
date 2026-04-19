-- Add structured fields to content_briefs for richer brief data
ALTER TABLE content_briefs ADD COLUMN IF NOT EXISTS topic text;
ALTER TABLE content_briefs ADD COLUMN IF NOT EXISTS brand text;
ALTER TABLE content_briefs ADD COLUMN IF NOT EXISTS angle text;
ALTER TABLE content_briefs ADD COLUMN IF NOT EXISTS data_points text;
