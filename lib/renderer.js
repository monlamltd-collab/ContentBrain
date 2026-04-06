const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { brands, getDimensions } = require('./config');

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Load template HTML and replace placeholders
function buildHtml(templateType, brand, post) {
  const brandConfig = brands[brand];
  const { colours, fonts } = brandConfig;
  const dims = getDimensions(templateType, post.platform || 'facebook');

  let html = fs.readFileSync(path.join(TEMPLATES_DIR, `${templateType}.html`), 'utf8');

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

  // Logo — pick light variant for cream backgrounds, dark for navy
  const needsLightLogo = templateType === 'hook'; // cream background
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
  const filename = `${brand}-${templateType}-${post.platform || 'facebook'}-${Date.now()}.png`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  const browser = await puppeteer.launch({
    headless: true,
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

module.exports = { renderPost, renderTestSuite, buildHtml };
