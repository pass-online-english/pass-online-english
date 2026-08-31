#!/usr/bin/env node
/**
 * ブラウザ認証（OAuth 2.0 / デスクトップアプリ）。
 *
 * gcloud CLI をインストールできない環境向けの認証方法。
 * サービスアカウント鍵も作らないため、組織ポリシー
 * `constraints/iam.disableServiceAccountKeyCreation` の影響を受けない。
 *
 *   npm run analytics:login
 *
 * 一時的にローカルの 127.0.0.1 でコールバックを受け取り、
 * 取得したトークンをリポジトリ外（既定 ~/.config/pass-analytics/）に 0600 で保存する。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { google } from 'googleapis';
import { main, log, section } from './lib/cli.mjs';
import { oauthClientFromEnv, oauthTokenPath } from './lib/env.mjs';
import { SCOPES, writeOAuthToken } from './lib/auth.mjs';

const TIMEOUT_MS = 5 * 60 * 1000;

/** 既定のブラウザで URL を開く。失敗しても致命的ではない（URLは表示済み）。 */
function openBrowser(url) {
  const cmd =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function page(title, body, ok = true) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${title}</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI","Noto Sans JP",sans-serif;
display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;
background:#f6f7f9;color:#1a1a1a}
.card{background:#fff;padding:40px 48px;border-radius:12px;text-align:center;
box-shadow:0 2px 16px rgba(0,0,0,.08);max-width:460px}
h1{font-size:19px;margin:0 0 12px;color:${ok ? '#0b7a3b' : '#b3261e'}}
p{font-size:14px;line-height:1.7;color:#555;margin:0}
</style></head><body><div class="card"><h1>${title}</h1><p>${body}</p></div></body></html>`;
}

/**
 * コールバック用サーバを起動する。
 * 認可URLには確定したポート番号が必要なため、「起動」と「コード待ち」を分けて返す。
 */
function startCallbackServer(state) {
  return new Promise((resolve, reject) => {
    let settle;
    const codePromise = new Promise((res, rej) => {
      settle = { res, rej };
    });

    const server = http.createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');

      const finish = (status, html, outcome) => {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        server.close();
        outcome();
      };

      if (error) {
        finish(400, page('認証がキャンセルされました', `理由: ${error}<br>ターミナルに戻って、もう一度実行してください。`, false),
          () => settle.rej(new Error(`認証が拒否されました: ${error}`)));
      } else if (!code) {
        finish(400, page('認可コードを受け取れませんでした', 'ターミナルに戻って、もう一度実行してください。', false),
          () => settle.rej(new Error('認可コードを受け取れませんでした。')));
      } else if (returnedState !== state) {
        // CSRF 対策: 開始時に生成した state と一致することを確認する
        finish(400, page('認証を中断しました', 'リクエストの照合に失敗しました。もう一度実行してください。', false),
          () => settle.rej(new Error('state が一致しません。認証を中断しました。')));
      } else {
        finish(200, page('認証が完了しました', 'このタブを閉じて、ターミナルに戻ってください。'),
          () => settle.res(code));
      }
    });

    const timer = setTimeout(() => {
      server.close();
      settle.rej(new Error('5分以内に認証が完了しませんでした。もう一度実行してください。'));
    }, TIMEOUT_MS);
    timer.unref?.();

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, codePromise: codePromise.finally(() => clearTimeout(timer)) });
    });
  });
}

await main(async () => {
  const { clientId, clientSecret } = oauthClientFromEnv();
  const state = crypto.randomBytes(24).toString('hex');

  section('ブラウザ認証');

  const { port, codePromise } = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${port}`;
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...SCOPES],
    state,
  });

  log('  要求する権限（読み取り専用のみ）:');
  log('    - Google アナリティクスの閲覧');
  log('    - Search Console データの閲覧');
  log('');
  log('  ブラウザで以下のURLを開き、GA4 と Search Console を閲覧できる');
  log('  Google アカウントでログインして許可してください。\n');
  log(`  ${authUrl}\n`);

  if (openBrowser(authUrl)) log('  （ブラウザを自動で開きました）\n');
  log('  認証の完了を待っています… 中断する場合は Ctrl+C\n');

  const code = await codePromise;
  const { tokens } = await oauth2.getToken(code);

  if (!tokens.refresh_token) {
    throw new Error(
      'リフレッシュトークンを取得できませんでした。\n' +
        '  すでに許可済みのため再発行されなかった可能性があります。\n' +
        '  https://myaccount.google.com/permissions で該当アプリのアクセス権を削除してから、\n' +
        '  もう一度 `npm run analytics:login` を実行してください。'
    );
  }

  oauth2.setCredentials(tokens);

  const file = writeOAuthToken({
    clientId,
    clientSecret,
    scopes: [...SCOPES],
    createdAt: new Date().toISOString(),
    tokens,
  });

  section('完了');
  log(`  トークンを保存しました: ${file}`);
  log('  （リポジトリ外・パーミッション 600。Git には含まれません）\n');
  log('  次のコマンドで疎通を確認してください:\n');
  log('    npm run analytics:doctor\n');
});
