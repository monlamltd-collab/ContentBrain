const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Audio, Img, staticFile } = require('remotion');
const { BrandLogo } = require('../components/BrandLogo');

// Lot of the Day composition. Vertical (1080×1920), designed to host a
// 60–90s voiceover. Layout:
//   0–3s    Intro card with archetype label
//   3–end   Lot photo (Ken Burns) with overlays:
//             - Address + postcode (top)
//             - Hook headline + price (mid)
//             - Bullets cycling on (lower)
//   last 5s CTA card fades over the photo
//
// Inputs come from server.js's runLotOfTheDay() flow. The voiceover file is
// the cleaned wav written by lib/audio-processor.js after Simon's Telegram
// voice-message reply. If voiceoverFile is null the composition still renders
// (silent) — used for dry-runs.

const LotVideo = ({
  lot = {},
  archetype = 'best-yield',
  hookHeadline = '',
  keyBullets = [],
  brand = { colours: { red: '#C0392B', green: '#0f8a5f' } },
  brandKey = 'auctionbrain',
  voiceoverFile = null,
  musicFile = null,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const { colours } = brand;
  const bullets = Array.isArray(keyBullets) ? keyBullets : [];

  const introEnd = 3 * fps;
  const photoStart = introEnd;
  const bulletsStart = 9 * fps;
  const ctaStart = Math.max(durationInFrames - 5 * fps, bulletsStart);

  // Ken Burns: scale + slow drift
  const photoScale = interpolate(frame, [0, durationInFrames], [1.0, 1.18], { extrapolateRight: 'clamp' });
  const photoX = interpolate(frame, [0, durationInFrames], [0, -50], { extrapolateRight: 'clamp' });
  const photoY = interpolate(frame, [0, durationInFrames], [0, -40], { extrapolateRight: 'clamp' });

  const introOpacity = interpolate(frame, [0, 12, introEnd - 15, introEnd], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp'
  });

  const overlayOpacity = interpolate(frame, [photoStart + 10, photoStart + 30], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp'
  });

  const ctaOpacity = interpolate(frame, [ctaStart, ctaStart + 18], [0, 1], {
    extrapolateLeft: 'clamp', extrapolateRight: 'clamp'
  });

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: '#0d0d14', fontFamily: "'IBM Plex Sans', 'DM Sans', Arial, sans-serif" }
  },
    React.createElement('link', {
      href: 'https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;700&display=swap',
      rel: 'stylesheet'
    }),

    // Lot photo with Ken Burns
    lot.image_url ? React.createElement('div', {
      style: { position: 'absolute', inset: 0, overflow: 'hidden' }
    },
      React.createElement(Img, {
        src: lot.image_url,
        style: {
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: `translate(${photoX}px, ${photoY}px) scale(${photoScale})`,
          transformOrigin: 'center center',
        }
      }),
      React.createElement('div', {
        style: {
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(180deg, rgba(13,13,20,0.55) 0%, rgba(13,13,20,0.15) 28%, rgba(13,13,20,0.55) 70%, rgba(13,13,20,0.95) 100%)'
        }
      })
    ) : null,

    // Intro card
    React.createElement('div', {
      style: {
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(13,13,20,0.94)',
        opacity: introOpacity,
        padding: '0 80px',
      }
    },
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 80 }),
      React.createElement('div', {
        style: {
          fontSize: 64,
          fontWeight: 700,
          color: '#ffffff',
          textAlign: 'center',
          marginTop: 40,
          lineHeight: 1.15,
        }
      }, archetypeLabel(archetype)),
      React.createElement('div', {
        style: {
          width: 96,
          height: 4,
          backgroundColor: colours.red,
          marginTop: 28,
          borderRadius: 2,
        }
      }),
      React.createElement('div', {
        style: {
          fontSize: 28,
          color: 'rgba(255,255,255,0.7)',
          marginTop: 28,
          textAlign: 'center',
        }
      }, "Today's lot →")
    ),

    // Address + brand mark (top)
    React.createElement('div', {
      style: {
        position: 'absolute',
        top: 80,
        left: 64,
        right: 64,
        opacity: overlayOpacity,
      }
    },
      React.createElement(BrandLogo, { brandKey, startFrame: photoStart + 5, size: 48 }),
      React.createElement('div', {
        style: {
          fontSize: 36,
          fontWeight: 700,
          color: '#ffffff',
          marginTop: 24,
          textShadow: '0 2px 12px rgba(0,0,0,0.7)',
        }
      }, lot.address || ''),
      lot.postcode ? React.createElement('div', {
        style: {
          fontSize: 24,
          color: 'rgba(255,255,255,0.85)',
          marginTop: 4,
          textShadow: '0 2px 8px rgba(0,0,0,0.6)',
        }
      }, lot.postcode) : null
    ),

    // Hook headline + price (mid-screen)
    React.createElement('div', {
      style: {
        position: 'absolute',
        top: '34%',
        left: 64,
        right: 64,
        opacity: overlayOpacity,
      }
    },
      React.createElement('div', {
        style: {
          fontSize: 84,
          fontWeight: 700,
          color: '#ffffff',
          lineHeight: 1.05,
          textShadow: '0 4px 20px rgba(0,0,0,0.75)',
        }
      }, hookHeadline),
      React.createElement('div', {
        style: {
          width: 120,
          height: 4,
          backgroundColor: colours.red,
          marginTop: 24,
          borderRadius: 2,
        }
      }),
      React.createElement('div', {
        style: {
          fontSize: 56,
          fontWeight: 700,
          color: colours.red,
          marginTop: 24,
          textShadow: '0 2px 12px rgba(0,0,0,0.6)',
        }
      }, formatPrice(lot.price))
    ),

    // Bullets — animate in one by one
    bullets.length ? React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 240,
        left: 64,
        right: 64,
      }
    },
      ...bullets.map((bullet, i) => {
        const start = bulletsStart + (i * 4 * fps);
        const op = interpolate(frame, [start, start + 15], [0, 1], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp'
        });
        const ty = interpolate(frame, [start, start + 15], [12, 0], {
          extrapolateLeft: 'clamp', extrapolateRight: 'clamp'
        });
        return React.createElement('div', {
          key: i,
          style: {
            fontSize: 28,
            color: '#ffffff',
            marginTop: i === 0 ? 0 : 12,
            opacity: op,
            transform: `translateY(${ty}px)`,
            textShadow: '0 2px 8px rgba(0,0,0,0.7)',
          }
        }, '• ' + bullet);
      })
    ) : null,

    // CTA card (final phase)
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 80,
        left: 64,
        right: 64,
        textAlign: 'center',
        opacity: ctaOpacity,
        padding: '24px 32px',
        background: 'rgba(13,13,20,0.85)',
        border: `2px solid ${colours.red}`,
        borderRadius: 12,
      }
    },
      React.createElement('div', {
        style: {
          fontSize: 24,
          color: 'rgba(255,255,255,0.65)',
          marginBottom: 8,
        }
      }, 'Full breakdown at'),
      React.createElement('div', {
        style: {
          fontSize: 40,
          fontWeight: 700,
          color: '#ffffff',
        }
      }, 'auctionbrain.co.uk')
    ),

    // Background music — quiet, ducked under voiceover
    musicFile ? React.createElement(Audio, {
      src: staticFile(musicFile),
      volume: (f) => {
        const fadeFrames = 20;
        const fadeIn = interpolate(f, [0, fadeFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const fadeOut = interpolate(f, [durationInFrames - fadeFrames, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return 0.08 * fadeIn * fadeOut;
      }
    }) : null,

    // Voiceover (kicks in just before intro card fades)
    voiceoverFile ? React.createElement(Audio, {
      src: staticFile(voiceoverFile),
      volume: 1.0,
      startFrom: Math.max(0, introEnd - 10),
    }) : null
  );
};

function archetypeLabel(archetype) {
  switch (archetype) {
    case 'best-yield': return 'Best Yield Today';
    case 'deepest-discount': return 'Deepest Discount Today';
    case 'dev-or-refurb': return 'Refurb Project Today';
    case 'urgent': return 'Bidding This Week';
    default: return 'Lot of the Day';
  }
}

function formatPrice(n) {
  if (!n) return '';
  return '£' + Math.round(Number(n)).toLocaleString('en-GB');
}

module.exports = { LotVideo };
