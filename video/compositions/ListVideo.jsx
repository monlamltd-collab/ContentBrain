const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, spring, Audio, staticFile } = require('remotion');
const { BrandLogo } = require('../components/BrandLogo');
const { ScrambleText } = require('../components/ScrambleText');
const { ThemeDecoration } = require('../components/ThemeDecoration');
const { getTheme } = require('../../lib/themes');

const MOTION = {
  crisp:   { itemDamping: 12, itemStiffness: 100, itemEnter: 30 },
  soft:    { itemDamping: 18, itemStiffness: 60,  itemEnter: 18 },
  minimal: { itemDamping: 24, itemStiffness: 36,  itemEnter: 8  },
};

const ListVideo = ({ headline, items, brand, brandKey = 'auctionbrain', musicFile, voiceoverFile, theme }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = typeof theme === 'string' ? getTheme(theme) : (theme && theme.background ? theme : getTheme('dark-tech'));
  const motion = MOTION[t.motion] || MOTION.crisp;

  const titleOpacity = interpolate(frame, [10, 25], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: t.background, fontFamily: t.fontHeading },
  },
    React.createElement('link', { href: t.googleFontHref, rel: 'stylesheet' }),

    React.createElement(ThemeDecoration, { theme: t, networkSeed: 99, networkNodes: 20 }),

    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 0,
        left: 0,
        right: 0,
        height: '70%',
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
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 44 }),

      React.createElement('div', {
        style: {
          fontFamily: t.fontHeading,
          fontSize: headline.length > 40 ? 32 : 40,
          fontWeight: 700,
          color: t.ink,
          lineHeight: 1.2,
          marginTop: 32,
          opacity: titleOpacity,
        },
      },
        React.createElement(ScrambleText, { text: headline, startFrame: 10, duration: 20 })
      ),

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
            config: { damping: motion.itemDamping, stiffness: motion.itemStiffness },
          });
          const itemOpacity = interpolate(itemProgress, [0, 1], [0, 1]);
          const itemX = interpolate(itemProgress, [0, 1], [motion.itemEnter, 0]);

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
            React.createElement('div', {
              style: {
                width: 10,
                height: 10,
                minWidth: 10,
                backgroundColor: t.accent,
                borderRadius: '50%',
                marginTop: 8,
              },
            }),
            React.createElement('div', {
              style: {
                fontFamily: t.fontBody,
                fontSize: 24,
                color: t.inkMuted,
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
