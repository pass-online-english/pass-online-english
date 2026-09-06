#!/usr/bin/env node
/**
 * 収集した価格を、店頭価格メモ／前回の収集結果と比べる。
 *
 *   npm run netsuper:diff
 *   npm run netsuper:diff -- --tolerance 15        「ほぼ同じ」とみなす幅（％）
 *   npm run netsuper:diff -- --yen 30              同上（円）。％と円のゆるいほうを採用
 *   npm run netsuper:diff -- --against 2026-08-30  比較する前回のスナップショット
 *
 * 店頭価格メモ: data/netsuper/store-prices.csv（商品名, 店頭価格, メモ）
 * 出力: 最新スナップショットのディレクトリに diff.md と buy-online.csv
 */
import fs from 'node:fs';
import path from 'node:path';
import { parseCliArgs, parseLimit } from '../analytics/lib/args.mjs';
import { main, log, section, warn, isEntrypoint } from '../analytics/lib/cli.mjs';
import { toCSV, mdTable, fmtNum, fmtPct } from '../analytics/lib/output.mjs';
import { outputRoot, REPO_ROOT, relativeToCwd } from './lib/paths.mjs';
import { parseStorePrices } from './lib/csv.mjs';
import { compareToStore, compareSnapshots, buyOnline, VERDICT } from './lib/compare.mjs';

const HELP = `
収集済みの価格を、店頭価格メモ・前回の収集結果と比べます。

  npm run netsuper:diff [-- --tolerance 10] [--yen 20] [--against <YYYY-MM-DD>] [--top 40]
`;

const DEFAULT_STORE_PRICES = path.join(REPO_ROOT, 'data', 'netsuper', 'store-prices.csv');

/** reports/netsuper/<YYYY-MM-DD>/items.json を新しい順に返す。 */
export function listSnapshots(root = outputRoot()) {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name))
    .map((d) => ({ date: d.name, dir: path.join(root, d.name), file: path.join(root, d.name, 'items.json') }))
    .filter((s) => fs.existsSync(s.file))
    .sort((a, b) => (a.date < b.date ? 1 : -1));
}

function readSnapshot(s) {
  const data = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  return { ...s, store: data.store, items: data.items || [] };
}

const yen = (v) => (typeof v === 'number' ? `${fmtNum(v)}円` : '—');
const signedYen = (v) => (typeof v === 'number' ? `${v > 0 ? '+' : ''}${fmtNum(v)}円` : '—');

export function buildDiffMarkdown({ current, previous, storeResults, snapshotDiff, tolerancePct, toleranceYen, top }) {
  const lines = [
    `# 価格の差分 — ${current.store || '（店舗名未設定）'}`,
    '',
    `収集日: ${current.date}　商品 ${fmtNum(current.items.length)} 件` +
      (previous ? `　前回: ${previous.date}（${fmtNum(previous.items.length)} 件）` : '　前回: なし'),
    '',
  ];

  if (storeResults) {
    const list = buyOnline(storeResults);
    const pricier = storeResults.filter((r) => r.verdict === VERDICT.PRICIER);
    const soldOut = storeResults.filter((r) => r.verdict === VERDICT.SOLD_OUT);
    const noMatch = storeResults.filter((r) => r.verdict === VERDICT.NO_MATCH);

    lines.push(
      '## ネットスーパーで買ってよさそうなもの',
      '',
      `店頭価格との差が ${Math.round(tolerancePct * 100)}% または ${toleranceYen}円 以内、もしくはネットのほうが安いもの。`,
      '',
      mdTable(list.slice(0, top), [
        { key: 'name', label: '商品（メモ）' },
        { key: 'netName', label: 'ネット表示名' },
        { key: 'storePrice', label: '店頭', align: 'right', format: yen },
        { key: 'netPrice', label: 'ネット', align: 'right', format: yen },
        { key: 'diff', label: '差', align: 'right', format: signedYen },
        { key: 'diffPct', label: '差率', align: 'right', format: (v) => (v === null ? '—' : fmtPct(v, 1)) },
        { key: 'matchScore', label: '一致度', align: 'right' },
      ]),
      '',
      '## 店頭で買ったほうがよさそうなもの',
      '',
      mdTable(pricier.slice(0, top), [
        { key: 'name', label: '商品（メモ）' },
        { key: 'netName', label: 'ネット表示名' },
        { key: 'storePrice', label: '店頭', align: 'right', format: yen },
        { key: 'netPrice', label: 'ネット', align: 'right', format: yen },
        { key: 'diff', label: '差', align: 'right', format: signedYen },
        { key: 'diffPct', label: '差率', align: 'right', format: (v) => (v === null ? '—' : fmtPct(v, 1)) },
      ]),
      ''
    );
    if (soldOut.length) {
      lines.push(`売り切れ: ${soldOut.map((r) => r.name).join('、')}`, '');
    }
    if (noMatch.length) {
      lines.push(
        '### メモにあるがネット側で見つからなかったもの',
        '',
        `${noMatch.map((r) => r.name).join('、')}`,
        '',
        '_収集対象のカテゴリに含まれていないか、商品名の書き方が違う可能性があります。_',
        ''
      );
    }
    lines.push(
      '_一致度は商品名の近さ（1.00 が完全一致）。0.6 未満は突き合わせていません。_',
      '_同じ商品名でも内容量が違えば価格差は当然生じます。unit 列も確認してください。_',
      ''
    );
  } else {
    lines.push(
      '## 店頭価格メモがありません',
      '',
      'data/netsuper/store-prices.csv に「商品名, 店頭価格」を書くと、',
      '店頭とネットの差額をこのレポートに出せます。',
      '',
      'data/netsuper/store-prices.example.csv をコピーして使ってください。',
      ''
    );
  }

  if (snapshotDiff) {
    const { changed, added, removed } = snapshotDiff;
    const down = changed.filter((c) => c.diff < 0);
    const up = changed.filter((c) => c.diff > 0);
    lines.push(
      `## 前回（${previous.date}）からの変化`,
      '',
      `値下がり ${down.length} 件 / 値上がり ${up.length} 件 / 新登場 ${added.length} 件 / 消えた ${removed.length} 件`,
      '',
      '### 値下がり',
      '',
      mdTable(down.slice(0, top), [
        { key: 'name', label: '商品' },
        { key: 'prevPrice', label: '前回', align: 'right', format: yen },
        { key: 'price', label: '今回', align: 'right', format: yen },
        { key: 'diff', label: '差', align: 'right', format: signedYen },
      ]),
      '',
      '### 値上がり',
      '',
      mdTable(up.slice(0, top), [
        { key: 'name', label: '商品' },
        { key: 'prevPrice', label: '前回', align: 'right', format: yen },
        { key: 'price', label: '今回', align: 'right', format: yen },
        { key: 'diff', label: '差', align: 'right', format: signedYen },
      ]),
      ''
    );
  }

  lines.push(
    '---',
    '',
    '_表示価格をそのまま記録したものです。税込/税抜の扱いや送料・手数料は含みません。_'
  );
  return lines.join('\n');
}

