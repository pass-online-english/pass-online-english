#!/usr/bin/env node
/**
 * 集めた価格を表にして見る。
 *
 *   npm run netsuper:table                      画面に表示
 *   npm run netsuper:table -- --category 野菜   売場をしぼる
 *   npm run netsuper:table -- --sort name       並び順を変える（既定は価格の安い順）
 *   npm run netsuper:table -- --limit 50        表示件数
 *   npm run netsuper:table -- --date 2026-09-06 過去の収集結果を見る
 *
 * 同時に items.md（Markdown の表）を書き出すので、そのまま貼り付けにも使える。
 * 表計算で開きたいときは items.csv をそのまま開けばよい。
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCliArgs, parseLimit } from '../analytics/lib/args.mjs';
import { main, log, section, isEntrypoint } from '../analytics/lib/cli.mjs';
import { mdTable, fmtNum, truncate } from '../analytics/lib/output.mjs';
import { outputRoot, relativeToCwd } from './lib/paths.mjs';
import { listSnapshots } from './diff.mjs';

const HELP = `
集めた価格を表にして見ます。

  npm run netsuper:table [-- --category <売場>] [--sort price|name] [--limit 100] [--date YYYY-MM-DD]
`;

const yen = (v) => (typeof v === 'number' ? `${fmtNum(v)}円` : '—');

/** 日本語は1文字で2文字分の幅を取るため、桁を揃えるには実際の見た目の幅で数える。 */
function displayWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
  return w;
}

function padDisplay(s, width) {
  return `${s}${' '.repeat(Math.max(0, width - displayWidth(s)))}`;
}

/** 売場ごとにまとめた Markdown の表。 */
export function buildItemsMarkdown(rows, { store, collectedAt }) {
  const categories = [...new Set(rows.map((r) => r.category || '（売場不明）'))].sort();
  const lines = [
    `# 商品と価格 — ${store || '（店舗名未設定）'}`,
    '',
    `収集日: ${collectedAt}　商品 ${fmtNum(rows.length)} 件　売場 ${categories.length} か所`,
    '',
  ];
  for (const category of categories) {
    const list = rows
      .filter((r) => (r.category || '（売場不明）') === category)
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    lines.push(`## ${category}（${list.length} 件）`, '');
    lines.push(
      mdTable(list, [
        { key: 'name', label: '商品' },
        { key: 'price', label: '税込', align: 'right', format: yen },
        { key: 'unit', label: '容量' },
        { key: 'soldOut', label: '在庫', format: (v) => (v ? '売切' : '') },
      ])
    );
    lines.push('');
  }
  lines.push('---', '', '_表示価格をそのまま記録したものです。送料・手数料・ポイントは含みません。_');
  return lines.join('\n');
}

export const run = async () => {
  const values = parseCliArgs({
    category: { type: 'string' },
    sort: { type: 'string' },
    date: { type: 'string' },
  });
  if (values.help) { log(HELP); return; }
  const limit = parseLimit(values.limit, 40);

  const snapshots = listSnapshots();
  if (!snapshots.length) {
    throw new Error(
      `収集結果がありません（${relativeToCwd(outputRoot())}）。\n  先に \`npm run netsuper:capture\` を実行してください。`
    );
  }
  const snapshot = values.date ? snapshots.find((s) => s.date === values.date) : snapshots[0];
  if (!snapshot) throw new Error(`--date ${values.date} の収集結果が見つかりません。`);

  const data = JSON.parse(fs.readFileSync(snapshot.file, 'utf8'));
  let rows = data.items ?? [];
  if (!rows.length) throw new Error(`${snapshot.date} の収集結果に商品がありません。`);

  const md = buildItemsMarkdown(rows, { store: data.store, collectedAt: snapshot.date });
  const mdPath = path.join(snapshot.dir, 'items.md');
  fs.writeFileSync(mdPath, `${md}\n`, 'utf8');

  if (values.category) {
    // 売場名がそのまま一致するものを優先する。無ければ部分一致に落とす
    // （「野菜」で「カット野菜…」まで拾ってしまうのを避けるため）
    const exact = rows.filter((r) => (r.category || '') === values.category);
    rows = exact.length ? exact : rows.filter((r) => (r.category || '').includes(values.category));
    if (!rows.length) throw new Error(`--category "${values.category}" に一致する売場がありません。`);
  }
  const sort = values.sort ?? 'price';
  if (sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  else if (sort === 'price') rows = [...rows].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
  else throw new Error('--sort は price か name で指定してください。');

  section(`${data.store || ''} ${snapshot.date}　商品 ${fmtNum(rows.length)} 件`);
  const shown = rows.slice(0, limit);
  const width = Math.max(...shown.map((r) => displayWidth(truncate(r.name, 34))), 8);
  for (const r of shown) {
    const name = padDisplay(truncate(r.name, 34), width);
    const price = String(typeof r.price === 'number' ? `${fmtNum(r.price)}円` : '—').padStart(8);
    const mark = r.soldOut ? ' 売切' : '';
    log(`  ${name} ${price}  ${truncate(r.category, 20)}${mark}`);
  }
  if (rows.length > limit) log(`  … ほか ${fmtNum(rows.length - limit)} 件（--limit で増やせます）`);

  log('');
  log(`  表（Markdown）: ${relativeToCwd(mdPath)}`);
  log(`  表計算で開く  : open ${relativeToCwd(path.join(snapshot.dir, 'items.csv'))}`);
};

if (isEntrypoint(import.meta.url)) main(run);
