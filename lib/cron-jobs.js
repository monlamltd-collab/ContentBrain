// lib/cron-jobs.js — every scheduled job in one place.
//
// Pure move out of server.js (decomposition step 3.2). registerCronJobs()
// registers all schedules; server.js calls it once at startup. runGenerate
// and runWeeklyReels are exported because /api/triggers/generate and the
// wake-recovery logic call them directly.
//
// Schedule map (UTC unless noted):
//   05:45        Reddit scraper (Firecrawl) → scraped_articles + briefs
//   06:30        Reddit brief promotion (belt-and-braces with the above)
//   06:30        social-engine audience snapshot
//   07:00        daily content generation (runGenerate)
//   07:00        Phase G daily social-engine post
//   08:00        social-engine breakout learner
//   08:00 Mon    weekly superlative reels (runWeeklyReels)
//   09:00 Mon-Fri (Europe/London)  outbound sequence advance
//   */15         publish approved posts
//   */30         wake recovery (generation + weekly reels)
//   */5          scheduled blog/guide publish + FB cross-post
//   04:00        social-engine stale-pending cleanup
//   20:00        Facebook insights collection

require('dotenv').config();
const cron = require('node-cron');
const { publish } = require('./publish');
const { sendNotification, sendPostForReview } = require('./telegram');
const { getApprovedPosts, updatePostStatus } = require('./supabase');

// Track last generation date to avoid duplicates after PC wake
let lastGenerateDate = null;

