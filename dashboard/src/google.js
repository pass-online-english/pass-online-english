// Google Calendar / Google Tasks 連携。すべてサーバー側で完結させ、
// client_secret / refresh_token / access_token をブラウザへ渡さない(要件21)。

import { dayKey, localToMs, addDays, partsFor } from './time.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const TASKS_API = 'https://tasks.googleapis.com/tasks/v1';

export function hasGoogleCredentials(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN);
}

/** refresh_token から access_token を取得（有効期限まで KV にキャッシュ） */
export async function getAccessToken(env, store) {
  const cacheKey = 'google:access_token';
  const cached = await store.get(cacheKey);
  if (cached && cached.expiresAt - 60000 > Date.now()) return cached.token;

  const body = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: env.GOOGLE_REFRESH_TOKEN,
    grant_type: 'refresh_token',
  });

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    // invalid_grant = リフレッシュトークン失効。README の再取得手順が必要。
    throw new Error('Googleトークン更新に失敗 (' + res.status + '): ' + text.slice(0, 200));
  }
  const json = JSON.parse(text);
  const token = json.access_token;
  const expiresAt = Date.now() + (Number(json.expires_in) || 3600) * 1000;
  await store.put(cacheKey, { token, expiresAt }, Math.max(60, Math.floor((expiresAt - Date.now()) / 1000)));
  return token;
}

async function googleGet(url, token) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(res.status + ' ' + text.slice(0, 160));
  }
  return res.json();
}

function isImportant(config, calendar, summary) {
  const cu = config.comingUp || {};
  if (cu.importantCalendarId && calendar.calendarId === cu.importantCalendarId) return true;
  const tags = cu.importantTags || [];
  const title = String(summary || '');
  return tags.some((tag) => tag && title.indexOf(tag) >= 0);
}

/** Google の event を画面用に正規化する */
export function normalizeEvent(raw, calendar, config, offsetMin) {
  const allDay = Boolean(raw.start && raw.start.date && !raw.start.dateTime);
  let startMs;
  let endMs;
  let startDay;
  let endDay;

  if (allDay) {
    startDay = raw.start.date;
    // Google の終日イベントの end.date は「翌日」（排他的）
    const exclusiveEnd = (raw.end && raw.end.date) || addDays(startDay, 1);
    endDay = addDays(exclusiveEnd, -1);
    if (endDay < startDay) endDay = startDay;
    startMs = localToMs(startDay, offsetMin, 0, 0);
    endMs = localToMs(exclusiveEnd, offsetMin, 0, 0);
  } else {
    startMs = Date.parse(raw.start.dateTime);
    endMs = raw.end && raw.end.dateTime ? Date.parse(raw.end.dateTime) : startMs + 3600000;
    startDay = dayKey(startMs, offsetMin);
    endDay = dayKey(Math.max(startMs, endMs - 1), offsetMin);
  }

  const p = allDay ? null : partsFor(startMs, offsetMin);
  return {
    id: calendar.key + ':' + (raw.id || String(startMs)),
    calendarKey: calendar.key,
    calendarName: calendar.displayName,
    color: calendar.color,
    person: calendar.person,
    title: raw.summary || '(タイトルなし)',
    location: raw.location || '',
    allDay,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    startMs,
    endMs,
    startDay,
    endDay,
    startMinutes: p ? p.hour * 60 + p.minute : null,
    important: isImportant(config, calendar, raw.summary),
  };
}

/**
 * 有効な全カレンダーの予定をまとめて取得する。
 * 一部のカレンダーが失敗しても、取得できた分は返す(要件23)。
 */
