/**
 * 比較ロジック。
 *  A. 店頭価格メモ × ネットスーパー価格 → 「ネットで買っていいもの」の選別
 *  B. 前回スナップショット × 今回 → 値上がり / 値下がり / 新登場 / 消えた
 *
 * どちらも突き合わせは商品名。表記ゆれがあるため完全一致→包含→類似度の順で、
 * 閾値未満は「一致なし」にする（誤った組み合わせで判断するほうが害が大きい）。
 */
import { bestMatch, nameKey } from './price.mjs';

/** 判定の区分。 */
export const VERDICT = {
  CHEAPER: 'ネットが安い',
  SAME: 'ほぼ同じ',
  PRICIER: 'ネットが高い',
  SOLD_OUT: '売り切れ',
  NO_MATCH: 'ネットに見つからず',
};

/**
 * 店頭価格メモの各行に、ネットスーパー側の価格を突き合わせる。
 * tolerancePct（比率）と toleranceYen（円）のどちらかに収まれば「ほぼ同じ」。
 */
export function compareToStore(storeItems, netItems, { tolerancePct = 0.1, toleranceYen = 20, threshold = 0.6 } = {}) {
  const priced = netItems.filter((i) => typeof i.price === 'number');
  const results = [];
  for (const s of storeItems) {
    const m = bestMatch(s.name, priced, { threshold });
    if (!m) {
      results.push({ ...s, verdict: VERDICT.NO_MATCH, netPrice: null, diff: null, diffPct: null, matchScore: null });
      continue;
    }
    const net = m.item;
    const diff = net.price - s.storePrice;
    const diffPct = s.storePrice > 0 ? diff / s.storePrice : null;
    const within =
      Math.abs(diff) <= toleranceYen || (diffPct !== null && Math.abs(diffPct) <= tolerancePct);
    let verdict;
    if (net.soldOut) verdict = VERDICT.SOLD_OUT;
    else if (within) verdict = VERDICT.SAME;
    else if (diff < 0) verdict = VERDICT.CHEAPER;
    else verdict = VERDICT.PRICIER;
    results.push({
      ...s,
      verdict,
      netName: net.name,
      netPrice: net.price,
      netUnit: net.unit || '',
      netUrl: net.url || '',
      category: net.category || '',
      diff,
      diffPct,
      matchScore: Number(m.score.toFixed(2)),
    });
  }
  return results;
}

/** 買い物リストに載せる行（安い or ほぼ同じ、かつ在庫あり）。 */
export function buyOnline(results) {
  return results
    .filter((r) => r.verdict === VERDICT.CHEAPER || r.verdict === VERDICT.SAME)
    .sort((a, b) => (a.diff ?? 0) - (b.diff ?? 0));
}

/** 商品の同一判定キー。URL があれば URL、なければ正規化した商品名。 */
function itemKey(item) {
  return item.url ? `u:${item.url}` : `n:${nameKey(item.name)}`;
}

/**
 * 前回と今回のスナップショットを比べる。
 * 価格が変わったもの・消えたもの・増えたものを返す。
 */
export function compareSnapshots(prevItems, currItems, { minChangeYen = 1 } = {}) {
  const prev = new Map();
  for (const p of prevItems) if (typeof p.price === 'number') prev.set(itemKey(p), p);
  const curr = new Map();
  for (const c of currItems) if (typeof c.price === 'number') curr.set(itemKey(c), c);

  const changed = [];
  const added = [];
  for (const [k, c] of curr) {
    const p = prev.get(k);
    if (!p) { added.push(c); continue; }
    const diff = c.price - p.price;
    if (Math.abs(diff) >= minChangeYen) {
      changed.push({
        name: c.name,
        category: c.category || '',
        prevPrice: p.price,
        price: c.price,
        diff,
        diffPct: p.price > 0 ? diff / p.price : null,
        url: c.url || '',
      });
    }
  }
  const removed = [...prev.entries()].filter(([k]) => !curr.has(k)).map(([, p]) => p);
  changed.sort((a, b) => a.diff - b.diff);
  return { changed, added, removed, prevCount: prev.size, currCount: curr.size };
}
