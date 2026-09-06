#!/usr/bin/env node
/**
 * 設定に書いたカテゴリを順に開き、商品名と価格を集めて保存する。
 *
 *   npm run netsuper:scrape
 *   npm run netsuper:scrape -- --category 野菜        指定カテゴリだけ
 *   npm run netsuper:scrape -- --headed               ブラウザを表示
 *   npm run netsuper:scrape -- --out reports/tmp      出力先を変える
 *
 * 出力: reports/netsuper/<YYYY-MM-DD>/ に items.csv / items.json / summary.md
 * （reports/ は .gitignore 済み。実データはコミットしない）
 *
 * 相手のサーバに負荷をかけないよう、ページは1枚ずつ順番に開き、
 * 既定で 1.5 秒空ける（設定の waitMs）。並列アクセスはしない。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCliArgs } from '../analytics/lib/args.mjs';
import { main, log, section, warn, isEntrypoint } from '../analytics/lib/cli.mjs';
import { toCSV, mdTable, fmtNum } from '../analytics/lib/output.mjs';
import { outputRoot, ensureDir, today, relativeToCwd } from './lib/paths.mjs';
import { loadConfig } from './lib/config.mjs';
import { openBrowser, firstPage, collectCategory, attachApiCapture, hasSession, sleep } from './lib/browser.mjs';
import { pickPrice, extractUnit, normalizeText } from './lib/price.mjs';

const HELP = `
カテゴリを巡回して商品名と価格を集めます。

  npm run netsuper:scrape [-- --category <名前>] [--headed] [--out <ディレクトリ>]
`;

export const CSV_COLUMNS = [
  'collectedAt', 'category', 'name', 'price', 'priceKind', 'priceCandidates',
  'unit', 'soldOut', 'url', 'source', 'sourceUrl', 'priceRaw',
];

/**
 * 収集した生データを、価格を解釈した行に変換する。
 *
 * 画面から取った商品は価格が文字列（「本体298円（税込321円）」）なので解釈が要る。
 * API から取った商品はすでに数値なので、そのまま使う。
 */
export function toRows(rawItems, { collectedAt = today() } = {}) {
  const rows = [];
  const seen = new Set();
  for (const it of rawItems) {
    const name = normalizeText(it.name);
    const fromApi = typeof it.price === 'number';
    const parsed = fromApi
      ? { price: it.price, priceKind: it.priceKind || 'api', candidates: it.candidates || [], priceRaw: '' }
      : pickPrice(it.priceText || it.rawText || '');
    if (!name && parsed.price === null) continue;
    const key = `${name}|${it.url || ''}|${parsed.price ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      collectedAt,
      category: it.category || '',
      name,
      price: parsed.price,
      priceKind: parsed.priceKind,
      priceCandidates: (parsed.candidates || []).join('/'),
      unit: it.unit || extractUnit(it.rawText || name),
      soldOut: it.soldOut ? 1 : 0,
      url: it.url || '',
      source: it.source || (fromApi ? 'api' : 'dom'),
      sourceUrl: it.sourceUrl || '',
      priceRaw: (it.priceText || '').slice(0, 60),
    });
  }
  return rows;
}

/** 収集結果のサマリ（Markdown）。 */
export function buildSummary(rows, { store, collectedAt, categories }) {
  const priced = rows.filter((r) => typeof r.price === 'number');
  const byCategory = new Map();
  for (const r of rows) {
    const c = byCategory.get(r.category) || { category: r.category, count: 0, priced: 0, sum: 0, soldOut: 0 };
    c.count += 1;
    if (typeof r.price === 'number') { c.priced += 1; c.sum += r.price; }
    if (r.soldOut) c.soldOut += 1;
    byCategory.set(r.category, c);
  }
  const catRows = [...byCategory.values()]
    .map((c) => ({ ...c, avg: c.priced ? Math.round(c.sum / c.priced) : null }))
    .sort((a, b) => b.count - a.count);

  const uncertain = rows.filter((r) => r.priceKind === 'max_of_multiple' || r.price === null);

  const lines = [
    `# ネットスーパー価格 — ${store || '（店舗名未設定）'}`,
    '',
    `収集日: ${collectedAt}　対象カテゴリ: ${categories} 件　商品: ${fmtNum(rows.length)} 件`,
    '',
    '## カテゴリ別',
    '',
    mdTable(catRows, [
      { key: 'category', label: 'カテゴリ' },
      { key: 'count', label: '件数', align: 'right', format: (v) => fmtNum(v) },
      { key: 'avg', label: '平均価格', align: 'right', format: (v) => (v === null ? '—' : `${fmtNum(v)}円`) },
      { key: 'soldOut', label: '売切', align: 'right', format: (v) => fmtNum(v) },
    ]),
    '',
    '## 取得元',
    '',
    `画面から ${fmtNum(rows.filter((r) => r.source === 'dom').length)} 件 / ` +
      `アプリが受け取ったデータから ${fmtNum(rows.filter((r) => r.source === 'api').length)} 件`,
    '',
    '## 確認したい行',
    '',
    priced.length === rows.length
      ? '_価格はすべて1つに確定しています_'
      : `価格を確定できなかった / 複数候補があった商品: ${uncertain.length} 件（items.csv の priceKind と priceRaw を参照）`,
    '',
    '## 使い方',
    '',
    '店頭価格メモとの差分は次で出せます。',
    '',
    '```',
    'npm run netsuper:diff',
    '```',
    '',
    '_価格は収集時点の表示価格。税込/税抜の扱いは店舗の表示に依存するため、priceKind が single 以外の行は元の表示（priceRaw）を確認してください。_',
  ];
  return lines.join('\n');
}

