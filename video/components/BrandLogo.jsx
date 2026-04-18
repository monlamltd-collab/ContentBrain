const React = require('react');
const { useCurrentFrame, interpolate, spring, useVideoConfig } = require('remotion');

const BrandLogo = ({ brandKey = 'auctionbrain', startFrame = 0, size = 56 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = Math.max(0, frame - startFrame);

  const logoOpacity = interpolate(elapsed, [0, 15], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  // Horizontal rule wipe
  const ruleWidth = interpolate(elapsed, [10, 40], [0, 300], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  if (brandKey === 'bridgematch') {
    return React.createElement('div', {
      style: { opacity: logoOpacity },
    },
      React.createElement('div', {
        style: {
          fontSize: size,
          fontWeight: 700,
          fontFamily: "'IBM Plex Sans', 'DM Sans', Arial, sans-serif",
          letterSpacing: '-0.01em',
          lineHeight: 1.1,
        },
      },
        React.createElement('span', { style: { color: '#2563EB' } }, 'Bridge'),
        React.createElement('span', { style: { color: '#0f8a5f' } }, 'Match')
      ),
      React.createElement('div', {
        style: {
          width: ruleWidth,
          height: 2,
          background: 'linear-gradient(90deg, #2563EB, #0f8a5f)',
          marginTop: 8,
        },
      })
    );
  }

  // AuctionBrain
  return React.createElement('div', {
    style: { opacity: logoOpacity },
  },
    React.createElement('div', {
      style: {
        fontSize: size,
        lineHeight: 1.1,
        display: 'flex',
        alignItems: 'baseline',
      },
    },
      React.createElement('span', {
        style: {
          fontFamily: "'IBM Plex Sans', 'DM Sans', Arial, sans-serif",
          fontWeight: 700,
          color: '#ffffff',
          letterSpacing: '-0.01em',
        },
      }, 'Auction'),
      React.createElement('span', {
        style: {
          fontFamily: "'IBM Plex Mono', 'Courier New', monospace",
          fontWeight: 400,
          color: '#C0392B',
          letterSpacing: '0.05em',
        },
      }, 'Brain')
    ),
    React.createElement('div', {
      style: {
        width: ruleWidth,
        height: 2,
        backgroundColor: '#ffffff',
        marginTop: 8,
      },
    })
  );
};

module.exports = { BrandLogo };
