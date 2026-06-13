require('dotenv').config();
const { generateBatch } = require('../lib/generate');
const { renderPost } = require('../lib/renderer');
const { renderVideo } = require('../lib/video-renderer');
const { insertPost } = require('../lib/supabase');
const { sendNotification } = require('../lib/telegram');

async function run() {
  console.log('\n=== ContentBrain — Generate Content ===\n');

  // Step 1: Generate copy for all 6 posts
  console.log('Step 1: Generating copy via Claude...');
  const posts = await generateBatch();
  console.log(`  Generated ${posts.length} posts\n`);

  // Step 2: Render graphics (PNG) + videos (MP4)
  console.log('Step 2: Rendering graphics + videos...');
  const savedPosts = [];
  for (const post of posts) {
    try {
      // Render static PNG
      const { filename } = await renderPost(post.template_type, post.brand, post);
      console.log(`  Rendered PNG: ${filename}`);

      // Render animated MP4 video
      let videoFilename = null;
      try {
        const video = await renderVideo(post.template_type, post.brand, post);
        videoFilename = video.filename;
        console.log(`  Rendered MP4: ${videoFilename}`);
      } catch (videoErr) {
        console.warn(`  Video render skipped for ${post.brand}/${post.template_type}: ${videoErr.message}`);
      }

      // Step 3: Store in Supabase
      const scheduledFor = getNextScheduleSlot(savedPosts.length);
      const meta = {};
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
      console.log(`  Saved: ${saved.id} (${post.brand}/${post.platform})`);
    } catch (err) {
      console.error(`  Error processing ${post.brand}/${post.template_type}: ${err.message}`);
    }
  }

  // Step 4: Telegram notification
  console.log('\nStep 3: Sending notification...');
  const brandCounts = savedPosts.reduce((acc, p) => {
    acc[p.brand] = (acc[p.brand] || 0) + 1;
    return acc;
  }, {});

  const summary = Object.entries(brandCounts)
    .map(([brand, count]) => `${brand}: ${count}`)
    .join(', ');

  await sendNotification(
    `<b>ContentBrain</b>\n\n${savedPosts.length} new posts ready for review.\n${summary}\n\nReview at your dashboard.`
  );

  console.log(`\nDone — ${savedPosts.length} posts queued as drafts.\n`);
}

// Schedule posts across the next few days
function getNextScheduleSlot(index) {
  const now = new Date();
  const daysAhead = Math.floor(index / 2); // 2 posts per day spread
  const hour = index % 2 === 0 ? 9 : 14; // 9am and 2pm slots
  const date = new Date(now);
  date.setDate(date.getDate() + daysAhead + 1);
  date.setHours(hour, 0, 0, 0);
  return date;
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
