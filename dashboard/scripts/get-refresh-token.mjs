#!/usr/bin/env node
/**
 * Google の refresh_token を1回だけ取得するためのローカル CLI。
 *
 *   1) Google Cloud Console で「OAuth クライアント ID(デスクトップアプリ)」を作成
 *   2) GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/get-refresh-token.mjs
 *   3) 表示された URL をブラウザで開き、Google アカウントで承認
 *   4) 出力された refresh_token を `npx wrangler secret put GOOGLE_REFRESH_TOKEN` に貼る
 *
 * 取得したトークンはこのマシンのファイルには保存しない（標準出力に一度だけ表示）。
 */
import http from 'node:http';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const PORT = Number(process.env.PORT || 8976);
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPES = [
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/tasks.readonly',
];

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  const clientId = process.env.GOOGLE_CLIENT_ID || (await rl.question('GOOGLE_CLIENT_ID: ')).trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || (await rl.question('GOOGLE_CLIENT_SECRET: ')).trim();
  rl.close();

  if (!clientId || !clientSecret) {
    console.error('client id / secret が必要です');
    process.exit(1);
  }

  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',            // refresh_token を確実に受け取るため
    include_granted_scopes: 'true',
  }).toString();

  console.log('\n次の URL をブラウザで開いて承認してください:\n');
  console.log(authUrl + '\n');

  const code = await new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      const err = url.searchParams.get('error');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<html><body style="font-family:sans-serif;padding:40px">
        <h2>${err ? '認可に失敗しました' : '認可が完了しました'}</h2>
        <p>ターミナルへ戻ってください。</p></body></html>`);
      server.close();
      err ? reject(new Error(err)) : resolve(url.searchParams.get('code'));
    });
    server.listen(PORT, () => console.log(`ローカルサーバー起動: ${REDIRECT_URI}`));
    setTimeout(() => { server.close(); reject(new Error('タイムアウト(5分)')); }, 5 * 60 * 1000);
  });

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }).toString(),
  });
  const json = await res.json();
  if (!res.ok || !json.refresh_token) {
    console.error('取得に失敗しました:', JSON.stringify(json, null, 2));
    process.exit(1);
  }

  console.log('\n===== refresh_token（この値を Cloudflare の Secret に登録） =====\n');
  console.log(json.refresh_token);
  console.log('\n登録コマンド:  npx wrangler secret put GOOGLE_REFRESH_TOKEN\n');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
