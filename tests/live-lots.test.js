'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  SENTINEL_AUCTION_DATE,
  REAL_DATE_BEFORE,
  isRealAuctionDate,
  isSentinelDate,
  liveInventoryOrClause,
  applyTraditionalLiveWindow,
  rejectNonActionableLiveRows,
  todayUTC,
  daysAheadUTC,
} = require('../lib/live-lots');

describe('live-lots date guards', () => {
  it('classifies real vs sentinel dates', () => {
    assert.equal(isRealAuctionDate('2026-08-26'), true);
    assert.equal(isRealAuctionDate(SENTINEL_AUCTION_DATE), false);
    assert.equal(isSentinelDate(SENTINEL_AUCTION_DATE), true);
    assert.equal(isRealAuctionDate(null), false);
  });

  it('liveInventoryOrClause excludes unbounded future sentinel from traditionals', () => {
    const clause = liveInventoryOrClause({
      today: '2026-07-24',
      horizonEnd: '2026-08-07',
      mmoaStaleDays: 30,
      now: new Date('2026-07-24T12:00:00Z'),
    });
    assert.match(clause, /auction_date\.gte\.2026-07-24/);
    assert.match(clause, new RegExp(`auction_date\\.lt\\.${REAL_DATE_BEFORE}`));
    assert.match(clause, /auction_date\.eq\.2099-12-31/);
    assert.match(clause, /auction_date\.is\.null/);
    assert.doesNotMatch(clause, /auction_date\.lte\.2099/);
  });

  it('applyTraditionalLiveWindow chains gte/lt(/lte)/status', () => {
    const calls = [];
    const qb = {
      gte(col, val) { calls.push(['gte', col, val]); return this; },
      lt(col, val) { calls.push(['lt', col, val]); return this; },
      lte(col, val) { calls.push(['lte', col, val]); return this; },
      eq(col, val) { calls.push(['eq', col, val]); return this; },
    };
    applyTraditionalLiveWindow(qb, {
      today: '2026-07-24',
      horizonEnd: '2026-08-07',
      requireAvailable: true,
    });
    assert.deepEqual(calls, [
      ['gte', 'auction_date', '2026-07-24'],
      ['lt', 'auction_date', REAL_DATE_BEFORE],
      ['lte', 'auction_date', '2026-08-07'],
      ['eq', 'status', 'available'],
    ]);
  });
});

describe('rejectNonActionableLiveRows', () => {
  const today = '2026-07-24';
  const rows = [
    { id: 'trad-future', auction_date: '2026-08-01', status: 'available' },
    { id: 'sentinel', auction_date: SENTINEL_AUCTION_DATE, status: 'available' },
    { id: 'past', auction_date: '2026-06-01', status: 'available' },
    { id: 'null-mmoa', auction_date: null, status: 'available' },
    { id: 'sold', auction_date: '2026-08-01', status: 'sold' },
  ];

  it('keeps traditional futures and optional null/sentinel mmoa when not traditionalOnly', () => {
    const out = rejectNonActionableLiveRows(rows, { today });
    const ids = out.map((r) => r.id);
    assert.ok(ids.includes('trad-future'));
    assert.ok(ids.includes('sentinel'));
    assert.ok(ids.includes('null-mmoa'));
    assert.ok(!ids.includes('past'));
  });

  it('traditionalOnly drops sentinel and null dates', () => {
    const out = rejectNonActionableLiveRows(rows, { today, traditionalOnly: true });
    const ids = out.map((r) => r.id);
    assert.deepEqual(ids, ['trad-future', 'sold']);
  });
});

describe('day helpers', () => {
  it('todayUTC and daysAheadUTC format YYYY-MM-DD', () => {
    const now = new Date('2026-07-24T15:00:00Z');
    assert.equal(todayUTC(now), '2026-07-24');
    assert.equal(daysAheadUTC(14, now), '2026-08-07');
  });
});
