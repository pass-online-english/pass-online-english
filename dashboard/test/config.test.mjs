import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, publicConfig, activeCalendars } from '../src/config.js';

test('環境変数なしでも妥当なデフォルトになる', () => {
  const c = loadConfig({});
  assert.equal(c.timezone, 'Asia/Tokyo');
  assert.equal(c.daysToDisplay, 7);
  assert.equal(c.tonightStartTime, '17:00');
  assert.equal(c.weatherThresholds.rainPop, 50);
});

test('CONFIG_JSON が深くマージされる', () => {
  const c = loadConfig({
    CONFIG_JSON: JSON.stringify({
      weatherThresholds: { rainPop: 30 },
      calendars: [{ calendarId: 'a@example.com', displayName: '夫', color: '#111', person: 'me' }],
    }),
  });
  assert.equal(c.weatherThresholds.rainPop, 30);
  assert.equal(c.weatherThresholds.hotTemp, 33, '指定していない閾値は既定値のまま');
  assert.equal(c.calendars.length, 1);
  assert.equal(c.calendars[0].key, 'me');
  assert.equal(c.calendars[0].enabled, true);
});

test('個別の環境変数が CONFIG_JSON より優先される', () => {
  const c = loadConfig({ CONFIG_JSON: JSON.stringify({ timezone: 'UTC' }), TIMEZONE: 'Asia/Tokyo', MAX_TASKS: '8' });
  assert.equal(c.timezone, 'Asia/Tokyo');
  assert.equal(c.maxTasks, 8);
});

test('壊れた JSON は警告になり、落ちない', () => {
  const c = loadConfig({ CONFIG_JSON: '{ broken' });
  assert.equal(c.warnings.length, 1);
  assert.equal(c.timezone, 'Asia/Tokyo');
});

test('publicConfig は calendarId を含まない', () => {
  const c = loadConfig({ CONFIG_JSON: JSON.stringify({ calendars: [{ calendarId: 'secret@example.com', displayName: '妻', person: 'wife' }] }) });
  const pub = JSON.stringify(publicConfig(c));
  assert.ok(!pub.includes('secret@example.com'));
  assert.ok(pub.includes('妻'));
});

test('activeCalendars は無効/未設定を除外する', () => {
  const c = loadConfig({});
  assert.deepEqual(activeCalendars(c).map((x) => x.key), ['me']);
});
