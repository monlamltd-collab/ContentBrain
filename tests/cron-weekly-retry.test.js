const { test } = require('node:test');
const assert = require('node:assert/strict');

const CRON_JOBS_PATH = require.resolve('../lib/cron-jobs');
const PUBLISH_PATH = require.resolve('../lib/publish');
const TELEGRAM_PATH = require.resolve('../lib/telegram');
const SUPABASE_PATH = require.resolve('../lib/supabase');
const LOT_FLOW_PATH = require.resolve('../lib/lot-flow');
const GENERATE_PATH = require.resolve('../lib/generate');
const NODE_CRON_PATH = require.resolve('node-cron');

function putMock(path, exports) {
  require.cache[path] = { id: path, filename: path, loaded: true, exports };
}

test('runWeeklyReels retries only failed archetypes after partial success and never duplicates successes', async () => {
  for (const p of [CRON_JOBS_PATH, PUBLISH_PATH, TELEGRAM_PATH, SUPABASE_PATH, LOT_FLOW_PATH]) {
    delete require.cache[p];
  }

  const calls = [];
  putMock(PUBLISH_PATH, { publish: async () => ({}) });
  putMock(TELEGRAM_PATH, {
    sendNotification: async () => {},
    sendPostForReview: async () => ({ ok: true }),
  });
  putMock(SUPABASE_PATH, {
    getApprovedPosts: async () => [],
    updatePostStatus: async () => {},
  });
  putMock(LOT_FLOW_PATH, {
    runWeeklySuperlatives: async options => {
      calls.push(options);
      if (calls.length === 1) {
        return {
          generated: 4,
          failed: 1,
          skipped: 0,
          failures: [{ superlative: 'worst-lot-week', error: 'render failed' }],
        };
      }
      return { generated: 1, failed: 0, skipped: 0, failures: [] };
    },
  });

  const { runWeeklyReels } = require('../lib/cron-jobs');
  await runWeeklyReels();
  await runWeeklyReels();
  await runWeeklyReels();

  assert.deepEqual(calls, [
    {},
    { archetypes: ['worst-lot-week'] },
  ]);
  assert.equal(calls.length, 2, 'successful archetypes must not be regenerated and completion must stick');
});

test('runGenerate permits retry after generation throws', async () => {
  for (const p of [CRON_JOBS_PATH, PUBLISH_PATH, TELEGRAM_PATH, SUPABASE_PATH, GENERATE_PATH]) {
    delete require.cache[p];
  }

  let runs = 0;
  putMock(PUBLISH_PATH, { publish: async () => ({}) });
  putMock(TELEGRAM_PATH, { sendNotification: async () => {}, sendPostForReview: async () => ({ ok: true }) });
  putMock(SUPABASE_PATH, { getApprovedPosts: async () => [], updatePostStatus: async () => {} });
  putMock(GENERATE_PATH, {
    generateBatch: async () => {
      runs++;
      throw new Error('malformed model output');
    },
  });

  const { runGenerate } = require('../lib/cron-jobs');
  await runGenerate();
  await runGenerate();

  assert.equal(runs, 2, 'a failed batch must not mark the day complete');
});

test('registerCronJobs staggers Phase G away from the legacy 07:00 browser job', () => {
  delete require.cache[CRON_JOBS_PATH];
  delete require.cache[NODE_CRON_PATH];
  const schedules = [];
  putMock(NODE_CRON_PATH, { schedule: expression => { schedules.push(expression); } });
  putMock(PUBLISH_PATH, { publish: async () => ({}) });
  putMock(TELEGRAM_PATH, { sendNotification: async () => {}, sendPostForReview: async () => ({ ok: true }) });
  putMock(SUPABASE_PATH, { getApprovedPosts: async () => [], updatePostStatus: async () => {} });

  const { registerCronJobs } = require('../lib/cron-jobs');
  registerCronJobs();

  assert.equal(schedules.filter(expression => expression === '0 7 * * *').length, 1);
  assert.ok(schedules.includes('15 7 * * 2,4'), 'queued blog cards must only sweep on Tuesday/Thursday');
  assert.ok(schedules.includes('30 7 * * *'));
});
