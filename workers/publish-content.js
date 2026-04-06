require('dotenv').config();
const { getApprovedPosts, updatePostStatus } = require('../lib/supabase');
const { publishToMake } = require('../lib/publish');

async function run() {
  console.log('\n=== ContentBrain — Publish Content ===\n');

  // Step 1: Get approved posts due for publishing
  const posts = await getApprovedPosts();
  if (!posts.length) {
    console.log('No approved posts due for publishing.\n');
    return;
  }

  console.log(`Found ${posts.length} approved posts to publish.\n`);

  // Step 2: Send each post to Make webhook
  let published = 0;
  for (const post of posts) {
    try {
      await publishToMake(post);
      await updatePostStatus(post.id, 'published');
      published++;
      console.log(`  Published: ${post.id} (${post.brand}/${post.platform})`);
    } catch (err) {
      console.error(`  Error publishing ${post.id}: ${err.message}`);
    }
  }

  console.log(`\nDone — ${published}/${posts.length} posts published.\n`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
