#!/usr/bin/env node
/**
 * キーワードギャップ分析。
 *
 * Google キーワードプランナーの検索ボリュームと、Search Console の実測を
 * 突き合わせて「需要はあるのに取れていないキーワード」を洗い出す。
 *
 *   npm run analytics:keywords -- --days 28
 *   npm run analytics:keywords -- --dir path/to/csv
 *
 * CSV の置き場所（既定）: data/keyword-planner/
 * キーワードプランナーから「.csv」でダウンロードしたファイルを
 * そのまま置いてください（UTF-16 のタブ区切りのままで読めます）。
 */
import path from 'node:path';
import { main, log, section, isEntrypoint } from './lib/cli.mjs';
import { parseCliArgs, parseFormats, parseLimit } from './lib/args.mjs';
import { resolveRange, formatRange, lengthInDays } from './lib/dates.mjs';
import { gscLagDays, REPO_ROOT } from './lib/env.mjs';
import { querySearchAnalytics } from './lib/gsc-client.mjs';
import { loadKeywordPlannerDir } from './lib/keyword-planner.mjs';
import { buildKeywordGap, volumeBuckets, STATUS, TARGET_POSITION } from './lib/keyword-gap.mjs';
import {
  createRunDir, writeJSON, writeCSV, writeText, mdTable, fmtNum, fmtPct, truncate, relativeToCwd,
} from './lib/output.mjs';

const args = parseCliArgs({ dir: { type: 'string' }, 'min-volume': { type: 'string' } });
const formats = parseFormats(args.format);

const DEFAULT_DIR = path.join(REPO_ROOT, 'data', 'keyword-planner');

const pos = (v) => (v === null || v === undefined ? '圏外' : v.toFixed(1));
const vol = (v) => (v === null || v === undefined ? '—' : fmtNum(v));
const pct = (v) => (v === null || v === undefined ? '—' : fmtPct(v, 2));

