const path = require('path');
const fs = require('fs');
const { bundle } = require('@remotion/bundler');
const { renderMedia, selectComposition } = require('@remotion/renderer');
const { brands, getDimensions } = require('./config');

const VIDEO_ENTRY = path.join(__dirname, '..', 'video', 'index.js');
const OUTPUT_DIR = path.join(__dirname, '..', 'output');
const MUSIC_DIR = path.join(__dirname, '..', 'public', 'music');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Pick a random music track from public/music/ (if any exist)
function pickMusicFile() {
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const tracks = fs.readdirSync(MUSIC_DIR).filter(f => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f));
  if (!tracks.length) return null;
  const pick = tracks[Math.floor(Math.random() * tracks.length)];
  return `music/${pick}`;
}

// Map template types to Remotion composition IDs
const COMPOSITION_MAP = {
  stat: 'StatVideo',
  hook: 'HookVideo',
  list: 'ListVideo',
  reel: 'ReelVideo',
  lot: 'LotVideo',
};

let bundleLocation = null;

// Bundle once, reuse for multiple renders
async function ensureBundle() {
  if (bundleLocation) return bundleLocation;
  console.log('  Bundling Remotion project...');
  bundleLocation = await bundle({
    entryPoint: VIDEO_ENTRY,
    webpackOverride: (config) => {
      // Fix: force javascript/auto type on .js/.jsx files to allow ESM syntax
      const rules = (config.module?.rules || []).map((rule) => {
        if (rule.test && rule.test.toString().includes('jsx')) {
          return { ...rule, type: 'javascript/auto' };
        }
        return rule;
      });
      return { ...config, module: { ...config.module, rules } };
    },
  });
  console.log('  Bundle ready.');
  return bundleLocation;
}

// Build input props from a post object + brand config
function buildProps(templateType, brandKey, post) {
  const brandConfig = brands[brandKey];
  // Theme is the operator-tunable visual style. Sources, in priority order:
  //   1. explicit post.theme (used by feature scripts + tests)
  //   2. post.meta.visual_style (set by Claude during generation)
  //   3. undefined → composition falls back to dark-tech
  const theme = post.theme || (post.meta && post.meta.visual_style) || undefined;
  const base = {
    brand: {
      colours: brandConfig.colours,
      fonts: brandConfig.fonts,
    },
    brandKey,
    musicFile: post.musicFile || pickMusicFile(),
    voiceoverFile: post.voiceoverFile || null,
    theme,
  };

  switch (templateType) {
    case 'stat':
      return { ...base, headline: post.copy_headline, body: post.copy_body };
    case 'hook':
      return { ...base, headline: post.copy_headline, body: post.copy_body, cta: post.copy_cta };
    case 'list': {
      const items = (post.copy_body || '').split(/\n|•|·/).map(s => s.trim()).filter(Boolean);
      return { ...base, headline: post.copy_headline, items };
    }
    case 'reel':
      return { ...base, headline: post.copy_headline, body: post.copy_body };
    case 'lot':
      return {
        ...base,
        lot: post.lot || {},
        archetype: post.archetype || (post.meta && post.meta.archetype) || 'best-yield',
        hookHeadline: post.hookHeadline || (post.meta && post.meta.hook_headline) || post.copy_headline || '',
        keyBullets: post.keyBullets
          || (post.meta && post.meta.key_bullets)
          || (post.copy_body || '').split('\n').map(s => s.trim()).filter(Boolean),
        superlativeBadge: post.superlativeBadge || (post.meta && post.meta.superlative_badge) || null,
      };
    default:
      throw new Error(`Unknown template type: ${templateType}`);
  }
}

// Render a single video to MP4
async function renderVideo(templateType, brandKey, post) {
  const bundled = await ensureBundle();
  const compositionId = COMPOSITION_MAP[templateType];

  if (!compositionId) {
    throw new Error(`No video composition for template type: ${templateType}`);
  }

  const inputProps = buildProps(templateType, brandKey, post);
  const filename = `${brandKey}-${templateType}-${post.platform || 'facebook'}-${Date.now()}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, filename);

  const composition = await selectComposition({
    serveUrl: bundled,
    id: compositionId,
    inputProps,
  });

  // Allow duration override (e.g. from revision requests)
  if (post.overrideDurationSeconds) {
    composition.durationInFrames = Math.round(post.overrideDurationSeconds * composition.fps);
  }

  await renderMedia({
    composition,
    serveUrl: bundled,
    codec: 'h264',
    outputLocation: outputPath,
    inputProps,
  });

  return { filename, outputPath };
}

// Render test suite — one video per brand×template combo
async function renderVideoTestSuite() {
  const results = [];
  const testPost = {
    copy_headline: '168 Auction Houses',
    copy_body: 'Search every UK property auction in one place.\nFind lots that never reach Rightmove.\nAI scores every investment opportunity.',
    copy_cta: 'Try AuctionBrain free — auctionbrain.co.uk',
    platform: 'facebook',
  };

  for (const brand of Object.keys(brands)) {
    for (const template of ['stat', 'hook', 'list', 'reel']) {
      const post = { ...testPost };
      if (brand === 'bridgematch') {
        post.copy_headline = 'Match in Minutes';
        post.copy_body = 'Find the right bridging lender for your deal.\nKnow your LTV before you bid.\nPer-lender calculations in seconds.';
        post.copy_cta = 'Try BridgeMatch free — bridgematch.co.uk';
      }

      console.log(`  Rendering video: ${brand}/${template}...`);
      const result = await renderVideo(template, brand, post);
      results.push({ brand, template, ...result });
      console.log(`  Done: ${result.filename}`);
    }
  }

  return results;
}

module.exports = { renderVideo, renderVideoTestSuite, ensureBundle };
