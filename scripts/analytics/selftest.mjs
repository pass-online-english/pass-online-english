#!/usr/bin/env node
/**
 * 分析ロジックの自己テスト。Google API には接続しない。
 *
 * 期間計算・URL正規化・SEO候補抽出・GA4×GSC突き合わせといった
 * 「純粋な計算部分」を合成データで検証する。認証設定の前でも実行できる。
 *
 *   npm run analytics:selftest
 */
import assert from 'node:assert/strict';
import {
  resolveRange, previousRange, yoyRange, comparisonRange, lengthInDays, shiftDays,
} from './lib/dates.mjs';
import { pageKey, joinCoverage } from './lib/urls.mjs';
import { toCSV, delta, fmtPct, mdTable } from './lib/output.mjs';
import {
  opportunityA, opportunityB, opportunityC, opportunityD, opportunityE, expectedCtr, extractOpportunities,
} from './lib/opportunities.mjs';
import { buildReport } from './report.mjs';
import { summarizeKeyEvents, summaryMarkdown, detailMarkdown, geoCrossMarkdown } from './ga4.mjs';
import { buildMarkdown as gscMarkdown } from './search-console.mjs';
import { combineByPage, impressionsWithoutClicks, trafficWithPoorBehavior, funnelTotals } from './lib/combine.mjs';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  ❌ ${name}`);
    console.log(`     ${err.message}`);
  }
}

console.log('\n── 期間計算 ──────────────────────────────────');

test('--days 7 は7日間（終端を含む）になる', () => {
  const r = resolveRange({ days: '7', end: '2026-08-24', start: undefined });
  const r2 = resolveRange({ days: '7', lagDays: 0 });
  assert.equal(lengthInDays(r2), 7);
  assert.equal(shiftDays(r2.endDate, -6), r2.startDate);
});

test('lagDays で終端が手前にずれる', () => {
  const a = resolveRange({ days: '7', lagDays: 0 });
  const b = resolveRange({ days: '7', lagDays: 3 });
  assert.equal(shiftDays(a.endDate, -3), b.endDate);
  assert.equal(lengthInDays(b), 7);
});

test('前期間は直前の同じ長さの期間になる（重複しない）', () => {
  const cur = { startDate: '2026-08-01', endDate: '2026-08-28' };
  const prev = previousRange(cur);
  assert.equal(prev.endDate, '2026-07-31');
  assert.equal(prev.startDate, '2026-07-04');
  assert.equal(lengthInDays(prev), lengthInDays(cur));
});

test('前年同期（曜日揃え）は364日前で曜日が一致する', () => {
  const cur = { startDate: '2026-08-01', endDate: '2026-08-28' };
  const yoy = yoyRange(cur);
  assert.equal(yoy.startDate, '2025-08-02');
  assert.equal(new Date(`${cur.startDate}T00:00:00Z`).getUTCDay(), new Date(`${yoy.startDate}T00:00:00Z`).getUTCDay());
});

test('前年同期（暦日揃え）は同じ月日になる', () => {
  const yoy = yoyRange({ startDate: '2026-08-01', endDate: '2026-08-28' }, { mode: 'calendar' });
  assert.equal(yoy.startDate, '2025-08-01');
  assert.equal(yoy.endDate, '2025-08-28');
});

test('--compare none は比較なしを返す', () => {
  assert.equal(comparisonRange({ startDate: '2026-08-01', endDate: '2026-08-28' }, 'none'), null);
});

test('--start が --end より後ならエラーになる', () => {
  assert.throws(() => resolveRange({ start: '2026-08-28', end: '2026-08-01' }));
});

test('不正な日付形式はエラーになる', () => {
  assert.throws(() => resolveRange({ start: '2026/08/01', end: '2026-08-28' }));
});

console.log('\n── URL 正規化 ────────────────────────────────');

test('絶対URLとパスが同じキーになる', () => {
  assert.equal(pageKey('https://example.com/blog/toeic990.html'), pageKey('/blog/toeic990.html'));
});

test('クエリ文字列とフラグメントを除去する', () => {
  assert.equal(pageKey('https://example.com/blog/a.html?utm_source=x#top'), '/blog/a.html');
});

test('ルートと index.html を同一視する', () => {
  assert.equal(pageKey('https://example.com/'), '/');
  assert.equal(pageKey('https://example.com/index.html'), '/');
  assert.equal(pageKey('/'), '/');
});

test('末尾スラッシュの有無を吸収する', () => {
  assert.equal(pageKey('/blog/'), '/blog');
  assert.equal(pageKey('/blog'), '/blog');
});

test('突き合わせカバレッジを算出できる', () => {
  const c = joinCoverage(['/', '/a'], ['/', '/b']);
  assert.deepEqual(c.matched, ['/']);
  assert.deepEqual(c.gscOnly, ['/b']);
  assert.deepEqual(c.ga4Only, ['/a']);
  assert.equal(c.matchRate, 0.5);
});

console.log('\n── 出力ユーティリティ ────────────────────────');

test('CSV がカンマ・引用符・改行をエスケープする', () => {
  const csv = toCSV([{ q: 'a,b', r: 'say "hi"', s: 'x\ny' }]);
  assert.ok(csv.includes('"a,b"'));
  assert.ok(csv.includes('"say ""hi"""'));
  assert.ok(csv.includes('"x\ny"'));
  assert.ok(csv.startsWith('﻿'), 'Excel 用の BOM が必要');
});

test('前期間が0のとき増減率は null（∞にしない）', () => {
  assert.equal(delta(10, 0).pct, null);
  assert.equal(delta(10, 0).abs, 10);
  assert.equal(delta(15, 10).pct, 0.5);
});

test('Markdown テーブルのパイプ文字がエスケープされる', () => {
  const md = mdTable([{ a: 'x|y' }], [{ key: 'a', label: 'A' }]);
  assert.ok(md.includes('x\\|y'));
});

test('空配列では「該当データなし」を返す', () => {
  assert.ok(mdTable([], [{ key: 'a', label: 'A' }]).includes('該当データなし'));
});

console.log('\n── SEO 改善候補 ──────────────────────────────');

const queryRows = [
  { query: '英検準1級 ライティング', clicks: 5, impressions: 900, ctr: 0.0056, position: 8.2 },
  { query: '英検1級 面接 対策', clicks: 2, impressions: 400, ctr: 0.005, position: 12.4 },
  { query: 'toeic 990 勉強法', clicks: 60, impressions: 500, ctr: 0.12, position: 2.1 },
  { query: 'オンライン英会話 大阪', clicks: 0, impressions: 25, ctr: 0, position: 6.0 },
  { query: '英検 2級 いつ', clicks: 1, impressions: 800, ctr: 0.00125, position: 30.5 },
];

test('A: 順位4〜15位かつ表示回数が多いクエリを拾う', () => {
  const a = opportunityA(queryRows);
  const qs = a.map((r) => r.query);
  assert.ok(qs.includes('英検準1級 ライティング'), '8.2位/900表示 は候補になるべき');
  assert.ok(qs.includes('英検1級 面接 対策'), '12.4位/400表示 は候補になるべき');
  assert.ok(!qs.includes('toeic 990 勉強法'), '2.1位は順位帯の外');
  assert.ok(!qs.includes('英検 2級 いつ'), '30.5位は順位帯の外');
  assert.ok(!qs.includes('オンライン英会話 大阪'), '表示25回はしきい値未満');
});

test('A: 推定クリック増が大きい順に並ぶ', () => {
  const a = opportunityA(queryRows);
  for (let i = 1; i < a.length; i += 1) assert.ok(a[i - 1].estimatedClickGain >= a[i].estimatedClickGain);
});

test('順位相応CTRは順位が下がるほど小さくなる', () => {
  assert.ok(expectedCtr(1) > expectedCtr(3));
  assert.ok(expectedCtr(3) > expectedCtr(10));
  assert.ok(expectedCtr(10) > expectedCtr(30));
});

test('B: 順位の割にCTRが低いクエリを拾い、良好なものは拾わない', () => {
  const b = opportunityB(queryRows, 'query');
  const qs = b.map((r) => r.query);
  assert.ok(qs.includes('英検準1級 ライティング'), '8位で CTR 0.56% は低すぎる');
  assert.ok(!qs.includes('toeic 990 勉強法'), '2位で CTR 12% は順位相応');
});

test('C: 表示回数が急増したクエリを拾う', () => {
  const prev = [
    { query: '英検準1級 ライティング', clicks: 4, impressions: 200, ctr: 0.02, position: 9.0 },
    { query: 'toeic 990 勉強法', clicks: 58, impressions: 480, ctr: 0.12, position: 2.2 },
  ];
  const c = opportunityC(queryRows, prev, 'query');
  const qs = c.map((r) => r.query);
  assert.ok(qs.includes('英検準1級 ライティング'), '200→900 は急増');
  assert.ok(!qs.includes('toeic 990 勉強法'), '480→500 は横ばい');
  assert.ok(c.find((r) => r.query === '英検1級 面接 対策')?.isNew, '前期間に存在しないものは新規扱い');
});

test('D: クリック減・順位下落・消失を劣化候補として拾う', () => {
  const prev = [
    { query: '英検 2級 いつ', clicks: 40, impressions: 900, ctr: 0.044, position: 4.0 },
    { query: '消えたクエリ', clicks: 30, impressions: 500, ctr: 0.06, position: 5.0 },
  ];
  const d = opportunityD(queryRows, prev, 'query');
  const decayed = d.find((r) => r.query === '英検 2級 いつ');
  assert.ok(decayed, 'クリック40→1・順位4→30.5 は劣化候補');
  assert.ok(decayed.position_drop > 0, '順位下落は正の値で表す');
  const gone = d.find((r) => r.query === '消えたクエリ');
  assert.ok(gone?.disappeared, '当期間に存在しないクエリは消失として拾う');
  assert.equal(gone.clicks, 0);
});

test('E: 同一クエリで複数ページが競合しているものを拾う', () => {
  const queryPage = [
    { query: '英検 ライティング', page: 'https://example.com/a.html', clicks: 5, impressions: 300, ctr: 0.016, position: 7 },
    { query: '英検 ライティング', page: 'https://example.com/b.html', clicks: 2, impressions: 250, ctr: 0.008, position: 9 },
    { query: '単独クエリ', page: 'https://example.com/c.html', clicks: 10, impressions: 400, ctr: 0.025, position: 3 },
    { query: '軽微な併存', page: 'https://example.com/d.html', clicks: 10, impressions: 500, ctr: 0.02, position: 3 },
    { query: '軽微な併存', page: 'https://example.com/e.html', clicks: 0, impressions: 5, ctr: 0, position: 40 },
  ];
  const e = opportunityE(queryPage);
  const qs = e.map((r) => r.query);
  assert.ok(qs.includes('英検 ライティング'), '表示シェアが拮抗する2ページは候補');
  assert.ok(!qs.includes('単独クエリ'), '1ページだけなら候補にしない');
  assert.ok(!qs.includes('軽微な併存'), '表示シェア1%程度の副次ページは候補にしない');
  assert.equal(e.find((r) => r.query === '英検 ライティング').bestPosition, 7);
});

console.log('\n── GA4 × Search Console 統合 ─────────────────');

const gscPageRows = [
  { page: 'https://example.com/', clicks: 40, impressions: 2000, ctr: 0.02, position: 6.5 },
  { page: 'https://example.com/blog/toeic990.html', clicks: 20, impressions: 3000, ctr: 0.0067, position: 9.1 },
  { page: 'https://example.com/missing.html', clicks: 5, impressions: 300, ctr: 0.017, position: 12 },
];
const ga4LandingRows = [
  { landingPagePlusQueryString: '/', sessions: 38, totalUsers: 35, engagedSessions: 25, keyEvents: 3, userEngagementDuration: 1900 },
  { landingPagePlusQueryString: '/blog/toeic990.html', sessions: 19, totalUsers: 18, engagedSessions: 5, keyEvents: 0, userEngagementDuration: 200 },
];
const ga4PageRows = [
  { pagePath: '/', pageTitle: 'Passオンライン英語', screenPageViews: 60 },
  { pagePath: '/blog/toeic990.html', pageTitle: 'TOEIC990点の勉強法', screenPageViews: 25 },
];
const gscQueryPageRows = [
  { query: 'toeic 990 勉強法', page: 'https://example.com/blog/toeic990.html', clicks: 18, impressions: 2000, ctr: 0.009, position: 8 },
  { query: '英検 オンライン', page: 'https://example.com/', clicks: 30, impressions: 1500, ctr: 0.02, position: 6 },
];

const combined = combineByPage({ gscPageRows, ga4LandingRows, ga4PageRows, gscQueryPageRows });

test('絶対URL(GSC)とパス(GA4)が同一ページとして結合される', () => {
  const root = combined.rows.find((r) => r.pageKey === '/');
  assert.equal(root.clicks, 40);
  assert.equal(root.sessions, 38);
  assert.equal(root.pageViews, 60);
  assert.equal(root.pageTitle, 'Passオンライン英語');
  assert.deepEqual(root.matchedIn, ['gsc', 'ga4-landing', 'ga4-page']);
});

test('GA4 のランディングページ名が変わっても結合できる（フォールバック対応）', () => {
  const alt = combineByPage({
    gscPageRows,
    ga4LandingRows: [{ landingPage: '/', sessions: 38, totalUsers: 35, engagedSessions: 25, keyEvents: 3, userEngagementDuration: 1900 }],
    ga4PageRows,
    gscQueryPageRows,
  });
  assert.equal(alt.landingDimensionUsed, 'landingPage');
  assert.equal(alt.rows.find((r) => r.pageKey === '/').sessions, 38);
});

test('片方にしか無いページも欠落させず、カバレッジで報告する', () => {
  assert.ok(combined.rows.find((r) => r.pageKey === '/missing.html'));
  assert.equal(combined.coverage.gscOnlyPages, 1);
  assert.deepEqual(combined.coverage.gscOnlySamples, ['/missing.html']);
});

test('ファネル比率を算出できる', () => {
  const root = combined.rows.find((r) => r.pageKey === '/');
  assert.ok(Math.abs(root.clickToSessionRatio - 38 / 40) < 1e-9);
  assert.ok(Math.abs(root.sessionToKeyEventRate - 3 / 38) < 1e-9);
  assert.ok(Math.abs(root.engagementRate - 25 / 38) < 1e-9);
});

test('ファネル合計が整合する', () => {
  const f = funnelTotals(combined.rows);
  assert.equal(f.impressions, 5300);
  assert.equal(f.clicks, 65);
  assert.equal(f.sessions, 57);
  assert.equal(f.keyEvents, 3);
  assert.ok(Math.abs(f.ctr - 65 / 5300) < 1e-9);
});

test('「表示されているがクリックされていない」ページを抽出できる', () => {
  const rows = impressionsWithoutClicks(combined.rows);
  const keys = rows.map((r) => r.pageKey);
  assert.ok(keys.includes('/blog/toeic990.html'), '3000表示/CTR0.67% は該当');
  assert.ok(!keys.includes('/'), 'CTR 2% は該当しない');
});

test('「流入しているが行動が悪い」ページを抽出できる', () => {
  const rows = trafficWithPoorBehavior(combined.rows);
  const keys = rows.map((r) => r.pageKey);
  assert.ok(keys.includes('/blog/toeic990.html'), 'エンゲージ率 26% は該当');
  assert.ok(!keys.includes('/'), 'エンゲージ率 66% は該当しない');
});

test('ゼロ除算が発生しない', () => {
  const empty = combineByPage({});
  assert.deepEqual(empty.rows, []);
  const f = funnelTotals([]);
  assert.equal(f.ctr, null);
  assert.equal(fmtPct(null), '');
});

console.log('\n── レポート生成（合成データ） ────────────────');

/** 合成データで report.md の生成を通し、表示処理の欠落やゼロ除算がないか確かめる */
function mockGa4(withKeyEvents) {
  const wrap = (key, label, dimensions, rows, prevRows = null) => [
    key,
    {
      spec: { key, label, group: 'x', dimensions },
      current: { rows, previous: null, metrics: [], dimensions, totals: {}, rowCount: rows.length, hasOtherRow: false },
      previous: prevRows ? { rows: prevRows } : null,
    },
  ];
  const summary = {
    totalUsers: 520, newUsers: 430, sessions: 610, engagedSessions: 380, engagementRate: 0.623,
    bounceRate: 0.377, screenPageViews: 940, averageSessionDuration: 74.2,
    userEngagementDuration: 31000, eventCount: 3100, keyEvents: withKeyEvents ? 12 : 0,
  };
  const summaryPrev = { ...summary, sessions: 500, totalUsers: 460, keyEvents: withKeyEvents ? 9 : 0 };

  return Object.fromEntries([
    wrap('summary', 'サマリー', [], [summary], [summaryPrev]),
    wrap('daily', '日次', ['date'],
      Array.from({ length: 14 }, (_, i) => ({
        date: `202608${String(i + 10).padStart(2, '0')}`,
        sessions: i === 7 ? 260 : 25 + i, totalUsers: 20 + i, screenPageViews: 40 + i,
        engagementRate: 0.6, keyEvents: withKeyEvents ? 1 : 0,
      }))),
    wrap('pages', 'ページ', ['pagePath', 'pageTitle'], ga4PageRows.map((r) => ({ ...r, sessions: 30, totalUsers: 28, engagementRate: 0.6, keyEvents: 0 }))),
    wrap('landing-pages', 'LP', ['landingPagePlusQueryString'], ga4LandingRows.map((r) => ({ ...r, engagementRate: r.engagedSessions / r.sessions, averageSessionDuration: 60 })),
      [{ landingPagePlusQueryString: '/', sessions: 30, totalUsers: 29, engagedSessions: 20, keyEvents: 2, userEngagementDuration: 1500 }]),
    wrap('channels', 'チャネル', ['sessionDefaultChannelGroup'],
      [{ sessionDefaultChannelGroup: 'Organic Search', sessions: 400, totalUsers: 350, engagementRate: 0.65, keyEvents: withKeyEvents ? 10 : 0 },
       { sessionDefaultChannelGroup: 'Direct', sessions: 210, totalUsers: 170, engagementRate: 0.55, keyEvents: withKeyEvents ? 2 : 0 }],
      [{ sessionDefaultChannelGroup: 'Organic Search', sessions: 300, totalUsers: 280, engagementRate: 0.6, keyEvents: 8 }]),
    wrap('source-medium', 'source/medium', ['sessionSourceMedium'],
      [{ sessionSourceMedium: 'google / organic', sessions: 400, totalUsers: 350, engagementRate: 0.65, keyEvents: 10 },
       { sessionSourceMedium: '(direct) / (none)', sessions: 210, totalUsers: 170, engagementRate: 0.55, keyEvents: 2 }]),
    wrap('geo-city', '市区町村', ['country', 'region', 'city'],
      [{ country: 'Japan', region: 'Osaka', city: 'Osaka', sessions: 180, engagementRate: 0.3, averageSessionDuration: 12, keyEvents: 0, totalUsers: 175 },
       { country: 'Japan', region: 'Tokyo', city: 'Shinjuku City', sessions: 90, engagementRate: 0.7, averageSessionDuration: 95, keyEvents: 2, totalUsers: 80 }]),
    wrap('device', 'デバイス', ['deviceCategory'],
      [{ deviceCategory: 'mobile', sessions: 420, totalUsers: 390, engagementRate: 0.6, averageSessionDuration: 65, keyEvents: 7 },
       { deviceCategory: 'desktop', sessions: 190, totalUsers: 160, engagementRate: 0.68, averageSessionDuration: 92, keyEvents: 5 }]),
    wrap('events', 'イベント', ['eventName'],
      [{ eventName: 'page_view', eventCount: 940, keyEvents: 0, totalUsers: 520 },
       { eventName: 'click', eventCount: 120, keyEvents: withKeyEvents ? 12 : 0, totalUsers: 95 }]),
    wrap('key-event-landing-pages', 'キーイベントLP', ['landingPagePlusQueryString', 'eventName'],
      withKeyEvents ? [{ landingPagePlusQueryString: '/', eventName: 'click', keyEvents: 12, eventCount: 120, sessions: 38 }] : []),
  ]);
}

function renderReport({ withKeyEvents = true, withComparison = true } = {}) {
  const range = { startDate: '2026-08-10', endDate: '2026-08-23' };
  const comparison = withComparison ? { startDate: '2026-07-27', endDate: '2026-08-09', label: '前期間' } : null;
  const ga4 = mockGa4(withKeyEvents);
  const gscPrev = [{ query: '英検準1級 ライティング', clicks: 4, impressions: 200, ctr: 0.02, position: 9 }];

  const gsc = {
    range,
    totals: { clicks: 65, impressions: 5300, ctr: 0.0123, position: 8.4 },
    totalsPrev: withComparison ? { clicks: 50, impressions: 4000, ctr: 0.0125, position: 9.1 } : null,
    results: {
      query: { spec: { dimensions: ['query'] }, current: { rows: queryRows }, previous: withComparison ? { rows: gscPrev } : null },
      page: { spec: { dimensions: ['page'] }, current: { rows: gscPageRows }, previous: withComparison ? { rows: gscPageRows } : null },
      'query-page': { spec: { dimensions: ['query', 'page'] }, current: { rows: gscQueryPageRows }, previous: null },
      device: { spec: { dimensions: ['device'] }, current: { rows: [{ device: 'MOBILE', clicks: 45, impressions: 4000, ctr: 0.011, position: 8.9 }] }, previous: null },
    },
  };

  const opp = extractOpportunities({
    queryCurrent: queryRows,
    queryPrevious: withComparison ? gscPrev : null,
    pageCurrent: gscPageRows,
    pagePrevious: withComparison ? gscPageRows : null,
    queryPage: gscQueryPageRows,
  });

  return buildReport({
    range, comparison, ga4, gsc,
    keyEventInfo: summarizeKeyEvents(ga4),
    combined, opp, funnel: funnelTotals(combined.rows),
  });
}

test('統合レポートが全セクションを含めて生成される', () => {
  const md = renderReport();
  for (const heading of [
    '## 1. アクセス概況', '## 2. Google 検索の状況', '## 3. 流入元', '## 4. ランディングページ',
    '## 5. 地域・デバイス', '## 6. コンバージョン', '## 7. Search Console × GA4 統合分析',
    '## 8. SEO 改善候補', '## 9. このレポートを読むうえでの制約', '## 10. Executive Summary',
  ]) {
    assert.ok(md.includes(heading), `${heading} が欠落`);
  }
  assert.ok(!md.includes('undefined'), 'undefined が出力に混入している');
  assert.ok(!md.includes('NaN'), 'NaN が出力に混入している');
  assert.ok(!md.includes('Infinity'), 'Infinity が出力に混入している');
});

test('急増・急減の外れ値を検知して表に出す', () => {
  const md = renderReport();
  assert.ok(md.includes('急増・急減の検知'));
  assert.ok(/σ/.test(md), '標準偏差での乖離が表示されるはず');
});

test('キーイベント未設定なら「分析できない」と明示する', () => {
  const md = renderReport({ withKeyEvents: false });
  assert.ok(md.includes('現在、キーイベントによるコンバージョン分析はできません'));
  assert.ok(md.includes('GA4 側の設定変更は本ツールでは行いません'));
  assert.ok(!md.includes('undefined'));
});

test('比較期間なしでも落ちず、未算出であることを明示する', () => {
  const md = renderReport({ withComparison: false });
  assert.ok(md.includes('比較期間が未指定のため算出していません'));
  assert.ok(!md.includes('undefined'));
  assert.ok(!md.includes('NaN'));
});

test('地域データに推定である旨の注意書きが入る', () => {
  const md = renderReport();
  assert.ok(md.includes('IP アドレスからの推定'));
  assert.ok(md.includes('モバイルキャリア'));
});

test('原因を断定しない表現になっている', () => {
  const md = renderReport();
  assert.ok(md.includes('候補'), '「候補」として提示されるべき');
  assert.ok(md.includes('断定しないでください') || md.includes('特定できません'));
});

test('GA4 単体レポートの Markdown が生成される', () => {
  const range = { startDate: '2026-08-10', endDate: '2026-08-23' };
  const comparison = { startDate: '2026-07-27', endDate: '2026-08-09', label: '前期間' };
  const ga4 = mockGa4(true);
  const md = summaryMarkdown(ga4, range, comparison, summarizeKeyEvents(ga4)) + detailMarkdown(ga4);
  assert.ok(md.includes('# GA4 レポート'));
  assert.ok(md.includes('## サイト全体'));
  assert.ok(md.includes('## 日次推移'));
  assert.ok(md.includes('## デバイス別'));
  assert.ok(!md.includes('undefined'));
  assert.ok(!md.includes('NaN'));
});

test('地域クロス分析の Markdown が生成される', () => {
  const crossRows = [
    { city: 'Osaka', deviceCategory: 'mobile', sessions: 170, totalUsers: 168, engagedSessions: 20, engagementRate: 0.12, keyEvents: 0 },
    { city: 'Shinjuku City', deviceCategory: 'desktop', sessions: 60, totalUsers: 52, engagedSessions: 44, engagementRate: 0.73, keyEvents: 2 },
  ];
  const md = geoCrossMarkdown({
    'cross-city-device': {
      spec: { key: 'cross-city-device', label: '市区町村 × デバイス', dimensions: ['city', 'deviceCategory'] },
      current: { rows: crossRows, hasOtherRow: false },
      previous: null,
    },
  });
  assert.ok(md.includes('地域偏りのクロス分析'));
  assert.ok(md.includes('IP アドレスからの推定'));
  assert.ok(md.includes('Osaka'));
  assert.ok(!md.includes('undefined'));
});

test('Search Console 単体レポートの Markdown が生成される', () => {
  const range = { startDate: '2026-08-08', endDate: '2026-08-21' };
  const md = gscMarkdown(
    {
      totals: { clicks: 65, impressions: 5300, ctr: 0.0123, position: 8.4 },
      totalsPrev: { clicks: 50, impressions: 4000, ctr: 0.0125, position: 9.1 },
      results: {
        query: { spec: { dimensions: ['query'] }, current: { rows: queryRows }, previous: { rows: [] } },
        page: { spec: { dimensions: ['page'] }, current: { rows: gscPageRows }, previous: { rows: [] } },
        'query-page': { spec: { dimensions: ['query', 'page'] }, current: { rows: gscQueryPageRows }, previous: null },
        date: { spec: { dimensions: ['date'] }, current: { rows: [{ date: '2026-08-20', clicks: 5, impressions: 300, ctr: 0.017, position: 8.1 }] }, previous: null },
      },
    },
    range,
    { ...range, label: '前期間' }
  );
  assert.ok(md.includes('# Search Console レポート'));
  assert.ok(md.includes('## サイト全体'));
  assert.ok(md.includes('検索クエリ別'));
  assert.ok(md.includes('一致しません'), '非開示クエリに関する注記が必要');
  assert.ok(!md.includes('undefined'));
  assert.ok(!md.includes('NaN'));
});

console.log(`\n${'─'.repeat(50)}`);
console.log(`  成功 ${passed} 件 / 失敗 ${failed} 件`);
console.log(`${'─'.repeat(50)}\n`);
if (failed > 0) process.exitCode = 1;
