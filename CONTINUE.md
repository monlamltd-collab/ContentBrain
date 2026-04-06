# ContentBrain — Continuation Prompt

Copy-paste this into the next session:

---

We're in ~/Documents/GitHub/ContentBrain. Building ContentBrain v2 — automated social media content pipeline for AuctionBrain and BridgeMatch.

## What's done (v1 — fully working):
- Claude Haiku generates 6 posts per run (3 per brand)
- Puppeteer renders 4 HTML/CSS graphic templates (stat, hook, list, reel) as PNG
- Posts stored in Supabase `posts` table (draft/approved/rejected/published)
- Express review UI at localhost:3000 (password: contentbrain2026)
- Make.com webhook publishes approved posts to Facebook (confirmed working, live post made)
- Telegram notifications when drafts ready
- Supabase project: pohrbfhftbprlfzsozyj (shared with AuctionBrain)

## What we're building now (v2):

### v2.0 — Remotion video templates (START HERE)
Remotion is installed (remotion, @remotion/cli, @remotion/renderer, @remotion/bundler).
Need to:
1. Create `video/` directory with Remotion project structure (Root.jsx, compositions)
2. Build 4 animated video compositions matching the 4 template types:
   - StatVideo: number counter animation, fade-in caption, red divider sweep
   - HookVideo: headline slide-in, body fade, green CTA bar slides up
   - ListVideo: green title bar, bullet points appear one by one with red markers
   - ReelVideo: 9:16, large text zoom-in, subline fade
3. All compositions accept brand props (colours, fonts, messages) from lib/config.js
4. Add royalty-free background music support
5. Create lib/video-renderer.js that uses @remotion/renderer to render compositions to MP4
6. Update workers/generate-content.js to generate video posts alongside static PNGs
7. Update Make.com payload to handle video files

### v2.1 — Screenshot posts from live AuctionBrain app
### v2.2 — Carousel/multi-image posts
### v2.3 — Royalty-free music library + audio overlay

### v3.0-3.3 — Engagement tracking loop
- Facebook metrics via Make.com native module
- LinkedIn + TikTok metrics via direct API (apps submitted for review)
- post_metrics Supabase table
- Claude weekly analysis + auto prompt adjustment

## Brand specs:
- AuctionBrain: navy #1a2b4b, green #0f8a5f, cream #faf8f4, red #C0392B, Source Serif 4 headings, DM Sans body
- BridgeMatch: same colours, professional/reassuring tone

## Key files:
- lib/config.js — brand colours, fonts, messages
- lib/renderer.js — Puppeteer PNG renderer (working)
- lib/generate.js — Claude copy generation (working)
- lib/publish.js — Make.com webhook (working)
- lib/supabase.js — DB operations (working)
- server.js — Review UI (working)
- workers/generate-content.js — main generation worker
- workers/publish-content.js — publishing worker
- templates/*.html — 4 static graphic templates

## Env vars configured:
SUPABASE_URL, SUPABASE_ANON_KEY (service role key), CLAUDE_API_KEY, MAKE_WEBHOOK_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, REVIEW_UI_PASSWORD

## External accounts status:
- Facebook: LIVE (posting via Make.com works)
- LinkedIn: Developer app created, verification done, Community Management API requested (pending review ~1-2 weeks)
- TikTok: PARKED (needs demo video of working integration before review — build first, submit later)
- Make.com: Working, free tier, webhook URL in .env
