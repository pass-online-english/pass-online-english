import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDayComments, buildTonightComments, describeCode } from '../src/weather.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({});

function hours(date, popByHour) {
  return Array.from({ length: 24 }, (_, h) => ({
    time: `${date}T${String(h).padStart(2, '0')}:00`,
    date, hour: h, temp: 20, pop: popByHour(h), precip: 0, code: 3,
  }));
}

test('18時以降に雨なら「18時以降 雨 / 傘推奨」', () => {
  const daily = [{ date: '2026-08-31', code: 61, icon: '☂', label: '小雨', tmax: 26, tmin: 20, pop: 80, precipSum: 2, uv: 3, wind: 3 }];
  const hourly = hours('2026-08-31', (h) => (h >= 18 ? 80 : 10));
  const c = buildDayComments(config, daily, hourly, '2026-08-31', { fromHour: 9 });
  assert.equal(c[0].icon, '☂');
  assert.equal(c[0].text, '18時以降 雨');
  assert.equal(c[0].detail, '傘推奨');
});

test('猛暑日は最高気温と注意コメント', () => {
  const daily = [{ date: '2026-08-01', code: 0, icon: '☀', label: '快晴', tmax: 36, tmin: 27, pop: 0, precipSum: 0, uv: 9, wind: 2 }];
  const c = buildDayComments(config, daily, hours('2026-08-01', () => 0), '2026-08-01', {});
  assert.ok(c.some((x) => x.text === '最高36℃' && x.detail.includes('猛暑')));
});

test('寒暖差が大きい日は羽織るもの推奨', () => {
  const daily = [{ date: '2026-10-20', code: 1, icon: '🌤', label: '晴れ', tmax: 24, tmin: 12, pop: 0, precipSum: 0, uv: 4, wind: 2 }];
  const c = buildDayComments(config, daily, hours('2026-10-20', () => 0), '2026-10-20', {});
  assert.ok(c.some((x) => x.text === '朝晩の寒暖差大' && x.detail === '羽織るもの推奨'));
});

test('閾値は設定で変更できる', () => {
  const strict = loadConfig({ CONFIG_JSON: JSON.stringify({ weatherThresholds: { rainPop: 95 } }) });
  const daily = [{ date: '2026-08-31', code: 61, icon: '☂', label: '雨', tmax: 26, tmin: 22, pop: 80, precipSum: 1, uv: 3, wind: 2 }];
  const hourly = hours('2026-08-31', () => 80);
  assert.ok(!buildDayComments(strict, daily, hourly, '2026-08-31', {}).some((x) => x.detail === '傘推奨'));
  assert.ok(buildDayComments(config, daily, hourly, '2026-08-31', {}).some((x) => x.detail === '傘推奨'));
});

test('穏やかな晴天は洗濯日和', () => {
  const daily = [{ date: '2026-05-05', code: 0, icon: '☀', label: '快晴', tmax: 24, tmin: 16, pop: 0, precipSum: 0, uv: 5, wind: 2 }];
  const c = buildDayComments(config, daily, hours('2026-05-05', () => 0), '2026-05-05', {});
  assert.equal(c.length, 1);
  assert.equal(c[0].text, '洗濯日和');
});

test('TONIGHT は tonightStartTime 以降だけを見る', () => {
  const hourly = hours('2026-08-31', (h) => (h < 12 ? 90 : 0));
  assert.equal(buildTonightComments(config, hourly, '2026-08-31').length, 0);
  const evening = hours('2026-08-31', (h) => (h >= 19 ? 90 : 0));
  assert.equal(buildTonightComments(config, evening, '2026-08-31')[0].text, '19時以降 雨');
});

test('未知の天気コードでも落ちない', () => {
  assert.deepEqual(describeCode(12345), { icon: '·', label: '—' });
});
