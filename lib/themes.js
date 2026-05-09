// Visual theme presets consumed by Remotion compositions.
//
// Each theme is a frozen config object. Compositions read the theme passed
// via props and look up colour/font/decoration choices instead of hardcoding.
// The default theme (`dark-tech`) reproduces the look ContentBrain has had
// since launch — so a composition that omits a theme prop is unchanged.
//
// Adding a theme: drop a new entry into THEMES below and (if it uses fonts
// not already loaded) extend googleFontHref. Decorations + motion are advisory
// strings — each composition decides how to honour them. New themes appear
// automatically in the Claude prompt menu via THEME_NAMES.
//
// Decoration tokens (composition-defined behaviour):
//   network   — render the existing NetworkBackground component
//   grain     — subtle SVG noise overlay
//   gradient  — CSS gradient using background + accent
//   solid     — no extra decoration, plain background
//
// Motion tokens (composition-defined behaviour):
//   crisp     — short fast springs, sharp transitions
//   soft      — longer easing curves, gentler reveals
//   minimal   — almost-static, prestige feel

const DARK_TECH = Object.freeze({
  name: 'dark-tech',
  label: 'Dark Tech (default)',
  description: 'Near-black background, neural-network overlay, IBM Plex Sans, brick-red accent. The original ContentBrain look.',
  background: '#0d0d14',
  backgroundOverlay: 'linear-gradient(180deg, transparent 0%, rgba(13,13,20,0.95) 35%)',
  ink: '#ffffff',
  inkMuted: 'rgba(255,255,255,0.7)',
  accent: '#C0392B',
  accentSecondary: '#0f8a5f',
  fontHeading: "'IBM Plex Sans', 'DM Sans', Arial, sans-serif",
  fontBody: "'IBM Plex Sans', Arial, sans-serif",
  fontMono: "'IBM Plex Mono', 'Courier New', monospace",
  decoration: 'network',
  motion: 'crisp',
  googleFontHref: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap',
});

const LIGHT_EDITORIAL = Object.freeze({
  name: 'light-editorial',
  label: 'Light Editorial',
  description: 'Cream background, deep navy headlines, magazine-feel serif headers. Reads as editorial commentary rather than a tech ad.',
  background: '#faf8f4',
  backgroundOverlay: 'linear-gradient(180deg, transparent 0%, rgba(250,248,244,0.85) 40%)',
  ink: '#171717',
  inkMuted: 'rgba(23,23,23,0.62)',
  accent: '#1a3a52',
  accentSecondary: '#9a3324',
  fontHeading: "'Playfair Display', 'Georgia', serif",
  fontBody: "'Inter', 'Helvetica Neue', Arial, sans-serif",
  fontMono: "'JetBrains Mono', 'Courier New', monospace",
  decoration: 'grain',
  motion: 'soft',
  googleFontHref: 'https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;700;900&family=Inter:wght@400;600&family=JetBrains+Mono:wght@400;500&display=swap',
});

const COLOUR_POP = Object.freeze({
  name: 'colour-pop',
  label: 'Colour Pop',
  description: 'Warm off-white background with a bold orange accent and chunky display font. Friendly and approachable, less corporate.',
  background: '#fff7e6',
  backgroundOverlay: 'linear-gradient(180deg, transparent 0%, rgba(255,247,230,0.78) 40%)',
  ink: '#1a1410',
  inkMuted: 'rgba(26,20,16,0.6)',
  accent: '#e67e22',
  accentSecondary: '#7c3aed',
  fontHeading: "'Archivo Black', 'DM Sans', Arial, sans-serif",
  fontBody: "'DM Sans', 'Helvetica Neue', Arial, sans-serif",
  fontMono: "'Space Mono', 'Courier New', monospace",
  decoration: 'gradient',
  motion: 'crisp',
  googleFontHref: 'https://fonts.googleapis.com/css2?family=Archivo+Black&family=DM+Sans:wght@400;500;700&family=Space+Mono:wght@400;700&display=swap',
});

const THEMES = Object.freeze({
  'dark-tech': DARK_TECH,
  'light-editorial': LIGHT_EDITORIAL,
  'colour-pop': COLOUR_POP,
});

const THEME_NAMES = Object.freeze(Object.keys(THEMES));
const DEFAULT_THEME_NAME = 'dark-tech';

function getTheme(name) {
  return THEMES[name] || THEMES[DEFAULT_THEME_NAME];
}

// Render the available themes as a menu Claude can pick from. Used in the
// generation prompt so the model sees current options without hardcoding
// names in two places.
function renderThemeMenu() {
  const lines = THEME_NAMES.map(n => {
    const t = THEMES[n];
    return `- ${t.name}: ${t.description}`;
  });
  return `VISUAL THEME MENU — pick exactly ONE name. Output the chosen theme name as the visual_style field.\n\n${lines.join('\n')}`;
}

module.exports = { THEMES, THEME_NAMES, DEFAULT_THEME_NAME, getTheme, renderThemeMenu };
