require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { uploadMedia } = require('./supabase');

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Per-brand Facebook credentials
const FB_PAGES = {
  auctionbrain: {
    id: process.env.FB_PAGE_ID,
    token: process.env.FB_PAGE_ACCESS_TOKEN
  },
  bridgematch: {
    id: process.env.FB_BRIDGEMATCH_PAGE_ID,
    token: process.env.FB_BRIDGEMATCH_PAGE_TOKEN
  }
};

function getFbPage(brand) {
  const page = FB_PAGES[brand] || FB_PAGES.auctionbrain;
  if (!page.id || !page.token) return null;
  return page;
}

// Post directly to Facebook Graph API — no Make.com dependency
async function publishToFacebook(post) {
  const page = getFbPage(post.brand);
  if (!page) {
    throw new Error(`No Facebook credentials for ${post.brand} — add to .env`);
  }

  // Lot-of-day posts pre-build the caption in lot-content.js and stash it on
  // post.meta. Generic social posts use the assembled copy_* fields.
  const caption = (post.meta && post.meta.caption_facebook)
    ? post.meta.caption_facebook
    : [post.copy_headline, post.copy_body, post.copy_cta].filter(Boolean).join('\n\n');

  // Video post
  if (post.video_url) {
    const videoPath = path.join(OUTPUT_DIR, post.video_url);
    if (fs.existsSync(videoPath)) {
      // Reels must publish via /video_reels to get reel placement, reach and
      // monetization. The /videos endpoint posts a normal feed video, not a reel.
      if (post.meta && post.meta.is_reel) {
        return publishReelToFacebook(page, videoPath, caption, post.brand);
      }
      const form = new FormData();
      form.append('access_token', page.token);
      form.append('description', caption);
      form.append('source', new Blob([fs.readFileSync(videoPath)]), post.video_url);

      const res = await fetch(`https://graph-video.facebook.com/v22.0/${page.id}/videos`, {
        method: 'POST',
        body: form
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Facebook video upload failed (${res.status}): ${err.slice(0, 300)}`);
      }

      const data = await res.json();
      console.log(`  [Facebook] Video posted to ${post.brand}: ${data.id}`);
      return { ok: true, platform: 'facebook', postId: data.id };
    }
  }

  // Image post
  if (post.image_url) {
    const imagePath = path.join(OUTPUT_DIR, post.image_url);
    if (fs.existsSync(imagePath)) {
      const form = new FormData();
      form.append('access_token', page.token);
      form.append('message', caption);
      form.append('source', new Blob([fs.readFileSync(imagePath)]), post.image_url);

      const res = await fetch(`https://graph.facebook.com/v22.0/${page.id}/photos`, {
        method: 'POST',
        body: form
      });

      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Facebook photo upload failed (${res.status}): ${err.slice(0, 300)}`);
      }

      const data = await res.json();
      console.log(`  [Facebook] Photo posted to ${post.brand}: ${data.id || data.post_id}`);
      return { ok: true, platform: 'facebook', postId: data.id || data.post_id };
    }
  }

  // Text-only fallback
  const res = await fetch(`https://graph.facebook.com/v22.0/${page.id}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: page.token,
      message: caption
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook text post failed (${res.status}): ${err.slice(0, 300)}`);
  }

  const data = await res.json();
  console.log(`  [Facebook] Text posted to ${post.brand}: ${data.id}`);
  return { ok: true, platform: 'facebook', postId: data.id };
}

// Publish a vertical video as a proper Facebook Reel via the 3-step
// /video_reels upload protocol (start -> upload binary -> finish). The plain
// /videos endpoint does NOT create a reel, so it gets no reel placement, reel
// reach or monetization — this path is required for the weekly auction reels.
async function publishReelToFacebook(page, videoPath, caption, brand) {
  // Step 1 — initialise the upload session.
  const startBody = new URLSearchParams({ upload_phase: 'start', access_token: page.token });
  const startRes = await fetch(`https://graph.facebook.com/v22.0/${page.id}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: startBody.toString()
  });
  if (!startRes.ok) {
    throw new Error(`Reels start failed (${startRes.status}): ${(await startRes.text()).slice(0, 300)}`);
  }
  const startData = await startRes.json();
  const videoId = startData.video_id;
  const uploadUrl = startData.upload_url;
  if (!videoId || !uploadUrl) {
    throw new Error(`Reels start returned no video_id/upload_url: ${JSON.stringify(startData).slice(0, 200)}`);
  }

  // Step 2 — upload the video binary to the returned rupload URL.
  const videoBuffer = fs.readFileSync(videoPath);
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: `OAuth ${page.token}`,
      offset: '0',
      file_size: String(videoBuffer.length)
    },
    body: videoBuffer
  });
  if (!uploadRes.ok) {
    throw new Error(`Reels binary upload failed (${uploadRes.status}): ${(await uploadRes.text()).slice(0, 300)}`);
  }
  const uploadData = await uploadRes.json().catch(() => ({}));
  if (uploadData.success === false) {
    throw new Error(`Reels binary upload rejected: ${JSON.stringify(uploadData).slice(0, 200)}`);
  }

  // Step 3 — finish: publish the reel now.
  const finishBody = new URLSearchParams({
    access_token: page.token,
    video_id: videoId,
    upload_phase: 'finish',
    video_state: 'PUBLISHED',
    description: caption
  });
  const finishRes = await fetch(`https://graph.facebook.com/v22.0/${page.id}/video_reels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: finishBody.toString()
  });
  if (!finishRes.ok) {
    throw new Error(`Reels finish failed (${finishRes.status}): ${(await finishRes.text()).slice(0, 300)}`);
  }
  const finishData = await finishRes.json().catch(() => ({}));
  if (finishData.success === false) {
    throw new Error(`Reels finish rejected: ${JSON.stringify(finishData).slice(0, 200)}`);
  }

  console.log(`  [Facebook] Reel published to ${brand}: ${videoId}`);
  return { ok: true, platform: 'facebook', postId: videoId };
}

// Legacy Make.com webhook — kept as fallback
async function publishToMake(post) {
  if (!MAKE_WEBHOOK_URL) {
    throw new Error('MAKE_WEBHOOK_URL not configured');
  }

  const caption = [post.copy_headline, post.copy_body, post.copy_cta]
    .filter(Boolean)
    .join('\n\n');

  let imageBase64 = null;
  if (post.image_url) {
    const imagePath = path.join(OUTPUT_DIR, post.image_url);
    if (fs.existsSync(imagePath)) {
      imageBase64 = fs.readFileSync(imagePath).toString('base64');
    }
  }

  let videoPublicUrl = null;
  if (post.video_url) {
    const videoPath = path.join(OUTPUT_DIR, post.video_url);
    if (fs.existsSync(videoPath)) {
      videoPublicUrl = await uploadMedia(videoPath, post.video_url);
      console.log(`  Uploaded video: ${videoPublicUrl}`);
    }
  }

  const hasVideo = !!videoPublicUrl;
  const isReel = hasVideo && post.template_type === 'reel';

  const payload = {
    id: post.id,
    brand: post.brand,
    platform: post.platform,
    template_type: post.template_type,
    caption,
    headline: post.copy_headline,
    body: post.copy_body,
    cta: post.copy_cta,
    has_video: hasVideo,
    is_reel: isReel,
    image_filename: post.image_url,
    image_base64: imageBase64,
    video_url: videoPublicUrl
  };

  const res = await fetch(MAKE_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Make webhook failed (${res.status}): ${err.slice(0, 200)}`);
  }

  return { ok: true, platform: post.platform };
}

