const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } = require('remotion');
const { NetworkBackground } = require('../components/NetworkBackground');
const { BrandLogo } = require('../components/BrandLogo');
const { ScrambleText } = require('../components/ScrambleText');

const ListVideo = ({ headline, items, brand, brandKey = 'auctionbrain', musicFile, voiceoverFile }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { colours } = brand;

  // Title with scramble decode
  const titleOpacity = interpolate(frame, [10, 25], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: '#0d0d14', fontFamily: "'IBM Plex Sans', 'DM Sans', Arial, sans-serif" },
  },
    React.createElement('link', { href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;700&family=IBM+Plex+Mono:wght@400;500&display=swap', rel: 'stylesheet' }),

    React.createElement(NetworkBackground, { nodeCount: 20, seed: 99 }),

    // Gradient overlay
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '70%',
        background: 'linear-gradient(180deg, transparent 0%, rgba(13,13,20,0.97) 30%)',
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
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 44 }),

      // Title
      React.createElement('div', {
        style: {
          fontSize: headline.length > 40 ? 32 : 40,
          fontWeight: 700,
          color: '#ffffff',
          lineHeight: 1.2,
          marginTop: 32,
          opacity: titleOpacity,
        },
      },
        React.createElement(ScrambleText, { text: headline, startFrame: 10, duration: 20 })
      ),

      // List items — appear one by one
      React.createElement('div', {
        style: {
          marginTop: 28,
          display: 'flex',
          flexDirection: 'column',
          gap: 20,
        },
      },
        items.map((item, i) => {
          const itemStart = 40 + i * 22;
          const itemProgress = spring({
            frame: Math.max(0, frame - itemStart),
            fps,
            config: { damping: 12, stiffness: 100 },
          });
          const itemOpacity = interpolate(itemProgress, [0, 1], [0, 1]);
          const itemX = interpolate(itemProgress, [0, 1], [30, 0]);

          return React.createElement('div', {
            key: i,
            style: {
              display: 'flex',
              alignItems: 'flex-start',
              gap: 16,
              opacity: itemOpacity,
              transform: `translateX(${itemX}px)`,
            },
          },
            // Red dot marker
            React.createElement('div', {
              style: {
                width: 10,
                height: 10,
                minWidth: 10,
                backgroundColor: colours.red,
                borderRadius: '50%',
                marginTop: 8,
              },
            }),
            React.createElement('div', {
              style: {
                fontSize: 24,
                color: 'rgba(255,255,255,0.85)',
                lineHeight: 1.4,
              },
            }, item)
          );
        })
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

module.exports = { ListVideo };
