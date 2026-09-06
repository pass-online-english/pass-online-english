#!/usr/bin/env node
/**
 * 抽出・比較ロジックの自己テスト。ネットスーパーには接続しない。
 *
 *   npm run netsuper:selftest
 *
 * 価格の解釈・商品名の突き合わせ・差分判定を合成データで検証し、
 * 商品カードの自動判定は合成 HTML をブラウザに読ませて検証する。
 * Chromium が無い環境ではブラウザ部分だけスキップする。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { extractPrices, pickPrice, extractUnit, nameKey, similarity, bestMatch } from './lib/price.mjs';
import { parseCSV, parseStorePrices, toNumber } from './lib/csv.mjs';
import { compareToStore, compareSnapshots, buyOnline, VERDICT } from './lib/compare.mjs';
import { toRows, buildSummary } from './scrape.mjs';
import { buildDiffMarkdown } from './diff.mjs';
import { assignCategories } from './capture.mjs';
import { pageExtract } from './lib/extract.mjs';
import { extractProducts, dedupeProducts, toAmount } from './lib/apidata.mjs';
import {
  isSameDocumentNavigation, openList, extractFromPage, describeFrames,
  attachApiCapture, scrollAndHarvest,
} from './lib/browser.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error('test() は同期関数のみ。非同期は asyncTest を使ってください。');
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

console.log('\n── 価格の解釈 ────────────────────────────────');

test('「298円」を読める', () => {
  assert.equal(pickPrice('298円').price, 298);
});

test('カンマ区切りと ¥ 表記を読める', () => {
  assert.equal(pickPrice('¥1,280').price, 1280);
  assert.equal(pickPrice('1,280円').price, 1280);
});

test('全角の価格を読める', () => {
  assert.equal(pickPrice('１，２８０円').price, 1280);
});

test('税抜と税込が並ぶときは税込を採る', () => {
  const r = pickPrice('本体298円 (税込321円)');
  assert.equal(r.price, 321);
  assert.equal(r.priceKind, 'tax_included');
});

test('「税込」表記がなければ大きいほうを採り、候補を残す', () => {
  const r = pickPrice('298円 321円');
  assert.equal(r.price, 321);
  assert.equal(r.priceKind, 'max_of_multiple');
  assert.deepEqual(r.candidates, [298, 321]);
});

test('単位あたり価格は本体価格より優先しない', () => {
  const r = pickPrice('980円 100gあたり 245円');
  assert.equal(r.price, 980);
});

test('価格が無ければ null（0円と混同しない）', () => {
  const r = pickPrice('売り切れ');
  assert.equal(r.price, null);
  assert.equal(r.priceKind, 'unknown');
});

test('日付や個数を価格と誤認しない', () => {
  assert.equal(pickPrice('2026年9月6日 3個入').price, null);
});

test('内容量を拾える', () => {
  assert.equal(extractUnit('国産牛こま切れ 300g 598円'), '300g');
  assert.equal(extractUnit('たまご 10個入'), '10個入');
  assert.equal(extractUnit('名前だけ'), '');
});

test('extractPrices は税抜表記を区別する', () => {
  const [a, b] = extractPrices('本体 298円 税込 321円');
  assert.equal(a.taxExcluded, true);
  assert.equal(b.taxIncluded, true);
});

console.log('\n── 商品名の突き合わせ ────────────────────────');

test('全角・記号・空白の違いを吸収する', () => {
  assert.equal(nameKey('キッコーマン　特選（丸大豆）しょうゆ'), nameKey('ｷｯｺｰﾏﾝ特選 丸大豆 しょうゆ'));
});

test('完全一致が最優先', () => {
  const m = bestMatch('牛乳', [{ name: '牛乳', price: 200 }, { name: '低脂肪牛乳', price: 180 }]);
  assert.equal(m.item.price, 200);
  assert.equal(m.score, 1);
});

test('表記ゆれでも近いものを拾う', () => {
  const m = bestMatch('明治おいしい牛乳 900ml', [{ name: '明治 おいしい牛乳 900ml', price: 278 }]);
  assert.ok(m && m.score >= 0.6);
});

test('無関係な商品には一致させない', () => {
  const m = bestMatch('トイレットペーパー', [{ name: '国産豚バラ肉', price: 398 }]);
  assert.equal(m, null);
});

test('類似度は 0〜1 に収まる', () => {
  assert.ok(similarity('牛乳', '牛乳') === 1);
  assert.ok(similarity('牛乳', 'トマト') < 0.3);
});

console.log('\n── 店頭価格メモの読み込み ────────────────────');

test('BOM・引用符・CRLF を含む CSV を読める', () => {
  const csv = '﻿商品名,店頭価格,メモ\r\n"牛乳, 1L",198,毎週\r\nたまご,258,\r\n';
  const { items, errors } = parseStorePrices(csv);
  assert.equal(errors.length, 0);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, '牛乳, 1L');
  assert.equal(items[0].storePrice, 198);
  assert.equal(items[0].note, '毎週');
});

test('英語の列名でも読める', () => {
  const { items } = parseStorePrices('name,price\nmilk,198\n');
  assert.equal(items[0].storePrice, 198);
});

test('「198円」のような表記も数値として読む', () => {
  assert.equal(toNumber('１９８円'), 198);
  assert.equal(toNumber('1,280'), 1280);
  assert.equal(toNumber(''), null);
});

test('価格を読めない行はエラーとして報告し、他の行は残す', () => {
  const { items, errors } = parseStorePrices('商品名,店頭価格\n牛乳,やすい\nたまご,258\n');
  assert.equal(items.length, 1);
  assert.equal(errors.length, 1);
});

test('空の CSV でも落ちない', () => {
  assert.deepEqual(parseCSV(''), []);
  assert.deepEqual(parseStorePrices('').items, []);
});

console.log('\n── 店頭価格との比較 ──────────────────────────');

const NET = [
  { name: '牛乳 1000ml', price: 205, soldOut: false, category: '乳製品', url: 'https://x/1' },
  { name: 'たまご 10個入', price: 320, soldOut: false, category: '卵', url: 'https://x/2' },
  { name: '国産豚バラ肉 300g', price: 498, soldOut: false, category: '精肉', url: 'https://x/3' },
  { name: '食パン 6枚', price: 158, soldOut: true, category: 'パン', url: 'https://x/4' },
];
const STORE = [
  { name: '牛乳 1000ml', storePrice: 198, note: '' },
  { name: 'たまご 10個入', storePrice: 258, note: '' },
  { name: '国産豚バラ肉 300g', storePrice: 480, note: '' },
  { name: '食パン 6枚', storePrice: 150, note: '' },
  { name: 'ヨーグルト', storePrice: 128, note: '' },
];

test('差が小さいものは「ほぼ同じ」', () => {
  const r = compareToStore(STORE, NET);
  const milk = r.find((x) => x.name === '牛乳 1000ml');
  assert.equal(milk.verdict, VERDICT.SAME);
  assert.equal(milk.diff, 7);
});

test('差が大きいものは「ネットが高い」', () => {
  const r = compareToStore(STORE, NET);
  assert.equal(r.find((x) => x.name === 'たまご 10個入').verdict, VERDICT.PRICIER);
});

test('円と％のゆるいほうで判定する（18円差は 20円以内なので同じ扱い）', () => {
  const r = compareToStore(STORE, NET, { tolerancePct: 0.01, toleranceYen: 20 });
  assert.equal(r.find((x) => x.name === '国産豚バラ肉 300g').verdict, VERDICT.SAME);
});

test('売り切れは買い物リストに入れない', () => {
  const r = compareToStore(STORE, NET);
  assert.equal(r.find((x) => x.name === '食パン 6枚').verdict, VERDICT.SOLD_OUT);
  assert.ok(!buyOnline(r).some((x) => x.name === '食パン 6枚'));
});

test('ネット側に無い商品は「見つからず」', () => {
  const r = compareToStore(STORE, NET);
  const y = r.find((x) => x.name === 'ヨーグルト');
  assert.equal(y.verdict, VERDICT.NO_MATCH);
  assert.equal(y.netPrice, null);
});

test('価格が取れていない商品とは突き合わせない', () => {
  const r = compareToStore([{ name: 'なぞ商品', storePrice: 100 }], [{ name: 'なぞ商品', price: null }]);
  assert.equal(r[0].verdict, VERDICT.NO_MATCH);
});

test('買い物リストは差額の小さい（得な）順', () => {
  const r = compareToStore(
    [{ name: 'A', storePrice: 200 }, { name: 'B', storePrice: 200 }],
    [{ name: 'A', price: 205, soldOut: false }, { name: 'B', price: 180, soldOut: false }]
  );
  assert.deepEqual(buyOnline(r).map((x) => x.name), ['B', 'A']);
});

console.log('\n── 前回との比較 ──────────────────────────────');

test('値上がり・値下がり・新登場・消えたを分類する', () => {
  const prev = [
    { name: '牛乳', price: 198, url: 'https://x/1' },
    { name: 'たまご', price: 258, url: 'https://x/2' },
    { name: '消えた商品', price: 100, url: 'https://x/9' },
  ];
  const curr = [
    { name: '牛乳', price: 188, url: 'https://x/1' },
    { name: 'たまご', price: 298, url: 'https://x/2' },
    { name: '新商品', price: 150, url: 'https://x/8' },
  ];
  const d = compareSnapshots(prev, curr);
  assert.equal(d.changed.length, 2);
  assert.equal(d.changed[0].name, '牛乳');
  assert.equal(d.changed[0].diff, -10);
  assert.equal(d.added.length, 1);
  assert.equal(d.removed.length, 1);
});

test('URL が無くても商品名で同一判定できる', () => {
  const d = compareSnapshots([{ name: '牛乳 1L', price: 198 }], [{ name: '牛乳　1L', price: 208 }]);
  assert.equal(d.changed.length, 1);
  assert.equal(d.added.length, 0);
});

test('価格が同じなら変化なし', () => {
  const d = compareSnapshots([{ name: 'A', price: 100 }], [{ name: 'A', price: 100 }]);
  assert.equal(d.changed.length, 0);
});

console.log('\n── 行の組み立てと出力 ────────────────────────');

test('抽出結果を価格つきの行に変換する', () => {
  const rows = toRows(
    [{ name: ' 牛乳　1000ml ', priceText: '本体 189円 (税込 205円)', rawText: '牛乳 1000ml 205円', category: '乳製品', url: 'https://x/1', soldOut: false }],
    { collectedAt: '2026-09-06' }
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, '牛乳 1000ml');
  assert.equal(rows[0].price, 205);
  assert.equal(rows[0].priceKind, 'tax_included');
  assert.equal(rows[0].collectedAt, '2026-09-06');
});

test('同じ商品が重複しても1行にまとまる', () => {
  const item = { name: '牛乳', priceText: '198円', rawText: '牛乳 198円', url: 'https://x/1' };
  assert.equal(toRows([item, { ...item }]).length, 1);
});

test('名前も価格も取れない行は捨てる', () => {
  assert.equal(toRows([{ name: '', priceText: '', rawText: '' }]).length, 0);
});

test('サマリは0件でも生成できる', () => {
  const md = buildSummary([], { store: 'テスト店', collectedAt: '2026-09-06', categories: 0 });
  assert.ok(md.includes('# ネットスーパー価格'));
});

test('差分レポートは店頭価格メモが無くても生成できる', () => {
  const md = buildDiffMarkdown({
    current: { date: '2026-09-06', store: 'テスト店', items: [] },
    previous: null,
    storeResults: null,
    snapshotDiff: null,
    tolerancePct: 0.1,
    toleranceYen: 20,
    top: 10,
  });
  assert.ok(md.includes('店頭価格メモがありません'));
});

test('差分レポートに買い物リストが載る', () => {
  const md = buildDiffMarkdown({
    current: { date: '2026-09-06', store: 'テスト店', items: NET },
    previous: { date: '2026-08-30', items: NET },
    storeResults: compareToStore(STORE, NET),
    snapshotDiff: compareSnapshots(NET, NET),
    tolerancePct: 0.1,
    toleranceYen: 20,
    top: 10,
  });
  assert.ok(md.includes('牛乳 1000ml'));
  assert.ok(md.includes('前回（2026-08-30）からの変化'));
});

// ── ブラウザでの商品カード自動判定 ──────────────────
const FIXTURES = [
  {
    name: 'よくあるカード型グリッド',
    html: `<div class="list">
      ${[
        ['明治 おいしい牛乳 900ml', '235円'],
        ['たまご Mサイズ 10個入', '268円'],
        ['国産豚バラ肉 300g', '498円'],
        ['トマト 1袋', '198円'],
      ].map(([n, p], i) => `
        <div class="item-card">
          <a href="/item/${i}"><img src="https://example.test/${i}.jpg" alt="${n}"></a>
          <div class="item-card__body">
            <a class="item-name" href="/item/${i}">${n}</a>
            <div class="item-price"><span class="num">${p}</span></div>
            <button type="button">カートに入れる</button>
          </div>
        </div>`).join('')}
    </div>`,
    expect: { count: 4, first: { name: '明治 おいしい牛乳 900ml', price: 235 } },
  },
  {
    name: '価格が複数タグに割れているカード',
    html: `<ul class="goods">
      ${[
        ['サントリー天然水 2L', '108', '116'],
        ['食パン 6枚切', '148', '159'],
        ['納豆 3P', '98', '105'],
      ].map(([n, honta, zeikomi], i) => `
        <li class="goods__item">
          <p class="goods__name">${n}</p>
          <p class="goods__price">本体 <span>${honta}</span>円（税込 <span>${zeikomi}</span>円）</p>
        </li>`).join('')}
    </ul>`,
    expect: { count: 3, first: { name: 'サントリー天然水 2L', price: 116 } },
  },
  {
    name: 'テーブル型の一覧（売り切れ表示つき）',
    html: `<table><tbody>
      <tr class="row"><td class="nm">きゅうり 3本</td><td class="pr">158円</td><td>　</td></tr>
      <tr class="row"><td class="nm">にんじん 1袋</td><td class="pr">198円</td><td>売り切れ</td></tr>
      <tr class="row"><td class="nm">じゃがいも 1kg</td><td class="pr">298円</td><td>　</td></tr>
      <tr class="row"><td class="nm">玉ねぎ 3個</td><td class="pr">248円</td><td>　</td></tr>
    </tbody></table>`,
    expect: { count: 4, first: { name: 'きゅうり 3本', price: 158 }, soldOutName: 'にんじん 1袋' },
  },
  {
    name: 'ヘッダ・フッタなど商品以外の価格表示が混ざるページ',
    html: `<header><p>3,000円以上のお買い上げで送料無料</p></header>
    <div class="list">
      ${[['豆腐 300g', '78円'], ['ちくわ 5本', '118円'], ['もやし', '38円']]
        .map(([n, p], i) => `<article class="p-card"><h3 class="p-card__ttl">${n}</h3><p class="p-card__price">${p}</p></article>`)
        .join('')}
    </div>
    <footer><p>年会費 0円</p></footer>`,
    expect: { count: 3, first: { name: '豆腐 300g', price: 78 } },
  },
];

/**
 * `#/` で画面を切り替える SPA の再現。
 *
 * `router` が true なら hashchange を購読する（普通のルータ）。
 * false なら購読せず、読み直さないと表示が変わらない
 * （ルータ任せの遷移が効かないアプリの再現）。
 * どちらも起動時に見出しだけ描画し、売場の中身は 400ms 後に出す。
 */
