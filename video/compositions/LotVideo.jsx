const React = require('react');
const { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Audio, Img, staticFile } = require('remotion');
const { BrandLogo } = require('../components/BrandLogo');
const { getTheme } = require('../../lib/themes');

// Lot of the Day composition. Vertical (1080×1920), designed to host a
// 60–90s voiceover. Layout:
//   0–3s    Intro card with archetype label
//   3–end   Lot photo (Ken Burns) with overlays:
//             - Address + postcode (top)
//             - Hook headline + price (mid)
//             - Bullets cycling on (lower)
//   last 5s CTA card fades over the photo
//
// The photo dominates the visual frame, so the theme only styles the chrome
// — intro/CTA card backgrounds, accent strokes, font choices. The Ken Burns
// pan and the photo itself are theme-independent.

// Convert a hex like '#0d0d14' to an rgba(...) string with the given alpha.
// Used to make theme-aware translucent overlays over the photo.
function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string' || !hex.startsWith('#')) return `rgba(13,13,20,${alpha})`;
  const h = hex.replace('#', '');
  const r = parseInt(h.length === 3 ? h[0] + h[0] : h.slice(0, 2), 16);
  const g = parseInt(h.length === 3 ? h[1] + h[1] : h.slice(2, 4), 16);
  const b = parseInt(h.length === 3 ? h[2] + h[2] : h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

const LotVideo = ({
  lot = {},
  archetype = 'best-yield',
  hookHeadline = '',
  keyBullets = [],
  superlativeBadge = null,
  brand = { colours: { red: '#C0392B', green: '#0f8a5f' } },
  brandKey = 'auctionbrain',
  voiceoverFile = null,
  musicFile = null,
  theme,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = typeof theme === 'string' ? getTheme(theme) : (theme && theme.background ? theme : getTheme('dark-tech'));
  const bullets = Array.isArray(keyBullets) ? keyBullets : [];

  const introEnd = 3 * fps;
  const photoStart = introEnd;
  const bulletsStart = 9 * fps;
  const ctaStart = Math.max(durationInFrames - 5 * fps, bulletsStart);

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

  // Photo gradient overlay uses the theme background colour so light themes
  // don't paint a dark band over the photo bottom.
  const photoGradient = `linear-gradient(180deg, ${hexToRgba(t.background, 0.55)} 0%, ${hexToRgba(t.background, 0.15)} 28%, ${hexToRgba(t.background, 0.55)} 70%, ${hexToRgba(t.background, 0.95)} 100%)`;
  const cardBg = hexToRgba(t.background, 0.9);
  const introBg = hexToRgba(t.background, 0.94);

  // Pick a sensible text colour for the photo overlays — the white text shadow
  // approach works for both light and dark backgrounds because the gradient
  // beneath it always tends toward the theme background.
  const photoInk = t.background === '#0d0d14' ? '#ffffff' : t.ink;

  return React.createElement(AbsoluteFill, {
    style: { backgroundColor: t.background, fontFamily: t.fontHeading }
  },
    React.createElement('link', { href: t.googleFontHref, rel: 'stylesheet' }),

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
        style: { position: 'absolute', inset: 0, background: photoGradient }
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
        background: introBg,
        opacity: introOpacity,
        padding: '0 80px',
      }
    },
      React.createElement(BrandLogo, { brandKey, startFrame: 0, size: 80 }),
      React.createElement('div', {
        style: {
          fontFamily: t.fontHeading,
          fontSize: 64,
          fontWeight: 700,
          color: t.ink,
          textAlign: 'center',
          marginTop: 40,
          lineHeight: 1.15,
        }
      }, superlativeBadge || archetypeLabel(archetype)),
      React.createElement('div', {
        style: {
          width: 96,
          height: 4,
          backgroundColor: t.accent,
          marginTop: 28,
          borderRadius: 2,
        }
      }),
      React.createElement('div', {
        style: {
          fontFamily: t.fontBody,
          fontSize: 28,
          color: t.inkMuted,
          marginTop: 28,
          textAlign: 'center',
        }
      }, superlativeBadge ? 'This week →' : "Today's lot →")
    ),

    // Address top
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
          fontFamily: t.fontHeading,
          fontSize: 36,
          fontWeight: 700,
          color: photoInk,
          marginTop: 24,
          textShadow: '0 2px 12px rgba(0,0,0,0.7)',
        }
      }, lot.address || ''),
      lot.postcode ? React.createElement('div', {
        style: {
          fontFamily: t.fontBody,
          fontSize: 24,
          color: photoInk,
          opacity: 0.85,
          marginTop: 4,
          textShadow: '0 2px 8px rgba(0,0,0,0.6)',
        }
      }, lot.postcode) : null
    ),

    // Superlative badge — the "X of the week" series label, sits above the hook
    superlativeBadge ? React.createElement('div', {
      style: {
        position: 'absolute',
        top: '24%',
        left: 64,
        right: 64,
        opacity: overlayOpacity,
      }
    },
      React.createElement('div', {
        style: {
          display: 'inline-block',
          fontFamily: t.fontHeading,
          fontSize: 34,
          fontWeight: 700,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          color: '#ffffff',
          backgroundColor: t.accent,
          padding: '14px 28px',
          borderRadius: 8,
          boxShadow: '0 6px 24px rgba(0,0,0,0.45)',
        }
      }, superlativeBadge)
    ) : null,

    // Hook + price
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
          fontFamily: t.fontHeading,
          fontSize: 84,
          fontWeight: 700,
          color: photoInk,
          lineHeight: 1.05,
          textShadow: '0 4px 20px rgba(0,0,0,0.75)',
        }
      }, hookHeadline),
      React.createElement('div', {
        style: {
          width: 120,
          height: 4,
          backgroundColor: t.accent,
          marginTop: 24,
          borderRadius: 2,
        }
      }),
      React.createElement('div', {
        style: {
          fontFamily: t.fontHeading,
          fontSize: 56,
          fontWeight: 700,
          color: t.accent,
          marginTop: 24,
          textShadow: '0 2px 12px rgba(0,0,0,0.6)',
        }
      }, formatPrice(lot.price))
    ),

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
        const op = interpolate(frame, [start, start + 15], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const ty = interpolate(frame, [start, start + 15], [12, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return React.createElement('div', {
          key: i,
          style: {
            fontFamily: t.fontBody,
            fontSize: 28,
            color: photoInk,
            marginTop: i === 0 ? 0 : 12,
            opacity: op,
            transform: `translateY(${ty}px)`,
            textShadow: '0 2px 8px rgba(0,0,0,0.7)',
          }
        }, '• ' + bullet);
      })
    ) : null,

    // CTA card
    React.createElement('div', {
      style: {
        position: 'absolute',
        bottom: 80,
        left: 64,
        right: 64,
        textAlign: 'center',
        opacity: ctaOpacity,
        padding: '24px 32px',
        background: cardBg,
        border: `2px solid ${t.accent}`,
        borderRadius: 12,
      }
    },
      React.createElement('div', {
        style: {
          fontFamily: t.fontBody,
          fontSize: 24,
          color: t.inkMuted,
          marginBottom: 8,
        }
      }, 'Full breakdown at'),
      React.createElement('div', {
        style: {
          fontFamily: t.fontHeading,
          fontSize: 40,
          fontWeight: 700,
          color: t.ink,
        }
      }, 'auctionbrain.co.uk')
    ),

    musicFile ? React.createElement(Audio, {
      src: staticFile(musicFile),
      volume: (f) => {
        const fadeFrames = 20;
        const fadeIn = interpolate(f, [0, fadeFrames], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        const fadeOut = interpolate(f, [durationInFrames - fadeFrames, durationInFrames], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
        return 0.08 * fadeIn * fadeOut;
      }
    }) : null,

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
