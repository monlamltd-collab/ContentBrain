const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } = require('remotion');
const { BrandLogo } = require('../components/BrandLogo');
const { ScrambleText } = require('../components/ScrambleText');
const { ThemeDecoration } = require('../components/ThemeDecoration');
const { getTheme } = require('../../lib/themes');

// Spring presets per theme.motion. Keeps motion intent in one place so
// every composition reads the same vocabulary.
const MOTION = {
  crisp:   { damping: 12, stiffness: 80, ease: [12, 30] },
  soft:    { damping: 18, stiffness: 50, ease: [18, 45] },
  minimal: { damping: 24, stiffness: 30, ease: [24, 60] },
};

const StatVideo = ({ headline, body, brand, brandKey = 'auctionbrain', musicFile, voiceoverFile, theme }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = typeof theme === 'string' ? getTheme(theme) : (theme && theme.background ? theme : getTheme('dark-tech'));
  const motion = MOTION[t.motion] || MOTION.crisp;

  const statScale = spring({ frame: Math.max(0, frame - 15), fps, config: { damping: motion.damping, stiffness: motion.stiffness } });
  const statOpacity = interpolate(frame, motion.ease, [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const dividerWidth = interpolate(frame, [40, 60], [0, 120], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: t.background, fontFamily: t.fontHeading },
  },
    React.createElement('link', { href: t.googleFontHref, rel: 'stylesheet' }),

    React.createElement(ThemeDecoration, { theme: t, networkSeed: 42, networkNodes: 25 }),

    // Bottom gradient — fades content area into the background colour
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '55%',
        background: t.backgroundOverlay,
      },
    }),

    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: '0 64px 80px',
        display: 'flex',
        flexDirection: 'column',
      },
    },
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 48 }),

      React.createElement('div', {
        style: {
          fontFamily: t.fontHeading,
          fontSize: headline.length > 20 ? 64 : headline.length > 10 ? 80 : 96,
          fontWeight: 700,
          color: t.ink,
          marginTop: 40,
          transform: `scale(${statScale})`,
          opacity: statOpacity,
          transformOrigin: 'left center',
        },
      }, headline),

      React.createElement('div', {
        style: {
          width: dividerWidth,
          height: 3,
          backgroundColor: t.accent,
          marginTop: 16,
          marginBottom: 16,
          borderRadius: 2,
        },
      }),

      React.createElement('div', {
        style: {
          fontFamily: t.fontBody,
          fontSize: 24,
          color: t.inkMuted,
          lineHeight: 1.5,
          fontStyle: 'italic',
        },
      },
        React.createElement(ScrambleText, { text: body, startFrame: 50, duration: 25 })
      )
    ),

    musicFile ? React.createElement(Audio, {
      src: staticFile(musicFile),
      volume: (f) => {
        const fadeFrames = 15;
        const fadeIn = interpolate(f, [0, fadeFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const fadeOut = interpolate(f, [durationInFrames - fadeFrames, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return 0.15 * fadeIn * fadeOut;
      },
    }) : null,

    voiceoverFile ? React.createElement(Audio, { src: staticFile(voiceoverFile), volume: 0.9, startFrom: 15 }) : null
  );
};

module.exports = { StatVideo };
