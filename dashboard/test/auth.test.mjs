import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate, parseCookies, safeEqual, deviceCookieHeader } from '../src/auth.js';
import { createStore } from '../src/cache.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig({ AUTHORIZED_USERS: 'me@example.com,wife@example.com' });
const store = createStore({});
const req = (url, headers = {}) => new Request(url, { headers });

test('Cookie を解析できる', () => {
  const c = parseCookies(req('https://x.example/', { Cookie: 'hd_device=abc; CF_Authorization=xyz' }));
  assert.equal(c.hd_device, 'abc');
  assert.equal(c.CF_Authorization, 'xyz');
});

test('safeEqual は長さ違い・値違いを弾く', () => {
  assert.equal(safeEqual('secret', 'secret'), true);
  assert.equal(safeEqual('secret', 'secrez'), false);
  assert.equal(safeEqual('secret', 'secret2'), false);
  assert.equal(safeEqual('', ''), true);
});

test('シークレット未設定なら 503（誰でも見える状態にはしない）', async () => {
  const res = await authenticate(req('https://x.example/'), {}, config, store);
  assert.equal(res.ok, false);
  assert.equal(res.status, 503);
});

test('トークン無しのアクセスは 401', async () => {
  const res = await authenticate(req('https://x.example/'), { DASHBOARD_TOKEN: 'topsecret' }, config, store);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

test('?token= で認証でき、Cookie 発行を指示する', async () => {
  const res = await authenticate(req('https://x.example/?token=topsecret'), { DASHBOARD_TOKEN: 'topsecret' }, config, store);
  assert.equal(res.ok, true);
  assert.equal(res.method, 'device-token');
  assert.equal(res.setToken, 'topsecret');
  const cookie = deviceCookieHeader(res.setToken);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
});

test('誤ったトークンは拒否される', async () => {
  const res = await authenticate(req('https://x.example/?token=wrong'), { DASHBOARD_TOKEN: 'topsecret' }, config, store);
  assert.equal(res.ok, false);
  assert.equal(res.status, 401);
});

test('Cookie / Bearer でも認証できる', async () => {
  const byCookie = await authenticate(req('https://x.example/', { Cookie: 'hd_device=topsecret' }), { DASHBOARD_TOKEN: 'topsecret' }, config, store);
  assert.equal(byCookie.ok, true);
  const byBearer = await authenticate(req('https://x.example/', { Authorization: 'Bearer topsecret' }), { DASHBOARD_TOKEN: 'topsecret' }, config, store);
  assert.equal(byBearer.ok, true);
});

test('署名を検証できない Access JWT は通らない', async () => {
  const bogus = 'eyJhbGciOiJSUzI1NiIsImtpZCI6Im5vcGUifQ.eyJlbWFpbCI6ImF0dGFja2VyQGV4YW1wbGUuY29tIn0.c2ln';
  const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: 'aud' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ keys: [] }), { status: 200 });
  try {
    const res = await authenticate(req('https://x.example/', { 'Cf-Access-Jwt-Assertion': bogus }), env, config, store);
    assert.equal(res.ok, false);
    assert.equal(res.status, 401);
    assert.match(res.message, /署名鍵が見つかりません/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