// Smart publish — tries Facebook direct first, falls back to Make.com.
//
// Outbound posts (track='outbound', channel='resend' — see migration 008)
// take the Resend branch via publishToResend(). The router dispatches on
// channel for outbound and on platform for social so the existing social
// flow is untouched.
async function publish(post) {
  if (post.channel === 'resend' || post.track === 'outbound') {
    return publishToResend(post);
  }

  if (post.platform === 'facebook' && getFbPage(post.brand)) {
    return publishToFacebook(post);
  }

  // Fall back to Make.com for other platforms or if no FB token
  if (MAKE_WEBHOOK_URL) {
    return publishToMake(post);
  }

  throw new Error(`No publishing method available for ${post.platform} — configure FB_PAGE_ACCESS_TOKEN or MAKE_WEBHOOK_URL`);
}

// ── RESEND BRANCH (Phase B) ───────────────────────────────────────────────
//
// Outbound emails generated by lib/generate.generateOutbound are persisted
// as posts with track='outbound', channel='resend'. After human approval in
// Telegram, server.js calls publish(post) which lands here.
//
// publishToResend is a thin adapter: it pulls the right contact/from-address
// from post.meta, calls lib/resend.sendOutbound, and stashes the resulting
// Resend message id back on post.meta so webhook events can be matched up.
// Suppression + filter checks have ALREADY run by this point (Telegram
// approval is the human gate); this function does NOT re-check them. If a
// belt-and-braces safety net is wanted, add isSuppressed(to) at the top —
// coder's call.
// Per-track from-address. Defaults can be overridden via env so the dedicated
// outbound subdomain (e.g. outreach.bridgematch.co.uk) doesn't have to be
// hard-coded. Lender = BridgeMatch; auction_house = AuctionBrain; broker
// also BridgeMatch.
const RESEND_FROM = {
  lender:        process.env.RESEND_FROM_LENDER       || 'Simon at BridgeMatch <outreach@outreach.bridgematch.co.uk>',
  broker:        process.env.RESEND_FROM_BROKER       || 'Simon at BridgeMatch <outreach@outreach.bridgematch.co.uk>',
  auction_house: process.env.RESEND_FROM_AUCTION_HOUSE || 'Simon at AuctionBrain <outreach@outreach.auctionbrain.co.uk>',
};

