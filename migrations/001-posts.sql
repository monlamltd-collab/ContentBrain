-- ContentBrain posts queue table
create table if not exists posts (
  id uuid primary key default gen_random_uuid(),
  brand text not null check (brand in ('auctionbrain', 'bridgematch')),
  platform text not null check (platform in ('facebook', 'linkedin', 'tiktok')),
  template_type text not null check (template_type in ('stat', 'hook', 'list', 'reel')),
  copy_headline text,
  copy_body text,
  copy_cta text,
  image_url text,
  status text not null default 'draft' check (status in ('draft', 'approved', 'rejected', 'published')),
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  published_at timestamptz,
  scheduled_for timestamptz
);

-- Index for queue queries
create index if not exists idx_posts_status on posts (status);
create index if not exists idx_posts_brand_status on posts (brand, status);
create index if not exists idx_posts_scheduled on posts (status, scheduled_for)
  where status = 'approved';
