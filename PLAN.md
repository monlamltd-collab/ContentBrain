# ContentBrain — Build Plan

Automated social media content generation and publishing pipeline for AuctionBrain and BridgeMatch.

## Phases

### Phase 1: Project Structure & Config ✅
- [x] Init repo, package.json, .gitignore, .env.example
- [x] Install dependencies (express, puppeteer, @anthropic-ai/sdk, @supabase/supabase-js, dotenv)
- [x] Create directory structure (lib/, templates/, workers/, public/, migrations/, output/)
- [x] Brand config module — lib/config.js
- [x] Supabase client module — lib/supabase.js
- [x] Supabase migration SQL — migrations/001-posts.sql

### Phase 2: Graphic Templates ✅
- [x] HTML/CSS template: Stat Post (1080x1080) — templates/stat.html
- [x] HTML/CSS template: Hook + CTA Post (1080x1080) — templates/hook.html
- [x] HTML/CSS template: List/Value Post (1080x1080) — templates/list.html
- [x] HTML/CSS template: Video Cover/Reel (1080x1920) — templates/reel.html
- [x] Puppeteer renderer module — lib/renderer.js
- [x] Test render all 8 variants (4 templates x 2 brands) — all pass

### Phase 3: Content Generation ✅
- [x] Claude API copy generation module — lib/generate.js
- [x] Post type prompts (stat, hook, list, reel)
- [x] Brand-aware prompt injection
- [x] generate-content.js worker — workers/generate-content.js
- [x] Telegram notification module — lib/telegram.js

### Phase 4: Review UI ✅
- [x] Express server with password auth — server.js
- [x] HTML preview page (draft cards with image, copy, brand/platform labels)
- [x] Approve/Reject API endpoints
- [x] Status update in Supabase

### Phase 5: Publishing Pipeline ✅
- [x] Buffer API integration module — lib/buffer.js
- [x] publish-content.js worker — workers/publish-content.js
- [x] Status tracking (approved → published)

### Phase 6: Deployment & Scheduling
- [x] Railway Procfile
- [ ] Run Supabase migration
- [ ] Configure .env with real credentials
- [ ] Add brand logo PNGs to templates/logos/
- [ ] End-to-end test (generate → review → approve → publish)
- [ ] Cron scheduling on Railway (generate Mon/Wed/Fri, publish daily)

## Brand Specs

### AuctionBrain
- Audience: UK property investors looking for auction deals
- Tone: sharp, data-driven, insider advantage
- Messages: 168 houses in one place, ~50% never reach Rightmove, AI scoring, free, bridging built in
- Colours: navy #1a2b4b, green #0f8a5f, cream #faf8f4, red #C0392B
- Fonts: Source Serif 4 (headings), DM Sans (body)
- URL: auctionbrain.co.uk

### BridgeMatch
- Audience: property investors/developers needing bridging finance
- Tone: professional, reassuring, makes complex simple
- Messages: match to right lender in minutes, know fundability before bidding, per-lender LTGDV, free
- Colours: navy #1a2b4b, green #0f8a5f, cream #faf8f4
- Fonts: Source Serif 4 (headings), DM Sans (body)
- URL: bridgematch.co.uk
