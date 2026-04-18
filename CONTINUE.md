# ContentBrain — Continuation Prompt

Copy-paste this into the next session:

---

We're in ~/Documents/GitHub/ContentBrain. Building ContentBrain v2 — automated social media content pipeline for AuctionBrain and BridgeMatch.

## What's done (v1 + v2.0 + v2.1 — fully working):
- Claude Haiku generates 3 posts per run (AuctionBrain only for now, all targeting Facebook)
- Puppeteer renders 4 HTML/CSS graphic templates (stat, hook, list, reel) as PNG
- Remotion renders animated MP4 videos with background music (5 tracks in public/music/)
- Posts stored in Supabase `posts` table (draft/approved/rejected/published)
- Express review UI at localhost:3000 (password: contentbrain2026)
- **Direct Facebook Graph API publishing** — permanent page tokens, no Make.com dependency
  - AuctionBrain page ID: 1005815299290301
  - BridgeMatch page ID: 975090445696140
  - Both have permanent (never-expire) tokens in .env
- Telegram bot for notifications, approve/revise/reject workflow
- **Smart revision flow** — LLM classifies feedback (copy change vs video change vs both), re-renders video at requested duration if needed
- **Wake recovery** — 30-min cron catches missed daily generation if PC was sleeping
- **Startup notifications** — Telegram ping on every server start with status summary
- **Error alerting** — publish failures and Telegram send failures notify via Telegram
- Supabase project: pohrbfhftbprlfzsozyj (shared with AuctionBrain)

## What was changed this session (2026-04-18):
1. Diagnosed pipeline: server running via PM2 but Telegram sends were failing silently, posts stuck as drafts
2. Fixed lib/telegram.js — sendPostForReview now returns {ok, error}, all failures logged with status codes
3. Replaced Make.com with direct Facebook Graph API in lib/publish.js — publish() smart router tries FB direct first, Make.com fallback
4. Added per-brand Facebook pages (AuctionBrain + BridgeMatch) with permanent tokens
5. Added wake recovery cron, startup notification, publish error alerts to server.js
6. Changed lib/generate.js — all posts now target Facebook (was distributing across fb/linkedin/tiktok)
7. Upgraded revision flow — LLM classifies feedback type, can re-render videos at custom duration
8. Video renderer accepts overrideDurationSeconds for revision-triggered re-renders

## What to do next — DEPLOY TO RAILWAY:
Simon has Railway Hobby plan ($5/mo). Deploy ContentBrain so it runs 24/7 without his PC.

### Railway deployment steps:
1. Set up Railway project linked to GitHub repo (or deploy from local)
2. Add all env vars from .env to Railway's environment settings
3. Ensure Procfile exists (or configure start command: `node server.js`)
4. Handle Remotion/Puppeteer dependencies — Railway needs Chrome/Chromium for rendering
   - May need `@sparticuz/chromium` or Railway's nixpacks buildpack with Chrome
   - Or Dockerfile with Chrome pre-installed
5. Switch Telegram from polling to webhook (more efficient for serverless-adjacent hosting)
6. Test full pipeline: generate → Telegram review → approve → Facebook publish
7. Disable PM2 on Simon's PC once Railway is confirmed working

### Other pending items:
- LinkedIn: Community Management API pending approval, then wire up direct posting
- TikTok: Parked until LinkedIn works (need demo for app review)
- Make.com: Can disable scenario entirely — only kept as dormant fallback code
- Default video durations could be longer (currently 6-8s, text-heavy content needs more time)

## Key files:
- lib/config.js — brand colours, fonts, messages
- lib/renderer.js — Puppeteer PNG renderer
- lib/video-renderer.js — Remotion MP4 renderer (supports overrideDurationSeconds)
- lib/generate.js — Claude copy generation (all posts → facebook now)
- lib/publish.js — publish() smart router: Facebook direct + Make.com fallback
- lib/supabase.js — DB operations
- lib/telegram.js — Telegram bot with error-returning sends
- server.js — Express + crons + Telegram polling + smart revision flow
- video/Root.jsx — Remotion composition registry
- video/compositions/*.jsx — 4 video compositions with music support
- public/music/ — 5 royalty-free background tracks

## Env vars (all in .env):
SUPABASE_URL, SUPABASE_ANON_KEY, CLAUDE_API_KEY, MAKE_WEBHOOK_URL, FB_PAGE_ID, FB_PAGE_ACCESS_TOKEN, FB_BRIDGEMATCH_PAGE_ID, FB_BRIDGEMATCH_PAGE_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, REVIEW_UI_PASSWORD, PORT

## External accounts:
- Facebook: LIVE — direct Graph API posting, permanent tokens, both pages
- LinkedIn: Developer app created, Community Management API pending review
- TikTok: PARKED
- Make.com: Free tier exhausted, no longer needed for Facebook
- Railway: Hobby plan ($5/mo), ready to deploy
