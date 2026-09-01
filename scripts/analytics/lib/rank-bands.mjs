/**
 * 順位帯別の分布と、前期間からの移動。
 *
 * 「SEO ができているか」を判断するとき、クリック数だけを見ると
 * 単発の流入や季節変動に振り回される。順位帯ごとにクエリが
 * どう分布し、前期間からどちらへ動いたかを見るほうが、
 * 検索エンジンからの評価の変化を素直に反映する。
 *
 * 【注意】Search Console の掲載順位は表示回数で重み付けされた平均値。
 * 表示回数が少ないクエリの順位は変動が大きく、帯をまたぐ動きが
 * 実際の評価変化とは限らない。
 */

export const RANK_BANDS = Object.freeze([
  { key: '1-3', label: '1〜3位', note: '上位表示。クリックが取れる位置' },
  { key: '4-10', label: '4〜10位', note: '1ページ目。改善の回収効率が最も高い' },
  { key: '11-20', label: '11〜20位', note: '2ページ目。あと一歩' },
  { key: '21-50', label: '21〜50位', note: '露出はごくわずか' },
  { key: '51+', label: '51位以下', note: '実質的に見られていない' },
]);

const BAND_INDEX = new Map(RANK_BANDS.map((b, i) => [b.key, i]));

/** 平均掲載順位から順位帯を返す。順位が無い（圏外）場合は null。 */
export function bandOf(position) {
  if (!Number.isFinite(position) || position <= 0) return null;
  if (position <= 3) return '1-3';
  if (position <= 10) return '4-10';
  if (position <= 20) return '11-20';
  if (position <= 50) return '21-50';
  return '51+';
}

export function bandLabel(key) {
  return RANK_BANDS.find((b) => b.key === key)?.label ?? key;
}

/**
 * 順位帯ごとの集計。
 * @param {object[]} rows Search Console の query 別（または page 別）行
 */
export function rankDistribution(rows = []) {
  const buckets = new Map(
    RANK_BANDS.map((b) => [b.key, { ...b, queries: 0, impressions: 0, clicks: 0, positionWeighted: 0 }])
  );

  let unranked = 0;
  for (const row of rows) {
    const key = bandOf(row.position);
    if (!key) {
      unranked += 1;
      continue;
    }
    const bucket = buckets.get(key);
    bucket.queries += 1;
    bucket.impressions += row.impressions ?? 0;
    bucket.clicks += row.clicks ?? 0;
    bucket.positionWeighted += (row.position ?? 0) * (row.impressions ?? 0);
  }

  const bands = [...buckets.values()].map((b) => ({
    key: b.key,
    label: b.label,
    note: b.note,
    queries: b.queries,
    impressions: b.impressions,
    clicks: b.clicks,
    ctr: b.impressions ? b.clicks / b.impressions : null,
    avgPosition: b.impressions ? b.positionWeighted / b.impressions : null,
  }));

  const totals = {
    queries: bands.reduce((s, b) => s + b.queries, 0),
    impressions: bands.reduce((s, b) => s + b.impressions, 0),
    clicks: bands.reduce((s, b) => s + b.clicks, 0),
    unranked,
  };
  totals.ctr = totals.impressions ? totals.clicks / totals.impressions : null;

  for (const b of bands) {
    b.impressionShare = totals.impressions ? b.impressions / totals.impressions : null;
    b.queryShare = totals.queries ? b.queries / totals.queries : null;
  }

  /** 1ページ目（10位以内）に入っているクエリ数。SEO 進捗の見出し指標 */
  totals.topTenQueries = bands.filter((b) => b.key === '1-3' || b.key === '4-10').reduce((s, b) => s + b.queries, 0);
  totals.topTenImpressions = bands
    .filter((b) => b.key === '1-3' || b.key === '4-10')
    .reduce((s, b) => s + b.impressions, 0);

  return { bands, totals };
}

/**
 * 前期間からの順位帯の移動。
 * @param {object[]} currentRows
 * @param {object[]} previousRows
 * @param {string} dim 'query' または 'page'
 */
export function rankTransitions(currentRows = [], previousRows = [], dim = 'query') {
  const prev = new Map(previousRows.map((r) => [String(r[dim]), r]));
  const curr = new Map(currentRows.map((r) => [String(r[dim]), r]));

  const improved = [];
  const declined = [];
  const unchanged = [];
  const entered = [];
  const exited = [];

  for (const row of currentRows) {
    const key = String(row[dim]);
    const before = prev.get(key);
    const bandAfter = bandOf(row.position);

    if (!before) {
      entered.push({
        [dim]: row[dim],
        band: bandAfter,
        position: row.position,
        impressions: row.impressions,
        clicks: row.clicks,
      });
      continue;
    }

    const bandBefore = bandOf(before.position);
    const item = {
      [dim]: row[dim],
      band_prev: bandBefore,
      band: bandAfter,
      position_prev: before.position,
      position: row.position,
      // 順位は小さいほど良いので、改善を正の値にする
      positionGain: before.position - row.position,
      impressions_prev: before.impressions,
      impressions: row.impressions,
      clicks_prev: before.clicks,
      clicks: row.clicks,
    };

    const from = BAND_INDEX.get(bandBefore);
    const to = BAND_INDEX.get(bandAfter);
    if (from === undefined || to === undefined) unchanged.push(item);
    else if (to < from) improved.push(item);
    else if (to > from) declined.push(item);
    else unchanged.push(item);
  }

  for (const row of previousRows) {
    if (curr.has(String(row[dim]))) continue;
    exited.push({
      [dim]: row[dim],
      band_prev: bandOf(row.position),
      position_prev: row.position,
      impressions_prev: row.impressions,
      clicks_prev: row.clicks,
    });
  }

  improved.sort((a, b) => b.positionGain - a.positionGain || b.impressions - a.impressions);
  declined.sort((a, b) => a.positionGain - b.positionGain || b.impressions_prev - a.impressions_prev);
  entered.sort((a, b) => b.impressions - a.impressions);
  exited.sort((a, b) => b.impressions_prev - a.impressions_prev);

  const currentDist = rankDistribution(currentRows);
  const previousDist = rankDistribution(previousRows);

  return {
    improved,
    declined,
    unchanged,
    entered,
    exited,
    summary: {
      improvedCount: improved.length,
      declinedCount: declined.length,
      unchangedCount: unchanged.length,
      enteredCount: entered.length,
      exitedCount: exited.length,
      topTenQueries: currentDist.totals.topTenQueries,
      topTenQueries_prev: previousDist.totals.topTenQueries,
      topTenQueriesDelta: currentDist.totals.topTenQueries - previousDist.totals.topTenQueries,
      totalQueries: currentDist.totals.queries,
      totalQueries_prev: previousDist.totals.queries,
    },
    currentDistribution: currentDist,
    previousDistribution: previousDist,
  };
}

/**
 * 帯ごとの前期間比を並べた表を作る（Markdown 用）。
 */
export function distributionComparison(currentDist, previousDist) {
  const prevByKey = new Map((previousDist?.bands ?? []).map((b) => [b.key, b]));
  return currentDist.bands.map((b) => {
    const p = prevByKey.get(b.key);
    return {
      ...b,
      queries_prev: p?.queries ?? null,
      queriesDelta: p ? b.queries - p.queries : null,
      impressions_prev: p?.impressions ?? null,
      impressionsDelta: p ? b.impressions - p.impressions : null,
      clicks_prev: p?.clicks ?? null,
      clicksDelta: p ? b.clicks - p.clicks : null,
    };
  });
}
