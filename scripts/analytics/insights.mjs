#!/usr/bin/env node
/**
 * SEO 改善候補の抽出（Search Console 単体）。
 *
 *   npm run analytics:insights -- --days 28
 *   npm run analytics:insights -- --days 28 --min-impressions 50
 *   npm run analytics:insights -- --days 90 --compare yoy
 */
import { main, log, section } from './lib/cli.mjs';
import { parseCliArgs, parseFormats, parseLimit } from './lib/args.mjs';
import { resolveRange, comparisonRange, formatRange } from './lib/dates.mjs';
import { gscLagDays } from './lib/env.mjs';
import { querySearchAnalytics } from './lib/gsc-client.mjs';
import { extractOpportunities } from './lib/opportunities.mjs';
import {
  createRunDir, writeJSON, writeCSV, writeText, mdTable, fmtNum, fmtPct,
  fmtDelta, truncate, relativeToCwd,
} from './lib/output.mjs';

const args = parseCliArgs({
  'min-impressions': { type: 'string' },
  'position-low': { type: 'string' },
  'position-high': { type: 'string' },
});
const formats = parseFormats(args.format);

export async function buildOpportunities({ range, comparison, opts = {} }) {
  const [queryCurrent, pageCurrent, queryPage] = [
    await querySearchAnalytics({ ...range, dimensions: ['query'], maxRows: 5000 }),
    await querySearchAnalytics({ ...range, dimensions: ['page'], maxRows: 5000 }),
    await querySearchAnalytics({ ...range, dimensions: ['query', 'page'], maxRows: 10000 }),
  ];

  let queryPrevious = null;
  let pagePrevious = null;
  if (comparison) {
    queryPrevious = await querySearchAnalytics({ ...comparison, dimensions: ['query'], maxRows: 5000 });
    pagePrevious = await querySearchAnalytics({ ...comparison, dimensions: ['page'], maxRows: 5000 });
  }

  return extractOpportunities(
    {
      queryCurrent: queryCurrent.rows,
      queryPrevious: queryPrevious?.rows ?? null,
      pageCurrent: pageCurrent.rows,
      pagePrevious: pagePrevious?.rows ?? null,
      queryPage: queryPage.rows,
    },
    opts
  );
}

