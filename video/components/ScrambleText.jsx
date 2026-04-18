const React = require('react');
const { useCurrentFrame, useVideoConfig } = require('remotion');

const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$%&*';

function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 16807 + 0) % 2147483647;
    return s / 2147483647;
  };
}

const ScrambleText = ({ text, startFrame = 0, duration = 30, style = {} }) => {
  const frame = useCurrentFrame();
  const elapsed = frame - startFrame;

  if (elapsed < 0) {
    return React.createElement('span', { style: { ...style, opacity: 0 } }, text);
  }

  const progress = Math.min(elapsed / duration, 1);
  const rng = seededRandom(frame * 31 + 7);

  const chars = text.split('').map((char, i) => {
    if (char === ' ') return ' ';

    // Each character decodes at a staggered time
    const charThreshold = (i / text.length) * 0.7 + 0.1; // 10%-80% of duration
    const jitter = (seededRandom(i * 17)() - 0.5) * 0.3; // randomise order slightly
    const decodeAt = charThreshold + jitter;

    if (progress >= decodeAt) {
      return char; // decoded
    }

    // Show random character, cycling each frame
    const randomIndex = Math.floor(rng() * CHARS.length);
    return CHARS[randomIndex];
  });

  // Overall opacity: fade in at start
  const opacity = Math.min(elapsed / 8, 1);

  return React.createElement('span', {
    style: {
      ...style,
      opacity,
      fontVariantLigatures: 'none', // prevent ligatures messing up monospace feel
    },
  }, chars.join(''));
};

module.exports = { ScrambleText };