async function publishToResend(post) {
  // Lazy requires — keeps Resend env-validation cost off the social cron path.
  const { sendOutbound } = require('./resend');
  const { isSuppressed } = require('./suppression');
  const { supabase } = require('./supabase');

  const meta = (post && post.meta) || {};
  const track = (meta.track || post.track || 'lender').toLowerCase();
  const to = meta.contact_email || meta.to;
  const subject = post.copy_headline;
  const body = post.copy_body;

  if (!to)      throw new Error(`publishToResend: post.meta.contact_email is required (post ${post.id})`);
  if (!subject) throw new Error(`publishToResend: post.copy_headline is required (post ${post.id})`);
  if (!body)    throw new Error(`publishToResend: post.copy_body is required (post ${post.id})`);

  const from = RESEND_FROM[track] || RESEND_FROM.lender;

  // Pre-flight suppression check. If suppressed, mark the post status
  // 'suppressed' + stash the reason on meta and return — this is NOT a
  // code failure (it's the system working as designed), so don't throw.
  const supp = await isSuppressed(to);
  if (supp.suppressed) {
    console.warn(`[publishToResend] suppressed ${to} (${supp.level} match '${supp.match}': ${supp.reason}); post ${post.id} marked suppressed`);
    const newMeta = {
      ...meta,
      suppression_reason: supp.reason,
      suppression_match: supp.match,
      suppression_level: supp.level,
    };
    const { error: updErr } = await supabase
      .from('posts')
      .update({ status: 'suppressed', meta: newMeta })
      .eq('id', post.id);
    if (updErr) {
      // Updating the status failed, but the send was correctly blocked —
      // log loudly and return ok so the caller doesn't retry-send.
      console.error(`[publishToResend] failed to mark post ${post.id} suppressed: ${updErr.message}`);
    }
    return { ok: true, channel: 'resend', suppressed: true, reason: supp.reason };
  }

  // Send.
  let result;
  try {
    result = await sendOutbound({
      to,
      from,
      subject,
      body,
      replyTo: from,
    });
  } catch (err) {
    // Race: contact got added to suppression between our pre-flight and
    // sendOutbound's own check. Treat exactly like the pre-flight case.
    if (err.message && err.message.startsWith('Suppressed: ')) {
      console.warn(`[publishToResend] race-suppressed ${to}: ${err.message}`);
      const newMeta = { ...meta, suppression_reason: 'race_post_preflight', suppression_error: err.message };
      await supabase.from('posts').update({ status: 'suppressed', meta: newMeta }).eq('id', post.id).then(() => {}, () => {});
      return { ok: true, channel: 'resend', suppressed: true, reason: 'race_post_preflight' };
    }
    throw err;
  }

  // Persist the resend_id and mark published.
  const newMeta = { ...meta, resend_id: result.id };
  const { error: updErr } = await supabase
    .from('posts')
    .update({
      status: 'published',
      published_at: new Date().toISOString(),
      meta: newMeta,
    })
    .eq('id', post.id);
  if (updErr) {
    console.error(`[publishToResend] post ${post.id} sent (resend_id=${result.id}) but DB update failed: ${updErr.message}`);
    // Send already happened; surface the DB error so the caller can decide.
    throw new Error(`Post ${post.id} sent but DB update failed: ${updErr.message}`);
  }

  console.log(`[publishToResend] published post ${post.id} -> ${to} (resend_id=${result.id})`);
  return { ok: true, channel: 'resend', resendId: result.id };
}