function spaHtml({ router }) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>テスト店</title></head><body>
<h1>テストネットスーパー</h1>
<div id="app"></div>
<script>
  var DATA = {
    "#/a": [["りんご 1袋","198"],["みかん 5個","258"],["ぶどう 1房","498"]],
    "#/b": [["牛乳 900ml","235"],["たまご 10個入","268"],["チーズ 6P","398"]]
  };
  function render() {
    var items = DATA[location.hash] || [];
    document.getElementById("app").innerHTML = items.map(function (it, i) {
      return '<div class="card"><a class="nm" href="/i/' + i + '">' + it[0] + '</a>'
           + '<p class="pr">' + it[1] + '円</p></div>';
    }).join("");
  }
  ${router ? 'window.addEventListener("hashchange", function () { setTimeout(render, 100); });' : ''}
  setTimeout(render, 400);
</script>
</body></html>`;
}

/**
 * `#/…` 付きのURLをいきなり開くと何も描画しないアプリの再現（twidy と同じ挙動）。
 * ルータはアプリ本体を先に読み込まないと初期化されず、
 * 起動後のハッシュ変更にだけ反応する。
 */
const COLD_SPA_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>テスト店</title></head><body>
<h1>テストネットスーパー</h1>
<div id="app"></div>
<script>
  var DATA = {
    "#/a": [["りんご 1袋","198"],["みかん 5個","258"],["ぶどう 1房","498"]],
    "#/b": [["牛乳 900ml","235"],["たまご 10個入","268"],["チーズ 6P","398"]]
  };
  var booted = false;
  function render() {
    var items = DATA[location.hash] || [];
    document.getElementById("app").innerHTML = items.map(function (it, i) {
      return '<div class="card"><a class="nm" href="/i/' + i + '">' + it[0] + '</a>'
           + '<p class="pr">' + it[1] + '円</p></div>';
    }).join("");
  }
  window.addEventListener("hashchange", function () {
    if (booted) setTimeout(render, 100);
  });
  setTimeout(function () {
    // ハッシュ付きで直接開かれた場合、ルータは初期化されるが描画はしない
    booted = true;
    if (!location.hash) render();
  }, 300);
