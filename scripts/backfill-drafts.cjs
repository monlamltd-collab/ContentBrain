// One-off backfill: any blog draft in BM (or AB) that wasn't announced
// to Telegram (because the CONTENTBRAIN_REVIEW_URL secret was wrong) gets
// re-POSTed to /api/review now that the URL is fixed. Idempotent re-run-safe;
// just shows you the same drafts in Telegram if you run it twice.
//
// Usage:  node scripts/backfill-drafts.cjs
// Reads creds from /tmp/cb-env.txt (KEY=VALUE per line).

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');

const path = require('path');
const envPath = path.join(__dirname, '..', '.tmp', 'cb-env.txt');
const env = {};
for (const line of fs.readFileSync(envPath, 'utf-8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2];
}

const REVIEW_URL = 'https://web-production-fa400.up.railway.app/api/review';
const REVIEW_KEY = env.REVIEW_API_KEY;
if (!REVIEW_KEY) { console.error('REVIEW_API_KEY missing'); process.exit(1); }

const projects = [
  {
    name: 'AuctionBrain (primary)',
    url: env.SUPABASE_URL,
    key: env.SUPABASE_ANON_KEY, // anon key for read-only listing
    brandFallback: 'auctionbrain',
  },
  {
    name: 'BridgeMatch (secondary)',
    url: env.SUPABASE_URL_BRIDGEMATCH,
    key: env.SUPABASE_SERVICE_KEY_BRIDGEMATCH,
    brandFallback: 'bridgematch',
  },
].filter(p => p.url && p.key);

(async () => {
  let totalSent = 0;
  let totalFailed = 0;

  for (const proj of projects) {
    console.log(`\n=== ${proj.name} ===`);
    const sb = createClient(proj.url, proj.key);
    const { data: drafts, error } = await sb
      .from('blog_posts')
      .select('id, title, summary, brand, post_type, evaluation_score, content')
      .eq('status', 'draft')
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) {
      console.error(`  Query failed: ${error.message}`);
      continue;
    }
    if (!drafts || drafts.length === 0) {
      console.log('  No drafts to backfill.');
      continue;
    }

    console.log(`  Found ${drafts.length} draft(s) — sending to Telegram via /api/review...`);
    for (const d of drafts) {
      const payload = {
        content_type: d.post_type === 'guide' ? 'guide' : 'blog',
        brand: d.brand || proj.brandFallback,
        source: 'backfill-' + new Date().toISOString().slice(0, 10),
        post_id: d.id,
        title: d.title,
        summary: (d.summary || (d.content || '').replace(/[#*_`]/g, '').slice(0, 200)),
        score: d.evaluation_score || null,
        word_count: ((d.content || '').match(/\S+/g) || []).length,
      };

      try {
        const res = await fetch(REVIEW_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${REVIEW_KEY}`,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          console.log(`  ✓ Sent: "${d.title}"`);
          totalSent++;
        } else {
          const body = await res.text();
          console.log(`  ✗ Failed (${res.status}): "${d.title}" — ${body.slice(0, 120)}`);
          totalFailed++;
        }
        // Tiny pacing so we don't blast Telegram and trip its rate limit.
        await new Promise(r => setTimeout(r, 600));
      } catch (e) {
        console.log(`  ✗ Error: "${d.title}" — ${e.message}`);
        totalFailed++;
      }
    }
  }

  console.log(`\n═══ DONE — sent ${totalSent}, failed ${totalFailed}. Check Telegram. ═══`);
})();
