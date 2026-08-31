import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore, withFallback } from '../src/cache.js';

test('取得成功で status=ok、TTL 内は上流を叩かない', async () => {
  const store = createStore({});
  let calls = 0;
  const fetcher = async () => { calls++; return { value: calls }; };

  const first = await withFallback({ source: 'unit-a', store, ttlMs: 60000, fetcher });
  assert.equal(first.status, 'ok');
  assert.equal(first.data.value, 1);

  const second = await withFallback({ source: 'unit-a', store, ttlMs: 60000, fetcher });
  assert.equal(calls, 1, 'TTL 内はキャッシュを返す');
  assert.equal(second.servedFromCache, true);

  const forced = await withFallback({ source: 'unit-a', store, ttlMs: 60000, force: true, fetcher });
  assert.equal(calls, 2, 'force=true なら再取得する');
  assert.equal(forced.data.value, 2);
});

test('失敗しても直前の正常データを返し続ける(要件23)', async () => {
  const store = createStore({});
  await withFallback({ source: 'unit-b', store, ttlMs: 0, fetcher: async () => ({ value: 'good' }) });

  const failed = await withFallback({
    source: 'unit-b', store, ttlMs: 0,
    fetcher: async () => { throw new Error('Google API 500'); },
  });
  assert.equal(failed.status, 'error');
  assert.equal(failed.data.value, 'good', '画面は最後の正常データで動き続ける');
  assert.ok(failed.error.includes('Google API 500'));
  assert.ok(failed.lastSuccessAt <= Date.now());
  assert.ok(failed.lastFetchedAt >= failed.lastSuccessAt);
});

test('復旧したら status が ok に戻る(要件24)', async () => {
  const store = createStore({});
  let broken = true;
  const fetcher = async () => { if (broken) throw new Error('offline'); return { value: 'fresh' }; };

  await withFallback({ source: 'unit-c', store, ttlMs: 0, fetcher });
  broken = false;
  const recovered = await withFallback({ source: 'unit-c', store, ttlMs: 0, fetcher });
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.error, null);
  assert.equal(recovered.data.value, 'fresh');
});

test('一度も成功していない状態での失敗は data=null', async () => {
  const store = createStore({});
  const res = await withFallback({ source: 'unit-d', store, ttlMs: 0, fetcher: async () => { throw new Error('boom'); } });
  assert.equal(res.status, 'error');
  assert.equal(res.data, null);
  assert.equal(res.lastSuccessAt, null);
});

test('KV バインディングがあればそちらを使う', async () => {
  const kvData = new Map();
  const env = {
    DASHBOARD_CACHE: {
      async get(key) { return kvData.has(key) ? JSON.parse(kvData.get(key)) : null; },
      async put(key, value) { kvData.set(key, value); },
    },
  };
  const store = createStore(env);
  assert.equal(store.kind, 'kv');
  await withFallback({ source: 'unit-e', store, ttlMs: 60000, fetcher: async () => ({ ok: true }) });
  assert.ok(kvData.has('state:unit-e'));
});
