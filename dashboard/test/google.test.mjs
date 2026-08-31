import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent, normalizeTask } from '../src/google.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ CONFIG_JSON: JSON.stringify({ comingUp: { importantCalendarId: 'imp@example.com' } }) });
const cal = { key: 'me', calendarId: 'me@example.com', displayName: '自分', color: '#4FC3F7', person: 'me' };
const TZ = 540;

test('時刻ありイベントを正規化する', () => {
  const e = normalizeEvent({
    id: 'x1', summary: '定例MTG', location: '会議室A',
    start: { dateTime: '2026-08-31T10:00:00+09:00' },
    end: { dateTime: '2026-08-31T11:00:00+09:00' },
  }, cal, config, TZ);
  assert.equal(e.allDay, false);
  assert.equal(e.startDay, '2026-08-31');
  assert.equal(e.startMinutes, 600);
  assert.equal(e.endMs - e.startMs, 3600000);
  assert.equal(e.color, '#4FC3F7');
  assert.equal(e.person, 'me');
});

test('終日イベントの end.date(排他的)を含む日に直す', () => {
  const e = normalizeEvent({
    id: 'x2', summary: '旅行',
    start: { date: '2026-09-12' },
    end: { date: '2026-09-14' },   // Google は「翌日」を返す
  }, cal, config, TZ);
  assert.equal(e.allDay, true);
  assert.equal(e.startDay, '2026-09-12');
  assert.equal(e.endDay, '2026-09-13');
  assert.equal(e.startMinutes, null);
});

test('1日だけの終日イベント', () => {
  const e = normalizeEvent({ id: 'x3', summary: '記念日', start: { date: '2026-09-25' }, end: { date: '2026-09-26' } }, cal, config, TZ);
  assert.equal(e.startDay, '2026-09-25');
  assert.equal(e.endDay, '2026-09-25');
});

test('深夜をまたぐイベントは開始日で扱う', () => {
  const e = normalizeEvent({
    id: 'x4', summary: '会食',
    start: { dateTime: '2026-08-31T22:00:00+09:00' },
    end: { dateTime: '2026-09-01T01:00:00+09:00' },
  }, cal, config, TZ);
  assert.equal(e.startDay, '2026-08-31');
  assert.equal(e.endDay, '2026-09-01');
});

test('重要イベントはカレンダーIDとタグで判定する（AI判定なし）', () => {
  const impCal = { ...cal, key: 'imp', calendarId: 'imp@example.com' };
  const byCalendar = normalizeEvent({ id: 'a', summary: '通院', start: { date: '2026-09-18' }, end: { date: '2026-09-19' } }, impCal, config, TZ);
  const byTag = normalizeEvent({ id: 'b', summary: '★結婚記念日', start: { date: '2026-09-25' }, end: { date: '2026-09-26' } }, cal, config, TZ);
  const normal = normalizeEvent({ id: 'c', summary: '買い物', start: { date: '2026-09-20' }, end: { date: '2026-09-21' } }, cal, config, TZ);
  assert.equal(byCalendar.important, true);
  assert.equal(byTag.important, true);
  assert.equal(normal.important, false);
});

test('タイトルが無いイベントも落ちない', () => {
  const e = normalizeEvent({ id: 'z', start: { dateTime: '2026-08-31T10:00:00+09:00' } }, cal, config, TZ);
  assert.equal(e.title, '(タイトルなし)');
  assert.equal(e.endMs - e.startMs, 3600000, '終了時刻が無ければ1時間とみなす');
});

test('タスクの due は日付単位に正規化される', () => {
  const t = normalizeTask({ id: 't1', title: '経費申請', due: '2026-08-29T00:00:00.000Z' }, { id: '@default', name: 'Tasks' });
  assert.equal(t.due, '2026-08-29');
  const noDue = normalizeTask({ id: 't2', title: '写真整理' }, { id: '@default', name: 'Tasks' });
  assert.equal(noDue.due, null);
});
