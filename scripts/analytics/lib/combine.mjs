/**
 * GA4 と Search Console のページ単位での突き合わせ。
 *
 * 【方針】ユーザー単位の結合は行わない。
 *  - Search Console: Google 検索での「表示・クリック」を測る
 *  - GA4: サイトに到達したあとの行動を測る
 * 両者は母数の定義もサンプリングも異なるため、共通のキー（ページURL）
 * ごとの集計値を並べて見るところまでに留める。
 * クリック数とセッション数が一致しないのは正常であり、その差自体
 * （直帰前の離脱、計測タグ未設置、リダイレクト等）が示唆になる。
 */
import { pageKey, absoluteUrl, joinCoverage } from './urls.mjs';

/**
 * @param {object[]} gscPageRows   Search Console の page 別行
 * @param {object[]} ga4LandingRows GA4 の landingPage 別行
 * @param {object[]} ga4PageRows    GA4 の pagePath 別行
 * @param {object[]} gscQueryPageRows Search Console の query×page 行
 */
export function combineByPage({ gscPageRows = [], ga4LandingRows = [], ga4PageRows = [], gscQueryPageRows = [] } = {}) {
  const landingDim = ga4LandingRows.length
    ? Object.keys(ga4LandingRows[0]).find((k) => k.startsWith('landingPage')) ?? 'landingPagePlusQueryString'
    : 'landingPagePlusQueryString';

  const gscByKey = new Map();
  for (const r of gscPageRows) {
    const key = pageKey(r.page);
    const acc = gscByKey.get(key) ?? { key, clicks: 0, impressions: 0, positionWeighted: 0, urls: new Set() };
    acc.clicks += r.clicks;
    acc.impressions += r.impressions;
    acc.positionWeighted += r.position * r.impressions;
    acc.urls.add(r.page);
    gscByKey.set(key, acc);
  }

  const landingByKey = new Map();
  for (const r of ga4LandingRows) {
    const key = pageKey(r[landingDim]);
    const acc = landingByKey.get(key) ?? {
      key, sessions: 0, totalUsers: 0, engagedSessions: 0, keyEvents: 0, userEngagementDuration: 0,
    };
    acc.sessions += r.sessions ?? 0;
    acc.totalUsers += r.totalUsers ?? 0;
    acc.engagedSessions += r.engagedSessions ?? 0;
    acc.keyEvents += r.keyEvents ?? 0;
    acc.userEngagementDuration += r.userEngagementDuration ?? 0;
    landingByKey.set(key, acc);
  }

  const viewsByKey = new Map();
  for (const r of ga4PageRows) {
    const key = pageKey(r.pagePath);
    const acc = viewsByKey.get(key) ?? { key, screenPageViews: 0, pageTitle: r.pageTitle ?? '' };
    acc.screenPageViews += r.screenPageViews ?? 0;
    if (!acc.pageTitle) acc.pageTitle = r.pageTitle ?? '';
    viewsByKey.set(key, acc);
  }

  const queriesByKey = new Map();
  for (const r of gscQueryPageRows) {
    const key = pageKey(r.page);
    if (!queriesByKey.has(key)) queriesByKey.set(key, []);
    queriesByKey.get(key).push({ query: r.query, clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position });
  }

  const allKeys = new Set([...gscByKey.keys(), ...landingByKey.keys(), ...viewsByKey.keys()]);
  const rows = [];
  for (const key of allKeys) {
    const g = gscByKey.get(key);
    const l = landingByKey.get(key);
    const v = viewsByKey.get(key);
    const topQueries = (queriesByKey.get(key) ?? []).sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions);

    rows.push({
      pageKey: key,
      url: absoluteUrl(key),
      pageTitle: v?.pageTitle ?? '',

      // Search Console（検索での見え方）
      impressions: g?.impressions ?? 0,
      clicks: g?.clicks ?? 0,
      ctr: g && g.impressions ? g.clicks / g.impressions : 0,
      position: g && g.impressions ? g.positionWeighted / g.impressions : null,

      // GA4（到達後の行動）
      sessions: l?.sessions ?? 0,
      users: l?.totalUsers ?? 0,
      engagedSessions: l?.engagedSessions ?? 0,
      engagementRate: l && l.sessions ? l.engagedSessions / l.sessions : null,
      avgEngagementSeconds: l && l.sessions ? l.userEngagementDuration / l.sessions : null,
      keyEvents: l?.keyEvents ?? 0,
      pageViews: v?.screenPageViews ?? 0,

      // ファネル指標
      /** 検索クリック → GA4 セッションの到達率。1 から大きく外れる場合は計測差の確認が必要 */
      clickToSessionRatio: g && g.clicks > 0 ? (l?.sessions ?? 0) / g.clicks : null,
      /** LP セッション → キーイベント率 */
      sessionToKeyEventRate: l && l.sessions > 0 ? l.keyEvents / l.sessions : null,
      /** 検索表示 → キーイベントまでの通し率 */
      impressionToKeyEventRate: g && g.impressions > 0 ? (l?.keyEvents ?? 0) / g.impressions : null,

      topQueries: topQueries.slice(0, 10),
      matchedIn: [g ? 'gsc' : null, l ? 'ga4-landing' : null, v ? 'ga4-page' : null].filter(Boolean),
    });
  }

  const coverage = joinCoverage([...landingByKey.keys()], [...gscByKey.keys()]);

  return {
    rows: rows.sort((a, b) => b.clicks - a.clicks || b.sessions - a.sessions),
    coverage: {
      matchedPages: coverage.matched.length,
      gscOnlyPages: coverage.gscOnly.length,
      ga4OnlyPages: coverage.ga4Only.length,
      matchRate: coverage.matchRate,
      gscOnlySamples: coverage.gscOnly.slice(0, 10),
      ga4OnlySamples: coverage.ga4Only.slice(0, 10),
    },
    landingDimensionUsed: landingDim,
  };
}

/**
 * 「検索では表示されているがクリックされていない」ページ
 */
export function impressionsWithoutClicks(rows, { minImpressions = 30 } = {}) {
  return rows
    .filter((r) => r.impressions >= minImpressions)
    .map((r) => ({ ...r, missedImpressions: r.impressions - r.clicks }))
    .filter((r) => r.ctr < 0.02)
    .sort((a, b) => b.impressions - a.impressions);
}

/**
 * 「Google から流入しているが、その後の行動が悪い」ページ
 * 到達はしているのにエンゲージメントが低い＝内容やページ体験の見直し候補
 */
export function trafficWithPoorBehavior(rows, { minSessions = 10, engagementRateThreshold = 0.4 } = {}) {
  return rows
    .filter((r) => r.clicks > 0 && r.sessions >= minSessions)
    .filter((r) => r.engagementRate !== null && r.engagementRate < engagementRateThreshold)
    .sort((a, b) => b.sessions - a.sessions);
}

/**
 * ファネル集計: 検索表示 → クリック → セッション → エンゲージ → キーイベント
 */
export function funnelTotals(rows) {
  const sum = (k) => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const impressions = sum('impressions');
  const clicks = sum('clicks');
  const sessions = sum('sessions');
  const engaged = sum('engagedSessions');
  const keyEvents = sum('keyEvents');
  return {
    impressions,
    clicks,
    sessions,
    engagedSessions: engaged,
    keyEvents,
    ctr: impressions ? clicks / impressions : null,
    clickToSession: clicks ? sessions / clicks : null,
    sessionToEngaged: sessions ? engaged / sessions : null,
    engagedToKeyEvent: engaged ? keyEvents / engaged : null,
    impressionToKeyEvent: impressions ? keyEvents / impressions : null,
  };
}