</script>
</body></html>`;

const SPA_HTML = spaHtml({ router: false });
const ROUTER_SPA_HTML = spaHtml({ router: true });

/**
 * 画面をキャンバスに描画するアプリの再現（twidy と同じ構成）。
 * HTML には商品が1つも存在せず、商品データは API から JSON で届く。
 */
const CANVAS_APP_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>テスト店</title></head><body>
<div id="loading"><div class="spinner"></div></div>
<canvas width="800" height="600"></canvas>
<script>
  fetch("/api/graphql", { method: "POST" }).then(function (r) { return r.json(); });
</script>
</body></html>`;

const CANVAS_API_JSON = JSON.stringify({
  data: {
    products: {
      edges: [
        { node: { id: 'p1', name: 'トマト 1袋', taxIncludedPrice: 198, inStock: true } },
        { node: { id: 'p2', name: 'きゅうり 3本', taxIncludedPrice: 158, inStock: true } },
        { node: { id: 'p3', name: 'にんじん 1袋', taxIncludedPrice: 208, inStock: false } },
      ],
    },
  },
});

/**
 * 通信を Service Worker が代行するアプリの再現。
 * ページ自身は商品データを取りに行かず、Service Worker が取ってくる。
 * ページ単位の監視ではこの通信が見えない。
 */
