const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const VOICEOVER_DIR = path.join(__dirname, '..', 'public', 'voiceover');

// Find Remotion's bundled ffmpeg
function findFfmpeg() {
  try {
    // Remotion bundles ffmpeg — check common locations
    const remotionPath = require.resolve('@remotion/renderer');
    const remotionDir = path.dirname(remotionPath);

    // Check platform-specific paths
    const candidates = [
      path.join(remotionDir, '..', 'node_modules', '.cache', 'remotion', 'ffmpeg'),
      path.join(remotionDir, '..', '..', '.cache', 'remotion', 'ffmpeg'),
    ];

    // Also check system path
    try {
      execSync('ffmpeg -version', { stdio: 'ignore' });
      return 'ffmpeg';
    } catch {}

    // Check if Remotion can find it for us
    try {
      const { getExecutablePath } = require('@remotion/renderer');
      if (getExecutablePath) {
        const p = getExecutablePath('ffmpeg');
        if (p && fs.existsSync(p)) return p;
      }
    } catch {}

    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
      if (fs.existsSync(c + '.exe')) return c + '.exe';
    }

    throw new Error('ffmpeg not found. Install ffmpeg or ensure @remotion/renderer is installed.');
  } catch (err) {
    throw new Error('Could not locate ffmpeg: ' + err.message);
  }
}

/**
 * Process a raw voiceover recording to sound polished:
 * - Noise gate (remove background hiss)
 * - High-pass filter (cut rumble below 80Hz)
 * - Presence boost (2-5kHz for clarity)
 * - Compression (even out levels)
 * - Light reverb (small room polish)
 * - Normalise volume
 */
function processVoiceover(inputPath, outputFilename) {
  const ffmpeg = findFfmpeg();
  const outputPath = path.join(VOICEOVER_DIR, outputFilename);

  if (!fs.existsSync(VOICEOVER_DIR)) {
    fs.mkdirSync(VOICEOVER_DIR, { recursive: true });
  }

  // Audio filter chain:
  // 1. highpass at 80Hz — cut room rumble
  // 2. lowpass at 14kHz — cut hiss
  // 3. equalizer boost at 3kHz — presence/clarity
  // 4. acompressor — even out dynamics
  // 5. aecho — very subtle room reverb
  // 6. loudnorm — normalise to broadcast levels
  const filters = [
    'highpass=f=80',
    'lowpass=f=14000',
    'equalizer=f=3000:t=q:w=1.5:g=3',
    'equalizer=f=200:t=q:w=2:g=-2',
    'acompressor=threshold=-20dB:ratio=3:attack=5:release=50:makeup=2',
    'aecho=0.8:0.7:15:0.15',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
  ].join(',');

  console.log(`  Processing voiceover: ${path.basename(inputPath)} -> ${outputFilename}`);
  // execFileSync with argv array — no shell parsing, so paths with
  // metacharacters can't inject commands.
  execFileSync(ffmpeg, ['-i', inputPath, '-af', filters, '-ar', '44100', '-ac', '1', '-y', outputPath], { stdio: 'inherit' });
  console.log(`  Done: ${outputPath}`);

  return outputPath;
}

/**
 * Process all raw recordings in a source directory
 */
function processAllVoiceovers(sourceDir) {
  if (!fs.existsSync(sourceDir)) {
    console.log('No source directory found:', sourceDir);
    return [];
  }

  const files = fs.readdirSync(sourceDir).filter(f =>
    /\.(wav|mp3|m4a|ogg|webm|aac)$/i.test(f)
  );

  const results = [];
  for (const file of files) {
    const inputPath = path.join(sourceDir, file);
    const outputName = file.replace(/\.[^.]+$/, '-processed.mp3');
    try {
      const outputPath = processVoiceover(inputPath, outputName);
      results.push({ input: file, output: outputName, outputPath });
    } catch (err) {
      console.error(`  Failed to process ${file}: ${err.message}`);
    }
  }
  return results;
}

module.exports = { processVoiceover, processAllVoiceovers, findFfmpeg };
