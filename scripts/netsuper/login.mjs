#!/usr/bin/env node
/**
 * ネットスーパーへのログイン（人が手でログインし、その状態のブラウザを残す）。
 *
 *   npm run netsuper:login
 *   npm run netsuper:login -- --url https://example.com/#/login
 *   npm run netsuper:login -- --check     # ログイン状態が残っているか確認
 *
 * ブラウザが開くので、いつもどおりログインしてから
 * ターミナルに戻って Enter を押す。
 * ID / パスワードはこのスクリプトを通らないし、保存もしない。
 * 残るのはブラウザのプロファイル（Cookie / localStorage / IndexedDB）だけで、
 * 置き場所はリポジトリの外（既定 ~/.config/pass-netsuper/profile/）。
 */
import fs from 'node:fs';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseCliArgs } from '../analytics/lib/args.mjs';
import { main, log, section } from '../analytics/lib/cli.mjs';
import { profileDir, relativeToCwd } from './lib/paths.mjs';
import { loadConfig, configExists, ConfigError } from './lib/config.mjs';
import { openBrowser, firstPage, openList, extractFromPage, hasSession, markLoggedIn } from './lib/browser.mjs';

const HELP = `
ネットスーパーのログイン状態を保存します。

  npm run netsuper:login                      設定の entryUrl を開いてログイン
  npm run netsuper:login -- --url <URL>       URL を直接指定して開く
  npm run netsuper:login -- --check           ログイン状態が残っているか確認

  --check は最初のカテゴリURL（なければ entryUrl）を開き、
  商品が取れるかどうかで判定します。
`;

function resolveEntry(values) {
  if (values.url) return values.url;
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
  return entryUrl;
}

async function checkSession(values) {
  if (!hasSession()) {
    log(`ログイン状態は保存されていません（${profileDir()}）。`);
    log('  まず `npm run netsuper:login` を実行してください。');
    process.exitCode = 1;
    return;
  }
  const cfg = configExists() ? loadConfig({ requireCategories: false }) : null;
  const url = values.url || cfg?.categories[0]?.url || cfg?.entryUrl;
  if (!url) {
    log('プロファイルはありますが、確認用のURLがありません（--url で指定してください）。');
    return;
  }
  const context = await openBrowser({ headed: Boolean(values.headed) });
  try {
    const page = await firstPage(context);
    await openList(page, url, { waitMs: cfg?.waitMs ?? 1500 });
    const res = await extractFromPage(page, cfg?.selectors);
    const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' ').slice(0, 400));
    section('ログイン状態の確認');
    log(`  URL       : ${page.url()}`);
    log(`  抽出件数  : ${res.count} 件（判定モード: ${res.mode}）`);
    if (res.count > 0) {
      log('  → ログイン状態は有効とみられます。');
      return;
    }
    log(`  画面の文言: ${body || '（本文が空）'}`);
    if (/(ログイン|会員登録|サインイン|新規登録)/.test(body)) {
      log('  → ログアウトしています。`npm run netsuper:login` をやり直してください。');
    } else if (/(店舗|お届け先|エリア|郵便番号)/.test(body)) {
      log('  → 店舗やお届け先の選択を求められています。');
      log('     `npm run netsuper:login -- --check --headed` で画面を見ながら選んでください。');
    } else {
      log('  → 商品が取れませんでした。`npm run netsuper:probe -- --headed` で画面を確認してください。');
    }
    process.exitCode = 1;
  } finally {
    await context.close();
  }
}

main(async () => {
  const values = parseCliArgs({
    url: { type: 'string' },
    check: { type: 'boolean' },
    headed: { type: 'boolean' },
    chrome: { type: 'boolean' },
  });
  if (values.help) { log(HELP); return; }
  if (values.check) { await checkSession(values); return; }

  const entryUrl = resolveEntry(values);
  section('ネットスーパーへのログイン');
  log('  ブラウザが開きます。いつもどおりログインしてください。');
  log('  このスクリプトは ID / パスワードを受け取りません。');
  log('  ログイン後、お届け先や店舗の選択があれば、そこまで済ませてください。');
  log('  商品一覧が見える状態にしてから Enter を押すのが確実です。\n');

  const context = await openBrowser({ headed: true, channel: values.chrome ? 'chrome' : undefined });
  try {
    const page = await firstPage(context);
    await page.goto(entryUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const rl = readline.createInterface({ input: stdin, output: stdout });
    await rl.question('  ログインが終わったら、このターミナルで Enter を押してください… ');
    rl.close();

    const url = page.url();
    log(`\n  最後に開いていた画面: ${url}`);
  } finally {
    await context.close();
  }

  const dir = profileDir();
  fs.chmodSync(dir, 0o700);
  markLoggedIn();
  log(`  ログイン状態を保存しました: ${relativeToCwd(dir)}`);
  log('  ※ ログイン済みのブラウザそのものです。共有・コミットしないでください。');
  log('\n  次: `npm run netsuper:probe -- --headed` で商品一覧の取り出しを試します。');
});
