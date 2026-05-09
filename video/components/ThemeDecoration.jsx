// Shared decoration renderer for theme-aware compositions.
// Each composition calls <ThemeDecoration theme={t} /> in its background layer.
// The decoration string on the theme decides what gets rendered:
//   'network'  → existing NetworkBackground
//   'gradient' → radial + linear CSS gradient using accent + accentSecondary
//   'grain'    → subtle SVG noise overlay
//   else        → null (solid background only)
//
// Adding a new decoration: extend the switch + handle the corresponding token
// in lib/themes.js. Compositions don't need to know about new tokens.

const React = require('react');
const { NetworkBackground } = require('./NetworkBackground');

const NOISE_SVG_DATA_URI = "data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='1.2' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.18 0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E";

const ThemeDecoration = ({ theme, networkSeed = 42, networkNodes = 25 }) => {
  if (!theme || !theme.decoration) return null;

  switch (theme.decoration) {
    case 'network':
      return React.createElement(NetworkBackground, { nodeCount: networkNodes, seed: networkSeed });

    case 'gradient':
      return React.createElement('div', {
        style: {
          position: 'absolute',
          inset: 0,
          background: `radial-gradient(circle at 70% 30%, ${theme.accent}22 0%, ${theme.background} 60%), linear-gradient(135deg, ${theme.background} 0%, ${theme.accentSecondary}14 100%)`,
        },
      });

    case 'grain':
      return React.createElement('div', {
        style: {
          position: 'absolute',
          inset: 0,
          backgroundImage: `url("${NOISE_SVG_DATA_URI}")`,
          opacity: 0.5,
          mixBlendMode: 'multiply',
        },
      });

    default:
      return null;
  }
};

module.exports = { ThemeDecoration };
