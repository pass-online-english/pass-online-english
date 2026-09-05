/**
 * キーワードプランナーの検索ボリュームと、Search Console の実測を突き合わせる。
 *
 * Search Console だけでは「すでに表示されているクエリ」しか見えない。
 * 検索ボリュームを重ねることで、「需要はあるのに取れていないキーワード」
 * ＝まだ土俵に上がれていない市場が見えるようにする。
 *
 * 【前提と限界】
 * - ボリュームは広告費のないアカウントでは 50/500/5000/50000 に丸められる。
 *   絶対値ではなく、規模の桁として扱うこと。
 * - Search Console のクエリは完全一致で突き合わせている。表記ゆれや
 *   語順違いは別クエリとして扱われるため、実際にはもう少し取れている
 *   可能性がある。
 * - 「推定クリック」は順位別CTRの目安から計算した粗い値であり、
 *   保証された予測ではない。
 */
import { normalizeKeyword } from './keyword-planner.mjs';
import { expectedCtr } from './opportunities.mjs';
import { bandOf } from './rank-bands.mjs';

/** 到達目標として想定する順位。ここに入れた場合のクリック数を機会とみなす */
export const TARGET_POSITION = 5;

export const STATUS = Object.freeze({
  NOT_RANKING: '未獲得',
  BARELY: '露出のみ',
  CLOSE: 'あと一歩',
  HARVESTABLE: '刈り取り余地',
  WON: '獲得済み',
});

function classify(position) {
  if (position === null || position === undefined) return STATUS.NOT_RANKING;
  if (position <= 3) return STATUS.WON;
  if (position <= 10) return STATUS.HARVESTABLE;
  if (position <= 20) return STATUS.CLOSE;
  return STATUS.BARELY;
}

/**
 * @param {object[]} keywords キーワードプランナーの行
 * @param {object[]} gscQueryRows Search Console の query 別行
 * @param {object} opts
 * @param {number} opts.days GSC データの期間日数（月換算に使う）
 */
export function buildKeywordGap(keywords, gscQueryRows = [], { days = 28 } = {}) {
  const monthFactor = days > 0 ? 30 / days : 1;

  const gscByKey = new Map();
  for (const row of gscQueryRows) {
    const key = normalizeKeyword(row.query);
    const existing = gscByKey.get(key);
    // 同じ正規化キーに複数当たる場合は表示回数が多いほうを採用
    if (!existing || (row.impressions ?? 0) > (existing.impressions ?? 0)) gscByKey.set(key, row);
  }

  const rows = keywords.map((kw) => {
    const gsc = gscByKey.get(kw.normalized) ?? null;
    const position = gsc?.position ?? null;
    const clicksMonthly = gsc ? (gsc.clicks ?? 0) * monthFactor : 0;
    const volume = kw.volume ?? null;

    const targetCtr = expectedCtr(TARGET_POSITION);
    const potentialClicks = volume === null ? null : Math.round(volume * targetCtr);
    const opportunity = potentialClicks === null ? null : Math.max(0, Math.round(potentialClicks - clicksMonthly));

    return {
      keyword: kw.keyword,
      normalized: kw.normalized,
      volume,
      competition: kw.competition,
      threeMonthChange: kw.threeMonthChange,
      yoyChange: kw.yoyChange,

      position,
      band: position === null ? null : bandOf(position),
      impressions: gsc?.impressions ?? 0,
      clicks: gsc?.clicks ?? 0,
      ctr: gsc?.ctr ?? null,
      clicksPerMonth: Math.round(clicksMonthly),

      status: classify(position),
      /** TARGET_POSITION に入れた場合の推定クリック数（月） */
      potentialClicksPerMonth: potentialClicks,
      /** 現状との差。大きいほど取りこぼしが大きい */
      opportunityClicksPerMonth: opportunity,
      matchedInSearchConsole: Boolean(gsc),
    };
  });

  rows.sort((a, b) => (b.opportunityClicksPerMonth ?? -1) - (a.opportunityClicksPerMonth ?? -1) || (b.volume ?? 0) - (a.volume ?? 0));

  // Search Console にはあるが、キーワードリストに無いクエリ（取りこぼしの逆）
  const plannerKeys = new Set(keywords.map((k) => k.normalized));
  const unlisted = gscQueryRows
    .filter((r) => !plannerKeys.has(normalizeKeyword(r.query)))
    .sort((a, b) => b.impressions - a.impressions);

  const summary = {
    keywordCount: rows.length,
    matchedCount: rows.filter((r) => r.matchedInSearchConsole).length,
    notRankingCount: rows.filter((r) => r.status === STATUS.NOT_RANKING).length,
    totalVolume: rows.reduce((s, r) => s + (r.volume ?? 0), 0),
    capturedVolume: rows.filter((r) => r.matchedInSearchConsole).reduce((s, r) => s + (r.volume ?? 0), 0),
    totalOpportunity: rows.reduce((s, r) => s + (r.opportunityClicksPerMonth ?? 0), 0),
    unlistedQueryCount: unlisted.length,
  };
  summary.captureRate = summary.totalVolume ? summary.capturedVolume / summary.totalVolume : null;

  return { rows, unlisted, summary, targetPosition: TARGET_POSITION, days };
}

/** ボリューム帯ごとの獲得状況をまとめる */
export function volumeBuckets(rows) {
  const buckets = [
    { key: '50000+', label: '5万以上', min: 50000 },
    { key: '5000+', label: '5,000〜', min: 5000 },
    { key: '500+', label: '500〜', min: 500 },
    { key: '1+', label: '500未満', min: 0 },
  ];
  return buckets.map((b, i) => {
    const max = i === 0 ? Infinity : buckets[i - 1].min;
    const inBucket = rows.filter((r) => (r.volume ?? 0) >= b.min && (r.volume ?? 0) < max);
    return {
      ...b,
      keywords: inBucket.length,
      captured: inBucket.filter((r) => r.matchedInSearchConsole).length,
      notRanking: inBucket.filter((r) => r.status === STATUS.NOT_RANKING).length,
      totalVolume: inBucket.reduce((s, r) => s + (r.volume ?? 0), 0),
    };
  });
}
