#!/usr/bin/env node
/**
 * GA4 × Search Console 統合レポート。
 *
 *   npm run analytics:report -- --days 28
 *   npm run analytics:report -- --days 7  --compare previous
 *   npm run analytics:report -- --days 90 --compare yoy --geo-cross
 *
 * 出力される report.md は「Claude Code がそのまま読んで分析できる」ことを
 * 目的にしており、数値の羅列に加えて解釈のための注記を含む。
 * 断定的な原因説明は行わない（データから確認できないため）。
 */
import { main, log, section, isEntrypoint } from './lib/cli.mjs';
import { parseCliArgs, parseFormats } from './lib/args.mjs';
import { resolveRange, comparisonRange, formatRange, retentionWarnings, lengthInDays } from './lib/dates.mjs';
import { ga4LagDays, gscLagDays, siteOrigin } from './lib/env.mjs';
import { collectGa4, summarizeKeyEvents, withDelta } from './ga4.mjs';
import { collectGsc, withGscDelta } from './search-console.mjs';
import { extractOpportunities } from './lib/opportunities.mjs';
import { combineByPage, impressionsWithoutClicks, trafficWithPoorBehavior, funnelTotals } from './lib/combine.mjs';
import { schemaNotes } from './lib/ga4-client.mjs';
import {
  createRunDir, writeJSON, writeCSV, writeText, mdTable, fmtNum, fmtPct, fmtSeconds,
  delta, fmtDelta, truncate, relativeToCwd,
} from './lib/output.mjs';

const args = parseCliArgs({ 'geo-cross': { type: 'boolean' } });
const formats = parseFormats(args.format);

const pct = (v) => (v === null || v === undefined ? '—' : fmtPct(v));
const pos = (v) => (v === null || v === undefined ? '—' : v.toFixed(1));