/** CLI 本体。selftest から import されたときは実行しない。 */
export const run = async () => {
  const values = parseCliArgs({
    category: { type: 'string' },
    headed: { type: 'boolean' },
    chrome: { type: 'boolean' },
  });
  if (values.help) { log(HELP); return; }

  const cfg = loadConfig();
  if (!hasSession()) {
    warn('※ ログインセッションがありません。会員価格やログイン限定の売場は取れない可能性があります。');
    warn('  `npm run netsuper:login` を先に実行してください。\n');
  }

  let categories = cfg.categories;
  if (values.category) {
    categories = categories.filter((c) => c.name.includes(values.category));
    if (!categories.length) throw new Error(`--category "${values.category}" に一致するカテゴリがありません。`);
  }

  section(`収集開始（${categories.length} カテゴリ）`);
  const collectedAt = today();
  const context = await openBrowser({
    headed: Boolean(values.headed || cfg.headed),
    channel: values.chrome ? 'chrome' : cfg.browserChannel,
  });
  const raw = [];
  const failures = [];
  try {
    const page = await firstPage(context);
    // 画面に商品が出ないアプリ向けに、サーバから届く JSON も記録しておく
    const capture = attachApiCapture(page, { pattern: cfg.apiPattern });
    for (const [i, cat] of categories.entries()) {
      log(`  [${i + 1}/${categories.length}] ${cat.name}`);
      try {
        const { items, meta } = await collectCategory(page, cat, cfg, {
          capture,
          onPage: ({ pageNo, found, added, mode }) =>
            log(mode === 'api' ? `      受信データから ${added} 件` : `      p${pageNo}: ${found} 件検出 / ${added} 件追加`),
        });
        if (!items.length) failures.push({ category: cat.name, reason: '0件（一覧URLか描画待ちを確認）' });
        if (meta?.mode === 'auto' && i === 0) log(`      自動判定: ${meta.selectors?.item || meta.signature || '—'}`);
        raw.push(...items);
      } catch (err) {
        failures.push({ category: cat.name, reason: err.message });
        warn(`      失敗: ${err.message}`);
      }
      if (i < categories.length - 1) await sleep(cfg.waitMs ?? 1500);
    }
  } finally {
    await context.close();
  }

  const rows = toRows(raw, { collectedAt });
  const dir = ensureDir(values.out ? path.resolve(values.out) : path.join(outputRoot(), collectedAt));
  fs.writeFileSync(path.join(dir, 'items.csv'), toCSV(rows, CSV_COLUMNS), 'utf8');
  fs.writeFileSync(
    path.join(dir, 'items.json'),
    `${JSON.stringify({ store: cfg.store, collectedAt, categories: categories.map((c) => c.name), items: rows }, null, 2)}\n`,
    'utf8'
  );
  fs.writeFileSync(
    path.join(dir, 'summary.md'),
    `${buildSummary(rows, { store: cfg.store, collectedAt, categories: categories.length })}\n`,
    'utf8'
  );

  section('完了');
  log(`  商品 ${fmtNum(rows.length)} 件を保存しました: ${relativeToCwd(dir)}/`);
  log('    items.csv   … 表計算で開く用');
  log('    items.json  … 差分比較用');
  log('    summary.md  … カテゴリ別の概要');
  if (failures.length) {
    log('');
    for (const f of failures) warn(`  取得できず: ${f.category} — ${f.reason}`);
    if (failures.length === categories.length) {
      log('');
      log('  すべてのカテゴリで0件でした。個々のセレクタではなく、');
      log('  ログイン状態か表示中の画面そのものが原因の可能性が高いです。');
      log('  次で実際の画面を確認してください（ブラウザが表示されます）。');
      log(`    npm run netsuper:probe -- --headed --url "${categories[0].url}"`);
    }
  }
  log('\n  次: `npm run netsuper:diff`（店頭価格メモ・前回との比較）');
};

if (isEntrypoint(import.meta.url)) main(run);
