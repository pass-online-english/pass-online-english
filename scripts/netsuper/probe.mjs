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
import {
  openBrowser, firstPage, openList, extractFromPage, describeFrames,
  attachApiCapture, scrollAndHarvest, hasSession,
} from './lib/browser.mjs';
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
    wait: { type: 'string' },
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

  const waitMs = values.wait === undefined ? (cfg?.waitMs ?? 1500) : Number(values.wait);
  if (!Number.isFinite(waitMs) || waitMs < 0) throw new Error('--wait はミリ秒（0以上の数値）で指定してください。');

  const context = await openBrowser({ headed: Boolean(values.headed || cfg?.headed) });
  let res;
  let dir;
  let bodyText = '';
  let finalUrl = url;
  let frames = [];
  let nav = null;
  let capture = null;
  let apiProducts = [];
  // 未捕捉の例外は描画停止の直接原因になる。console のエラー（画像404など）は参考情報。
  const problems = { errors: [], console: [], failedRequests: [], badResponses: [] };
  // アプリがサーバに何を聞いて何を返されたか。読み込み中で止まる原因はここに出る
  const api = [];
  try {
    const page = await firstPage(context);
    // 描画されない原因は JS エラーか通信の失敗であることが多いので拾っておく
    page.on('pageerror', (err) => problems.errors.push(String(err.message).split('\n')[0]));
    page.on('console', (m) => {
      if (m.type() === 'error') problems.console.push(m.text().slice(0, 200));
    });
    page.on('requestfailed', (req) => {
      problems.failedRequests.push(`${req.failure()?.errorText ?? 'failed'} ${req.url().slice(0, 120)}`);
    });
    page.on('response', (res) => {
      const type = res.request().resourceType();
      if (type === 'xhr' || type === 'fetch') api.push(`${res.status()} ${res.request().method()} ${res.url().slice(0, 110)}`);
      else if (res.status() >= 400) problems.badResponses.push(`${res.status()} ${res.url().slice(0, 110)}`);
    });

    capture = attachApiCapture(page, { pattern: cfg?.apiPattern });
    nav = await openList(page, url, { waitMs });
    res = await extractFromPage(page, cfg?.selectors);
    // 画面に商品が出ないアプリでも、届いた JSON に載っていることがある
    if (!res.count) await scrollAndHarvest(page, capture, { rounds: 8, pause: Math.max(800, waitMs) });
    apiProducts = capture.products(0);
    finalUrl = page.url();
    frames = await describeFrames(page);
    bodyText = await page
      .evaluate(() => (document.body ? document.body.innerText.replace(/\n{2,}/g, '\n') : ''))
      .catch(() => '');

    dir = ensureDir(path.join(outputRoot(), `probe-${stamp()}`));
    fs.writeFileSync(path.join(dir, 'page.html'), await page.content(), 'utf8');
    fs.writeFileSync(path.join(dir, 'page.txt'), bodyText, 'utf8');
    // 受信データそのものは住所や氏名を含みうるので、抜き出した商品と宛先だけ残す
    fs.writeFileSync(
      path.join(dir, 'api-products.json'),
      `${JSON.stringify(apiProducts, null, 2)}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dir, 'api-endpoints.txt'),
      capture.entries.map((e) => `${e.status} ${e.url}`).join('\n'),
      'utf8'
    );
    await page.screenshot({ path: path.join(dir, 'page.png'), fullPage: false }).catch(() => {});
    fs.writeFileSync(
      path.join(dir, 'extract.json'),
      `${JSON.stringify({ url, finalUrl, navigation: nav, frames, api, problems, result: res }, null, 2)}\n`,
      'utf8'
    );
  } finally {
    await context.close();
  }

  section('抽出結果');
  log(`  URL        : ${url}`);
  if (finalUrl !== url) log(`  遷移後URL  : ${finalUrl}（別の画面に飛ばされています）`);
  if (nav) log(`  遷移方法   : ${nav.how}${nav.sawPrices ? '' : ' / 価格の表示は確認できず'}`);
  log(`  判定モード : ${res.mode}${res.signature ? `（署名: ${res.signature} / 深さ ${res.depth}）` : ''}`);
  log(`  商品件数   : ${res.count} 件`);
  if (res.selectors?.item) log(`  セレクタ   : ${res.selectors.item}`);
  log(`  保存先     : ${relativeToCwd(dir)}/（page.html / page.txt / page.png / extract.json）`);

  if (apiProducts.length) {
    section(`アプリが受け取ったデータから ${apiProducts.length} 件`);
    for (const p of apiProducts.slice(0, limit)) {
      log(`  ・${p.name}`);
      log(`      価格 : ${p.price} 円${p.priceKind === 'tax_included' ? '（税込）' : p.candidates.length > 1 ? `（候補: ${p.candidates.join(' / ')}）` : ''}`);
      if (p.unit) log(`      容量 : ${p.unit}`);
      if (p.soldOut) log('      状態 : 売り切れ');
    }
    log(`\n  全件: ${relativeToCwd(dir)}/api-products.json`);
    if (!res.count) {
      section('この売場はこの方法で収集できます');
      log('  画面には商品が出ていませんが、データは取れています。');
      log('  そのまま `npm run netsuper:scrape` で全カテゴリを収集できます。');
      return;
    }
  }

  if (res.mode === 'failed') {
    section('取り出せませんでした');
    log(`  価格らしきテキストを含む要素: ${res.priceNodeCount ?? 0} 個`);
    section('実際に表示されていた文言（先頭600文字）');
    log(bodyText.trim() ? bodyText.trim().slice(0, 600) : '（本文が空。JS の描画が終わっていない可能性があります）');
    section('ページの状態');
    for (const f of frames) {
      if (f.error) { log(`  ${f.url} — 読めませんでした（${f.error}）`); continue; }
      const mount = f.mountPoint ? `${f.mountPoint.selector} の子要素 ${f.mountPoint.children} 個` : 'マウント先なし';
      log(`  ${f.url.slice(0, 90)}`);
      log(`      タイトル「${f.title || '（なし）'}」 要素 ${f.elements} 個 / 本文 ${f.textLength} 文字 / HTML ${f.htmlLength} 文字 / ${mount}`);
    }
    if (problems.errors.length) {
      section('JavaScript の例外');
      for (const e of [...new Set(problems.errors)].slice(0, 8)) log(`  ${e}`);
    }
    if (problems.console.length) {
      section('コンソールのエラー（参考）');
      for (const e of [...new Set(problems.console)].slice(0, 8)) log(`  ${e}`);
    }
    if (problems.failedRequests.length) {
      section('失敗した通信');
      for (const r of [...new Set(problems.failedRequests)].slice(0, 8)) log(`  ${r}`);
    }
    if (problems.badResponses.length) {
      section('エラーを返した通信');
      for (const r of [...new Set(problems.badResponses)].slice(0, 8)) log(`  ${r}`);
    }
    section('アプリがサーバに聞いた内容');
    if (capture?.entries.length) log(`  （うち JSON を記録できたもの: ${capture.entries.length} 件 / 商品は見つからず）`);
    if (!api.length) {
      log('  1件もありません。アプリがサーバに問い合わせる前の段階で止まっています。');
    } else {
      for (const r of [...new Set(api)].slice(0, 12)) log(`  ${r}`);
    }

    // 画面に出ている文言をいちばんの手がかりにする。
    // 画像の404などは console にエラーを残すが、描画が止まった原因ではない。
    section('考えられる原因');
    const mainFrame = frames[0];
    const framedText = frames.slice(1).some((f) => f.textLength > 0);
    if (/(ログイン|会員登録|サインイン|新規登録|パスワード)/.test(bodyText)) {
      log('  ログイン画面が表示されています。`npm run netsuper:login` をやり直してください。');
    } else if (/(店舗|お届け先|エリア|郵便番号|配達)/.test(bodyText)) {
      log('  店舗またはお届け先の選択を求められています。');
      log('  `npm run netsuper:login` で開いたブラウザで、商品一覧が見えるところまで進めてください。');
    } else if (framedText) {
      log('  中身が iframe の中にあります。フレーム内も探しましたが商品は見つかりませんでした。');
    } else if (problems.errors.length) {
      log('  JavaScript の例外で描画が止まっています。上の例外の内容を共有してください。');
    } else if (mainFrame?.mountPoint && /loading|spinner|splash/i.test(mainFrame.mountPoint.selector)) {
      const failed = [...new Set(api)].filter((r) => !/^2\d\d /.test(r));
      log('  読み込み中の画面のまま止まっています。');
      if (!api.length) {
        log('  サーバへの問い合わせが1件もないため、アプリが起動しきっていません。');
        log('  画面を表示するブラウザなら動く可能性があります（--headed を付けて試す）。');
      } else if (failed.length) {
        log('  サーバがエラーを返しています。ログインが切れている可能性があります。');
        log('  `npm run netsuper:login` をやり直してください。');
      } else {
        log('  サーバとのやり取りは成功しているのに描画されていません。');
        log('  --headed を付けて、画面に何が出ているか確認してください。');
      }
    } else if (mainFrame && mainFrame.elements <= 5) {
      log('  ページ自体がほとんど空です。URL が読み込めていない可能性があります。');
    } else if (!bodyText.trim()) {
      log('  要素はあるのに文字が出ていません。描画待ちが足りないか、');
      log('  ブラウザが自動操作と判定されて中身を出していない可能性があります。');
      log('  `--wait 15000` を付けて長めに待つと切り分けられます。');
    } else {
      log('  一覧ページではない可能性があります。売場を開いたときのURLか確認してください。');
    }
    log(`\n  画面を目で見るには: npm run netsuper:probe -- --headed --url "${url}"`);
    log(`  もっと長く待つには: npm run netsuper:probe -- --wait 15000 --url "${url}"`);
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
