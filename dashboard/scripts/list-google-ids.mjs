#!/usr/bin/env node
/**
 * 連携に必要な「カレンダーID」と「タスクリストID」を一覧表示する。
 * Google の設定画面を探し回らずに済むように、CONFIG_JSON の雛形も出力する。
 *
 *   node scripts/list-google-ids.mjs
 *
 * .dev.vars に GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN が
 * 入っていれば、そのまま実行できる。
 */
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { resolveEnv, upsertDevVars } from './env.mjs';

const env = resolveEnv();
const missing = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'].filter((k) => !env[k]);
if (missing.length) {
  console.error('次の値が足りません: ' + missing.join(', '));
  console.error('.dev.vars に書くか、環境変数として渡してください。');
  console.error('リフレッシュトークンの取得: node scripts/get-refresh-token.mjs');
  process.exit(1);
}

async function accessToken() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }).toString(),
  });
  const json = await res.json();
  if (!res.ok) throw new Error('トークン更新に失敗: ' + JSON.stringify(json));
  return json.access_token;
}

async function get(url, token) {
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  const json = await res.json();
  if (!res.ok) throw new Error(url + ' → ' + JSON.stringify(json).slice(0, 200));
  return json;
}

const PALETTE = ['#4FC3F7', '#F48FB1', '#A5D6A7', '#FFD54F', '#CE93D8', '#FF8A65'];

async function main() {
  const token = await accessToken();

  const calendars = await get('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', token);
  console.log('\n=== カレンダー ===');
  const rows = (calendars.items || []).map((c, i) => ({
    id: c.id,
    name: c.summaryOverride || c.summary,
    primary: Boolean(c.primary),
    access: c.accessRole,
    color: PALETTE[i % PALETTE.length],
  }));
  for (const r of rows) {
    console.log(`- ${r.name}${r.primary ? '（自分のメインカレンダー）' : ''}`);
    console.log(`    calendarId: ${r.id}`);
    console.log(`    権限: ${r.access}`);
  }

  const lists = await get('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100', token);
  console.log('\n=== タスクリスト ===');
  for (const l of lists.items || []) {
    console.log(`- ${l.title}`);
    console.log(`    taskListId: ${l.id}`);
  }

  // そのまま貼れる CONFIG_JSON の雛形（表示名・色・person はあとで調整してください）
  const config = {
    calendars: rows.map((r, i) => ({
      key: r.primary ? 'me' : 'cal' + i,
      calendarId: r.id,
      displayName: r.primary ? '夫' : r.name,
      color: r.color,
      person: r.primary ? 'me' : 'other' + i,
      enabled: r.primary,
    })),
    taskLists: (lists.items || []).map((l, i) => ({ id: l.id, name: l.title, enabled: i === 0 })),
  };

  const oneLine = JSON.stringify(config);
  console.log('\n=== CONFIG_JSON の雛形（1行）===');
  console.log('※ person は色分けと TONIGHT のグループ分けに使います（me / wife / shared など）\n');
  console.log(oneLine);

  const rl = createInterface({ input: stdin, output: stdout });
  const answer = (await rl.question('\nこの雛形を .dev.vars に保存しますか？（あとで編集できます）[Y/n]: ')).trim().toLowerCase();
  rl.close();
  if (answer === '' || answer === 'y' || answer === 'yes') {
    const file = upsertDevVars({ CONFIG_JSON: oneLine });
    console.log('\n保存しました: ' + file);
    console.log('編集するとき:  open -e .dev.vars');
    console.log('起動するとき:  node scripts/serve-local.mjs\n');
  } else {
    console.log('');
  }
}

main().catch((e) => {
  console.error('\n取得に失敗しました: ' + e.message + '\n');
  if (/invalid_client/.test(e.message)) console.error('→ GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET を確認してください。');
  if (/invalid_grant/.test(e.message)) console.error('→ リフレッシュトークンが失効しています。node scripts/get-refresh-token.mjs で取り直してください。');
  if (/insufficient|scope|403/.test(e.message)) console.error('→ Google Cloud Console で Calendar API / Tasks API が有効か確認してください。');
  process.exit(1);
});
