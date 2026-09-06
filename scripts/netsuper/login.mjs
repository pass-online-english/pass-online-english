#!/usr/bin/env node
/**
 * ネットスーパーへのログイン（人が手でログインし、セッションだけを保存する）。
 *
 *   npm run netsuper:login
 *   npm run netsuper:login -- --url https://example.com/login
 *   npm run netsuper:login -- --check     # 保存済みセッションが生きているか確認
 *
 * ブラウザが開くので、いつもどおりログインしてから
 * ターミナルに戻って Enter を押す。
 * ID / パスワードはこのスクリプトを通らないし、保存もしない。
 * 保存されるのはログイン後の Cookie / localStorage のみで、
 * 置き場所はリポジトリの外（既定 ~/.config/pass-netsuper/session.json、0600）。
 */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseCliArgs } from '../analytics/lib/args.mjs';
import { main, log, section } from '../analytics/lib/cli.mjs';
import { sessionPath, relativeToCwd } from './lib/paths.mjs';
import { loadConfig, configExists, ConfigError } from './lib/config.mjs';
import { launch, newContext, saveSession, openList, extractFromPage } from './lib/browser.mjs';

const HELP = `
ネットスーパーのログインセッションを保存します。

  npm run netsuper:login                      設定の entryUrl を開いてログイン
  npm run netsuper:login -- --url <URL>       URL を直接指定して開く
  npm run netsuper:login -- --check           保存済みセッションの生死を確認

  --check は最初のカテゴリURL（なければ entryUrl）を headless で開き、
  商品が取れるかどうかで判定します。
`;

function resolveEntry(values) {
  if (values.url) return { entryUrl: values.url, cfg: null };
  if (!configExists()) {
    throw new ConfigError(
      '設定ファイルがなく --url も指定されていません。\n' +
        '  ログインページのURLを --url で渡すか、netsuper.config.json を作ってください。'
    );
  }
  const cfg = loadConfig({ requireCategories: false });
  const entryUrl = cfg.entryUrl || cfg.categories[0]?.url;
  if (!entryUrl) {
    throw new ConfigError('entryUrl も categories も設定されていません。--url でログインページを指定してください。');
  }
  return { entryUrl, cfg };
}

async function checkSession() {
  const file = sessionPath();
  if (!fs.existsSync(file)) {
    log(`セッションは保存されていません（${relativeToCwd(file)}）。`);
    log('  まず `npm run netsuper:login` を実行してください。');
    process.exitCode = 1;
    return;
  }
  const cfg = configExists() ? loadConfig({ requireCategories: false }) : null;
  const url = cfg?.categories[0]?.url || cfg?.entryUrl;
  if (!url) {
    log('セッションファイルはありますが、確認用のURLがありません（--url で指定してください）。');
    return;
  }
  const browser = await launch({ headed: false });
  try {
    const context = await newContext(browser);
    const page = await context.newPage();
    await openList(page, url, { waitMs: cfg?.waitMs ?? 1500 });
    const res = await extractFromPage(page, cfg?.selectors);
    const body = await page.evaluate(() => document.body.innerText.slice(0, 3000));
    const looksLoggedOut = /(ログイン|会員登録|サインイン)/.test(body) && res.count === 0;
    section('セッション確認');
    log(`  URL       : ${page.url()}`);
    log(`  抽出件数  : ${res.count} 件（判定モード: ${res.mode}）`);
    if (res.count > 0) {
      log('  → セッションは有効とみられます。');
    } else if (looksLoggedOut) {
      log('  → ログアウトしている可能性があります。`npm run netsuper:login` をやり直してください。');
      process.exitCode = 1;
    } else {
      log('  → 商品が取れませんでした。URL が一覧ページか確認してください（`npm run netsuper:probe`）。');
      process.exitCode = 1;
    }
  } finally {
    await browser.close();
  }
}

main(async () => {
  const values = parseCliArgs({ url: { type: 'string' }, check: { type: 'boolean' } });
  if (values.help) { log(HELP); return; }
  if (values.check) { await checkSession(); return; }

  const { entryUrl } = resolveEntry(values);
  section('ネットスーパーへのログイン');
  log('  ブラウザが開きます。いつもどおりログインしてください。');
  log('  このスクリプトは ID / パスワードを受け取りません。\n');

  const browser = await launch({ headed: true });
  try {
    const context = await newContext(browser, { useSession: true });
    const page = await context.newPage();
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const rl = readline.createInterface({ input: stdin, output: stdout });
    await rl.question('  ログインが終わったら、このターミナルで Enter を押してください… ');
    rl.close();

    const file = await saveSession(context);
    log(`\n  セッションを保存しました: ${file}（0600）`);
    log('  ※ このファイルはログイン済みの状態そのものです。共有・コミットしないでください。');
    log('  次は `npm run netsuper:probe` で商品一覧の取り出しを試します。');
  } finally {
    await browser.close();
  }
});