/** CLI 本体。selftest から import されたときは実行しない。 */
export const run = async () => {
  const values = parseCliArgs({
    tolerance: { type: 'string' },
    yen: { type: 'string' },
    against: { type: 'string' },
    'store-prices': { type: 'string' },
  });
  if (values.help) { log(HELP); return; }

  const tolerancePct = values.tolerance === undefined ? 0.1 : Number(values.tolerance) / 100;
  const toleranceYen = values.yen === undefined ? 20 : Number(values.yen);
  if (!Number.isFinite(tolerancePct) || tolerancePct < 0) throw new Error('--tolerance は0以上の数値（％）で指定してください。');
  if (!Number.isFinite(toleranceYen) || toleranceYen < 0) throw new Error('--yen は0以上の数値で指定してください。');
  const top = parseLimit(values.top, 40);

  const snapshots = listSnapshots();
  if (!snapshots.length) {
    throw new Error(
      `収集結果がありません（${relativeToCwd(outputRoot())}）。\n  先に \`npm run netsuper:scrape\` を実行してください。`
    );
  }
  const current = readSnapshot(snapshots[0]);
  const prevSnap = values.against
    ? snapshots.find((s) => s.date === values.against)
    : snapshots[1];
  if (values.against && !prevSnap) throw new Error(`--against ${values.against} のスナップショットが見つかりません。`);
  const previous = prevSnap ? readSnapshot(prevSnap) : null;

  const storeFile = values['store-prices'] ? path.resolve(values['store-prices']) : DEFAULT_STORE_PRICES;
  let storeResults = null;
  if (fs.existsSync(storeFile)) {
    const { items, errors } = parseStorePrices(fs.readFileSync(storeFile, 'utf8'));
    for (const e of errors) warn(`  店頭価格メモ: ${e}`);
    if (items.length) storeResults = compareToStore(items, current.items, { tolerancePct, toleranceYen });
  }

  const snapshotDiff = previous ? compareSnapshots(previous.items, current.items) : null;
  const md = buildDiffMarkdown({ current, previous, storeResults, snapshotDiff, tolerancePct, toleranceYen, top });
  fs.writeFileSync(path.join(current.dir, 'diff.md'), `${md}\n`, 'utf8');

  if (storeResults) {
    const rows = buyOnline(storeResults).map((r) => ({
      商品名: r.name,
      ネット表示名: r.netName,
      店頭価格: r.storePrice,
      ネット価格: r.netPrice,
      差額: r.diff,
      内容量: r.netUnit,
      カテゴリ: r.category,
      一致度: r.matchScore,
      URL: r.netUrl,
      メモ: r.note,
    }));
    fs.writeFileSync(path.join(current.dir, 'buy-online.csv'), toCSV(rows), 'utf8');
  }

  section('差分');
  log(`  今回: ${current.date}（${fmtNum(current.items.length)} 件）${previous ? ` / 前回: ${previous.date}` : ''}`);
  if (storeResults) {
    const list = buyOnline(storeResults);
    log(`  店頭価格メモ ${storeResults.length} 件のうち、ネットで買ってよさそう: ${list.length} 件`);
    for (const r of list.slice(0, 10)) {
      log(`    ・${r.name}  店頭 ${yen(r.storePrice)} → ネット ${yen(r.netPrice)}（${signedYen(r.diff)}）`);
    }
  } else {
    log(`  店頭価格メモがありません: ${relativeToCwd(storeFile)}`);
  }
  if (snapshotDiff) {
    log(`  前回比: 値下がり ${snapshotDiff.changed.filter((c) => c.diff < 0).length} 件 / ` +
        `値上がり ${snapshotDiff.changed.filter((c) => c.diff > 0).length} 件 / ` +
        `新登場 ${snapshotDiff.added.length} 件`);
  }
  log(`\n  レポート: ${relativeToCwd(path.join(current.dir, 'diff.md'))}`);
};

if (isEntrypoint(import.meta.url)) main(run);
