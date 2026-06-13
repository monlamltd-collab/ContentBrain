// scripts/higgsfield-smoke.js — manual one-shot Higgsfield check.
// Submits ONE cheapest Soul image generation end-to-end (submit → poll →
// download to output/) and prints every id involved. Costs credits — run
// deliberately:  node scripts/higgsfield-smoke.js ["custom prompt"]
require('dotenv').config();
const hf = require('../lib/higgsfield');

(async () => {
  if (!hf.isHiggsfieldConfigured()) {
    console.error('Not configured — set HIGGSFIELD_API_KEY and HIGGSFIELD_API_SECRET in .env');
    process.exit(1);
  }

  const prompt = process.argv[2]
    || 'Georgian terraced houses on a quiet London street at golden hour, cinematic, shallow depth of field';
  console.log(`Model:  ${hf.MODELS.soulImage}`);
  console.log(`Prompt: ${prompt}`);

  const { request_id } = await hf.submitGeneration(hf.MODELS.soulImage, {
    prompt,
    aspect_ratio: '1:1',
    resolution: '720p',
  });
  console.log(`Submitted: request_id=${request_id}`);

  const result = await hf.waitForCompletion(request_id, { timeoutMs: 240000, pollMs: 4000 });
  console.log(`Status: ${result.status}`);
  if (result.status !== 'completed') {
    console.error(hf.classifyError(result.status).userMessage);
    process.exit(1);
  }

  console.log(`Assets: ${result.assets.length}`);
  for (const asset of result.assets) {
    const { filename, outputPath } = await hf.downloadAsset(asset.url, 'smoke-soul');
    console.log(`  ${asset.kind} → ${outputPath} (${filename})`);
  }
  console.log('Smoke test passed.');
})().catch(err => {
  console.error('Smoke test failed:', err.message);
  process.exit(1);
});
