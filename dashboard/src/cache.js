// データ種別ごとの状態管理とフォールバック(要件23/24)。
// - 上流取得に成功: 最新データを KV に保存し status='ok'
// - 上流取得に失敗: 直前の正常データを返し status='error'（画面は止めない）
// - KV 未バインド時（ローカル/テスト）は同一 isolate 内のメモリを使う

const memory = new Map();

export function createStore(env) {
  const kv = env && env.DASHBOARD_CACHE ? env.DASHBOARD_CACHE : null;
  if (kv) {
    return {
      kind: 'kv',
      async get(key) {
        try {
          return await kv.get(key, 'json');
        } catch (_e) {
          return memory.get(key) || null;
        }
      },
      async put(key, value, ttlSeconds) {
        memory.set(key, value); // KV の結果整合性を補うローカルミラー
        try {
          const opts = ttlSeconds ? { expirationTtl: Math.max(60, Math.round(ttlSeconds)) } : undefined;
          await kv.put(key, JSON.stringify(value), opts);
        } catch (_e) {
          /* KV 障害時もメモリ側で継続 */
        }
      },
    };
  }
  return {
    kind: 'memory',
    async get(key) {
      return memory.get(key) || null;
    },
    async put(key, value) {
      memory.set(key, value);
    },
  };
}

const STATE_TTL_SECONDS = 60 * 60 * 24 * 7; // 最終正常データは1週間保持

function emptyState(source) {
  return {
    source,
    status: 'unknown',   // ok | stale | error | unknown
    lastFetchedAt: null,
    lastSuccessAt: null,
    error: null,
    data: null,
  };
}

/**
 * ソース単位の「取得 or 直前の正常値」を返す共通処理。
 * @param {object} opts
 * @param {string} opts.source        'calendar' | 'tasks' | 'weather'
 * @param {object} opts.store         createStore() の戻り値
 * @param {number} opts.ttlMs         上流を再取得する最小間隔（サーバー側キャッシュ）
 * @param {boolean} opts.force        ttl を無視して取得
 * @param {() => Promise<any>} opts.fetcher
 */
export async function withFallback(opts) {
  const { source, store, ttlMs, force, fetcher } = opts;
  const key = 'state:' + source;
  const prev = (await store.get(key)) || emptyState(source);
  const now = Date.now();

  const fresh = prev.data && prev.lastSuccessAt && now - prev.lastSuccessAt < ttlMs;
  if (fresh && !force) {
    return { ...prev, status: 'ok', servedFromCache: true, ageMs: now - prev.lastSuccessAt };
  }

  try {
    const data = await fetcher();
    const next = {
      source,
      status: 'ok',
      lastFetchedAt: now,
      lastSuccessAt: now,
      error: null,
      data,
    };
    await store.put(key, next, STATE_TTL_SECONDS);
    return { ...next, servedFromCache: false, ageMs: 0 };
  } catch (e) {
    const message = (e && e.message) ? String(e.message) : String(e);
    const next = {
      source,
      status: prev.data ? 'error' : 'error',
      lastFetchedAt: now,
      lastSuccessAt: prev.lastSuccessAt,
      error: message.slice(0, 300),
      data: prev.data,
    };
    await store.put(key, next, STATE_TTL_SECONDS);
    return {
      ...next,
      servedFromCache: Boolean(prev.data),
      ageMs: prev.lastSuccessAt ? now - prev.lastSuccessAt : null,
    };
  }
}
