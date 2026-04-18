const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } = require('remotion');
const { NetworkBackground } = require('../components/NetworkBackground');
const { BrandLogo } = require('../components/BrandLogo');
const { ScrambleText } = require('../components/ScrambleText');

const HookVideo = ({ headline, body, cta, brand, brandKey = 'auctionbrain', musicFile, voiceoverFile }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { colours } = brand;

  // Headline: slide in from left
  const headlineProgress = spring({ frame: Math.max(0, frame - 20), fps, config: { damping: 14, stiffness: 60 } });
  const headlineX = interpolate(headlineProgress, [0, 1], [-300, 0]);
  const headlineOpacity = interpolate(headlineProgress, [0, 1], [0, 1]);

  // Body: scramble text from frame 50
  // CTA bar: slide up from frame 80
  const ctaProgress = spring({ frame: Math.max(0, frame - 80), fps, config: { damping: 12, stiffness: 80 } });
  const ctaY = interpolate(ctaProgress, [0, 1], [60, 0]);
  const ctaOpacity = interpolate(ctaProgress, [0, 1], [0, 1]);

  const headlineSize = headline.length > 60 ? 36 : headline.length > 40 ? 44 : 52;

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: '#0d0d14', fontFamily: "'IBM Plex Sans', 'DM Sans', Arial, sans-serif" },
  },
    React.createElement('link', { href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap', rel: 'stylesheet' }),

    React.createElement(NetworkBackground, { nodeCount: 22, seed: 73 }),

    // Gradient overlay
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '65%',
        background: 'linear-gradient(180deg, transparent 0%, rgba(13,13,20,0.95) 35%)',
      },
    }),

    // Content
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
      // Logo
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 44 }),

      // Hook headline
      React.createElement('div', {
        style: {
          fontSize: headlineSize,
          fontWeight: 700,
          color: '#ffffff',
          lineHeight: 1.2,
          marginTop: 32,
          transform: `translateX(${headlineX}px)`,
          opacity: headlineOpacity,
        },
      }, headline),

      // Body text with scramble
      React.createElement('div', {
        style: {
          fontSize: 22,
          color: 'rgba(255,255,255,0.7)',
          lineHeight: 1.6,
          marginTop: 20,
          fontStyle: 'italic',
        },
      },
        React.createElement(ScrambleText, { text: body, startFrame: 50, duration: 30 })
      ),

      // CTA bar
      React.createElement('div', {
        style: {
          backgroundColor: colours.green,
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