export async function fetchCalendarEvents(config, env, store, options = {}) {
  const offsetMin = options.offsetMin;
  const today = options.today || dayKey(Date.now(), offsetMin);
  const lookaheadDays = Math.max(
    Number(config.daysToDisplay) || 7,
    (config.comingUp && config.comingUp.lookaheadDays) || 30,
  );
  const timeMin = new Date(localToMs(today, offsetMin, 0, 0)).toISOString();
  const timeMax = new Date(localToMs(addDays(today, lookaheadDays + 1), offsetMin, 0, 0)).toISOString();

  const calendars = config.calendars.filter((c) => c.enabled && c.calendarId);
  if (!calendars.length) throw new Error('有効なカレンダーが設定されていません（CONFIG_JSON.calendars を確認してください）');

  const token = await getAccessToken(env, store);
  const results = await Promise.all(calendars.map(async (cal) => {
    const url = CALENDAR_API + '/calendars/' + encodeURIComponent(cal.calendarId) + '/events'
      + '?singleEvents=true&orderBy=startTime&maxResults=250'
      + '&timeMin=' + encodeURIComponent(timeMin)
      + '&timeMax=' + encodeURIComponent(timeMax)
      + '&timeZone=' + encodeURIComponent(config.timezone);
    try {
      const json = await googleGet(url, token);
      const events = (json.items || [])
        .filter((it) => it.status !== 'cancelled' && it.start)
        .map((it) => normalizeEvent(it, cal, config, offsetMin));
      return { key: cal.key, name: cal.displayName, ok: true, events };
    } catch (e) {
      return { key: cal.key, name: cal.displayName, ok: false, error: e.message, events: [] };
    }
  }));

  const failures = results.filter((r) => !r.ok);
  if (failures.length === results.length) {
    throw new Error('全カレンダーの取得に失敗: ' + failures.map((f) => f.name + '=' + f.error).join(' / '));
  }

  const events = results
    .reduce((acc, r) => acc.concat(r.events), [])
    .sort((a, b) => a.startMs - b.startMs || (a.allDay === b.allDay ? 0 : a.allDay ? -1 : 1));

  return {
    fetchedAt: Date.now(),
    rangeStart: timeMin,
    rangeEnd: timeMax,
    events,
    errors: failures.map((f) => ({ calendar: f.name, error: f.error })),
  };
}

/** Google Tasks の task を正規化する（未完了のみ） */
export function normalizeTask(raw, list) {
  const due = raw.due ? String(raw.due).slice(0, 10) : null; // Google Tasks の due は日付単位
  return {
    id: list.id + ':' + raw.id,
    title: raw.title || '(無題のタスク)',
    notes: raw.notes || '',
    due,
    listId: list.id,
    listName: list.name,
    position: raw.position || '',
  };
}

export async function fetchTasks(config, env, store) {
  const lists = (config.taskLists || []).filter((l) => l.enabled);
  if (!lists.length) throw new Error('有効なタスクリストが設定されていません');

  const token = await getAccessToken(env, store);
  const results = await Promise.all(lists.map(async (list) => {
    const url = TASKS_API + '/lists/' + encodeURIComponent(list.id) + '/tasks'
      + '?showCompleted=false&showHidden=false&maxResults=100';
    try {
      const json = await googleGet(url, token);
      const tasks = (json.items || [])
        .filter((t) => t.status !== 'completed' && !t.deleted)
        .map((t) => normalizeTask(t, list));
      return { ok: true, name: list.name, tasks };
    } catch (e) {
      return { ok: false, name: list.name, error: e.message, tasks: [] };
    }
  }));

  const failures = results.filter((r) => !r.ok);
  if (failures.length === results.length) {
    throw new Error('タスク取得に失敗: ' + failures.map((f) => f.name + '=' + f.error).join(' / '));
  }

  const tasks = results.reduce((acc, r) => acc.concat(r.tasks), []).sort((a, b) => {
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due) return -1;
    if (b.due) return 1;
    return a.position < b.position ? -1 : 1;
  });

  return {
    fetchedAt: Date.now(),
    tasks,
    errors: failures.map((f) => ({ list: f.name, error: f.error })),
  };
}
