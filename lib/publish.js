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

// Smart publish — tries Facebook direct first, falls back to Make.com
async function publish(post) {
  if (post.platform === 'facebook' && getFbPage(post.brand)) {
    return publishToFacebook(post);
  }

  // Fall back to Make.com for other platforms or if no FB token
  if (MAKE_WEBHOOK_URL) {
    return publishToMake(post);
  }

  throw new Error(`No publishing method available for ${post.platform} — configure FB_PAGE_ACCESS_TOKEN or MAKE_WEBHOOK_URL`);
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

module.exports = { publish, publishToFacebook, publishToMake, publishBlogToFacebook };
