const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { brands, getDimensions } = require('./config');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Resolve a template file path. Phase G social-engine templates live under
// templates/social-engine/<name>.html — accept the prefixed form so the
// existing 4 templates (stat / hook / list / reel) keep working unchanged.
function resolveTemplatePath(templateType) {
  // Existing flat templates
  const flat = path.join(TEMPLATES_DIR, `${templateType}.html`);
  if (fs.existsSync(flat)) return flat;
  // Nested e.g. 'social-engine/niche-hook'
  if (templateType.includes('/')) {
    const nested = path.join(TEMPLATES_DIR, `${templateType}.html`);
    if (fs.existsSync(nested)) return nested;
  }
  // Default to flat path — buildHtml will surface the readFileSync error.
  return flat;
}

// Load template HTML and replace placeholders
function buildHtml(templateType, brand, post) {
  const brandConfig = brands[brand];
  const { colours, fonts } = brandConfig;
  const dims = getDimensions(templateType, post.platform || 'facebook');

  let html = fs.readFileSync(resolveTemplatePath(templateType), 'utf8');

  // Dimension placeholders
  html = html.replace(/\{\{WIDTH\}\}/g, dims.width);
  html = html.replace(/\{\{HEIGHT\}\}/g, dims.height);

  // Colour placeholders
  html = html.replace(/\{\{NAVY\}\}/g, colours.navy);
  html = html.replace(/\{\{GREEN\}\}/g, colours.green);
  html = html.replace(/\{\{CREAM\}\}/g, colours.cream);
  html = html.replace(/\{\{RED\}\}/g, colours.red || '#C0392B');

  // Font placeholders
  html = html.replace(/\{\{HEADING_FONT\}\}/g, fonts.heading);
  html = html.replace(/\{\{BODY_FONT\}\}/g, fonts.body);

  // Content placeholders
  html = html.replace(/\{\{HEADLINE\}\}/g, escapeHtml(post.copy_headline || ''));
  html = html.replace(/\{\{BODY\}\}/g, escapeHtml(post.copy_body || ''));
  html = html.replace(/\{\{CTA\}\}/g, escapeHtml(post.copy_cta || ''));

  // Dynamic font sizing based on text length
  const headlineLen = (post.copy_headline || '').length;
  if (templateType === 'stat') {
    const statSize = headlineLen > 20 ? 72 : headlineLen > 10 ? 96 : 120;
    html = html.replace(/\{\{STAT_SIZE\}\}/g, statSize);
  }
  if (templateType === 'hook') {
    const hlSize = headlineLen > 60 ? 40 : headlineLen > 40 ? 48 : 56;
    html = html.replace(/\{\{HEADLINE_SIZE\}\}/g, hlSize);
  }
  if (templateType === 'list') {
    const titleSize = headlineLen > 40 ? 36 : 44;
    html = html.replace(/\{\{TITLE_SIZE\}\}/g, titleSize);

    // Build list items from body (split on newlines or bullet markers)
    const items = (post.copy_body || '').split(/\n|•|·/).map(s => s.trim()).filter(Boolean);
    const listHtml = items.map(item =>
      `<div class="list-item"><div class="marker"></div><div class="item-text">${escapeHtml(item)}</div></div>`
    ).join('\n    ');
    html = html.replace(/\{\{LIST_ITEMS\}\}/g, listHtml);
  }

  // ── Phase G placeholders ─────────────────────────────────────────────────
  // All fall back to empty string when the source field is absent so non-
  // Phase-G templates ignore them. Dynamic headline-size scaling reused.
  const meta = (post && post.meta) || {};
  const hints = (post && post.visual_hints) || {};

  // Niche-tag chip (human label)
  const nicheLabel = hints.niche_tag_label || meta.niche_tag_label || '';
  html = html.replace(/\{\{NICHE_TAG_LABEL\}\}/g, escapeHtml(nicheLabel));

  // Hero + sub-image grid (niche-hook / hero-album / regional-roundup)
  html = html.replace(/\{\{HERO_IMAGE\}\}/g, escapeHtml(hints.hero_image_url || ''));
  const subUrls = Array.isArray(hints.sub_image_urls) ? hints.sub_image_urls : [];
  for (let i = 1; i <= 4; i++) {
    const url = subUrls[i - 1] || '';
    html = html.replace(new RegExp(`\\{\\{SUB_IMAGE_${i}\\}\\}`, 'g'), escapeHtml(url));
  }

  // Carousel frame index (regional-roundup, hero-album)
  html = html.replace(/\{\{FRAME_INDEX\}\}/g, String(post.frame_index != null ? post.frame_index + 1 : 1));
  html = html.replace(/\{\{FRAME_TOTAL\}\}/g, String(post.frame_total || 1));

  // Frame-specific data — carousel content per frame
  const fd = post.frame_data || {};
  html = html.replace(/\{\{FRAME_LOT_IMAGE\}\}/g, escapeHtml(fd.lot_image_url || hints.hero_image_url || ''));
  html = html.replace(/\{\{FRAME_ADDRESS\}\}/g, escapeHtml(fd.address_line || ''));
  html = html.replace(/\{\{FRAME_PRICE\}\}/g, escapeHtml(fd.price_text || ''));
  html = html.replace(/\{\{FRAME_KEY_FACT\}\}/g, escapeHtml(fd.key_fact || ''));
  html = html.replace(/\{\{FRAME_CAPTION\}\}/g, escapeHtml(fd.caption || ''));

  // Big stat (curiosity-gap, data-shock)
  html = html.replace(/\{\{MICRO_STAT\}\}/g, escapeHtml(meta.micro_stat || ''));
  html = html.replace(/\{\{MICRO_CAPTION\}\}/g, escapeHtml(meta.micro_caption || post.copy_body || ''));

  // Monet-mode follow_prompt overlay (vs traffic CTA)
  const followPrompt = meta.follow_prompt || '';
  const followOrCta = followPrompt || post.copy_cta || '';
  html = html.replace(/\{\{FOLLOW_PROMPT\}\}/g, escapeHtml(followPrompt));
  html = html.replace(/\{\{FOLLOW_OR_CTA\}\}/g, escapeHtml(followOrCta));

  // Dynamic stat-size scaling for data-shock / curiosity-gap big numbers
  const microStatLen = (meta.micro_stat || '').length;
  if (microStatLen) {
    const microStatSize = microStatLen > 6 ? 140 : microStatLen > 3 ? 200 : 260;
    html = html.replace(/\{\{MICRO_STAT_SIZE\}\}/g, microStatSize);
  } else {
    html = html.replace(/\{\{MICRO_STAT_SIZE\}\}/g, '160');
  }

  // Always replace any remaining {{HEADLINE_SIZE}} (templates set their own
  // default; the dynamic ones above already replace, but social templates
  // declare their own).
  if (!/\{\{HEADLINE_SIZE\}\}/.test(html)) {
    // already replaced
  } else {
    const hlSize = headlineLen > 60 ? 48 : headlineLen > 40 ? 56 : 64;
    html = html.replace(/\{\{HEADLINE_SIZE\}\}/g, hlSize);
  }

  // Logo — pick light variant for cream backgrounds, dark for navy
  // Every Phase G social-engine template uses the cream background.
  const isSocialEngine = templateType.startsWith('social-engine/');
  const needsLightLogo = templateType === 'hook' || isSocialEngine;
  const logoFile = needsLightLogo ? `${brand}-light.png` : `${brand}.png`;
  const logoAbsPath = path.join(__dirname, '..', 'templates', 'logos', logoFile);
  // Fallback to default if variant doesn't exist
  const fallbackPath = path.join(__dirname, '..', 'templates', 'logos', `${brand}.png`);
  const actualPath = fs.existsSync(logoAbsPath) ? logoAbsPath : fallbackPath;
  let logoUrl = '';
  if (fs.existsSync(actualPath)) {
    const logoData = fs.readFileSync(actualPath).toString('base64');
    logoUrl = `data:image/png;base64,${logoData}`;
  }
  html = html.replace(/\{\{LOGO_URL\}\}/g, logoUrl);

  return { html, width: dims.width, height: dims.height };
}

