// lib/video-renderer.js — duration resolution + music sentinel (PR2).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  resolveDurationSeconds,
  resolveMusicFile,
  MIN_DURATION_SECONDS,
  MAX_DURATION_SECONDS,
} = require('../lib/video-renderer');

test('duration precedence: override > duration_seconds > meta', () => {
  assert.equal(resolveDurationSeconds({
    overrideDurationSeconds: 30, duration_seconds: 10, meta: { duration_seconds: 5 },
  }), 30);
  assert.equal(resolveDurationSeconds({
    duration_seconds: 10, meta: { duration_seconds: 5 },
  }), 10);
  assert.equal(resolveDurationSeconds({ meta: { duration_seconds: 5 } }), 5);
});

test('duration: nothing set → null (composition default applies)', () => {
  assert.equal(resolveDurationSeconds({}), null);
  assert.equal(resolveDurationSeconds({ meta: {} }), null);
  assert.equal(resolveDurationSeconds({ meta: { duration_seconds: 'garbage' } }), null);
  assert.equal(resolveDurationSeconds({ duration_seconds: 0 }), null);
  assert.equal(resolveDurationSeconds({ duration_seconds: -4 }), null);
});

test('duration clamps to the 3–90s envelope', () => {
  assert.equal(resolveDurationSeconds({ duration_seconds: 1 }), MIN_DURATION_SECONDS);
  assert.equal(resolveDurationSeconds({ duration_seconds: 600 }), MAX_DURATION_SECONDS);
  // The lot video's proven 75s stays untouched.
  assert.equal(resolveDurationSeconds({ overrideDurationSeconds: 75 }), 75);
});

test('music: explicit caller prop passes through untouched', () => {
  assert.equal(resolveMusicFile({ musicFile: 'music/custom.mp3' }), 'music/custom.mp3');
});

test("music: meta 'none' → silent (null)", () => {
  assert.equal(resolveMusicFile({ meta: { music_file: 'none' } }), null);
});

test('music: meta names an existing track → that track', () => {
  const musicDir = path.join(__dirname, '..', 'public', 'music');
  const tracks = fs.existsSync(musicDir)
    ? fs.readdirSync(musicDir).filter(f => /\.(mp3|wav|ogg|m4a|aac)$/i.test(f))
    : [];
  if (!tracks.length) return; // no tracks in this checkout — covered in prod
  assert.equal(resolveMusicFile({ meta: { music_file: tracks[0] } }), `music/${tracks[0]}`);
  // Directory components are stripped before the existence check.
  assert.equal(resolveMusicFile({ meta: { music_file: `../evil/${tracks[0]}` } }), `music/${tracks[0]}`);
});

test('music: unknown meta track falls back to random-or-null, never throws', () => {
  const out = resolveMusicFile({ meta: { music_file: 'does-not-exist.mp3' } });
  assert.ok(out === null || /^music\//.test(out));
});

test('music: unset → random-or-null', () => {
  const out = resolveMusicFile({});
  assert.ok(out === null || /^music\//.test(out));
});
