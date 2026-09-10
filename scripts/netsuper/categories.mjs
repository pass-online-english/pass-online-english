#!/usr/bin/env node
/**
 * 売場（カテゴリ）の一覧をアプリから拾って、設定ファイルに書き込む。
 *
 *   npm run netsuper:categories
 *   npm run netsuper:categories -- --wait 60      待ち時間（秒）
 *   npm run netsuper:categories -- --dry-run      設定を書き換えずに一覧だけ出す
 *
 * 売場が数十あると URL を手で集めるのは現実的でない。アプリは起動時や
 * メニューを開いたときに売場の一覧を受け取っているので、それを記録して使う。
 *
 * URL は設定にすでにある売場URLを雛形にして、ID の部分だけ差し替えて組み立てる。
 * 雛形が無いと URL の形を推測することになるため、その場合はエラーで止める。
 */
import { parseCliArgs } from '../analytics/lib/args.mjs';
import { main, log, section, isEntrypoint } from '../analytics/lib/cli.mjs';
import { loadConfig, saveConfig, configExists } from './lib/config.mjs';
import { configPath, relativeToCwd } from './lib/paths.mjs';
import { openBrowser, firstPage, attachApiCapture, sleep } from './lib/browser.mjs';
import { collectCategories, collectByIdType, applyCategoryTemplate } from './lib/categories.mjs';

const HELP = `
売場の一覧をアプリから拾って設定に書き込みます。

  npm run netsuper:categories [-- --wait 60] [--dry-run]

  ブラウザが開いたら、売場の一覧（左側のメニュー）を開いてください。
  一覧が表示された時点で記録されます。閉じるか、待ち時間が過ぎると終わります。
`;

export const run = async () => {
  const values = parseCliArgs({ wait: { type: 'string' }, 'dry-run': { type: 'boolean' } });
  if (values.help) { log(HELP); return; }

  const waitSec = values.wait === undefined ? 45 : Number(values.wait);
  if (!Number.isFinite(waitSec) || waitSec < 5) throw new Error('--wait は5以上の秒数で指定してください。');

  if (!configExists()) {
    throw new Error(
      `設定ファイルがありません（${relativeToCwd(configPath())}）。\n` +
        '  売場URLを1つでも含む設定を先に作ってください。URL の形の雛形として使います。'
    );
  }
  const cfg = loadConfig({ requireCategories: false });
  const template = cfg.categories[0]?.url;
  if (!template) {
    throw new Error(
      '設定に売場URLが1つもありません。\n' +
        '  URL の形を推測はしません。売場を1つ開いたときのURLを categories に入れてから実行してください。'
    );
  }

  section('売場の一覧を取得');
  log('  ブラウザが開きます。左側の売場メニューを開いてください。');
  log(`  一覧を受け取った時点で記録します（最大 ${waitSec} 秒、閉じても終了）。\n`);

  const context = await openBrowser({ headed: true, channel: cfg.browserChannel });
  let found = [];
  let byType = new Map();
  try {
    const page = await firstPage(context);
    const capture = attachApiCapture(page, { pattern: cfg.apiPattern, maxEntries: 2000 });
    await page.goto(template, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

    let closed = false;
    context.on('close', () => { closed = true; });
    const deadline = Date.now() + waitSec * 1000;
    let last = 0;
    while (Date.now() < deadline && !closed) {
      await sleep(3000);
      byType = collectByIdType(capture.entries.map((e) => e.json));
      found = byType.get('Category') ?? [];
      if (found.length !== last) {
        last = found.length;
        log(`  売場 ${found.length} 件を確認`);
      }
    }
  } finally {
    await context.close().catch(() => {});
  }

  if (!found.length) {
    section('売場を見つけられませんでした');
    if (byType.size) {
      log('  受信データに入っていた ID の種別:');
      for (const [type, items] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
        const sample = items.slice(0, 3).map((i) => i.name).join(' / ');
        log(`    ${type.padEnd(14)} ${String(items.length).padStart(4)} 件  ${sample}`);
      }
      log('\n  この一覧を共有してもらえれば、どれが売場かを特定できます。');
    } else {
      log('  受信データに ID を持つものがありませんでした。');
      log('  左側の売場メニューを開きましたか？ 開くとアプリが一覧を取りに行きます。');
    }
    log('\n  `npm run netsuper:categories -- --wait 90` で待ち時間を延ばせます。');
    process.exitCode = 1;
    return;
  }

  const categories = applyCategoryTemplate(found, template);
  section(`見つかった売場 ${categories.length} 件`);
  for (const c of categories) log(`  ${c.name}`);

  if (values['dry-run']) {
    log('\n  --dry-run のため設定は書き換えていません。');
    return;
  }

  // すでに設定にある売場の指定（disabled など）は残す
  const previous = new Map(cfg.categories.map((c) => [c.url, c]));
  cfg.categories = categories.map((c) => ({ ...c, ...previous.get(c.url) }));
  const file = saveConfig(cfg);
  log(`\n  設定に書き込みました: ${relativeToCwd(file)}`);
  log('  不要な売場は "disabled": true を付けると飛ばせます。');
  log('\n  次: `npm run netsuper:scrape`');
};

if (isEntrypoint(import.meta.url)) main(run);
