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
 * 終わりの合図は「ブラウザを閉じること」。キー入力を待たないので、
 * 打ち間違いや入力の取りこぼしで途中終了することがない。
 *
 * 出力は scrape と同じ（reports/netsuper/<収集日>/）なので、
 * そのまま `npm run netsuper:diff` で店頭価格と比べられる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { stdout } from 'node:process';
import { parseCliArgs } from '../analytics/lib/args.mjs';
import { main, log, section, isEntrypoint } from '../analytics/lib/cli.mjs';
import { toCSV, fmtNum } from '../analytics/lib/output.mjs';
import { outputRoot, ensureDir, today, relativeToCwd } from './lib/paths.mjs';
import { loadConfig, configExists } from './lib/config.mjs';
import { openBrowser, firstPage, attachApiCapture } from './lib/browser.mjs';
import { describeShape } from './lib/apidata.mjs';
import { toRows, buildSummary, CSV_COLUMNS } from './scrape.mjs';

const HELP = `
ブラウザを開き、売場を見て回る間に価格を記録します。

  npm run netsuper:capture [-- --url <開始URL>]

  ブラウザで売場を順に開いてください（普段の買い物と同じ操作です）。
  見終わったらブラウザの窓を閉じると、集まった価格を保存します。
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
    // 商品データ自体が売場を持っていればそちらを使う
    return { ...p, category: p.category || (hit ? hit.name : '') };
  });
}

/**
 * ブラウザが閉じられるまで（または Ctrl+C まで）待つ。
 *
 * 閉じ方は環境で違う（窓を閉じる / アプリを終了する / Ctrl+C）。
 * どれでも確実に気づけるよう、複数の合図を見る。
 */
function waitUntilClosed(context) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      clearInterval(poll);
      resolve(reason);
    };
    const onSignal = () => finish('interrupt');

    context.on('close', () => finish('closed'));
    context.browser()?.on('disconnected', () => finish('disconnected'));
    // 最後のタブが閉じられたときも終わりとみなす
    const watchPage = (page) => page.on('close', () => {
      if (context.pages().length === 0) finish('all-pages-closed');
    });
    context.pages().forEach(watchPage);
    context.on('page', watchPage);
    // 上のどれも来ないことがあるので、開いている窓の数も定期的に確かめる
    const poll = setInterval(() => {
      if (context.pages().length === 0) finish('no-pages');
    }, 2000);

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  });
}

/** 集めた商品をその場で保存する。何度呼んでもよい。 */
function saveProducts(products, { cfg, dir, collectedAt }) {
  const rows = toRows(assignCategories(products, cfg?.categories ?? []), { collectedAt });
  if (!rows.length) return null;
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
  return rows;
}

export const run = async () => {
  const values = parseCliArgs({ url: { type: 'string' }, chrome: { type: 'boolean' } });
  if (values.help) { log(HELP); return; }

  const cfg = configExists() ? loadConfig({ requireCategories: false }) : null;
  const startUrl = values.url || cfg?.entryUrl || cfg?.categories[0]?.url;
  if (!startUrl) {
    throw new Error('開始URLがありません。--url でネットスーパーのURLを指定してください。');
  }

  section('価格の記録');
  log('  ブラウザが開きます。いつもどおり売場を見て回ってください。');
  log('  見たい売場を順に開き、下までスクロールすると、その分だけ記録されます。');
  log('  操作はすべてあなたが行います。ツールは受け取ったデータを記録するだけです。');
  log('');
  log('  ■ 見終わったら「ブラウザの窓を閉じて」ください。');
  log('    集めた分は数秒ごとに自動で保存されるので、途中でやめても消えません。');
  log('');

  const collectedAt = today();
  const dir = ensureDir(values.out ? path.resolve(values.out) : path.join(outputRoot(), collectedAt));

  const context = await openBrowser({ headed: true, channel: values.chrome ? 'chrome' : cfg?.browserChannel });
  let products = [];
  let entries = [];
  let endpoints = [];
  let sockets = [];
  let saved = 0;
  let timer;

  // Ctrl+C でも、ブラウザを閉じても、集めた分は必ず残す
  const flush = () => {
    if (!products.length || saved === products.length) return;
    if (saveProducts(products, { cfg, dir, collectedAt })) saved = products.length;
  };
  process.on('exit', flush);
  try {
    const page = await firstPage(context);
    // 商品が載っていそうな通信は、届いた時点で知らせる（進んでいるか分かるように）
    const shown = new Set();
    const capture = attachApiCapture(page, {
      pattern: cfg?.apiPattern,
      maxEntries: 5000,
      onEntry: (entry) => {
        const host = (() => { try { return new URL(entry.url).host; } catch { return entry.url; } })();
        if (shown.has(host)) return;
        shown.add(host);
        log(`  受信: ${host}`);
      },
    });
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});

    // 同じ行を延々と出しても意味がないので、数が変わったときだけ出す
    let last = '';
    timer = setInterval(() => {
      products = capture.products(0);
      const line = `  記録中… 商品 ${String(products.length).padStart(4)} 件 / 通信 ${String(capture.entries.length).padStart(4)} 件`;
      if (line === last) return;
      last = line;
      stdout.write(`${line}\n`);
      const before = saved;
      flush();
      if (before === 0 && saved > 0) log(`  → 保存を始めました: ${relativeToCwd(path.join(dir, 'items.csv'))}`);
    }, 3000);

    await waitUntilClosed(context);
    clearInterval(timer);
    products = capture.products(0);
    entries = capture.entries;
    endpoints = capture.endpoints;
    sockets = capture.sockets;
    flush();
  } finally {
    clearInterval(timer);
    await context.close().catch(() => {});
  }

  if (!products.length) {
    // 何が届いていたのかを残す。値は書かず、項目名と型だけ（住所や氏名を残さないため）
    fs.writeFileSync(
      path.join(dir, 'api-endpoints.txt'),
      [
        '── JSON 以外も含む、すべての通信',
        ...endpoints,
        '',
        '── WebSocket（応答イベントには出てこない通信）',
        ...(sockets.length
          ? sockets.map((w) => `${w.url}  受信 ${w.received} 回  先頭: ${w.sample.replace(/\s+/g, ' ')}`)
          : ['(なし)']),
      ].join('\n'),
      'utf8'
    );
    const shapes = entries
      .slice(-20)
      .map((e) => `── ${e.url}\n${describeShape(e.json).join('\n')}`)
      .join('\n\n');
    fs.writeFileSync(path.join(dir, 'api-shapes.txt'), shapes || '(記録なし)', 'utf8');

    section('商品が記録できませんでした');
    log(`  記録した通信: JSON ${entries.length} 件 / 全体 ${endpoints.length} 件 / WebSocket ${sockets.length} 本`);
    log('  売場を開いて、下までスクロールしましたか？');
    log('  商品が画面に出る前に閉じると、まだデータが届いていません。');
    log('');
    log('  届いていたデータの形を保存しました（中身の値は含みません）:');
    log(`    ${relativeToCwd(path.join(dir, 'api-shapes.txt'))}`);
    log(`    ${relativeToCwd(path.join(dir, 'api-endpoints.txt'))}`);
    log('  この2つを共有してもらえれば、読み取り方を合わせられます。');
    process.exitCode = 1;
    return;
  }

  const rows = saveProducts(products, { cfg, dir, collectedAt }) ?? [];
  saved = products.length;

  section('完了');
  log(`  商品 ${fmtNum(rows.length)} 件を保存しました: ${relativeToCwd(dir)}/`);
  log('    items.csv   … 表計算で開く用');
  log('    summary.md  … カテゴリ別の概要');
  log('');
  log('  次: `npm run netsuper:diff`（店頭価格メモ・前回との比較）');
};

if (isEntrypoint(import.meta.url)) main(run);
