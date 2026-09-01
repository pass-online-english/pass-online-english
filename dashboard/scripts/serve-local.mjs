#!/usr/bin/env node
/**
 * Wrangler なしで動作確認するための簡易ローカルサーバー（Node 20+）。
 *   DEMO_MODE=1 DASHBOARD_TOKEN=localdev node scripts/serve-local.mjs
 *   → http://localhost:8787/?token=localdev
 *
 * 本番は Cloudflare Workers。これはあくまで開発用のシムで、
 * Worker の fetch ハンドラをそのまま呼び出して挙動を揃えている。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import worker from '../src/index.js';
import { ROOT, resolveEnv } from './env.mjs';
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

const vars = resolveEnv();          // .dev.vars → 環境変数 の順に解決
const hasGoogle = Boolean(vars.GOOGLE_CLIENT_ID && vars.GOOGLE_CLIENT_SECRET && vars.GOOGLE_REFRESH_TOKEN);

const env = {
  ...vars,
  // Google の資格情報が揃っていれば実データ、無ければダミーデータ
  DEMO_MODE: vars.DEMO_MODE ?? (hasGoogle ? '0' : '1'),
  DASHBOARD_TOKEN: vars.DASHBOARD_TOKEN ?? 'localdev',
  ASSETS: {
    async fetch(request) {
      const url = new URL(request.url);
      const rel = url.pathname === '/' ? '/index.html' : url.pathname;
      const file = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(PUBLIC_DIR)) return new Response('Forbidden', { status: 403 });
      try {
        const body = await readFile(file);
        return new Response(body, { headers: { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' } });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    },
  },
};

http.createServer(async (req, res) => {
  const request = new Request('http://localhost:' + PORT + req.url, { method: req.method });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  const response = await worker.fetch(new Request(request, { headers }), env, {});
  const out = {};
  response.headers.forEach((v, k) => { out[k] = v; });
  res.writeHead(response.status, out);
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => {
  console.log((env.DEMO_MODE === '1' ? '[ダミーデータ] ' : '[Google 実データ] ')
    + 'http://localhost:' + PORT + '/?token=' + env.DASHBOARD_TOKEN);
});