// Render HTML to PNG
async function renderPost(templateType, brand, post) {
  const { html, width, height } = buildHtml(templateType, brand, post);
  // Strip the social-engine/ prefix in the output filename for readability;
  // collisions resolved by Date.now() suffix.
  const namePart = templateType.replace(/\//g, '-');
  const frameSuffix = post.frame_index != null ? `-f${post.frame_index}` : '';
  const filename = `${brand}-${namePart}-${post.platform || 'facebook'}${frameSuffix}-${Date.now()}.png`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.screenshot({ path: outputPath, type: 'png' });
    return { filename, outputPath };
  } finally {
    await browser.close();
  }
}

// Render an album / carousel: call renderPost frameCount times, passing
// frame_index + frame_data from post.meta.frame_data[i]. Returns an array
// of filenames (in OUTPUT_DIR) in frame-order.
async function renderAlbum(templateType, brand, post, frameCount) {
  if (!Number.isFinite(frameCount) || frameCount < 1) {
    throw new Error(`renderAlbum: frameCount must be >= 1 (got ${frameCount})`);
  }
  const filenames = [];
  const frameDataArr = Array.isArray(post.meta && post.meta.frame_data) ? post.meta.frame_data : [];
  for (let i = 0; i < frameCount; i++) {
    const framePost = {
      ...post,
      frame_index: i,
      frame_total: frameCount,
      frame_data: frameDataArr[i] || {},
    };
    // eslint-disable-next-line no-await-in-loop
    const { filename } = await renderPost(templateType, brand, framePost);
    filenames.push(filename);
  }
  return filenames;
}

// Render all 8 brand×template combos (for testing)
async function renderTestSuite() {
  const results = [];
  const testPost = {
    copy_headline: '168 Auction Houses',
    copy_body: 'Search every UK property auction in one place.\nFind lots that never reach Rightmove.\nAI scores every investment opportunity.',
    copy_cta: 'Try AuctionBrain free — auctionbrain.co.uk',
    platform: 'facebook'
  };

  for (const brand of Object.keys(brands)) {
    for (const template of ['stat', 'hook', 'list', 'reel']) {
      const post = { ...testPost };
      if (brand === 'bridgematch') {
        post.copy_headline = 'Match in Minutes';
        post.copy_body = 'Find the right bridging lender for your deal.\nKnow your LTV before you bid.\nPer-lender calculations in seconds.';
        post.copy_cta = 'Try BridgeMatch free — bridgematch.co.uk';
      }
      const result = await renderPost(template, brand, post);
      results.push({ brand, template, ...result });
      console.log(`  Rendered: ${result.filename}`);
    }
  }
  return results;
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

module.exports = { renderPost, renderAlbum, renderTestSuite, buildHtml };
