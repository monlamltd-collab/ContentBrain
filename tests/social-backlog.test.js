const test = require('node:test');
const assert = require('node:assert/strict');

const { archiveDraftSocialPosts } = require('../lib/supabase');

test('legacy cleanup only targets old draft rows with a social platform', async () => {
  const calls = [];
  const query = {
    from(table) { calls.push(['from', table]); return this; },
    update(values) { calls.push(['update', values]); return this; },
    eq(column, value) { calls.push(['eq', column, value]); return this; },
    not(column, operator, value) { calls.push(['not', column, operator, value]); return this; },
    lte(column, value) { calls.push(['lte', column, value]); return this; },
    select(columns) {
      calls.push(['select', columns]);
      return Promise.resolve({ data: [{ id: 'a' }, { id: 'b' }], error: null });
    },
  };

  const count = await archiveDraftSocialPosts(query, '2026-07-22T23:59:59.999Z');

  assert.equal(count, 2);
  assert.deepEqual(calls, [
    ['from', 'posts'],
    ['update', {
      status: 'rejected',
      rejection_feedback: 'Archived when automatic social generation was disabled',
    }],
    ['eq', 'status', 'draft'],
    ['not', 'platform', 'is', null],
    ['lte', 'created_at', '2026-07-22T23:59:59.999Z'],
    ['select', 'id'],
  ]);
});