const SW_APP_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>SW店</title></head><body>
<div id="loading"></div>
<script>navigator.serviceWorker.register("/sw.js");</script>
</body></html>`;

const SW_SCRIPT = `
self.addEventListener("install", function (event) {
  event.waitUntil(fetch("/api-graphql.json").then(function (r) { return r.json(); }));
});
`;

/** 売場を iframe に入れているサイトの再現。 */
const IFRAME_HOST_HTML = `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body>
<header><p>3,000円以上で送料無料</p></header>
<iframe src="/inner" width="1000" height="800" style="border:0"></iframe>
</body></html>`;

/** localhost だけで完結する一時サーバ（外部には接続しない）。 */
function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
      if (pathname === '/sw.js') {
        res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
        res.end(SW_SCRIPT);
        return;
      }
      if (pathname === '/api-graphql.json') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(CANVAS_API_JSON);
        return;
      }
      if (pathname === '/api/graphql') {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(CANVAS_API_JSON);
        return;
      }
      const body =
        pathname === '/canvas' ? CANVAS_APP_HTML
        : pathname === '/sw-app' ? SW_APP_HTML
        : pathname === '/host' ? IFRAME_HOST_HTML
        : pathname === '/inner' ? `<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body>${FIXTURES[0].html}</body></html>`
        : pathname === '/router' ? ROUTER_SPA_HTML
        : pathname === '/cold' ? COLD_SPA_HTML
        : SPA_HTML;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}/` });
    });
  });
}

