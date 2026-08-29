/**
 * GA4 で取得するレポート定義。
 *
 * ここを唯一の定義元にして、`npm run analytics:schema` がこの一覧を
 * プロパティのメタデータと突き合わせて検証する。
 *
 * 【GA4 API の制約】
 *  - 1リクエストあたり dimension 最大9・metric 最大10
 *    （超えた場合は ga4-client.mjs が自動的に複数リクエストへ分割する）
 *  - ディメンションの組み合わせが多いとカーディナリティ上限で (other) 行に丸められる
 * そのため、地域の偏りを見るクロス分析は「city × 1〜2項目」に分割して複数クエリで取得する。
 */

/** サイト全体・時系列で使う中心指標 */
/**
 * GA4 は 1リクエストあたり指標10個までのため、ここは10個を超えないこと。
 * 直帰率（bounceRate）は GA4 の定義上ちょうど 1 − engagementRate なので、
 * API では取得せず normalize() で算出している（1枠を節約するため）。
 */
export const CORE_METRICS = [
  'totalUsers',
  'newUsers',
  'sessions',
  'engagedSessions',
  'engagementRate',
  'screenPageViews',
  'averageSessionDuration',
  'userEngagementDuration',
  'eventCount',
  'keyEvents',
];

/** ページ・LP・流入元などの明細で使う指標（10個以内に収める） */
export const BREAKDOWN_METRICS = [
  'sessions',
  'totalUsers',
  'newUsers',
  'engagedSessions',
  'engagementRate',
  'screenPageViews',
  'averageSessionDuration',
  'userEngagementDuration',
  'keyEvents',
];

/** クロス分析用の軽量な指標セット */
export const CROSS_METRICS = ['sessions', 'totalUsers', 'engagedSessions', 'engagementRate', 'keyEvents'];

/**
 * レポート定義。
 * key: 出力ファイル名 / label: 表示名 / dimensions / metrics / limit / group
 */
export const GA4_REPORTS = [
  {
    key: 'summary',
    label: 'サイト全体サマリー',
    group: 'overview',
    dimensions: [],
    metrics: CORE_METRICS,
    limit: 1,
  },
  {
    key: 'daily',
    label: '日次推移',
    group: 'overview',
    dimensions: ['date'],
    metrics: CORE_METRICS,
    orderBys: [{ dimension: { dimensionName: 'date' }, desc: false }],
    limit: 400,
  },
  {
    key: 'pages',
    label: 'ページ別',
    group: 'content',
    dimensions: ['pagePath', 'pageTitle'],
    metrics: BREAKDOWN_METRICS,
    limit: 500,
  },
  {
    key: 'landing-pages',
    label: 'ランディングページ別',
    group: 'content',
    dimensions: ['landingPagePlusQueryString'],
    metrics: BREAKDOWN_METRICS,
    limit: 500,
  },
  {
    key: 'channels',
    label: 'チャネル別（Organic Search / Direct / Referral など）',
    group: 'acquisition',
    dimensions: ['sessionDefaultChannelGroup'],
    metrics: BREAKDOWN_METRICS,
    limit: 100,
  },
  {
    key: 'source-medium',
    label: 'source / medium 別',
    group: 'acquisition',
    dimensions: ['sessionSourceMedium'],
    metrics: BREAKDOWN_METRICS,
    limit: 200,
  },
  {
    key: 'source-medium-detail',
    label: 'source / medium / チャネル 別',
    group: 'acquisition',
    dimensions: ['sessionSource', 'sessionMedium', 'sessionDefaultChannelGroup'],
    metrics: CROSS_METRICS,
    limit: 300,
  },
  {
    key: 'geo-country',
    label: '国別',
    group: 'geo',
    dimensions: ['country'],
    metrics: BREAKDOWN_METRICS,
    limit: 200,
  },
  {
    key: 'geo-region',
    label: '地域（都道府県）別',
    group: 'geo',
    dimensions: ['country', 'region'],
    metrics: BREAKDOWN_METRICS,
    limit: 300,
  },
  {
    key: 'geo-city',
    label: '市区町村別',
    group: 'geo',
    dimensions: ['country', 'region', 'city'],
    metrics: BREAKDOWN_METRICS,
    limit: 500,
  },
  {
    key: 'device',
    label: 'デバイスカテゴリ別',
    group: 'tech',
    dimensions: ['deviceCategory'],
    metrics: BREAKDOWN_METRICS,
    limit: 20,
  },
  {
    key: 'device-detail',
    label: 'デバイス × ブラウザ × OS',
    group: 'tech',
    dimensions: ['deviceCategory', 'browser', 'operatingSystem'],
    metrics: CROSS_METRICS,
    limit: 300,
  },
  {
    key: 'events',
    label: 'イベント別（キーイベント判定用）',
    group: 'conversion',
    dimensions: ['eventName'],
    metrics: ['eventCount', 'keyEvents', 'totalUsers'],
    limit: 300,
  },
  {
    key: 'outbound-clicks',
    label: '外部リンククリック（問い合わせ導線の代替指標）',
    group: 'conversion',
    /**
     * 問い合わせ導線が外部サイト（Googleフォーム / LINE）への遷移である場合、
     * 送信完了は GA4 では計測できない。計測できる最後の地点が
     * 拡張計測機能の「離脱クリック」= click イベントなので、
     * どのページからどの外部ドメインへ遷移したかを取得する。
     */
    dimensions: ['linkDomain', 'linkUrl', 'pagePath'],
    metrics: ['eventCount', 'totalUsers', 'sessions'],
    dimensionFilter: {
      filter: { fieldName: 'eventName', stringFilter: { matchType: 'EXACT', value: 'click' } },
    },
    limit: 300,
  },
  {
    key: 'key-event-landing-pages',
    label: 'キーイベントが発生したランディングページ',
    group: 'conversion',
    dimensions: ['landingPagePlusQueryString', 'eventName'],
    metrics: ['keyEvents', 'eventCount', 'sessions'],
    limit: 500,
  },
];

