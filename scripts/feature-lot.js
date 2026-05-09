#!/usr/bin/env node
// Lot of the Day — manual test harness.
//
// Modes:
//   --dry-run         Picks a lot, generates content, prints it. No DB writes, no Telegram, no render.
//   --archetype=NAME  Override the day's archetype (best-yield | deepest-discount | dev-or-refurb | urgent).
//
// Future modes (to be added when render + Telegram pieces land):
//   --send-to-tg      Insert post row + send Telegram script alert (waits for voice reply).
//   --skip-publish    Render but do not push to Facebook.

require('dotenv').config();
const { pickLotOfTheDay, getScheduleForToday, ARCHETYPES } = require('../lib/lot-picker');
const { findLotsByArchetype, hasFeaturedLot } = require('../lib/supabase');
const { generateLotContent } = require('../lib/lot-content');

function parseArgs(argv) {
  const out = { dryRun: false, archetype: null };
  for (const arg of argv.slice(2)) {
    if (arg === '--dry-run') out.dryRun = true;
    else if (arg.startsWith('--archetype=')) out.archetype = arg.slice('--archetype='.length);
    else if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/feature-lot.js [--dry-run] [--archetype=<name>]');
      console.log(`Archetypes: ${ARCHETYPES.join(', ')}`);
      process.exit(0);
    }
  }
  return out;
}

async function pickFromArchetype(archetype) {
  const candidates = await findLotsByArchetype(archetype, { limit: 30 });
  for (const lot of candidates) {
    if (await hasFeaturedLot(lot.id)) continue;
    return { lot, archetype, fallbackUsed: false };
  }
  throw new Error(`No qualifying candidate for archetype '${archetype}'.`);
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('Lot of the Day — feature-lot.js');
  console.log('================================');

  const schedule = await getScheduleForToday();
  console.log(`Today's scheduled archetype: ${schedule.archetype} (day index ${schedule.dayIndex})`);
  if (args.archetype) console.log(`Override archetype: ${args.archetype}`);

  console.log('\n[1/3] Picking lot...');
  const pick = args.archetype
    ? await pickFromArchetype(args.archetype)
    : await pickLotOfTheDay();

  console.log(`  archetype: ${pick.archetype}${pick.fallbackUsed ? ' (FALLBACK)' : ''}`);
  console.log(`  lot:       ${pick.lot.id}`);
  console.log(`  address:   ${pick.lot.address}`);
  console.log(`  postcode:  ${pick.lot.postcode}`);
  console.log(`  price:     £${pick.lot.price?.toLocaleString('en-GB') || '?'}`);
  console.log(`  score:     ${pick.lot.score}`);
  console.log(`  yield:     ${pick.lot.est_gross_yield}%`);
  console.log(`  discount:  ${pick.lot.below_market}% below market`);
  console.log(`  auction:   ${pick.lot.auction_date}`);
  console.log(`  image:     ${pick.lot.image_url}`);

  console.log('\n[2/3] Generating Claude content...');
  const content = await generateLotContent({ lot: pick.lot, archetype: pick.archetype });

  console.log('\n--- HOOK HEADLINE ---');
  console.log(content.hook_headline);

  console.log('\n--- KEY BULLETS ---');
  for (const b of content.key_bullets) console.log(`• ${b}`);

  console.log('\n--- VOICEOVER SCRIPT ---');
  console.log(content.voiceover_script);

  console.log('\n--- FACEBOOK CAPTION ---');
  console.log(content.caption_facebook);

  if (args.dryRun) {
    console.log('\n[3/3] DRY RUN — exiting without DB writes, Telegram alerts, or render.');
    return;
  }

  console.log('\n[3/3] Live mode is not implemented yet — render + Telegram + publish steps');
  console.log('       land in subsequent commits. Re-run with --dry-run for now.');
}

main().catch(err => {
  console.error('\nFATAL:', err.message);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});
