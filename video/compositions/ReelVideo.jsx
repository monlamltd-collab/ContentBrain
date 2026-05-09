const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } = require('remotion');
const { BrandLogo } = require('../components/BrandLogo');
const { ScrambleText } = require('../components/ScrambleText');
const { ThemeDecoration } = require('../components/ThemeDecoration');
const { getTheme } = require('../../lib/themes');

const MOTION = {
  crisp:   { damping: 10, stiffness: 60, fadeIn: [15, 35] },
  soft:    { damping: 16, stiffness: 38, fadeIn: [18, 50] },
  minimal: { damping: 22, stiffness: 22, fadeIn: [22, 70] },
};

const ReelVideo = ({ headline, body, brand, brandKey = 'auctionbrain', musicFile, voiceoverFile, theme }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = typeof theme === 'string' ? getTheme(theme) : (theme && theme.background ? theme : getTheme('dark-tech'));
  const motion = MOTION[t.motion] || MOTION.crisp;

  const zoomSpring = spring({ frame: Math.max(0, frame - 15), fps, config: { damping: motion.damping, stiffness: motion.stiffness } });
  const headlineScale = interpolate(zoomSpring, [0, 1], [1.2, 1]);
  const headlineOpacity = interpolate(frame, motion.fadeIn, [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: t.background, fontFamily: t.fontHeading },
  },
    React.createElement('link', { href: t.googleFontHref, rel: 'stylesheet' }),

    React.createElement(ThemeDecoration, { theme: t, networkSeed: 55, networkNodes: 30 }),

    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '60%',
        background: t.backgroundOverlay,
      },
    }),

    React.createElement('div', {
      style: {
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: '30%',
        padding: '0 64px',
        display: 'flex',
        flexDirection: 'column',
      },
    },
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 52 }),

      React.createElement('div', {
        style: {
          fontFamily: t.fontHeading,
          fontSize: 64,
          fontWeight: 700,
          color: t.ink,
          lineHeight: 1.15,
          marginTop: 36,
          transform: `scale(${headlineScale})`,
          opacity: headlineOpacity,
          transformOrigin: 'left center',
        },
      }, headline),

      React.createElement('div', {
        style: {
          fontFamily: t.fontBody,
          fontSize: 30,
          color: t.accentSecondary,
          lineHeight: 1.4,
          marginTop: 24,
          fontStyle: 'italic',
        },
      },
        React.createElement(ScrambleText, { text: body, startFrame: 40, duration: 25 })
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
    voiceoverFile ? React.createElement(Audio, { src: staticFile(voiceoverFile), volume: 0.9, startFrom: 10 }) : null
  );
};

module.exports = { ReelVideo };
