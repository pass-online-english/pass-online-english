// DEMO_MODE 用のダミーデータ(Phase 1: Google 連携前でも全画面を確認できるようにする)。
// 「今日」を基準に相対生成するので、いつ開いても自然な画面になる。

import { addDays, localToMs, dayKey, partsFor } from './time.js';
import { buildDayComments, buildTonightComments, describeCode } from './weather.js';

function ev(config, key, title, day, startMin, durMin, extra = {}) {
  const cal = config.calendars.find((c) => c.key === key) || config.calendars[0];
  const offsetMin = extra.offsetMin;
  const allDay = startMin === null;
  const startMs = allDay ? localToMs(day, offsetMin, 0, 0) : localToMs(day, offsetMin, Math.floor(startMin / 60), startMin % 60);
  const endMs = allDay ? localToMs(addDays(day, 1), offsetMin, 0, 0) : startMs + durMin * 60000;
  return {
    id: 'demo:' + key + ':' + day + ':' + title,
    calendarKey: cal.key,
    calendarName: cal.displayName,
    color: cal.color,
    person: cal.person,
    title,
    location: extra.location || '',
    allDay,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs,
    startDay: day,
    endDay: allDay ? day : dayKey(endMs - 1, offsetMin),
    startMinutes: allDay ? null : startMin,
    important: Boolean(extra.important),
  };
}

export function demoCalendar(config, offsetMin, today) {
  const o = { offsetMin };
  const d = (n) => addDays(today, n);
  const events = [
    ev(config, 'me', '定例MTG', d(0), 10 * 60, 60, o),
    ev(config, 'wife', 'ヨガ', d(0), 11 * 60, 90, o),
    ev(config, 'me', '歯医者', d(0), 14 * 60, 45, { ...o, location: '銀座' }),
    ev(config, 'shared', '外食（イタリアン）', d(0), 19 * 60 + 30, 120, o),
    ev(config, 'wife', '美容院', d(1), 13 * 60, 120, o),
    ev(config, 'me', '出社', d(1), 9 * 60 + 30, 480, o),
    ev(config, 'shared', '実家へ', d(2), null, 0, o),
    ev(config, 'me', '健康診断', d(3), 8 * 60 + 30, 90, o),
    ev(config, 'wife', 'ランチ会', d(3), 12 * 60, 120, o),
    ev(config, 'me', '打ち合わせ', d(3), 15 * 60, 60, o),
    ev(config, 'me', '納品', d(3), 17 * 60, 60, o),
    ev(config, 'shared', '映画', d(4), 18 * 60, 150, o),
    ev(config, 'wife', 'friends dinner', d(5), 18 * 60 + 30, 150, o),
    ev(config, 'shared', '買い出し', d(6), 11 * 60, 120, o),
    ev(config, 'shared', '旅行（1泊2日）', d(12), null, 0, { ...o, important: true }),
    ev(config, 'me', '通院', d(18), 10 * 60, 60, { ...o, important: true }),
    ev(config, 'shared', '結婚記念日', d(25), null, 0, { ...o, important: true }),
  ].sort((a, b) => a.startMs - b.startMs);

  return { fetchedAt: Date.now(), events, errors: [], demo: true };
}

export function demoTasks(config, offsetMin, today) {
  const d = (n) => addDays(today, n);
  return {
    fetchedAt: Date.now(),
    demo: true,
    errors: [],
    tasks: [
      { id: 'demo:1', title: '経費申請', notes: '', due: d(-2), listId: '@default', listName: 'Tasks', position: '1' },
      { id: 'demo:2', title: '電球を買う', notes: '', due: d(-1), listId: '@default', listName: 'Tasks', position: '2' },
      { id: 'demo:3', title: 'クリーニング受け取り', notes: '', due: d(0), listId: '@default', listName: 'Tasks', position: '3' },
      { id: 'demo:4', title: '燃えないゴミの分別', notes: '', due: d(0), listId: '@default', listName: 'Tasks', position: '4' },
      { id: 'demo:5', title: 'ホテル予約', notes: '', due: d(2), listId: '@default', listName: 'Tasks', position: '5' },
      { id: 'demo:6', title: '両親へ電話', notes: '', due: d(3), listId: '@default', listName: 'Tasks', position: '6' },
      { id: 'demo:7', title: '保険の見直し', notes: '', due: d(9), listId: '@default', listName: 'Tasks', position: '7' },
      { id: 'demo:8', title: '本を返却', notes: '', due: null, listId: '@default', listName: 'Tasks', position: '8' },
      { id: 'demo:9', title: '写真の整理', notes: '', due: null, listId: '@default', listName: 'Tasks', position: '9' },
    ],
  };
}

export function demoWeather(config, offsetMin, today) {
  const codes = [3, 61, 1, 0, 2, 80, 3, 1];
  const daily = [];
  const span = Math.max(8, (Number(config.weekStartOffset) || 0) + (Number(config.daysToDisplay) || 7) + 1);
  for (let i = 0; i < span; i++) {
    const date = addDays(today, i);
    const code = codes[i % codes.length];
    daily.push({
      date,
      code,
      ...describeCode(code),
      tmax: 26 + ((i * 3) % 9),
      tmin: 15 + ((i * 2) % 6),
      pop: [60, 80, 10, 0, 20, 70, 40, 10][i % 8],
      precipSum: [2.4, 8.1, 0, 0, 0.2, 5.5, 1.1, 0][i % 8],
      sunrise: '05:12',
      sunset: '18:04',
      uv: 6 + (i % 4),
      wind: 3 + (i % 7),
    });
  }
  const hourly = [];
  for (let i = 0; i < 3; i++) {
    const date = addDays(today, i);
    for (let h = 0; h < 24; h++) {
      hourly.push({
        time: date + 'T' + (h < 10 ? '0' + h : h) + ':00',
        date,
        hour: h,
        temp: 18 + Math.round(8 * Math.sin(((h - 4) / 24) * Math.PI * 2)),
        pop: h >= 18 ? 70 : h >= 15 ? 40 : 10,
        precip: h >= 18 ? 1.2 : 0,
        code: h >= 18 ? 61 : 3,
      });
    }
  }
  const nowHour = partsFor(Date.now(), offsetMin).hour;
  const current = {
    temp: 22.4,
    apparent: 23.1,
    humidity: 62,
    precipitation: 0,
    wind: 2.6,
    code: 3,
    isDay: nowHour >= 6 && nowHour < 18,
    ...describeCode(3),
  };
  return {
    fetchedAt: Date.now(),
    demo: true,
    locationName: config.locationName,
    current,
    daily,
    hourly,
    comments: {
      today: buildDayComments(config, daily, hourly, today, { fromHour: nowHour }),
      tonight: buildTonightComments(config, hourly, today),
      tomorrow: buildDayComments(config, daily, hourly, addDays(today, 1), {}),
    },
  };
}