async function runBrowserTests() {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch {
    console.log('  ⏭  playwright が未インストールのためスキップ（npm install で入ります）');
    return;
  }
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.NETSUPER_CHROMIUM_PATH || undefined,
    });
  } catch (err) {
    console.log('  ⏭  Chromium を起動できないためスキップ');
    console.log(`     ${String(err.message).split('\n')[0]}`);
    console.log('     `npx playwright install chromium` で導入できます。');
    return;
  }

  try {
    const page = await browser.newPage();
    for (const f of FIXTURES) {
      await asyncTest(f.name, async () => {
        await page.setContent(`<!doctype html><html lang="ja"><body>${f.html}</body></html>`);
        const res = await page.evaluate(pageExtract, { selectors: {} });
        assert.equal(res.mode, 'auto', `判定モードが auto ではありません（${res.mode}）`);
        assert.equal(res.count, f.expect.count, `件数が違います（${res.count} 件）`);
        const first = res.items[0];
        assert.equal(first.name, f.expect.first.name, `商品名が違います（${first.name}）`);
        assert.equal(
          pickPrice(first.priceText || first.rawText).price,
          f.expect.first.price,
          `価格が違います（${first.priceText}）`
        );
        if (f.expect.soldOutName) {
          const so = res.items.find((i) => i.name === f.expect.soldOutName);
          assert.ok(so && so.soldOut, '売り切れを検出できていません');
          assert.ok(res.items.filter((i) => i.soldOut).length === 1, '売り切れの誤検出があります');
        }
      });
    }

    await asyncTest('セレクタを設定すればそちらが使われる', async () => {
      await page.setContent(`<!doctype html><html lang="ja"><body>${FIXTURES[0].html}</body></html>`);
      const res = await page.evaluate(pageExtract, {
        selectors: { item: '.item-card', name: '.item-name', price: '.item-price' },
      });
      assert.equal(res.mode, 'configured');
      assert.equal(res.count, 4);
      assert.equal(res.items[0].name, '明治 おいしい牛乳 900ml');
    });

    await asyncTest('商品が無いページでは failed を返す（0件を捏造しない）', async () => {
      await page.setContent('<!doctype html><html lang="ja"><body><p>ログインしてください</p></body></html>');
      const res = await page.evaluate(pageExtract, { selectors: {} });
      assert.equal(res.mode, 'failed');
      assert.equal(res.count, 0);
    });

    const fixture = await startFixtureServer();
    try {
      await asyncTest('ルータに任せて #/ の売場を切り替えられる', async () => {
        const spa = await browser.newPage();
        try {
          await openList(spa, `${fixture.base}router#/a`, { waitMs: 100 });
          const a = await extractFromPage(spa, {});
          assert.equal(a.count, 3, `1画面目が取れていません（${a.count} 件）`);
          assert.equal(a.items[0].name, 'りんご 1袋');

          await openList(spa, `${fixture.base}router#/b`, { waitMs: 100 });
          const b = await extractFromPage(spa, {});
          assert.equal(b.items[0].name, '牛乳 900ml', 'ハッシュ遷移後も前の画面が残っています');
        } finally {
          await spa.close();
        }
      });

      await asyncTest('#/… を直接開くと描画しないアプリでも売場を開ける', async () => {
        const spa = await browser.newPage();
        try {
          await openList(spa, `${fixture.base}cold#/a`, { waitMs: 100 });
          const a = await extractFromPage(spa, {});
          assert.equal(a.count, 3, `売場が描画されていません（${a.count} 件）。アプリ本体を先に開けていない可能性`);
          assert.equal(a.items[0].name, 'りんご 1袋');

          await openList(spa, `${fixture.base}cold#/b`, { waitMs: 100 });
          const b = await extractFromPage(spa, {});
          assert.equal(b.items[0].name, '牛乳 900ml');
        } finally {
          await spa.close();
        }
      });

      await asyncTest('hashchange を見ていないアプリは読み直して切り替える', async () => {
        const spa = await browser.newPage();
        try {
          await openList(spa, `${fixture.base}#/a`, { waitMs: 100, hashTimeout: 1500 });
          const a = await extractFromPage(spa, {});
          assert.equal(a.items[0].name, 'りんご 1袋');

          await openList(spa, `${fixture.base}#/b`, { waitMs: 100, hashTimeout: 1500 });
          const b = await extractFromPage(spa, {});
          assert.equal(b.items[0].name, '牛乳 900ml', 'ハッシュ遷移後も前の画面が残っています');
        } finally {
          await spa.close();
        }
      });

      await asyncTest('画面に商品が無くても受信データから取り出せる', async () => {
        const canvas = await browser.newPage();
        try {
          const capture = attachApiCapture(canvas, { pattern: 'graphql' });
          await openList(canvas, `${fixture.base}canvas`, { waitMs: 500 });
          const dom = await extractFromPage(canvas, {});
          assert.equal(dom.count, 0, '画面からは取れない前提のフィクスチャです');

          await scrollAndHarvest(canvas, capture, { rounds: 2, pause: 300, stableRounds: 1 });
          const products = capture.products(0);
          assert.equal(products.length, 3, `受信データから取れていません（${products.length} 件）`);
          assert.equal(products[0].name, 'トマト 1袋');
          assert.equal(products[0].price, 198);
          assert.equal(products[2].soldOut, true);
        } finally {
          await canvas.close();
        }
      });

      await asyncTest('Service Worker が代行する通信も記録できる', async () => {
        const swPage = await browser.newPage();
        try {
          const capture = attachApiCapture(swPage, {});
          await swPage.goto(`${fixture.base}sw-app`, { waitUntil: 'domcontentloaded' });
          // Service Worker の install で商品データを取りに行く
          const deadline = Date.now() + 15_000;
          while (Date.now() < deadline && capture.products(0).length === 0) {
            await new Promise((r) => setTimeout(r, 300));
          }
          const products = capture.products(0);
          assert.equal(
            products.length,
            3,
            `Service Worker の通信を取りこぼしています（${products.length} 件 / 記録: ${capture.entries.map((e) => e.url).join(', ') || 'なし'}）`
          );
          assert.equal(products[0].name, 'トマト 1袋');
        } finally {
          await swPage.close();
        }
      });

      await asyncTest('売場が iframe の中にあっても取り出せる', async () => {
        const framed = await browser.newPage();
        try {
          await openList(framed, `${fixture.base}host`, { waitMs: 100 });
          const res = await extractFromPage(framed, {});
          assert.equal(res.count, 4, `iframe 内の商品が取れていません（${res.count} 件）`);
          assert.equal(res.items[0].name, '明治 おいしい牛乳 900ml');
          assert.ok(res.frameUrl && res.frameUrl.endsWith('/inner'), 'どのフレームから取ったか記録されていません');
        } finally {
          await framed.close();
        }
      });

      await asyncTest('フレームの状態を報告できる（0件の原因切り分け用）', async () => {
        const framed = await browser.newPage();
        try {
          await openList(framed, `${fixture.base}host`, { waitMs: 100 });
          const info = await describeFrames(framed);
          assert.equal(info.length, 2, 'iframe が数えられていません');
          assert.ok(info[1].textLength > 0, 'iframe 内の本文が読めていません');
        } finally {
          await framed.close();
        }
      });

      await asyncTest('外枠だけ描画された状態を「準備完了」と誤認しない', async () => {
        const spa = await browser.newPage();
        try {
          // 見出しは即時、売場の中身は 400ms 後。待ちが甘いと商品が0件になる
          await openList(spa, `${fixture.base}router#/a`, { waitMs: 0, scroll: false });
          const res = await extractFromPage(spa, {});
          assert.equal(res.count, 3);
        } finally {
          await spa.close();
        }
      });
    } finally {
      fixture.server.close();
    }

    await asyncTest('自動判定したセレクタで同じ件数を取り直せる', async () => {
      await page.setContent(`<!doctype html><html lang="ja"><body>${FIXTURES[0].html}</body></html>`);
      const auto = await page.evaluate(pageExtract, { selectors: {} });
      assert.ok(auto.selectors.item, 'セレクタを作れませんでした');
      const again = await page.evaluate(pageExtract, { selectors: { item: auto.selectors.item } });
      assert.equal(again.count, auto.count);
    });
  } finally {
    await browser.close();
  }
}