async function runGenerate({ force = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  if (!force && lastGenerateDate === today) {
    console.log(`[${new Date().toISOString()}] Cron: already generated today, skipping.`);
    return;
  }
  lastGenerateDate = today;

  console.log(`[${new Date().toISOString()}] Cron: generating content...`);
  try {
    const { generateBatch } = require('./generate');
    const { renderPost } = require('./renderer');
    const { renderVideo } = require('./video-renderer');
    const { insertPost } = require('./supabase');

    const posts = await generateBatch();
    const savedPosts = [];
    const failedSends = [];

    for (const post of posts) {
      try {
        const { filename } = await renderPost(post.template_type, post.brand, post);

        let videoFilename = null;
        try {
          const video = await renderVideo(post.template_type, post.brand, post);
          videoFilename = video.filename;
        } catch (videoErr) {
          console.warn(`  Video render skipped: ${videoErr.message}`);
        }

        const daysAhead = Math.floor(savedPosts.length / 2);
        const hour = savedPosts.length % 2 === 0 ? 9 : 14;
        const scheduledFor = new Date();
        scheduledFor.setDate(scheduledFor.getDate() + daysAhead + 1);
        scheduledFor.setHours(hour, 0, 0, 0);

        // meta carries generation-time fields (hook_pattern, cta_pattern,
        // author) so future generations can rotate properly and the
        // admin can chart pattern-/author-level performance once
        // Facebook insights have caught up.
        const meta = {};
        if (post.hook_pattern) meta.hook_pattern = post.hook_pattern;
        if (post.cta_pattern) meta.cta_pattern = post.cta_pattern;
        if (post.author) meta.author = post.author;
        if (post.visual_style) meta.visual_style = post.visual_style;
        if (post.duration_seconds) meta.duration_seconds = post.duration_seconds;

        const saved = await insertPost({
          brand: post.brand,
          platform: post.platform,
          template_type: post.template_type,
          copy_headline: post.copy_headline,
          copy_body: post.copy_body,
          copy_cta: post.copy_cta,
          image_url: filename,
          video_url: videoFilename,
          status: 'draft',
          scheduled_for: scheduledFor.toISOString(),
          meta
        });

        savedPosts.push(saved);

        // Send to Telegram with video preview + approve/reject buttons
        const result = await sendPostForReview(saved);
        if (!result.ok) {
          failedSends.push({ id: saved.id, error: result.error });
        }
      } catch (err) {
        console.error(`  Error processing ${post.brand}/${post.template_type}: ${err.message}`);
      }
    }

    const msg = `${savedPosts.length} posts generated` +
      (failedSends.length ? ` (${failedSends.length} failed to send to Telegram)` : '');
    console.log(`[${new Date().toISOString()}] Cron: ${msg}`);

    // If any Telegram sends failed, send a summary notification
    if (failedSends.length) {
      await sendNotification(`Generated ${savedPosts.length} posts but ${failedSends.length} failed to send previews. Check the review UI to approve them.`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron generate error:`, err.message);
    await sendNotification(`Content generation failed: ${err.message}`);
  }
}

let lastWeeklyReelsWeek = null;

// Monday's ISO date (yyyy-mm-dd) for the current week — the "have we run this
// week" key, so a PC asleep over the weekend still gets one run per week.
function currentWeekKey(d = new Date()) {
  const x = new Date(d);
  const monOffset = (x.getDay() + 6) % 7; // 0=Mon .. 6=Sun
  x.setDate(x.getDate() - monOffset);
  return x.toISOString().slice(0, 10);
}

async function runWeeklyReels({ force = false } = {}) {
  const wk = currentWeekKey();
  if (!force && lastWeeklyReelsWeek === wk) {
    console.log(`[${new Date().toISOString()}] Weekly reels: already run this week, skipping.`);
    return;
  }
  lastWeeklyReelsWeek = wk;
  try {
    const { runWeeklySuperlatives } = require('./lot-flow');
    await runWeeklySuperlatives();
  } catch (err) {
    lastWeeklyReelsWeek = null; // allow a retry on the next wake-recovery tick
    console.error(`[${new Date().toISOString()}] Weekly reels cron error: ${err.message}`);
    try {
      await sendNotification(`<b>Weekly reels cron failed:</b> ${err.message.slice(0, 200)}`);
    } catch {}
  }
}

function registerCronJobs() {
// Generate new content daily at 7am (with wake-up resilience)
cron.schedule('0 7 * * *', runGenerate);

// Promote high-engagement Reddit threads to briefs daily at 06:30 UTC,
// 30 minutes before the content engines kick off — so any newly-promoted
// briefs are picked up by that day's generation runs.
cron.schedule('30 6 * * *', async () => {
  try {
    const { promoteRedditThreadsToBriefs } = require('./reddit-briefs');
    const result = await promoteRedditThreadsToBriefs();
    console.log(`[cron:reddit-briefs] ${result.promoted} promoted, ${result.evaluated} evaluated (${result.reason})`);
  } catch (err) {
    console.warn('[cron:reddit-briefs] failed:', err.message);
  }
});

// Reddit scraper — 05:45 UTC, before the 06:30 brief promotion and the
// 07:00 generation window. Firecrawl-extracts top weekly threads from the
// property/broker/bridging/solicitor subreddit list (lever-tunable) into
// scraped_articles; runRedditScrape also promotes immediately, so the
// 06:30 cron is belt-and-braces for anything it misses.
cron.schedule('45 5 * * *', async () => {
  try {
    const { runRedditScrape } = require('./reddit-scraper');
    const result = await runRedditScrape();
    console.log(`[cron:reddit-scraper] ${JSON.stringify(result)}`);
    if (result.errors && result.errors.length >= 3) {
      await sendNotification(`<b>Reddit scraper</b>: ${result.inserted} inserted, ${result.errors.length} errors — check logs.`).catch(() => {});
    }
  } catch (err) {
    console.warn('[cron:reddit-scraper] failed:', err.message);
    await sendNotification(`<b>Reddit scraper failed</b>: ${err.message.slice(0, 200)}`).catch(() => {});
  }
});

// Check on wake — if we missed today's generation, run it now
cron.schedule('*/30 * * * *', async () => {
  const today = new Date().toISOString().slice(0, 10);
  const hour = new Date().getHours();
  if (hour >= 7 && lastGenerateDate !== today) {
    console.log(`[${new Date().toISOString()}] Wake recovery: missed today's generation, running now...`);
    await runGenerate();
  }
});
// Outbound sequence advance — every weekday at 09:00 London time. Mon-Fri
// only avoids weekend sends (deliverability hit + bot-shaped); 09:00 lands
// in UK working hours rather than the spam-coded 07:00 / 18:00 windows. The
// `timezone` option handles BST/GMT switchovers automatically — `0 9 * * 1-5`
// in UTC would be an hour late in summer, so always use the option, not the
// expression. Researcher's full rationale: .ruflo/phase-c-design.md §2.
//
// Per-tick semantics: getDueSequences() returns rows where status='active'
// AND next_scheduled_at <= now() AND current_step < MAX_STEP, ordered ASC
// on next_scheduled_at so older-due rows go first. advanceSequence handles
// the warming-cap defer and the Telegram approval queue — this cron is just
// the trigger. See lib/sequence.js for the rest.
cron.schedule('0 9 * * 1-5', async () => {
  try {
    const seq = require('./sequence');
    const due = await seq.getDueSequences();
    if (!due.length) {
      console.log(`[${new Date().toISOString()}] Cron seq-advance: no due sequences`);
      return;
    }
    console.log(`[${new Date().toISOString()}] Cron seq-advance: ${due.length} due sequence(s)`);
    for (const row of due) {
      try {
        await seq.advanceSequence(row.id);
      } catch (err) {
        console.error(`  seq-advance ${row.id} (step ${row.current_step}) failed: ${err.message}`);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron seq-advance error:`, err.message);
  }
}, { timezone: 'Europe/London' });

// Publish approved posts every 15 minutes
cron.schedule('*/15 * * * *', async () => {
  try {
    const posts = await getApprovedPosts();
    if (!posts.length) return;

    console.log(`[${new Date().toISOString()}] Cron: publishing ${posts.length} approved posts...`);
    for (const post of posts) {
      try {
        const result = await publish(post);
        // Outbound (Resend) path owns its own status writes inside publishToResend —
        // 'suppressed' on a block, no write on a deferred (warming/paused). Only
        // mark 'published' here when publish actually delivered (social path or
        // a clean outbound send).
        if (result.suppressed) {
          console.log(`  Skipped: ${post.id} (${post.brand}) — already marked suppressed`);
        } else if (result.deferred) {
          console.log(`  Deferred: ${post.id} (${post.brand}/${post.track || ''}) — ${result.reason}; cron retries next tick`);
        } else {
          await updatePostStatus(post.id, 'published');
          // Store Facebook post ID for insights tracking
          if (result.postId) {
            const { supabase } = require('./supabase');
            // Supabase query builder isn't a real Promise — .catch() before await throws TypeError
            try {
              await supabase.from('posts').update({ fb_post_id: result.postId }).eq('id', post.id);
            } catch (e) { console.warn(`  fb_post_id save failed: ${e.message}`); }
          }

          // Phase G — boost hook. Only fires for social-track posts that the
          // orchestrator marked boost_eligible. Wrapped in try/catch: a boost
          // row failure must NOT roll back the publish — the post is already
          // live on FB and this is a best-effort paid amplification. Skip
          // for outbound and any non-social track.
          if (post.track === 'social' && post.meta && post.meta.boost_eligible === true && result.postId) {
            try {
              const { requestBoost } = require('./social-engine/boost');
              await requestBoost(post, result.postId);
            } catch (err) {
              // Phase G-3 — surface boost-hook failures to Telegram so the
              // operator notices when Make is paused / unreachable.
              // Phase G-4 — wrap via alertThrottled so a bursty outage
              // (10 failures in 15min) sends 3 alerts + 1 summary instead
              // of 10 separate messages. See .ruflo/phase-g4-design.md §4.3.
              console.warn(`  [boost] hook failed for ${post.id}: ${err.message}`);
              try {
                const { alertThrottled } = require('./social-engine/telegram-throttle');
                await alertThrottled('boost-hook-failed', post.id, () =>
                  `Boost request failed for post ${post.id}: ${err.message.slice(0, 200)}`);
              } catch (_) { /* swallow — Telegram outage must not break publish */ }
            }
          }

          console.log(`  Published: ${post.id} (${post.brand}/${post.platform || post.channel || 'n/a'}) ref:${result.postId || result.resendId || 'n/a'}`);
        }
      } catch (err) {
        console.error(`  Error publishing ${post.id}: ${err.message}`);
        // Notify on publish failure so it doesn't silently fail
        await sendNotification(`Failed to publish ${post.brand}/${post.template_type}: ${err.message.slice(0, 100)}`);
      }
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Cron publish error:`, err.message);
  }
});

// Phase G-4 — boost_runs stale-pending cleanup. 04:00 UTC daily, well
// before any other social-engine cron (06:00 reconcile, 06:30 audience,
// 08:00 learner, 09:00 BST publish). Marks rows pending > 24h as failed
// with meta.ended_reason='make_no_callback'. See .ruflo/phase-g4-design.md §3.
cron.schedule('0 4 * * *', async () => {
  try {
    const { reconcileStalePending } = require('./social-engine/cleanup');
    const result = await reconcileStalePending();
    if (result.aged_out > 0) {
      console.log(`[${new Date().toISOString()}] Stale-pending cleanup: aged_out=${result.aged_out}`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Stale-pending cleanup error:`, err.message);
  }
}, { timezone: 'UTC' });

// Phase G-3 — daily audience snapshot cron. 06:30 UTC = strictly AFTER the
// Make reconcile scenario fires at 06:00 UTC, so PR4's dashboard rows for
// social_audience_daily + boost_runs align same-morning. UTC (not
// Europe/London) so DST changes never shift the slot. See
// .ruflo/phase-g3-design.md §2.3 for rationale.
cron.schedule('30 6 * * *', async () => {
  try {
    const { runDailyAudienceSnapshot } = require('./social-engine/audience');
    await runDailyAudienceSnapshot();
  } catch (err) {
    // runDailyAudienceSnapshot should never throw (it catches per-brand
    // and surfaces Telegram alerts itself). Belt-and-braces — log here too.
    console.error(`[${new Date().toISOString()}] Cron audience-snapshot error:`, err.message);
  }
}, { timezone: 'UTC' });

// Phase G-4 — nightly breakout learner. 08:00 UTC = after Make reconcile
// (06:00) + audience snapshot (06:30) and before the 09:00 BST publish
// cron, so isBreakoutActive() / getBreakoutTags() pick up today's fresh
// signal. See .ruflo/phase-g4-design.md §1.7.
cron.schedule('0 8 * * *', async () => {
  try {
    const { runBreakoutLearner } = require('./social-engine/learner');
    const result = await runBreakoutLearner();
    console.log(`[${new Date().toISOString()}] Breakout learner: ${JSON.stringify(result)}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Breakout learner error:`, err.message);
    try {
      await sendNotification(`<b>Breakout learner cron failed:</b> ${err.message.slice(0, 200)}`);
    } catch (_) { /* Telegram outage must not cascade */ }
  }
}, { timezone: 'UTC' });

// Scheduled-publish cron — every 5 minutes, promote any blog/guide whose
// scheduled_for has arrived to status='published'. Runs against BOTH the
// primary Supabase project AND the optional bridgematch project so that
// posts in either project flip on time.
cron.schedule('*/5 * * * *', async () => {
  const nowIso = new Date().toISOString();
  const { supabase, supabaseBridgematch } = require('./supabase');
  const clients = [
    { name: 'primary', client: supabase },
    ...(supabaseBridgematch ? [{ name: 'bridgematch', client: supabaseBridgematch }] : [])
  ];

  for (const { name, client } of clients) {
    try {
      // Two cases publish:
      //   1. status='approved' AND scheduled_for IS NULL   (= "approve now",
      //      no specific time chosen — most Telegram approvals)
      //   2. status='approved' AND scheduled_for <= now    (= delayed schedule)
      //
      // Previously this only handled case 2, so case-1 posts sat in 'approved'
      // forever. We tried .or('scheduled_for.is.null,scheduled_for.lte.<iso>')
      // but the ISO timestamp's colons/dots tripped PostgREST's filter parser
      // (returned "column does not exist"). Two separate updates are reliable.

      const allPublished = [];

      // Case 1: approved + no schedule → publish immediately
      const r1 = await client
        .from('blog_posts')
        .update({ status: 'published', published_at: nowIso })
        .eq('status', 'approved')
        .is('scheduled_for', null)
        .select('id, title, brand, slug, summary, image_url, fb_post_id');
      if (r1.error) {
        console.error(`[scheduled-publish:${name}] no-schedule update error: ${r1.error.message}`);
      } else if (r1.data?.length) {
        allPublished.push(...r1.data);
      }

      // Case 2: approved + scheduled time has passed
      const r2 = await client
        .from('blog_posts')
        .update({ status: 'published', published_at: nowIso })
        .eq('status', 'approved')
        .lte('scheduled_for', nowIso)
        .select('id, title, brand, slug, summary, image_url, fb_post_id');
      if (r2.error) {
        console.error(`[scheduled-publish:${name}] scheduled update error: ${r2.error.message}`);
      } else if (r2.data?.length) {
        allPublished.push(...r2.data);
      }

      if (allPublished.length) {
        console.log(`[scheduled-publish:${name}] published ${allPublished.length} blog/guide post(s):`);
        const { publishBlogToFacebook } = require('./publish');
        for (const p of allPublished) {
          console.log(`  - ${p.brand || '?'}: ${p.title}`);
          try {
            await sendNotification(`<b>Published</b> (${p.brand || 'unknown'}): ${p.title}`);
          } catch {}

          // Cross-post to the brand's Facebook Page. Best-effort: a Facebook outage
          // must not roll back the blog publish. Skip if already cross-posted (re-runs).
          if (p.fb_post_id || !p.slug || !p.brand) continue;
          try {
            const result = await publishBlogToFacebook(p);
            if (result?.postId) {
              await client.from('blog_posts').update({ fb_post_id: result.postId }).eq('id', p.id);
              console.log(`  [scheduled-publish:${name}] FB cross-post ok: ${p.brand}/${p.id} → ${result.postId}`);
            }
          } catch (err) {
            console.error(`[scheduled-publish:${name}] FB cross-post failed for ${p.id}: ${err.message}`);
            try {
              await sendNotification(`<b>FB cross-post failed</b> (${p.brand}): ${p.title} — ${err.message.slice(0, 80)}`);
            } catch {}
          }
        }
      }
    } catch (err) {
      console.error(`[scheduled-publish:${name}] cron error: ${err.message}`);
    }
  }
});

// Collect Facebook insights daily at 8pm (gives posts time to accumulate engagement)
cron.schedule('0 20 * * *', async () => {
  try {
    const { collectInsights } = require('./insights');
    const result = await collectInsights();
    if (result.fetched > 0) {
      console.log(`[${new Date().toISOString()}] Insights: fetched metrics for ${result.fetched}/${result.total} posts`);
    }
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Insights cron error: ${err.message}`);
  }
});

// Phase G — Daily social-engine post at 07:00 UTC.
//
// Replaces the previous runLotOfTheDay() cron. The new orchestrator
// chooses today's mode + type, and when type === 'lot-of-day-traffic' it
// DELEGATES back to runLotOfTheDay verbatim — so the existing voice-memo
// workflow still works for that archetype. For every other type it picks,
// renders, inserts a draft, and sends to Telegram for review.
//
// Phase G social-engine — daily post cron at 07:00 UTC.
// Originally muted pending HLP compliance pre-flight (architecture Part 12),
// but unregulated property/auction content sits outside HLP's authorisation
// perimeter — no compliance gate is required. Unmuted 2026-05-31.
// SOCIAL_BANS + outbound-filters remain active as voice + quality protection.
cron.schedule('0 7 * * *', async () => {
  try {
    const { runDailySocialPost } = require('./social-engine/orchestrator');
    await runDailySocialPost();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Phase G cron error: ${err.message}`);
    try {
      await sendNotification(`<b>Phase G social-engine cron failed:</b> ${err.message.slice(0, 200)}`);
    } catch {}
  }
});

// ── WEEKLY SUPERLATIVE REELS ──
// Monday 08:00 — generate the five "X of the week" auction reels (cheapest,
// most expensive, best deal, biggest discount, worst lot), render them
// music-only, and send each for Telegram approval. They publish staggered
// one per weekday via the */15 approved-posts cron above.
cron.schedule('0 8 * * 1', runWeeklyReels);

// Wake recovery — if it's Mon/Tue past 08:00 and we haven't run this week, run now.
cron.schedule('*/30 * * * *', async () => {
  const now = new Date();
  const day = now.getDay(); // 0=Sun, 1=Mon, 2=Tue
  if ((day === 1 || day === 2) && now.getHours() >= 8 && lastWeeklyReelsWeek !== currentWeekKey()) {
    console.log(`[${now.toISOString()}] Wake recovery: missed this week's reels, running now...`);
    await runWeeklyReels();
  }
});
}

module.exports = { registerCronJobs, runGenerate, runWeeklyReels };
