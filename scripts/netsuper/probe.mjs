#!/usr/bin/env node
/**
 * 商品一覧ページの構造を調べて、抽出できるか確認する。
 *
 *   npm run netsuper:probe                       設定の最初のカテゴリを調べる
 *   npm run netsuper:probe -- --url <一覧URL>    URL を直接指定
 *   npm run netsuper:probe -- --save             判定できたセレクタを設定に書き戻す
 *   npm run netsuper:probe -- --headed           ブラウザを表示して確認する
 *
 * 取得した HTML とスクリーンショットを reports/netsuper/probe-… に残すので、
 * うまく取れなかった場合はそれを見てセレクタを詰められる。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCliArgs, parseLimit } from '../analytics/lib/args.mjs';
import { main, log, section } from '../analytics/lib/cli.mjs';
import { outputRoot, ensureDir, relativeToCwd } from './lib/paths.mjs';
import { loadConfig, configExists, updateSelectors, ConfigError } from './lib/config.mjs';
import { openBrowser, firstPage, openList, extractFromPage, hasSession } from './lib/browser.mjs';
import { pickPrice, extractUnit } from './lib/price.mjs';

const HELP = `
商品一覧の取り出しを試し、セレクタ候補を表示します。

  npm run netsuper:probe -- --url <一覧URL> [--save] [--headed] [--limit 8]
`;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

main(async () => {
  const values = parseCliArgs({
    url: { type: 'string' },
    save: { type: 'boolean' },
    headed: { type: 'boolean' },
  });
  if (values.help) { log(HELP); return; }
  const limit = parseLimit(values.limit, 8);

  const cfg = configExists() ? loadConfig({ requireCategories: false }) : null;
  const url = values.url || cfg?.categories[0]?.url || cfg?.entryUrl;
  if (!url) {
    throw new ConfigError('調べる一覧URLがありません。--url で指定するか、設定に categories を書いてください。');
  }
  if (!hasSession()) {
    log('※ 保存済みのログインセッションがありません。会員限定の価格は取れない可能性があります。');
    log('  `npm run netsuper:login` を先に実行してください。\n');
  }

  const context = await openBrowser({ headed: Boolean(values.headed) });
  let res;
  let dir;
  let bodyText = '';
  let finalUrl = url;
  try {
    const page = await firstPage(context);
    await openList(page, url, { waitMs: cfg?.waitMs ?? 1500 });
    res = await extractFromPage(page, cfg?.selectors);
    finalUrl = page.url();
    bodyText = await page
      .evaluate(() => (document.body ? document.body.innerText.replace(/\n{2,}/g, '\n') : ''))
      .catch(() => '');

    dir = ensureDir(path.join(outputRoot(), `probe-${stamp()}`));
    fs.writeFileSync(path.join(dir, 'page.html'), await page.content(), 'utf8');
    fs.writeFileSync(path.join(dir, 'page.txt'), bodyText, 'utf8');
    await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: false }).catch(() => {});
    fs.writeFileSync(path.join(dir, 'extract.json'), `${JSON.stringify(res, null, 2)}\n`, 'utf8');
  } finally {
    await context.close();
  }

  section('抽出結果');
  log(`  URL        : ${url}`);
  if (finalUrl !== url) log(`  遷移後URL  : ${finalUrl}（別の画面に飛ばされています）`);
  log(`  判定モード : ${res.mode}${res.signature ? `（署名: ${res.signature} / 深さ ${res.depth}）` : ''}`);
  log(`  商品件数   : ${res.count} 件`);
  if (res.selectors?.item) log(`  セレクタ   : ${res.selectors.item}`);
  log(`  保存先     : ${relativeToCwd(dir)}/（page.html / page.txt / page.png / extract.json）`);

  if (res.mode === 'failed') {
    section('取り出せませんでした');
    log(`  価格らしきテキストを含む要素: ${res.priceNodeCount ?? 0} 個`);
    section('実際に表示されていた文言（先頭600文字）');
    log(bodyText.trim() ? bodyText.trim().slice(0, 600) : '（本文が空。JS の描画が終わっていない可能性があります）');
    section('考えられる原因');
    if (/(ログイン|会員登録|サインイン|新規登録|パスワード)/.test(bodyText)) {
      log('  ログイン画面が表示されています。`npm run netsuper:login` をやり直してください。');
    } else if (/(店舗|お届け先|エリア|郵便番号|配達)/.test(bodyText)) {
      log('  店舗またはお届け先の選択を求められています。');
      log('  `npm run netsuper:login` で開いたブラウザで、商品一覧が見えるところまで進めてください。');
    } else if (!bodyText.trim()) {
      log('  本文が空です。描画待ちが足りない可能性があります（設定の waitMs を 5000 に）。');
    } else {
      log('  一覧ページではない可能性があります。売場を開いたときのURLか確認してください。');
    }
    log(`\n  画面を目で見るには: npm run netsuper:probe -- --headed --url "${url}"`);
    log(`  保存済みの画面   : ${relativeToCwd(dir)}/page.png`);
    process.exitCode = 1;
    return;
  }

  section(`先頭 ${Math.min(limit, res.items.length)} 件`);
  for (const it of res.items.slice(0, limit)) {
    const p = pickPrice(it.priceText || it.rawText);
    const unit = extractUnit(it.rawText);
    log(`  ・${it.name || '(名前を特定できず)'}`);
    log(`      価格 : ${p.price ?? '—'} 円${p.priceKind !== 'single' && p.priceKind !== 'tax_included' ? `（候補: ${p.candidates.join(' / ')}）` : ''}`);
    if (unit) log(`      容量 : ${unit}`);
    if (it.soldOut) log('      状態 : 売り切れ');
    if (!it.name || p.price === null) log(`      raw  : ${it.rawText.slice(0, 80)}`);
  }

  if (res.diagnostics?.length) {
    section('カード候補（件数の多い順）');
    for (const d of res.diagnostics.slice(0, 5)) {
      log(`  ${String(d.count).padStart(4)} 件  深さ${d.depth}  ${d.key.slice(0, 70)}`);
    }
  }

  const named = res.items.filter((i) => i.name).length;
  const priced = res.items.filter((i) => pickPrice(i.priceText || i.rawText).price !== null).length;
  section('品質');
  log(`  名前が取れた : ${named} / ${res.count}`);
  log(`  価格が取れた : ${priced} / ${res.count}`);
  if (named < res.count || priced < res.count) {
    log('  取りこぼしがある場合は、設定の selectors.name / selectors.price を指定すると安定します。');
  }

  if (values.save && res.selectors?.item) {
    const file = updateSelectors({ item: res.selectors.item }, undefined);
    log(`\n  セレクタを保存しました: ${relativeToCwd(file)}`);
  } else if (values.save) {
    log('\n  ※ 安定したセレクタを作れなかったため保存しませんでした（毎回の自動判定で動きます）。');
  }
});