console.log('\n── 受信データ（API）からの商品抽出 ──────────');

// Relay 形式（edges / node）で、価格が入れ子になっている応答
const GRAPHQL_RESPONSE = {
  data: {
    category: {
      name: '野菜',
      products: {
        edges: [
          {
            node: {
              id: 'UHJvZHVjdDox',
              name: 'トマト 1袋',
              price: { amount: 183, currency: 'JPY' },
              taxIncludedPrice: 198,
              unit: '1袋',
              inStock: true,
            },
          },
          {
            node: {
              id: 'UHJvZHVjdDoy',
              name: 'にんじん 1袋',
              price: { amount: 192, currency: 'JPY' },
              taxIncludedPrice: 208,
              inStock: false,
            },
          },
        ],
      },
    },
  },
};

// twidy（Saleor）の実際の形。商品名は浅く、価格は defaultVariant の下に深く入る。
const SALEOR_RESPONSE = {
  data: {
    twidyProducts: {
      edges: [
        {
          cursor: 'a',
          node: {
            id: 'UHJvZHVjdDox',
            name: 'トマト 1袋',
            slug: 'tomato',
            category: { name: '野菜' },
            thumbnail: { url: 'https://example.test/1.jpg' },
            defaultVariant: {
              id: 'variant-1',
              sku: '0490',
              name: '1袋',
              quantityAvailable: 12,
              pricing: { price: { gross: { amount: 198, currency: 'JPY' }, net: { amount: 183, currency: 'JPY' } } },
            },
          },
        },
        {
          cursor: 'b',
          node: {
            id: 'UHJvZHVjdDoy',
            name: 'にんじん 1袋',
            slug: 'ninjin',
            category: { name: '野菜' },
            defaultVariant: {
              sku: '0491',
              quantityAvailable: 0,
              pricing: { price: { gross: { amount: 208 }, net: { amount: 192 } } },
            },
          },
        },
      ],
    },
  },
};