const BRAND_BLOG_URL = {
  auctionbrain: 'https://www.auctionbrain.co.uk/blog',
  bridgematch: 'https://bridgematch.co.uk/blog'
};

// Cross-post a published blog post to the brand's Facebook Page.
// Used by the scheduled-publish cron in server.js after a blog flips to status='published'.
async function publishBlogToFacebook(blog) {
  const page = getFbPage(blog.brand);
  if (!page) {
    throw new Error(`No Facebook credentials for ${blog.brand} — add to .env`);
  }

  const blogRoot = BRAND_BLOG_URL[blog.brand] || BRAND_BLOG_URL.auctionbrain;
  const url = `${blogRoot}/${blog.slug}`;
  const caption = [
    `New on the blog: ${blog.title}`,
    blog.summary || '',
    `Read more → ${url}`
  ].filter(Boolean).join('\n\n');

  // If the blog has a remote image, FB's `url=` param fetches it server-side — no local file needed.
  if (blog.image_url && /^https?:\/\//i.test(blog.image_url)) {
    const params = new URLSearchParams();
    params.append('access_token', page.token);
    params.append('message', caption);
    params.append('url', blog.image_url);

    const res = await fetch(`https://graph.facebook.com/v22.0/${page.id}/photos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });

    if (res.ok) {
      const data = await res.json();
      console.log(`  [Facebook] Blog photo posted to ${blog.brand}: ${data.id || data.post_id}`);
      return { ok: true, postId: data.id || data.post_id };
    }

    const err = await res.text();
    console.warn(`  [Facebook] Blog photo failed (${res.status}); falling back to link post: ${err.slice(0, 150)}`);
  }

  // Text + link — FB auto-generates a link preview card.
  const res = await fetch(`https://graph.facebook.com/v22.0/${page.id}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      access_token: page.token,
      message: caption,
      link: url
    })
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Facebook blog cross-post failed (${res.status}): ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  console.log(`  [Facebook] Blog link posted to ${blog.brand}: ${data.id}`);
  return { ok: true, postId: data.id };
}

module.exports = { publish, publishToFacebook, publishReelToFacebook, publishToMake, publishBlogToFacebook, publishToResend };
