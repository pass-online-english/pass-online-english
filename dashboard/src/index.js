// Cloudflare Worker エントリポイント。
// 静的アセットも API も同一オリジンで配信し、すべてのリクエストに認証を適用する。

import { loadConfig, publicConfig } from './config.js';
import { authenticate, deviceCookieHeader } from './auth.js';
import { createStore, withFallback } from './cache.js';
import { tzOffsetMinutes, dayKey } from './time.js';
import { fetchCalendarEvents, fetchTasks, hasGoogleCredentials } from './google.js';
import { fetchWeather } from './weather.js';
import { demoCalendar, demoTasks, demoWeather } from './demo.js';

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

function unauthorizedHtml(message, status) {
  const body = '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Home Dashboard</title><style>'
    + 'body{background:#0d1117;color:#e6edf3;font-family:system-ui,-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;'
    + 'display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:24px}'
    + 'h1{font-size:24px;margin:0 0 12px}p{color:#9aa4b2;line-height:1.7;max-width:640px}'
    + '</style></head><body><div><h1>🔒 Home Dashboard</h1><p>'
    + String(message).replace(/[<>&]/g, '') + '</p></div></body></html>';
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** ソース別レスポンスの共通形（要件23: lastFetchedAt / lastSuccessAt / status / error） */
function sourceResponse(state, extra = {}) {
  return {
    source: state.source,
    status: state.status,
    lastFetchedAt: state.lastFetchedAt,
    lastSuccessAt: state.lastSuccessAt,
    error: state.error,
    ageMs: state.ageMs,
    servedFromCache: state.servedFromCache,
    serverTime: Date.now(),
    data: state.data,
    ...extra,
  };
}

async function handleCalendar(config, env, store, ctx) {
  const demo = isDemo(env);
  return withFallback({
    source: 'calendar',
    store,
    ttlMs: Math.max(30000, Number(config.refresh.calendar) || 300000),
    force: ctx.force,
    fetcher: async () => {
      if (demo || !hasGoogleCredentials(env)) return demoCalendar(config, ctx.offsetMin, ctx.today);
      return fetchCalendarEvents(config, env, store, { offsetMin: ctx.offsetMin, today: ctx.today });
    },
  });
}

async function handleTasks(config, env, store, ctx) {
  const demo = isDemo(env);
  return withFallback({
    source: 'tasks',
    store,
    ttlMs: Math.max(30000, Number(config.refresh.tasks) || 300000),
    force: ctx.force,
    fetcher: async () => {
      if (demo || !hasGoogleCredentials(env)) return demoTasks(config, ctx.offsetMin, ctx.today);
      return fetchTasks(config, env, store);
    },
  });
}

async function handleWeather(config, env, store, ctx) {
  const demo = isDemo(env);
  return withFallback({
    source: 'weather',
    store,
    ttlMs: Math.max(60000, Number(config.refresh.weather) || 1800000),
    force: ctx.force,
    fetcher: async () => {
      if (demo) {
        // デモでも実データを優先し、ネットワークが無ければダミーへフォールバック
        try {
          return await fetchWeather(config, { offsetMin: ctx.offsetMin, today: ctx.today });
        } catch (_e) {
          return demoWeather(config, ctx.offsetMin, ctx.today);
        }
      }
      return fetchWeather(config, { offsetMin: ctx.offsetMin, today: ctx.today });
    },
  });
}

function isDemo(env) {
  return String(env.DEMO_MODE || '') === '1' || String(env.DEMO_MODE || '').toLowerCase() === 'true';
}

export default {
  async fetch(request, env, _executionCtx) {
    const url = new URL(request.url);
    const config = loadConfig(env);
    if (isDemo(env) || !hasGoogleCredentials(env)) {
      // デモ表示では、未設定のカレンダー枠も含めて全体像が見えるようにする
      config.calendars = config.calendars.map((c) => ({ ...c, enabled: true }));
    }
    const store = createStore(env);

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'Method Not Allowed' }, 405);
    }

    // --- 認証（静的アセットを含む全リクエスト） ---
    const auth = await authenticate(request, env, config, store);
    if (!auth.ok) {
      const wantsJson = url.pathname.startsWith('/api/');
      return wantsJson
        ? json({ error: auth.message }, auth.status)
        : unauthorizedHtml(auth.message, auth.status);
    }

    // ?token= でアクセスされた場合は Cookie を発行し、URL からトークンを取り除く
    let setCookie = null;
    if (auth.setToken) {
      setCookie = deviceCookieHeader(auth.setToken);
      if (!url.pathname.startsWith('/api/')) {
        const clean = new URL(url.toString());
        clean.searchParams.delete('token');
        return new Response(null, {
          status: 302,
          headers: { Location: clean.pathname + (clean.search || ''), 'Set-Cookie': setCookie, 'Cache-Control': 'no-store' },
        });
      }
    }
    const withCookie = setCookie ? { 'Set-Cookie': setCookie } : {};

    const offsetMin = tzOffsetMinutes(config.timezone);
    const today = dayKey(Date.now(), offsetMin);
    const force = url.searchParams.get('force') === '1';
    const ctx = { offsetMin, today, force };

    try {
      switch (url.pathname) {
        case '/api/config':
          return json({
            config: publicConfig(config, {
              tzOffsetMinutes: offsetMin,
              demoMode: isDemo(env) || !hasGoogleCredentials(env),
              googleConfigured: hasGoogleCredentials(env),
              authMethod: auth.method,
              user: auth.email,
              warnings: config.warnings,
            }),
            serverTime: Date.now(),
            today,
          }, 200, withCookie);

        case '/api/calendar':
          return json(sourceResponse(await handleCalendar(config, env, store, ctx)), 200, withCookie);

        case '/api/tasks':
          return json(sourceResponse(await handleTasks(config, env, store, ctx)), 200, withCookie);

        case '/api/weather':
          return json(sourceResponse(await handleWeather(config, env, store, ctx)), 200, withCookie);

        case '/api/all': {
          // 低速回線の初回表示用。3ソースをまとめて返す。
          const [calendar, tasks, weather] = await Promise.all([
            handleCalendar(config, env, store, ctx),
            handleTasks(config, env, store, ctx),
            handleWeather(config, env, store, ctx),
          ]);
          return json({
            serverTime: Date.now(),
            today,
            calendar: sourceResponse(calendar),
            tasks: sourceResponse(tasks),
            weather: sourceResponse(weather),
          }, 200, withCookie);
        }

        case '/api/health': {
          const states = await Promise.all(['calendar', 'tasks', 'weather'].map(async (s) => {
            const st = (await store.get('state:' + s)) || { source: s, status: 'unknown' };
            return {
              source: s,
              status: st.status,
              lastFetchedAt: st.lastFetchedAt || null,
              lastSuccessAt: st.lastSuccessAt || null,
              error: st.error || null,
            };
          }));
          return json({
            ok: states.every((s) => s.status === 'ok' || s.status === 'unknown'),
            serverTime: Date.now(),
            timezone: config.timezone,
            demoMode: isDemo(env),
            googleConfigured: hasGoogleCredentials(env),
            cache: store.kind,
            sources: states,
          }, 200, withCookie);
        }

        case '/logout':
          return new Response(null, {
            status: 302,
            headers: {
              Location: '/',
              'Set-Cookie': 'hd_device=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax',
            },
          });
      }
    } catch (e) {
      return json({ error: (e && e.message) || String(e) }, 500, withCookie);
    }

    // --- 静的アセット ---
    if (!env.ASSETS) {
      return new Response('静的アセットのバインディング(ASSETS)がありません', { status: 500 });
    }
    const assetRes = await env.ASSETS.fetch(request);
    const headers = new Headers(assetRes.headers);
    if (setCookie) headers.append('Set-Cookie', setCookie);
    // 常時表示端末が古い HTML を掴み続けないようにする
    const ct = headers.get('Content-Type') || '';
    if (ct.indexOf('text/html') >= 0) headers.set('Cache-Control', 'no-cache');
    return new Response(assetRes.body, { status: assetRes.status, headers });
  },
};