test('商品名より深い階層にある価格を拾う（twidy の形）', () => {
  const products = extractProducts(SALEOR_RESPONSE);
  assert.equal(products.length, 2, `商品数が違います（${products.length} 件）`);
  assert.equal(products[0].name, 'トマト 1袋');
  assert.equal(products[0].price, 198);
  assert.equal(products[0].priceKind, 'tax_included');
});

test('税込（gross）を採り、税抜（net）は候補に残す', () => {
  const [tomato] = extractProducts(SALEOR_RESPONSE);
  assert.deepEqual(tomato.candidates, [183, 198]);
});

test('規格（variant）を別の商品として二重に数えない', () => {
  const products = extractProducts(SALEOR_RESPONSE);
  assert.ok(!products.some((p) => p.name === '1袋'), '規格が商品として混ざっています');
});

test('在庫数0を売り切れとして扱う（深い階層でも）', () => {
  const products = extractProducts(SALEOR_RESPONSE);
  assert.equal(products[0].soldOut, false);
  assert.equal(products[1].soldOut, true);
});

test('売場の名前を商品データから拾う', () => {
  const products = extractProducts(SALEOR_RESPONSE);
  assert.equal(products[0].category, '野菜');
});

test('入れ子の応答から商品を取り出せる', () => {
  const products = extractProducts(GRAPHQL_RESPONSE);
  assert.equal(products.length, 2);
  assert.equal(products[0].name, 'トマト 1袋');
});

test('税込が明示されていればそれを採る', () => {
  const [tomato] = extractProducts(GRAPHQL_RESPONSE);
  assert.equal(tomato.price, 198);
  assert.equal(tomato.priceKind, 'tax_included');
  assert.deepEqual(tomato.candidates, [183, 198]);
});

test('在庫なしを売り切れとして扱う', () => {
  const products = extractProducts(GRAPHQL_RESPONSE);
  assert.equal(products[0].soldOut, false);
  assert.equal(products[1].soldOut, true);
});

test('内容量の項目を拾い、無ければ商品名から補う', () => {
  const products = extractProducts(GRAPHQL_RESPONSE);
  assert.equal(products[0].unit, '1袋');
  assert.equal(products[1].unit, '1袋');
});

test('商品名と価格が別の階層に分かれていても読む', () => {
  const p = extractProducts({
    items: [{ taxIncludedPrice: 198, product: { name: 'トマト 1袋', id: 'x' } }],
  });
  assert.equal(p.length, 1);
  assert.equal(p[0].name, 'トマト 1袋');
  assert.equal(p[0].price, 198);
});

test('JSON が文字列として埋め込まれていても読む', () => {
  const inner = JSON.stringify({ items: [{ name: 'かぼちゃ 1/4', taxIncludedPrice: 198 }] });
  const p = extractProducts({ data: { cachedCatalog: inner } });
  assert.equal(p.length, 1);
  assert.equal(p[0].price, 198);
});

