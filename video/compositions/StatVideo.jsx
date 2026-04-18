const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } = require('remotion');
const { NetworkBackground } = require('../components/NetworkBackground');
const { BrandLogo } = require('../components/BrandLogo');
const { ScrambleText } = require('../components/ScrambleText');

const StatVideo = ({ headline, body, brand, brandKey = 'auctionbrain', musicFile, voiceoverFile }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { colours } = brand;

  // Big stat number: scale in with spring
  const statScale = spring({ frame: Math.max(0, frame - 15), fps, config: { damping: 12, stiffness: 80 } });
  const statOpacity = interpolate(frame, [15, 30], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  // Red divider sweep
  const dividerWidth = interpolate(frame, [40, 60], [0, 120], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: '#0d0d14', fontFamily: "'IBM Plex Sans', 'DM Sans', Arial, sans-serif" },
  },
    // Google Fonts
    React.createElement('link', { href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap', rel: 'stylesheet' }),

    // Neural network background
    React.createElement(NetworkBackground, { nodeCount: 25, seed: 42 }),

    // Dark overlay card (like Canva style)
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '55%',
        background: 'linear-gradient(180deg, transparent 0%, rgba(13,13,20,0.95) 30%)',
      },
    }),

    // Content
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
      // Logo
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 48 }),

      // Stat number
      React.createElement('div', {
        style: {
          fontFamily: "'IBM Plex Sans', Arial, sans-serif",
          fontSize: headline.length > 20 ? 64 : headline.length > 10 ? 80 : 96,
          fontWeight: 700,
          color: '#ffffff',
          marginTop: 40,
          transform: `scale(${statScale})`,
          opacity: statOpacity,
          transformOrigin: 'left center',
        },
      }, headline),

      // Red divider
      React.createElement('div', {
        style: {
          width: dividerWidth,
          height: 3,
          backgroundColor: colours.red,
          marginTop: 16,
          marginBottom: 16,
          borderRadius: 2,
        },
      }),

      // Caption with scramble effect
      React.createElement('div', {
        style: {
          fontSize: 24,
          color: 'rgba(255,255,255,0.7)',
          lineHeight: 1.5,
          fontStyle: 'italic',
        },
      },
        React.createElement(ScrambleText, { text: body, startFrame: 50, duration: 25 })
      )
    ),

    // Background music with fade in/out
    musicFile ? React.createElement(Audio, {
      src: staticFile(musicFile),
      volume: (f) => {
        const fadeFrames = 15;
        const fadeIn = interpolate(f, [0, fadeFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const fadeOut = interpolate(f, [durationInFrames - fadeFrames, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return 0.15 * fadeIn * fadeOut;
      },
    }) : null,

    // Voiceover
    voiceoverFile ? React.createElement(Audio, { src: staticFile(voiceoverFile), volume: 0.9, startFrom: 15 }) : null
  );
};

module.exports = { StatVideo };
