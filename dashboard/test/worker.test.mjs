import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

const ENV = { DEMO_MODE: '1', DASHBOARD_TOKEN: 'testtoken', TIMEZONE: 'Asia/Tokyo' };
const get = (path, headers = {}) => worker.fetch(new Request('https://dash.example' + path, { headers }), ENV, {});
const AUTH = { Cookie: 'hd_device=testtoken' };

test('未認証の API は 401 JSON', async () => {
  const res = await get('/api/config');
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.length > 0, true);
});

test('未認証の画面は 401 HTML（アプリ本体を返さない）', async () => {
  const res = await get('/');
  assert.equal(res.status, 401);
  assert.match(res.headers.get('Content-Type'), /text\/html/);
  assert.ok(!(await res.text()).includes('app.js'));
});

test('?token= はリダイレクトして Cookie を発行する', async () => {
  const res = await get('/?token=testtoken');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('Location'), '/');
  assert.match(res.headers.get('Set-Cookie'), /hd_device=testtoken.*HttpOnly.*Secure/);
});

test('/api/config は秘密情報を含まない', async () => {
  const res = await get('/api/config', AUTH);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(!body.includes('testtoken'), 'デバイストークンが漏れていない');
  assert.ok(!/refresh_token|client_secret|calendarId/i.test(body), '認証情報・カレンダーIDが漏れていない');
  const json = JSON.parse(body);
  assert.equal(json.config.timezone, 'Asia/Tokyo');
  assert.equal(json.config.tzOffsetMinutes, 540);
  assert.equal(json.config.demoMode, true);
  assert.ok(json.config.refresh.calendar >= 30000);
});

test('/api/calendar はソース状態付きで返る', async () => {
  const res = await get('/api/calendar', AUTH);
  const json = await res.json();
  assert.equal(json.source, 'calendar');
  assert.equal(json.status, 'ok');
  assert.ok(json.lastSuccessAt > 0);
  assert.ok(Array.isArray(json.data.events));
  const e = json.data.events[0];
  for (const k of ['title', 'startMs', 'endMs', 'startDay', 'endDay', 'allDay', 'color', 'person', 'calendarName']) {
    assert.ok(k in e, k + ' が含まれる');
  }
});

test('/api/tasks は未完了タスクのみ返る', async () => {
  const json = await (await get('/api/tasks', AUTH)).json();
  assert.equal(json.status, 'ok');
  assert.ok(json.data.tasks.length > 0);
});

test('/api/health は各ソースの状態を返す', async () => {
  await get('/api/calendar', AUTH);
  const json = await (await get('/api/health', AUTH)).json();
  assert.equal(json.timezone, 'Asia/Tokyo');
  assert.deepEqual(json.sources.map((s) => s.source), ['calendar', 'tasks', 'weather']);
});

test('POST は拒否される（閲覧専用）', async () => {
  const res = await worker.fetch(new Request('https://dash.example/api/config', { method: 'POST', headers: AUTH }), ENV, {});
  assert.equal(res.status, 405);
});

test('シークレット未設定なら 503 で起動しない', async () => {
  const res = await worker.fetch(new Request('https://dash.example/api/config'), { DEMO_MODE: '1' }, {});
  assert.equal(res.status, 503);
});

test('認証済みなら静的アセットを返す', async () => {
  const env = { ...ENV, ASSETS: { fetch: async () => new Response('<html>ok</html>', { headers: { 'Content-Type': 'text/html' } }) } };
  const res = await worker.fetch(new Request('https://dash.example/', { headers: AUTH }), env, {});
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-cache');
});
