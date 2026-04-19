-- Add rejection_feedback column to capture why posts were rejected
ALTER TABLE posts ADD COLUMN IF NOT EXISTS rejection_feedback text;