export function keywordGapMarkdown(gap, buckets, range, { files = [] } = {}) {
  const { summary } = gap;

  let md = `# キーワードギャップ分析\n\n`;
  md += `- Search Console 対象期間: ${formatRange(range)}\n`;
  md += `- 読み込んだキーワードプランナーのファイル: ${files.join(', ') || '（なし）'}\n`;
  md += `- 生成: ${new Date().toISOString()}\n\n`;

  md += `> **検索ボリュームは丸められた代表値です。** 広告費を使っていないアカウントでは\n`;
  md += `> 50 / 500 / 5,000 / 50,000 のように段階的な値になります（画面上の「1,000〜1万」に対応）。\n`;
  md += `> 絶対値ではなく規模の桁として扱ってください。\n`;
  md += `> また「推定クリック」は順位別CTRの目安から計算した粗い値で、保証された予測ではありません。\n\n`;

  md += `## サマリー\n\n`;
  md += mdTable(
    [
      { label: '調査したキーワード数', value: fmtNum(summary.keywordCount) },
      { label: 'Search Console で表示があるもの', value: `${fmtNum(summary.matchedCount)}件` },
      { label: '**まったく表示されていないもの**', value: `**${fmtNum(summary.notRankingCount)}件**` },
      { label: '調査対象の合計検索ボリューム（月）', value: fmtNum(summary.totalVolume) },
      { label: 'うち表示が取れている分', value: `${fmtNum(summary.capturedVolume)}（${pct(summary.captureRate)}）` },
      { label: `**${TARGET_POSITION}位に入れた場合の推定クリック増（月）**`, value: `**${fmtNum(summary.totalOpportunity)}**` },
    ],
    [
      { key: 'label', label: '項目' },
      { key: 'value', label: '値', align: 'right' },
    ]
  );

  md += `\n## ボリューム帯別の獲得状況\n\n`;
  md += mdTable(buckets, [
    { key: 'label', label: '月間検索ボリューム' },
    { key: 'keywords', label: 'キーワード数', align: 'right', format: fmtNum },
    { key: 'captured', label: '表示あり', align: 'right', format: fmtNum },
    { key: 'notRanking', label: '未獲得', align: 'right', format: fmtNum },
    { key: 'totalVolume', label: '合計ボリューム', align: 'right', format: fmtNum },
  ]);

  const cols = [
    { key: 'keyword', label: 'キーワード', format: (v) => truncate(v, 30) },
    { key: 'volume', label: '月間検索数', align: 'right', format: vol },
    { key: 'competition', label: '競合', align: 'center', format: (v) => v ?? '—' },
    { key: 'position', label: '現在の順位', align: 'right', format: pos },
    { key: 'impressions', label: '表示', align: 'right', format: fmtNum },
    { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
    { key: 'opportunityClicksPerMonth', label: '推定クリック増/月', align: 'right', format: fmtNum },
  ];

  md += `\n## 最優先：需要が大きいのに未獲得\n\n`;
  md += `検索されているのに、一度も検索結果に表示されていないキーワードです。\n`;
  md += `**新しいページを作る／既存ページを寄せる**判断材料になります。\n\n`;
  md += mdTable(
    gap.rows.filter((r) => r.status === STATUS.NOT_RANKING && (r.volume ?? 0) >= 500).slice(0, 30),
    cols
  );

  md += `\n## 次点：表示はあるが順位が低い\n\n`;
  md += `すでに認識はされているので、コンテンツの強化で順位を上げられる可能性があります。\n\n`;
  md += mdTable(
    gap.rows.filter((r) => r.status === STATUS.CLOSE || r.status === STATUS.BARELY).slice(0, 20),
    cols
  );

  md += `\n## 刈り取り余地：4〜10位にいる\n\n`;
  md += `1ページ目に入っているので、タイトル改善やCTR改善が直接効きます。\n\n`;
  md += mdTable(gap.rows.filter((r) => r.status === STATUS.HARVESTABLE).slice(0, 20), cols);

  md += `\n## 獲得済み：3位以内\n\n`;
  md += mdTable(gap.rows.filter((r) => r.status === STATUS.WON).slice(0, 20), cols);

  md += `\n## 全キーワード（推定クリック増の大きい順）\n\n`;
  md += mdTable(gap.rows.slice(0, 80), [...cols, { key: 'status', label: '状態', align: 'center' }]);

  if (gap.unlisted.length) {
    md += `\n## 調査リストに無かったが表示されているクエリ\n\n`;
    md += `Search Console には出ているのに、キーワードプランナーで調べていないものです。\n`;
    md += `ボリュームが大きければ、次回の調査リストに加えてください。\n\n`;
    md += mdTable(gap.unlisted.slice(0, 30), [
      { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 40) },
      { key: 'impressions', label: '表示', align: 'right', format: fmtNum },
      { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
      { key: 'position', label: '順位', align: 'right', format: pos },
    ]);
  }

  md += `\n---\n\n## 使い方のメモ\n\n`;
  md += `キーワードを追加調査するには、Google 広告 →「ツール」→「キーワード プランナー」→\n`;
  md += `「検索のボリュームと予測のデータを確認する」でキーワードを貼り付け、\n`;
  md += `**「過去の指標」タブ**から \`.csv\` をダウンロードして \`data/keyword-planner/\` に置いてください。\n`;
  md += `ファイルを増やすだけで、次回の実行から自動的に読み込まれます。\n`;

  return md;
}

if (isEntrypoint(import.meta.url)) await main(async () => {
  const dir = args.dir ? path.resolve(process.cwd(), args.dir) : DEFAULT_DIR;
  const range = resolveRange({ days: args.days, start: args.start, end: args.end, lagDays: gscLagDays() });

  section('キーワードギャップ分析');
  log(`  キーワードCSV: ${relativeToCwd(dir)}`);
  log(`  対象期間     : ${formatRange(range)}\n`);

  const { keywords, files, errors, missingDir } = loadKeywordPlannerDir(dir);

  if (missingDir || keywords.length === 0) {
    throw new Error(
      `キーワードプランナーのデータが見つかりません: ${dir}\n\n` +
        '  Google 広告 →「ツール」→「キーワード プランナー」→\n' +
        '  「検索のボリュームと予測のデータを確認する」でキーワードを貼り付け、\n' +
        '  「過去の指標」タブから .csv をダウンロードして上記のフォルダに置いてください。\n' +
        '  （拡張子は .csv ですが中身は UTF-16 のタブ区切りです。変換不要でそのまま置けます）'
    );
  }

  if (errors?.length) for (const e of errors) log(`  ⚠️  ${e}`);
  log(`  読み込み: ${files.length}ファイル / ${keywords.length}キーワード`);

  const gscRows = (await querySearchAnalytics({ ...range, dimensions: ['query'], maxRows: 5000 })).rows;
  log(`  Search Console: ${gscRows.length}クエリ\n`);

  const minVolume = parseLimit(args['min-volume'], null);
  const filtered = minVolume === null ? keywords : keywords.filter((k) => (k.volume ?? 0) >= minVolume);

  const gap = buildKeywordGap(filtered, gscRows, { days: lengthInDays(range) });
  const buckets = volumeBuckets(gap.rows);

  log(`  調査キーワード      : ${gap.summary.keywordCount}件`);
  log(`  うち表示あり        : ${gap.summary.matchedCount}件`);
  log(`  まったく未獲得      : ${gap.summary.notRankingCount}件`);
  log(`  合計検索ボリューム  : ${fmtNum(gap.summary.totalVolume)}/月（うち取得済み ${fmtPct(gap.summary.captureRate ?? 0, 1)}）`);
  log(`  推定クリック増      : ${fmtNum(gap.summary.totalOpportunity)}/月（${TARGET_POSITION}位到達を仮定）`);

  const outDir = createRunDir('keywords', { out: args.out });
  if (formats.includes('json')) {
    writeJSON(outDir, 'keyword-gap', { generatedAt: new Date().toISOString(), range, files, ...gap, buckets });
  }
  if (formats.includes('csv')) {
    writeCSV(outDir, 'keyword-gap', gap.rows);
    writeCSV(outDir, 'not-ranking', gap.rows.filter((r) => r.status === STATUS.NOT_RANKING));
    writeCSV(outDir, 'unlisted-queries', gap.unlisted);
  }
  if (formats.includes('md')) {
    writeText(outDir, 'keyword-gap.md', keywordGapMarkdown(gap, buckets, range, { files }));
  }

  section('出力');
  log(`  ${relativeToCwd(outDir)}/\n`);
});