/**
 * 地域の偏りを検証するためのクロス分析。
 * 一度に全部を組み合わせると (other) 行に丸められるため、意図的に分割する。
 */
export const GA4_GEO_CROSS_REPORTS = [
  {
    key: 'cross-city-device',
    label: '市区町村 × デバイス',
    dimensions: ['city', 'deviceCategory'],
    metrics: CROSS_METRICS,
    limit: 800,
  },
  {
    key: 'cross-city-browser',
    label: '市区町村 × ブラウザ',
    dimensions: ['city', 'browser'],
    metrics: CROSS_METRICS,
    limit: 800,
  },
  {
    key: 'cross-city-source-medium',
    label: '市区町村 × source / medium',
    dimensions: ['city', 'sessionSourceMedium'],
    metrics: CROSS_METRICS,
    limit: 800,
  },
  {
    key: 'cross-city-landing-page',
    label: '市区町村 × ランディングページ',
    dimensions: ['city', 'landingPagePlusQueryString'],
    metrics: CROSS_METRICS,
    limit: 800,
  },
  {
    key: 'cross-city-device-source',
    label: '市区町村 × デバイス × source / medium',
    dimensions: ['city', 'deviceCategory', 'sessionSourceMedium'],
    metrics: CROSS_METRICS,
    limit: 1000,
  },
  {
    key: 'cross-city-os-browser',
    label: '市区町村 × OS × ブラウザ',
    dimensions: ['city', 'operatingSystem', 'browser'],
    metrics: CROSS_METRICS,
    limit: 1000,
  },
];

/** schema-check 用: 使用している全フィールド名 */
export function allFieldNames() {
  const dims = new Set();
  const mets = new Set();
  for (const r of [...GA4_REPORTS, ...GA4_GEO_CROSS_REPORTS]) {
    r.dimensions.forEach((d) => dims.add(d));
    r.metrics.forEach((m) => mets.add(m));
  }
  return { dimensions: [...dims].sort(), metrics: [...mets].sort() };
}