export function buildReport({ range, comparison, ga4, gsc, keyEventInfo, combined, opp, funnel }) {
  const s = ga4['summary']?.current?.rows?.[0] ?? {};
  const sp = ga4['summary']?.previous?.rows?.[0] ?? null;
  const days = lengthInDays(range);

  let md = `# アクセス解析レポート\n\n`;
  md += `- **GA4 対象期間**: ${formatRange(range)}\n`;
  md += `- **Search Console 対象期間**: ${formatRange(gsc.range)}\n`;
  if (comparison) md += `- **比較期間**: ${formatRange(comparison)}（${comparison.label}）\n`;
  md += `- **生成日時**: ${new Date().toISOString()}\n`;
  md += `- **サイト**: ${siteOrigin() || '(SITE_ORIGIN 未設定)'}\n\n`;

  md += `> このファイルは自動生成された「データ」です。数値の解釈・原因の推定・施策の判断は、\n`;
  md += `> このデータを読んだうえで別途行ってください。API から確認できない事柄を断定しないでください。\n\n`;
  md += `---\n\n`;

  // ── 1. アクセス概況 ─────────────────────────────
  md += `## 1. アクセス概況（GA4）\n\n`;
  const overview = [
    ['ユーザー数', 'totalUsers', fmtNum],
    ['新規ユーザー数', 'newUsers', fmtNum],
    ['セッション数', 'sessions', fmtNum],
    ['エンゲージのあったセッション', 'engagedSessions', fmtNum],
    ['エンゲージメント率', 'engagementRate', pct],
    ['直帰率', 'bounceRate', pct],
    ['ページビュー', 'screenPageViews', fmtNum],
    ['平均セッション時間', 'averageSessionDuration', fmtSeconds],
    ['キーイベント数', 'keyEvents', fmtNum],
  ].map(([label, key, fmt]) => ({
    label,
    value: fmt(s[key]),
    prev: sp ? fmt(sp[key]) : '—',
    change: sp ? fmtDelta(delta(s[key], sp[key])) : '—',
  }));
  md += mdTable(overview, [
    { key: 'label', label: '指標' },
    { key: 'value', label: '当期間', align: 'right' },
    { key: 'prev', label: comparison?.label ?? '比較', align: 'right' },
    { key: 'change', label: '増減', align: 'right' },
  ]);
  md += `\n1日あたり平均: セッション ${fmtNum(Math.round((s.sessions ?? 0) / days))} / ユーザー ${fmtNum(Math.round((s.totalUsers ?? 0) / days))}\n\n`;

  const daily = ga4['daily']?.current?.rows ?? [];
  if (daily.length) {
    md += `### 日次推移\n\n`;
    md += mdTable(daily, [
      { key: 'date', label: '日付' },
      { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
      { key: 'totalUsers', label: 'ユーザー', align: 'right', format: fmtNum },
      { key: 'screenPageViews', label: 'PV', align: 'right', format: fmtNum },
      { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
      { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
    ]);

    // 急増・急減の検知（平均±2σを外れた日）
    const values = daily.map((d) => d.sessions);
    const mean = values.reduce((a, b) => a + b, 0) / (values.length || 1);
    const sd = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / (values.length || 1));
    const outliers = daily.filter((d) => sd > 0 && Math.abs(d.sessions - mean) > 2 * sd);
    md += `\n**急増・急減の検知**: 期間平均 ${mean.toFixed(1)} セッション / 標準偏差 ${sd.toFixed(1)}\n\n`;
    if (outliers.length) {
      md += mdTable(
        outliers.map((d) => ({ ...d, dev: (d.sessions - mean) / sd })),
        [
          { key: 'date', label: '日付' },
          { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
          { key: 'dev', label: '平均からの乖離', align: 'right', format: (v) => `${v > 0 ? '+' : ''}${v.toFixed(1)}σ` },
        ]
      );
      md += `\n_統計的な外れ値の検出であり、原因（キャンペーン、外部掲載、ボット等）は別途確認が必要です。_\n`;
    } else {
      md += `_平均±2σを超える日はありませんでした。_\n`;
    }
    md += '\n';
  }

  // ── 2. Google 検索の状況 ───────────────────────
  md += `---\n\n## 2. Google 検索の状況（Search Console）\n\n`;
  const t = gsc.totals;
  const tp = gsc.totalsPrev;
  md += mdTable(
    [
      { label: 'クリック数', value: fmtNum(t.clicks), prev: tp ? fmtNum(tp.clicks) : '—', change: tp ? fmtDelta(delta(t.clicks, tp.clicks)) : '—' },
      { label: '表示回数', value: fmtNum(t.impressions), prev: tp ? fmtNum(tp.impressions) : '—', change: tp ? fmtDelta(delta(t.impressions, tp.impressions)) : '—' },
      { label: 'CTR', value: pct(t.ctr), prev: tp ? pct(tp.ctr) : '—', change: tp ? `${((t.ctr - tp.ctr) * 100).toFixed(2)}pt` : '—' },
      { label: '平均掲載順位', value: pos(t.position), prev: tp ? pos(tp.position) : '—', change: tp ? `${(tp.position - t.position) > 0 ? '+' : ''}${(tp.position - t.position).toFixed(2)}（改善幅）` : '—' },
    ],
    [
      { key: 'label', label: '指標' },
      { key: 'value', label: '当期間', align: 'right' },
      { key: 'prev', label: comparison?.label ?? '比較', align: 'right' },
      { key: 'change', label: '増減', align: 'right' },
    ]
  );

  const queries = gsc.results['query'];
  if (queries) {
    md += `\n### 検索クエリ別（クリック上位30）\n\n`;
    md += mdTable(
      withGscDelta(queries.current.rows, queries.previous?.rows, ['query']).sort((a, b) => b.clicks - a.clicks).slice(0, 30),
      [
        { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 40) },
        { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
        { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
        { key: 'ctr', label: 'CTR', align: 'right', format: pct },
        { key: 'position', label: '掲載順位', align: 'right', format: pos },
        ...(comparison
          ? [{ key: 'clicks_delta', label: 'クリック増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.clicks_deltaPct }) }]
          : []),
      ]
    );
    md += `\n_検索数の少ないクエリは Search Console 側で開示されないため、上記の合計はサイト全体のクリック数と一致しません（仕様）。_\n\n`;
  }

  const gscDevice = gsc.results['device'];
  if (gscDevice) {
    md += `### 検索デバイス別\n\n`;
    md += mdTable(gscDevice.current.rows, [
      { key: 'device', label: 'デバイス' },
      { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
      { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
      { key: 'ctr', label: 'CTR', align: 'right', format: pct },
      { key: 'position', label: '掲載順位', align: 'right', format: pos },
    ]);
    md += '\n';
  }

  // ── 3. 流入元 ────────────────────────────────
  md += `---\n\n## 3. 流入元（GA4）\n\n### チャネル別\n\n`;
  const ch = ga4['channels'];
  if (ch) {
    md += mdTable(
      withDelta(ch.current.rows, ch.previous?.rows, ch.spec.dimensions, ['sessions', 'keyEvents']),
      [
        { key: 'sessionDefaultChannelGroup', label: 'チャネル' },
        { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
        { key: 'totalUsers', label: 'ユーザー', align: 'right', format: fmtNum },
        { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
        { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
        ...(comparison
          ? [{ key: 'sessions_delta', label: 'セッション増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.sessions_deltaPct }) }]
          : []),
      ]
    );
  }

  const sm = ga4['source-medium'];
  if (sm) {
    md += `\n### source / medium 別（上位25）\n\n`;
    md += mdTable(
      withDelta(sm.current.rows, sm.previous?.rows, sm.spec.dimensions, ['sessions', 'keyEvents']).slice(0, 25),
      [
        { key: 'sessionSourceMedium', label: 'source / medium' },
        { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
        { key: 'totalUsers', label: 'ユーザー', align: 'right', format: fmtNum },
        { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
        { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
        ...(comparison
          ? [{ key: 'sessions_delta', label: 'セッション増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.sessions_deltaPct }) }]
          : []),
      ]
    );
    md += '\n';
  }

  // ── 4. ランディングページ ──────────────────────
  md += `---\n\n## 4. ランディングページ（GA4）\n\n`;
  const lp = ga4['landing-pages'];
  if (lp) {
    const dim = lp.spec.dimensions[0];
    md += mdTable(
      withDelta(lp.current.rows, lp.previous?.rows, lp.spec.dimensions, ['sessions', 'keyEvents']).slice(0, 30),
      [
        { key: dim, label: 'ランディングページ', format: (v) => truncate(v, 50) },
        { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
        { key: 'totalUsers', label: 'ユーザー', align: 'right', format: fmtNum },
        { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
        { key: 'averageSessionDuration', label: '平均滞在', align: 'right', format: fmtSeconds },
        { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
        ...(comparison
          ? [{ key: 'sessions_delta', label: 'セッション増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.sessions_deltaPct }) }]
          : []),
      ]
    );
    md += '\n';
  }

  const pages = ga4['pages'];
  if (pages) {
    md += `### ページ別（PV 上位25）\n\n`;
    md += mdTable(pages.current.rows.slice(0, 25), [
      { key: 'pagePath', label: 'パス', format: (v) => truncate(v, 44) },
      { key: 'pageTitle', label: 'タイトル', format: (v) => truncate(v, 30) },
      { key: 'screenPageViews', label: 'PV', align: 'right', format: fmtNum },
      { key: 'totalUsers', label: 'ユーザー', align: 'right', format: fmtNum },
      { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
      { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
    ]);
    md += '\n';
  }

  // ── 5. 地域・デバイス ────────────────────────
  md += `---\n\n## 5. 地域・デバイス（GA4）\n\n### デバイス別\n\n`;
  const dev = ga4['device'];
  if (dev) {
    md += mdTable(dev.current.rows, [
      { key: 'deviceCategory', label: 'デバイス' },
      { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
      { key: 'totalUsers', label: 'ユーザー', align: 'right', format: fmtNum },
      { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
      { key: 'averageSessionDuration', label: '平均滞在', align: 'right', format: fmtSeconds },
      { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
    ]);
  }

  const city = ga4['geo-city'];
  if (city) {
    const totalSessions = city.current.rows.reduce((a, r) => a + r.sessions, 0);
    md += `\n### 市区町村別（上位25）\n\n`;
    md += mdTable(
      city.current.rows.slice(0, 25).map((r) => ({ ...r, share: totalSessions ? r.sessions / totalSessions : 0 })),
      [
        { key: 'city', label: '市区町村' },
        { key: 'region', label: '地域' },
        { key: 'country', label: '国' },
        { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
        { key: 'share', label: '構成比', align: 'right', format: (v) => fmtPct(v, 1) },
        { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
        { key: 'averageSessionDuration', label: '平均滞在', align: 'right', format: fmtSeconds },
        { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
      ]
    );
    md += `\n**GA4 の地域情報の扱いについて**\n\n`;
    md += `GA4 の city / region は IP アドレスからの推定です。以下はいずれも同じ分布を生みうるため、`;
    md += `この表だけでは実際の利用者分布とは判断できません。\n\n`;
    md += `- 実際にその地域に利用者がいる\n`;
    md += `- モバイルキャリアの IP 出口がその地域に集約されている（Osaka / Yokohama / Shinjuku City / Minato City / Chiyoda City は国内キャリア・大手 ISP の出口として現れやすい地点です）\n`;
    md += `- VPN・企業ネットワーク経由\n`;
    md += `- データセンター経由のアクセス（クローラ・ボットを含む）\n\n`;
    md += `切り分けの材料として \`--geo-cross\` オプションで市区町村 × デバイス / ブラウザ / 流入元 / LP のクロス集計を取得できます。`;
    md += `判断のヒントは cross-*.csv および ga4.md を参照してください。\n\n`;
  }

  // ── 6. コンバージョン ───────────────────────
  md += `---\n\n## 6. コンバージョン（キーイベント）\n\n`;
  md += `${keyEventInfo.note}\n\n`;
  if (keyEventInfo.configured) {
    md += mdTable(keyEventInfo.rows, [
      { key: 'eventName', label: 'イベント名' },
      { key: 'keyEvents', label: 'キーイベント数', align: 'right', format: fmtNum },
      { key: 'eventCount', label: 'イベント数', align: 'right', format: fmtNum },
      { key: 'totalUsers', label: 'ユーザー数', align: 'right', format: fmtNum },
    ]);
    const kelp = ga4['key-event-landing-pages'];
    if (kelp && kelp.current.rows.length) {
      md += `\n### キーイベントにつながったランディングページ\n\n`;
      const dim = kelp.spec.dimensions[0];
      md += mdTable(kelp.current.rows.filter((r) => r.keyEvents > 0).slice(0, 25), [
        { key: dim, label: 'ランディングページ', format: (v) => truncate(v, 46) },
        { key: 'eventName', label: 'イベント' },
        { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
        { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
      ]);
      md += '\n';
    }
  } else {
    md += `**現在、キーイベントによるコンバージョン分析はできません。**\n\n`;
    md += `期間内に計上されたイベントは以下のとおりです（キーイベントとしては計上されていません）。\n\n`;
    const ev = ga4['events']?.current?.rows ?? [];
    md += mdTable(ev.slice(0, 25), [
      { key: 'eventName', label: 'イベント名' },
      { key: 'eventCount', label: 'イベント数', align: 'right', format: fmtNum },
      { key: 'totalUsers', label: 'ユーザー数', align: 'right', format: fmtNum },
    ]);
    md += `\n_GA4 側の設定変更は本ツールでは行いません。_\n\n`;
  }

  // ── 7. 統合分析 ─────────────────────────────
  md += `---\n\n## 7. Search Console × GA4 統合分析（ページ単位）\n\n`;
  md += `Search Console（検索での表示・クリック）と GA4（到達後の行動）を、ページURLをキーに集計値として並べたものです。`;
  md += `ユーザー単位では結合していません。**クリック数とセッション数が一致しないのは正常です**（計測方法が異なるため）。\n\n`;

  md += `### ファネル（合計）\n\n`;
  md += mdTable(
    [
      { step: '① Google 検索での表示', value: fmtNum(funnel.impressions), rate: '—' },
      { step: '② 検索結果のクリック', value: fmtNum(funnel.clicks), rate: `CTR ${pct(funnel.ctr)}` },
      { step: '③ GA4 のセッション（LP到達）', value: fmtNum(funnel.sessions), rate: `クリック比 ${pct(funnel.clickToSession)}` },
      { step: '④ エンゲージのあったセッション', value: fmtNum(funnel.engagedSessions), rate: `セッション比 ${pct(funnel.sessionToEngaged)}` },
      { step: '⑤ キーイベント', value: fmtNum(funnel.keyEvents), rate: `エンゲージ比 ${pct(funnel.engagedToKeyEvent)}` },
    ],
    [
      { key: 'step', label: 'ステップ' },
      { key: 'value', label: '件数', align: 'right' },
      { key: 'rate', label: '前ステップからの比率', align: 'right' },
    ]
  );
  md += `\n③/② が 1 から大きく外れる場合、計測タグの未設置・リダイレクト・計測ブロック等の可能性があります（本レポートでは判定できません）。\n\n`;

  md += `### ページ別 統合表（検索クリック上位30）\n\n`;
  md += mdTable(combined.rows.slice(0, 30), [
    { key: 'pageKey', label: 'ページ', format: (v) => truncate(v, 40) },
    { key: 'impressions', label: '表示', align: 'right', format: fmtNum },
    { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
    { key: 'ctr', label: 'CTR', align: 'right', format: pct },
    { key: 'position', label: '順位', align: 'right', format: pos },
    { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
    { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
    { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
  ]);

  const noClicks = impressionsWithoutClicks(combined.rows);
  md += `\n### 検索では表示されているがクリックされていないページ\n\n`;
  md += `表示回数 ${30} 回以上かつ CTR 2% 未満のページ。title / description、および掲載順位の確認候補です。\n\n`;
  md += mdTable(noClicks.slice(0, 20), [
    { key: 'pageKey', label: 'ページ', format: (v) => truncate(v, 46) },
    { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
    { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
    { key: 'ctr', label: 'CTR', align: 'right', format: pct },
    { key: 'position', label: '掲載順位', align: 'right', format: pos },
  ]);

  const poor = trafficWithPoorBehavior(combined.rows);
  md += `\n### Google から流入しているが、その後の行動が良くないページ\n\n`;
  md += `検索クリックがあり、GA4 セッション 10 以上、かつエンゲージメント率 40% 未満のページ。\n`;
  md += `検索意図とページ内容のずれ、ファーストビュー、表示速度などの確認候補です（原因はこのデータからは特定できません）。\n\n`;
  md += mdTable(poor.slice(0, 20), [
    { key: 'pageKey', label: 'ページ', format: (v) => truncate(v, 42) },
    { key: 'clicks', label: '検索クリック', align: 'right', format: fmtNum },
    { key: 'sessions', label: 'セッション', align: 'right', format: fmtNum },
    { key: 'engagementRate', label: 'エンゲージ率', align: 'right', format: pct },
    { key: 'avgEngagementSeconds', label: '平均エンゲージ時間', align: 'right', format: (v) => (v === null ? '—' : fmtSeconds(v)) },
    { key: 'keyEvents', label: 'キーイベント', align: 'right', format: fmtNum },
  ]);

  md += `\n### 突き合わせのカバレッジ\n\n`;
  md += `- 両方に存在するページ: ${combined.coverage.matchedPages}\n`;
  md += `- Search Console のみ: ${combined.coverage.gscOnlyPages}\n`;
  md += `- GA4 のみ: ${combined.coverage.ga4OnlyPages}\n`;
  md += `- 一致率（GSC ページ基準）: ${pct(combined.coverage.matchRate)}\n\n`;
  if (combined.coverage.gscOnlyPages > 0) {
    md += `Search Console にあって GA4 にないページの例（計測タグ未設置、または URL 表記の差の可能性）:\n\n`;
    md += combined.coverage.gscOnlySamples.map((p) => `- \`${p}\``).join('\n');
    md += '\n\n';
  }

  // ── 8. SEO 改善候補 ────────────────────────
  md += `---\n\n## 8. SEO 改善候補\n\n> ${opp.disclaimer}\n\n`;

  md += `### A. 順位4〜15位＋表示回数が多い（伸びしろが大きい候補）\n\n`;
  md += mdTable(opp.A_rankingUpside.slice(0, 25), [
    { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 36) },
    { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
    { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
    { key: 'ctr', label: 'CTR', align: 'right', format: pct },
    { key: 'position', label: '掲載順位', align: 'right', format: pos },
    { key: 'estimatedClickGain', label: '推定クリック増', align: 'right', format: fmtNum },
  ]);

  md += `\n### B. 表示回数の割に CTR が低い（title / description 改善候補）\n\n**検索クエリ**\n\n`;
  md += mdTable(opp.B_lowCtrQueries.slice(0, 20), [
    { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 36) },
    { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
    { key: 'ctr', label: '実測CTR', align: 'right', format: pct },
    { key: 'expectedCtr', label: '順位相応CTR', align: 'right', format: pct },
    { key: 'position', label: '掲載順位', align: 'right', format: pos },
    { key: 'estimatedClickGain', label: '推定クリック増', align: 'right', format: fmtNum },
  ]);
  md += `\n**ページ**\n\n`;
  md += mdTable(opp.B_lowCtrPages.slice(0, 20), [
    { key: 'page', label: 'ページ', format: (v) => truncate(v, 46) },
    { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
    { key: 'ctr', label: '実測CTR', align: 'right', format: pct },
    { key: 'expectedCtr', label: '順位相応CTR', align: 'right', format: pct },
    { key: 'position', label: '掲載順位', align: 'right', format: pos },
    { key: 'estimatedClickGain', label: '推定クリック増', align: 'right', format: fmtNum },
  ]);

  md += `\n### C. 急増している検索クエリ（成長中候補）\n\n`;
  md += comparison
    ? mdTable(opp.C_growingQueries.slice(0, 25), [
        { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 34) },
        { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
        { key: 'impressions_delta', label: '表示増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.impressions_ratio === null ? null : r.impressions_ratio - 1 }) },
        { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
        { key: 'clicks_delta', label: 'クリック増減', align: 'right', format: (v, r) => fmtDelta({ abs: v, pct: r.clicks_ratio === null ? null : r.clicks_ratio - 1 }) },
        { key: 'position', label: '掲載順位', align: 'right', format: pos },
        { key: 'isNew', label: '新規', align: 'center', format: (v) => (v ? '✓' : '') },
      ])
    : '_比較期間が未指定のため算出していません。_\n';

  md += `\n### D. 悪化している検索クエリ / ページ（SEO 劣化候補）\n\n**検索クエリ**\n\n`;
  md += comparison
    ? mdTable(opp.D_decliningQueries.slice(0, 20), [
        { key: 'query', label: '検索クエリ', format: (v) => truncate(v, 34) },
        { key: 'clicks_prev', label: '前クリック', align: 'right', format: fmtNum },
        { key: 'clicks', label: '現クリック', align: 'right', format: fmtNum },
        { key: 'impressions_prev', label: '前表示', align: 'right', format: fmtNum },
        { key: 'impressions', label: '現表示', align: 'right', format: fmtNum },
        { key: 'position_prev', label: '前順位', align: 'right', format: pos },
        { key: 'position', label: '現順位', align: 'right', format: (v) => (v === null ? '圏外' : v.toFixed(1)) },
      ])
    : '_比較期間が未指定のため算出していません。_\n';
  md += `\n**ページ**\n\n`;
  md += comparison
    ? mdTable(opp.D_decliningPages.slice(0, 20), [
        { key: 'page', label: 'ページ', format: (v) => truncate(v, 44) },
        { key: 'clicks_prev', label: '前クリック', align: 'right', format: fmtNum },
        { key: 'clicks', label: '現クリック', align: 'right', format: fmtNum },
        { key: 'impressions_prev', label: '前表示', align: 'right', format: fmtNum },
        { key: 'impressions', label: '現表示', align: 'right', format: fmtNum },
        { key: 'position_prev', label: '前順位', align: 'right', format: pos },
        { key: 'position', label: '現順位', align: 'right', format: (v) => (v === null ? '圏外' : v.toFixed(1)) },
      ])
    : '_比較期間が未指定のため算出していません。_\n';

  md += `\n### E. カニバリゼーション候補（同一クエリで複数ページが表示）\n\n`;
  if (!opp.E_cannibalization.length) {
    md += '_該当データなし_\n';
  } else {
    for (const c of opp.E_cannibalization.slice(0, 10)) {
      md += `**「${c.query}」** — ${c.pageCount}ページ / 合計表示 ${fmtNum(c.totalImpressions)}\n\n`;
      md += mdTable(c.pages, [
        { key: 'page', label: 'ページ', format: (v) => truncate(v, 50) },
        { key: 'impressions', label: '表示回数', align: 'right', format: fmtNum },
        { key: 'impressionShare', label: '表示シェア', align: 'right', format: (v) => fmtPct(v, 1) },
        { key: 'clicks', label: 'クリック', align: 'right', format: fmtNum },
        { key: 'position', label: '掲載順位', align: 'right', format: pos },
      ]);
      md += '\n';
    }
  }

  // ── 9. データ上の制約 ──────────────────────
  md += `---\n\n## 9. このレポートを読むうえでの制約\n\n`;
  md += `- **Search Console**: データ保持は約16か月。直近 ${gscLagDays()} 日は未確定として除外。検索数の少ないクエリは非開示のため、クエリ別合計とサイト全体値は一致しない。\n`;
  md += `- **GA4**: 直近 ${ga4LagDays()} 日は未確定として除外。イベントデータ保持設定（2か月／14か月）より前は取得不可。前年同期比較には14か月設定が必要。\n`;
  md += `- **地域情報**: IP ベースの推定であり、実際の所在地とは限らない。\n`;
  md += `- **カーディナリティ**: ディメンションの組み合わせが多い表では \`(other)\` に集約される行がある。\n`;
  md += `- **統合分析**: ページURLをキーにした集計値の突き合わせであり、ユーザー単位の結合ではない。\n`;
  if (schemaNotes.warnings.length) {
    md += `\n**スキーマに関する注記**\n\n${schemaNotes.warnings.map((w) => `- ${w}`).join('\n')}\n`;
  }

  md += `\n---\n\n## 10. Executive Summary / 施策の検討\n\n`;
  md += `このセクションは意図的に空欄です。上記のデータを読んだうえで、\n`;
  md += `「何が起きているか」「なぜ起きている可能性があるか」「何を改善すべきか」を記述してください。\n`;
  md += `データから確認できない原因は、断定せず可能性として書いてください。\n`;

  return md;
}

if (isEntrypoint(import.meta.url)) await main(async () => {
  const ga4Range = resolveRange({ days: args.days, start: args.start, end: args.end, lagDays: ga4LagDays() });
  const gscRange = resolveRange({ days: args.days, start: args.start, end: args.end, lagDays: gscLagDays() });
  const ga4Comparison = comparisonRange(ga4Range, args.compare);
  const gscComparison = comparisonRange(gscRange, args.compare);

  section('統合レポート生成');
  log(`  GA4 期間           : ${formatRange(ga4Range)}`);
  log(`  Search Console 期間: ${formatRange(gscRange)}`);
  if (ga4Comparison) log(`  比較期間           : ${ga4Comparison.label}`);
  for (const w of [...retentionWarnings(ga4Range, 'ga4'), ...retentionWarnings(gscRange, 'gsc')]) log(`  ⚠️  ${w}`);

  log('\n  [1/3] GA4 を取得中…');
  const ga4 = await collectGa4({
    range: ga4Range,
    comparison: ga4Comparison,
    includeGeoCross: Boolean(args['geo-cross']),
  });
  const keyEventInfo = summarizeKeyEvents(ga4);

  log('\n  [2/3] Search Console を取得中…');
  const gscData = await collectGsc({ range: gscRange, comparison: gscComparison });

  log('\n  [3/3] 統合・候補抽出中…');
  const combined = combineByPage({
    gscPageRows: gscData.results['page']?.current.rows ?? [],
    ga4LandingRows: ga4['landing-pages']?.current.rows ?? [],
    ga4PageRows: ga4['pages']?.current.rows ?? [],
    gscQueryPageRows: gscData.results['query-page']?.current.rows ?? [],
  });
  const funnel = funnelTotals(combined.rows);
  const opp = extractOpportunities({
    queryCurrent: gscData.results['query']?.current.rows ?? [],
    queryPrevious: gscData.results['query']?.previous?.rows ?? null,
    pageCurrent: gscData.results['page']?.current.rows ?? [],
    pagePrevious: gscData.results['page']?.previous?.rows ?? null,
    queryPage: gscData.results['query-page']?.current.rows ?? [],
  });

  const dir = createRunDir('report', { out: args.out });

  if (formats.includes('md')) {
    writeText(
      dir,
      'report.md',
      buildReport({
        range: ga4Range,
        comparison: ga4Comparison,
        ga4,
        gsc: { ...gscData, range: gscRange },
        keyEventInfo,
        combined,
        opp,
        funnel,
      })
    );
  }

  if (formats.includes('json')) {
    writeJSON(dir, 'report', {
      generatedAt: new Date().toISOString(),
      ranges: { ga4: ga4Range, searchConsole: gscRange, comparison: ga4Comparison },
      ga4: {
        summary: ga4['summary']?.current.rows[0] ?? {},
        summaryPrevious: ga4['summary']?.previous?.rows[0] ?? null,
        reports: Object.fromEntries(
          Object.entries(ga4).map(([k, v]) => [k, { label: v.spec.label, rows: v.current.rows, previousRows: v.previous?.rows ?? null }])
        ),
      },
      searchConsole: {
        totals: gscData.totals,
        totalsPrevious: gscData.totalsPrev,
        reports: Object.fromEntries(
          Object.entries(gscData.results).map(([k, v]) => [k, { label: v.spec.label, rows: v.current.rows, previousRows: v.previous?.rows ?? null }])
        ),
      },
      keyEvents: keyEventInfo,
      combined: { rows: combined.rows, coverage: combined.coverage },
      funnel,
      opportunities: opp,
      schemaNotes: {
        substitutions: Object.fromEntries(schemaNotes.substitutions),
        dropped: [...schemaNotes.dropped],
        warnings: schemaNotes.warnings,
      },
    });
  }

  if (formats.includes('csv')) {
    writeCSV(dir, 'combined-pages', combined.rows.map(({ topQueries, matchedIn, ...r }) => ({ ...r, topQueries: topQueries.map((q) => q.query).join(' | ') })));
    writeCSV(dir, 'A-ranking-upside', opp.A_rankingUpside);
    writeCSV(dir, 'B-low-ctr-queries', opp.B_lowCtrQueries);
    writeCSV(dir, 'B-low-ctr-pages', opp.B_lowCtrPages);
    writeCSV(dir, 'C-growing-queries', opp.C_growingQueries);
    writeCSV(dir, 'D-declining-queries', opp.D_decliningQueries);
    writeCSV(dir, 'D-declining-pages', opp.D_decliningPages);
    writeCSV(dir, 'no-click-pages', impressionsWithoutClicks(combined.rows).map(({ topQueries, matchedIn, ...r }) => r));
    writeCSV(dir, 'poor-behavior-pages', trafficWithPoorBehavior(combined.rows).map(({ topQueries, matchedIn, ...r }) => r));
    for (const [key, v] of Object.entries(ga4)) writeCSV(dir, `ga4-${key}`, v.current.rows);
    for (const [key, v] of Object.entries(gscData.results)) writeCSV(dir, `gsc-${key}`, v.current.rows);
  }

  section('出力');
  log(`  ${relativeToCwd(dir)}/`);
  log(`  report.md を読めば全体の分析ができます。\n`);
  if (!keyEventInfo.configured) log(`  ⚠️  ${keyEventInfo.note}\n`);
  if (combined.coverage.matchRate !== null && combined.coverage.matchRate < 0.5) {
    log(`  ⚠️  Search Console と GA4 のページ一致率が ${fmtPct(combined.coverage.matchRate)} と低めです。SITE_ORIGIN の設定、または計測タグの設置状況を確認してください。\n`);
  }
});
