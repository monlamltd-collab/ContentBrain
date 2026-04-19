-- Store Facebook post ID for insights lookups
ALTER TABLE posts ADD COLUMN IF NOT EXISTS fb_post_id text;

-- Performance metrics table
CREATE TABLE IF NOT EXISTS post_metrics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id uuid REFERENCES posts(id) ON DELETE CASCADE,
  reach integer DEFAULT 0,
  impressions integer DEFAULT 0,
  engagements integer DEFAULT 0,
  clicks integer DEFAULT 0,
  video_views integer DEFAULT 0,
  video_avg_watch_seconds numeric DEFAULT 0,
  fetched_at timestamp with time zone DEFAULT now(),
  UNIQUE(post_id, fetched_at)
);

CREATE INDEX IF NOT EXISTS idx_post_metrics_post_id ON post_metrics(post_id);
CREATE INDEX IF NOT EXISTS idx_post_metrics_fetched_at ON post_metrics(fetched_at DESC);
