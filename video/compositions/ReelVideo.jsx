const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } = require('remotion');
const { NetworkBackground } = require('../components/NetworkBackground');
const { BrandLogo } = require('../components/BrandLogo');
const { ScrambleText } = require('../components/ScrambleText');

const ReelVideo = ({ headline, body, brand, brandKey = 'auctionbrain', musicFile, voiceoverFile }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { colours } = brand;

  // Headline zoom-in settle
  const zoomSpring = spring({ frame: Math.max(0, frame - 15), fps, config: { damping: 10, stiffness: 60 } });
  const headlineScale = interpolate(zoomSpring, [0, 1], [1.2, 1]);
  const headlineOpacity = interpolate(frame, [15, 35], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: '#0d0d14', fontFamily: "'IBM Plex Sans', 'DM Sans', Arial, sans-serif" },
  },
    React.createElement('link', { href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap', rel: 'stylesheet' }),

    React.createElement(NetworkBackground, { nodeCount: 30, seed: 55 }),

    // Gradient overlay — covers bottom 60%
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '60%',
        background: 'linear-gradient(180deg, transparent 0%, rgba(13,13,20,0.95) 35%)',
      },
    }),

    // Content — centred vertically, left-aligned
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
      // Logo
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 52 }),

      // Headline — zoom settle
      React.createElement('div', {
        style: {
          fontSize: 64,
          fontWeight: 700,
          color: '#ffffff',
          lineHeight: 1.15,
          marginTop: 36,
          transform: `scale(${headlineScale})`,
          opacity: headlineOpacity,
          transformOrigin: 'left center',
        },
      }, headline),

      // Subline — scramble decode
      React.createElement('div', {
        style: {
          fontSize: 30,
          color: colours.green,
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