test('名前だけ・価格だけのオブジェクトは商品とみなさない', () => {
  assert.equal(extractProducts({ user: { name: '八木' } }).length, 0);
  assert.equal(extractProducts({ cart: { totalPrice: 3200 } }).length, 0);
});

test('文字列の価格も読む', () => {
  const p = extractProducts({ items: [{ name: '牛乳', price: '235' }] });
  assert.equal(p[0].price, 235);
});

test('ありえない価格は採らない', () => {
  assert.equal(extractProducts({ items: [{ name: 'あやしい', price: 0 }] }).length, 0);
  assert.equal(extractProducts({ items: [{ name: 'あやしい', price: 99999999 }] }).length, 0);
});

test('価格が入れ子で税込・税抜に分かれていても読む', () => {
  const p = extractProducts({
    items: [{ productName: 'キャベツ 1玉', price: { taxIncluded: 258, taxExcluded: 239 } }],
  });
  assert.equal(p.length, 1);
  assert.equal(p[0].name, 'キャベツ 1玉');
  assert.equal(p[0].price, 258);
});

test('項目名が想定外でも金額が1つなら読む', () => {
  const p = extractProducts({ items: [{ itemTitle: 'ねぎ 1束', price: { jpy: 158 } }] });
  assert.equal(p[0].price, 158);
});

test('個数や割合を金額と取り違えない', () => {
  const p = extractProducts({ items: [{ name: 'あやしい', price: { quantity: 3, rate: 8 } }] });
  assert.equal(p.length, 0);
});

test('toAmount は入れ子・文字列・全角を読む', () => {
  assert.equal(toAmount(198), 198);
  assert.equal(toAmount('1,280円'), 1280);
  assert.equal(toAmount({ amount: 298, currency: 'JPY' }), 298);
  assert.equal(toAmount('やすい'), null);
});

test('同じ商品は id でまとめる（後から来た価格を採る）', () => {
  const merged = dedupeProducts([
    { id: 'a', name: '牛乳', price: 235 },
    { id: 'a', name: '牛乳', price: 228 },
    { id: 'b', name: 'たまご', price: 268 },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].price, 228);
});

test('id が無ければ商品名でまとめる', () => {
  const merged = dedupeProducts([
    { name: '牛乳', price: 235 },
    { name: '牛乳', price: 235 },
  ]);
  assert.equal(merged.length, 1);
});

console.log('\n── 手動で見て回ったときの仕分け ──────────────');

const CATS = [
  { name: '野菜', url: 'https://twidy.jp/#/category/shop/Q2F0ZWdvcnk6MQ==' },
  { name: '精肉', url: 'https://twidy.jp/#/category/shop/Q2F0ZWdvcnk6OQ==' },
];

test('見ていた画面から売場を判定する', () => {
  const rows = assignCategories(
    [
      { name: 'トマト', price: 198, sourceUrl: 'https://twidy.jp/#/category/shop/Q2F0ZWdvcnk6MQ==' },
      { name: '豚バラ', price: 498, sourceUrl: 'https://twidy.jp/#/category/shop/Q2F0ZWdvcnk6OQ==' },
    ],
    CATS
  );
  assert.equal(rows[0].category, '野菜');
  assert.equal(rows[1].category, '精肉');
});

test('設定にない売場は空欄にする（適当な名前を付けない）', () => {
  const rows = assignCategories([{ name: '謎', price: 100, sourceUrl: 'https://twidy.jp/#/category/shop/OTHER' }], CATS);
  assert.equal(rows[0].category, '');
});

test('見ていた画面が分からなくても落ちない', () => {
  const rows = assignCategories([{ name: '謎', price: 100 }], CATS);
  assert.equal(rows[0].category, '');
});

console.log('\n── SPA（#/ で画面を切り替えるサイト）の遷移判定 ──');

test('ハッシュだけが違うURLは同一ドキュメント遷移とみなす', () => {
  assert.equal(isSameDocumentNavigation('https://x.test/#/a', 'https://x.test/#/b'), true);
});

test('パスが違えば通常の遷移', () => {
  assert.equal(isSameDocumentNavigation('https://x.test/a', 'https://x.test/b'), false);
});

test('ホストが違えば通常の遷移', () => {
  assert.equal(isSameDocumentNavigation('https://x.test/#/a', 'https://y.test/#/a'), false);
});

test('about:blank からの初回遷移は通常の遷移', () => {
  assert.equal(isSameDocumentNavigation('about:blank', 'https://x.test/#/a'), false);
});

console.log('\n── 商品カードの自動判定（合成HTML） ──────────');
await runBrowserTests();

console.log(`\n${'─'.repeat(46)}`);
console.log(`  成功 ${passed} / 失敗 ${failed}`);
console.log(`${'─'.repeat(46)}\n`);
if (failed > 0) process.exitCode = 1;
