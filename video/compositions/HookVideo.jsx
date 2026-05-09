const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } = require('remotion');
const { BrandLogo } = require('../components/BrandLogo');
const { ScrambleText } = require('../components/ScrambleText');
const { ThemeDecoration } = require('../components/ThemeDecoration');
const { getTheme } = require('../../lib/themes');

const MOTION = {
  crisp:   { headlineDamping: 14, headlineStiffness: 60, ctaDamping: 12, ctaStiffness: 80, headlineEnter: -300, ctaEnter: 60 },
  soft:    { headlineDamping: 20, headlineStiffness: 40, ctaDamping: 18, ctaStiffness: 50, headlineEnter: -180, ctaEnter: 36 },
  minimal: { headlineDamping: 26, headlineStiffness: 22, ctaDamping: 24, ctaStiffness: 30, headlineEnter: -90, ctaEnter: 18 },
};

const HookVideo = ({ headline, body, cta, brand, brandKey = 'auctionbrain', musicFile, voiceoverFile, theme }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = typeof theme === 'string' ? getTheme(theme) : (theme && theme.background ? theme : getTheme('dark-tech'));
  const motion = MOTION[t.motion] || MOTION.crisp;

  const headlineProgress = spring({ frame: Math.max(0, frame - 20), fps, config: { damping: motion.headlineDamping, stiffness: motion.headlineStiffness } });
  const headlineX = interpolate(headlineProgress, [0, 1], [motion.headlineEnter, 0]);
  const headlineOpacity = interpolate(headlineProgress, [0, 1], [0, 1]);

  const ctaProgress = spring({ frame: Math.max(0, frame - 80), fps, config: { damping: motion.ctaDamping, stiffness: motion.ctaStiffness } });
  const ctaY = interpolate(ctaProgress, [0, 1], [motion.ctaEnter, 0]);
  const ctaOpacity = interpolate(ctaProgress, [0, 1], [0, 1]);

  const headlineSize = headline.length > 60 ? 36 : headline.length > 40 ? 44 : 52;

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: t.background, fontFamily: t.fontHeading },
  },
    React.createElement('link', { href: t.googleFontHref, rel: 'stylesheet' }),

    React.createElement(ThemeDecoration, { theme: t, networkSeed: 73, networkNodes: 22 }),

    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '65%',
        background: t.backgroundOverlay,
      },
    }),

    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        padding: '0 64px 0',
        display: 'flex',
        flexDirection: 'column',
      },
    },
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 44 }),

      React.createElement('div', {
        style: {
          fontFamily: t.fontHeading,
          fontSize: headlineSize,
          fontWeight: 700,
          color: t.ink,
          lineHeight: 1.2,
          marginTop: 32,
          transform: `translateX(${headlineX}px)`,
          opacity: headlineOpacity,
        },
      }, headline),

      React.createElement('div', {
        style: {
          fontFamily: t.fontBody,
          fontSize: 22,
          color: t.inkMuted,
          lineHeight: 1.6,
          marginTop: 20,
          fontStyle: 'italic',
        },
      },
        React.createElement(ScrambleText, { text: body, startFrame: 50, duration: 30 })
      ),

      React.createElement('div', {
        style: {
          backgroundColor: t.accentSecondary,
          padding: '20px 32px',
          marginTop: 28,
          marginBottom: 60,
          transform: `translateY(${ctaY}px)`,
          opacity: ctaOpacity,
          display: 'inline-block',
          alignSelf: 'flex-start',
        },
      },
        React.createElement('span', {
          style: {
            fontFamily: t.fontBody,
            fontSize: 22,
            fontWeight: 500,
            color: '#ffffff',
            letterSpacing: '0.02em',
          },
        }, cta)
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

module.exports = { HookVideo };