const CTR_COLS = [
  { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
  { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
  { key: 'ctr', label: 'CTR', align: 'right', format: (v) => fmtPct(v) },
  { key: 'position', label: '掲載順位', align: 'right', format: (v) => (v === null || v === undefined ? '—' : v.toFixed(1)) },
];

export function opportunitiesMarkdown(opp, range, comparison) {
  let md = `# SEO 改善候補\n\n`;
  md += `- 対象期間: ${formatRange(range)}\n`;
  if (comparison) md += `- 比較期間: ${formatRange(comparison)}（${comparison.label}）\n`;
  md += `- しきい値: 最小表示回数 ${opp.thresholds.minImpressions} / 順位帯 ${opp.thresholds.positionLow}〜${opp.thresholds.positionHigh}位\n\n`;
  md += `> ${opp.disclaimer}\n\n`;

  md += `## A. 順位4〜15位＋表示回数が多い（伸びしろが大きい候補）\n\n`;
  md += `あと少し順位が上がればクリックが増える可能性のあるクエリ。推定クリック増は「3位分順位が上がった場合」の粗い目安であり、保証値ではありません。\n\n`;
  md += mdTable(opp.A_rankingUpside, [
    { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 40) },
    ...CTR_COLS,
    { key: 'estimatedClickGain', label: '推定クリック増', align: 'right', format: fmtNum },
  ]);

  md += `\n## B-1. 表示回数の割に CTR が低い検索クエリ（title / description 改善候補）\n\n`;
  md += `順位相応の CTR と比べて実測が低いものを抽出しています。強調スニペットや広告枠、画像枠などで CTR が下がることもあるため、実際の検索結果を確認してください。\n\n`;
  md += mdTable(opp.B_lowCtrQueries, [
    { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 40) },
    ...CTR_COLS,
    { key: 'expectedCtr', label: '順位相応CTR', align: 'right', format: (v) => fmtPct(v) },
    { key: 'estimatedClickGain', label: '推定クリック増', align: 'right', format: fmtNum },
  ]);

  md += `\n## B-2. 表示回数の割に CTR が低いページ\n\n`;
  md += mdTable(opp.B_lowCtrPages, [
    { key: 'page', label: 'ページ', format: (v) => truncate(v, 56) },
    ...CTR_COLS,
    { key: 'expectedCtr', label: '順位相応CTR', align: 'right', format: (v) => fmtPct(v) },
    { key: 'estimatedClickGain', label: '推定クリック増', align: 'right', format: fmtNum },
  ]);

  md += `\n## C. 表示回数・クリックが急増している検索クエリ（成長中候補）\n\n`;
  if (!comparison) {
    md += `_比較期間が指定されていないため算出していません（\`--compare previous\` などを指定してください）。_\n`;
  } else {
    md += mdTable(opp.C_growingQueries, [
      { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 36) },
      { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
      { key: 'impressions_delta', label: '表示増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.impressions_ratio === null ? null : r.impressions_ratio - 1 }) },
      { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
      { key: 'clicks_delta', label: 'クリック増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.clicks_ratio === null ? null : r.clicks_ratio - 1 }) },
      { key: 'position', label: '掲載順位', align: 'right', format: (v) => (v ? v.toFixed(1) : '—') },
      { key: 'isNew', label: '新規', align: 'center', format: (v) => (v ? '✓' : '') },
    ]);
  }

  md += `\n## D-1. 悪化している検索クエリ（SEO 劣化候補）\n\n`;
  if (!comparison) {
    md += `_比較期間が指定されていないため算出していません。_\n`;
  } else {
    md += mdTable(opp.D_decliningQueries, [
      { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 36) },
      { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
      { key: 'clicks_delta', label: 'クリック増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.clicks_ratio === null ? null : r.clicks_ratio - 1 }) },
      { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
      { key: 'impressions_delta', label: '表示増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.impressions_ratio === null ? null : r.impressions_ratio - 1 }) },
      { key: 'position_prev', label: '前順位', align: 'right', format: (v) => (v ? v.toFixed(1) : '—') },
      { key: 'position', label: '現順位', align: 'right', format: (v) => (v ? v.toFixed(1) : '圏外') },
      { key: 'disappeared', label: '消失', align: 'center', format: (v) => (v ? '✓' : '') },
    ]);
  }

  md += `\n## D-2. 悪化しているページ\n\n`;
  if (!comparison) {
    md += `_比較期間が指定されていないため算出していません。_\n`;
  } else {
    md += mdTable(opp.D_decliningPages, [
      { key: 'page', label: 'ページ', format: (v) => truncate(v, 50) },
      { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
      { key: 'clicks_delta', label: 'クリック増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.clicks_ratio === null ? null : r.clicks_ratio - 1 }) },
      { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
      { key: 'position_prev', label: '前順位', align: 'right', format: (v) => (v ? v.toFixed(1) : '—') },
      { key: 'position', label: '現順位', align: 'right', format: (v) => (v ? v.toFixed(1) : '圏外') },
    ]);
  }

  md += `\n## E. 同一クエリで複数ページが表示されている（カニバリゼーション候補）\n\n`;
  md += `複数ページが同じクエリで出ること自体は正常な場合も多いため、あくまで確認候補です。\n\n`;
  if (!opp.E_cannibalization.length) {
    md += '_該当データなし_\n';
  } else {
    for (const c of opp.E_cannibalization.slice(0, 20)) {
      md += `**「${c.query}」** — ${c.pageCount}ページ / 合計表示 ${fmtNum(c.totalImpressions)} / 合計クリック ${fmtNum(c.totalClicks)}\n\n`;
      md += mdTable(c.pages, [
        { key: 'page', label: 'ページ', format: (v) => truncate(v, 52) },
        { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
        { key: 'impressionShare', label: '表示シェア', align: 'right', format: (v) => fmtPct(v, 1) },
        { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
        { key: 'position', label: '掲載順位', align: 'right', format: (v) => v.toFixed(1) },
      ]);
      md += '\n';
    }
  }

  return md;
}

await main(async () => {
  const range = resolveRange({ days: args.days, start: args.start, end: args.end, lagDays: gscLagDays() });
  const comparison = comparisonRange(range, args.compare);

  const opts = {};
  const minImpr = parseLimit(args['min-impressions'], null);
  if (minImpr !== null) opts.minImpressions = minImpr;
  const posLow = args['position-low'] ? Number(args['position-low']) : null;
  if (posLow !== null) opts.positionLow = posLow;
  const posHigh = args['position-high'] ? Number(args['position-high']) : null;
  if (posHigh !== null) opts.positionHigh = posHigh;
  const limit = parseLimit(args.limit, null);
  if (limit !== null) opts.limit = limit;

  section('SEO 改善候補の抽出');
  log(`  対象期間: ${formatRange(range)}`);
  if (comparison) log(`  比較期間: ${formatRange(comparison)}（${comparison.label}）`);
  log('');

  const opp = await buildOpportunities({ range, comparison, opts });

  const counts = {
    A: opp.A_rankingUpside.length,
    'B(query)': opp.B_lowCtrQueries.length,
    'B(page)': opp.B_lowCtrPages.length,
    C: opp.C_growingQueries.length,
    'D(query)': opp.D_decliningQueries.length,
    'D(page)': opp.D_decliningPages.length,
    E: opp.E_cannibalization.length,
  };
  for (const [k, v] of Object.entries(counts)) log(`  候補 ${k.padEnd(9)} ${v}件`);

  const dir = createRunDir('insights', { out: args.out });
  if (formats.includes('json')) {
    writeJSON(dir, 'opportunities', { generatedAt: new Date().toISOString(), range, comparison, ...opp });
  }
  if (formats.includes('csv')) {
    writeCSV(dir, 'A-ranking-upside', opp.A_rankingUpside);
    writeCSV(dir, 'B-low-ctr-queries', opp.B_lowCtrQueries);
    writeCSV(dir, 'B-low-ctr-pages', opp.B_lowCtrPages);
    writeCSV(dir, 'C-growing-queries', opp.C_growingQueries);
    writeCSV(dir, 'D-declining-queries', opp.D_decliningQueries);
    writeCSV(dir, 'D-declining-pages', opp.D_decliningPages);
    writeCSV(
      dir,
      'E-cannibalization',
      opp.E_cannibalization.flatMap((c) =>
        c.pages.map((p) => ({ query: c.query, pageCount: c.pageCount, totalImpressions: c.totalImpressions, ...p }))
      )
    );
  }
  if (formats.includes('md')) writeText(dir, 'opportunities.md', opportunitiesMarkdown(opp, range, comparison));

  section('出力');
  log(`  ${relativeToCwd(dir)}/\n`);
});
