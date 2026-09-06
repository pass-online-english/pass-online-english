#!/usr/bin/env node
/**
 * ブラウザを開いて、人が売場を見て回る間に価格を記録する。
 *
 *   npm run netsuper:capture
 *
 * 自動操作でうまく動かないアプリ向けの方法。
 * 画面の操作は人がやり、ツールはアプリがサーバから受け取ったデータを
 * 横で記録するだけ。アプリから見ればいつもの買い物と同じ動きになるので、
 * 自動操作でつまずく余地がない。
 *
 * 出力は scrape と同じ（reports/netsuper/<収集日>/）なので、
 * そのまま `npm run netsuper:diff` で店頭価格と比べられる。
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { parseCliArgs } from '../analytics/lib/args.mjs';
import { main, log, section, isEntrypoint } from '../analytics/lib/cli.mjs';
import { toCSV, fmtNum } from '../analytics/lib/output.mjs';
import { outputRoot, ensureDir, today, relativeToCwd } from './lib/paths.mjs';
import { loadConfig, configExists } from './lib/config.mjs';
import { openBrowser, firstPage, attachApiCapture } from './lib/browser.mjs';
import { toRows, buildSummary, CSV_COLUMNS } from './scrape.mjs';

const HELP = `
ブラウザを開き、売場を見て回る間に価格を記録します。

  npm run netsuper:capture [-- --url <開始URL>]

  ブラウザで売場を順に開いてください（普段の買い物と同じ操作です）。
  見終わったらターミナルで Enter を押すと、集まった価格を保存します。
`;

/** URL のうち、売場を見分ける部分（#/ 以降）。 */
function routeOf(url) {
  const i = String(url ?? '').indexOf('#');
  return i === -1 ? String(url ?? '') : String(url).slice(i);
}

/**
 * 記録した商品に、設定のカテゴリ名を割り当てる。
 * どの画面を見ているときに届いたかで判断する。一致しなければ空欄。
 */
export function assignCategories(products, categories = []) {
  return products.map((p) => {
    const route = routeOf(p.sourceUrl);
    const hit = categories.find((c) => route && routeOf(c.url) === route);
    return { ...p, category: hit ? hit.name : '' };
  });
}

export const run = async () => {
  const values = parseCliArgs({ url: { type: 'string' } });
  if (values.help) { log(HELP); return; }

  const cfg = configExists() ? loadConfig({ requireCategories: false }) : null;
  const startUrl = values.url || cfg?.entryUrl || cfg?.categories[0]?.url;
  if (!startUrl) {
    throw new Error('開始URLがありません。--url でネットスーパーのURLを指定してください。');
  }

  section('価格の記録');
  log('  ブラウザが開きます。いつもどおり売場を見て回ってください。');
  log('  見たい売場を順に開き、下までスクロールすると、その分だけ記録されます。');
  log('  操作はすべてあなたが行います。ツールは受け取ったデータを記録するだけです。\n');

  const context = await openBrowser({ headed: true });
  let products = [];
  let timer;
  try {
    const page = await firstPage(context);
    const capture = attachApiCapture(page, { pattern: cfg?.apiPattern, maxEntries: 5000 });
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

    // 記録できている実感がないと不安なので、件数を出し続ける
    timer = setInterval(() => {
      const n = capture.products(0).length;
      stdout.write(`\r  記録中… 商品 ${String(n).padStart(4)} 件 / 通信 ${String(capture.entries.length).padStart(4)} 件   `);
    }, 2000);

    const rl = readline.createInterface({ input: stdin, output: stdout });
    await rl.question('\n  見終わったら Enter を押してください… ');
    rl.close();
    clearInterval(timer);
    products = capture.products(0);
  } finally {
    clearInterval(timer);
    await context.close();
  }

  if (!products.length) {
    section('商品が記録できませんでした');
    log('  売場を開いてスクロールしましたか？');
    log('  それでも0件なら、データの届き方が想定と違う可能性があります。');
    log('  `npm run netsuper:probe -- --headed` の出力を共有してください。');
    process.exitCode = 1;
    return;
  }

  const collectedAt = today();
  const rows = toRows(assignCategories(products, cfg?.categories ?? []), { collectedAt });
  const dir = ensureDir(values.out ? path.resolve(values.out) : path.join(outputRoot(), collectedAt));
  fs.writeFileSync(path.join(dir, 'items.csv'), toCSV(rows, CSV_COLUMNS), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'items.json'),
    `${JSON.stringify({ store: cfg?.store ?? '', collectedAt, categories: [], items: rows }, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'summary.md'),
    `${buildSummary(rows, { store: cfg?.store ?? '', collectedAt, categories: new Set(rows.map((r) => r.category)).size })}\n`,
    'utf8'
  );

  section('完了');
  log(`  商品 ${fmtNum(rows.length)} 件を保存しました: ${relativeToCwd(dir)}/`);
  log('    items.csv   … 表計算で開く用');
  log('    summary.md  … カテゴリ別の概要');
  log('\n  次: `npm run netsuper:diff`（店頭価格メモ・前回との比較）');
};

if (isEntrypoint(import.meta.url)) main(run);
