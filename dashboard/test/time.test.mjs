import test from 'node:test';
import assert from 'node:assert/strict';
import { tzOffsetMinutes, dayKey, addDays, localToMs, hhmmToMinutes, partsFor } from '../src/time.js';

test('Asia/Tokyo のオフセットは +540 分', () => {
  assert.equal(tzOffsetMinutes('Asia/Tokyo', new Date('2026-08-31T00:00:00Z')), 540);
  assert.equal(tzOffsetMinutes('Asia/Tokyo', new Date('2026-01-15T00:00:00Z')), 540);
});

test('UTC 15:00 は東京では翌日 0:00', () => {
  const ms = Date.parse('2026-08-31T15:00:00Z');
  assert.equal(dayKey(ms, 540), '2026-09-01');
  assert.equal(partsFor(ms, 540).hour, 0);
});

test('localToMs はローカル時刻を UTC に戻す', () => {
  assert.equal(new Date(localToMs('2026-08-31', 540, 9, 30)).toISOString(), '2026-08-31T00:30:00.000Z');
});

test('addDays は月をまたぐ', () => {
  assert.equal(addDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
});

test('hhmmToMinutes は不正値でフォールバックする', () => {
  assert.equal(hhmmToMinutes('17:00'), 1020);
  assert.equal(hhmmToMinutes('99:99', 42), 42);
  assert.equal(hhmmToMinutes(null, 7), 7);
});
