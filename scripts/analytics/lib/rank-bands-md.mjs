/**
 * 順位帯分析の Markdown 出力。insights.mjs と report.mjs で共有する。
 */
import { mdTable, fmtNum, fmtPct, fmtDelta, truncate } from './output.mjs';
import { distributionComparison, bandLabel } from './rank-bands.mjs';

const pct = (v) => (v === null || v === undefined ? '—' : fmtPct(v, 2));
const pos = (v) => (v === null || v === undefined ? '—' : v.toFixed(1));
const signed = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${fmtNum(v)}`);

export function rankBandsMarkdown(transitions, { dimLabel = '検索クエリ', comparison = true } = {}) {
  const { currentDistribution: cur, previousDistribution: prev, summary } = transitions;

  let md = `### 順位帯別の分布\n\n`;
  md += `検索順位ごとに、いくつのクエリで表示され、どれだけクリックされているかの内訳です。\n`;
  md += `クリック総数より、**この分布がどちらへ動いたか**のほうが検索評価の変化を素直に反映します。\n\n`;

  const rows = comparison ? distributionComparison(cur, prev) : cur.bands;
  md += mdTable(rows, [
    { key: 'label', label: '順位帯' },
    { key: 'queries', label: 'クエリ数', align: 'right', format: fmtNum },
    ...(comparison ? [{ key: 'queriesDelta', label: '増減', align: 'right', format: signed }] : []),
    { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
    { key: 'impressionShare', label: '表示シェア', align: 'right', format: (v) => (v === null ? '—' : fmtPct(v, 1)) },
    { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
    { key: 'ctr', label: 'CTR', align: 'right', format: pct },
    { key: 'avgPosition', label: '平均順位', align: 'right', format: pos },
  ]);

  md += `\n**読み方**\n\n`;
  for (const b of cur.bands) {
    if (b.queries === 0) continue;
    md += `- **${b.label}**（${b.queries}クエリ / 表示${fmtNum(b.impressions)}）— ${b.note}\n`;
  }
  if (cur.totals.unranked > 0) {
    md += `- 順位が取得できなかった行が ${cur.totals.unranked} 件あります（表示回数が極端に少ない場合に発生します）\n`;
  }
  md += '\n';

  if (!comparison) {
    md += `_比較期間が指定されていないため、順位帯の移動は算出していません（\`--compare previous\` などを指定してください）。_\n\n`;
    return md;
  }

  // ── 見出し指標 ──────────────────────────────
  md += `### SEO の進捗（前期間との比較）\n\n`;
  md += mdTable(
    [
      {
        label: '**1ページ目（10位以内）のクエリ数**',
        value: fmtNum(summary.topTenQueries),
        prev: fmtNum(summary.topTenQueries_prev),
        change: signed(summary.topTenQueriesDelta),
      },
      {
        label: '表示されたクエリの総数',
        value: fmtNum(summary.totalQueries),
        prev: fmtNum(summary.totalQueries_prev),
        change: signed(summary.totalQueries - summary.totalQueries_prev),
      },
    ],
    [
      { key: 'label', label: '指標' },
      { key: 'value', label: '当期間', align: 'right' },
      { key: 'prev', label: '前期間', align: 'right' },
      { key: 'change', label: '増減', align: 'right' },
    ]
  );

  md += `\n順位帯をまたいで動いた${dimLabel}の内訳です。\n\n`;
  md += mdTable(
    [
      { label: '上の帯へ移動（改善）', count: summary.improvedCount },
      { label: '下の帯へ移動（悪化）', count: summary.declinedCount },
      { label: '同じ帯にとどまった', count: summary.unchangedCount },
      { label: '新しく表示された', count: summary.enteredCount },
      { label: '表示されなくなった', count: summary.exitedCount },
    ],
    [
      { key: 'label', label: '動き' },
      { key: 'count', label: `${dimLabel}数`, align: 'right', format: fmtNum },
    ]
  );
  md += '\n';

  const movementCols = (dimKey) => [
    { key: dimKey, label: dimLabel, format: (v) => truncate(v, 34) },
    { key: 'band_prev', label: '前', align: 'center', format: (v) => bandLabel(v) },
    { key: 'band', label: '現', align: 'center', format: (v) => bandLabel(v) },
    { key: 'position_prev', label: '前順位', align: 'right', format: pos },
    { key: 'position', label: '現順位', align: 'right', format: pos },
    { key: 'positionGain', label: '改善幅', align: 'right', format: (v) => (v === null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(1)}`) },
    { key: 'impressions', label: '表示', align: 'right', format: fmtNum },
    { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
  ];

  const dimKey = dimLabel === 'ページ' ? 'page' : 'query';

  md += `**上の帯へ移動した${dimLabel}（上位20）**\n\n`;
  md += mdTable(transitions.improved.slice(0, 20), movementCols(dimKey));

  md += `\n**下の帯へ移動した${dimLabel}（上位20）**\n\n`;
  md += mdTable(transitions.declined.slice(0, 20), movementCols(dimKey));

  md += `\n**新しく表示されるようになった${dimLabel}（上位20）**\n\n`;
  md += mdTable(transitions.entered.slice(0, 20), [
    { key: dimKey, label: dimLabel, format: (v) => truncate(v, 40) },
    { key: 'band', label: '順位帯', align: 'center', format: (v) => bandLabel(v) },
    { key: 'position', label: '順位', align: 'right', format: pos },
    { key: 'impressions', label: '表示', align: 'right', format: fmtNum },
    { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
  ]);

  md += `\n**表示されなくなった${dimLabel}（上位20）**\n\n`;
  md += mdTable(transitions.exited.slice(0, 20), [
    { key: dimKey, label: dimLabel, format: (v) => truncate(v, 40) },
    { key: 'band_prev', label: '前の順位帯', align: 'center', format: (v) => bandLabel(v) },
    { key: 'position_prev', label: '前順位', align: 'right', format: pos },
    { key: 'impressions_prev', label: '前表示', align: 'right', format: fmtNum },
    { key: 'clicks_prev', label: '前クリック', align: 'right', format: fmtNum },
  ]);

  md += `\n> 掲載順位は表示回数で重み付けされた平均値です。表示回数が少ないクエリは順位の変動が大きく、\n`;
  md += `> 帯をまたぐ動きが必ずしも検索評価の変化を意味するとは限りません。\n`;
  md += `> 表示回数の多いクエリの動きを優先して見てください。\n\n`;

  return md;
}

export { fmtDelta };
