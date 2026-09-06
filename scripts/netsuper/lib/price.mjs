/**
 * 価格文字列と商品名の正規化。
 *
 * ネットスーパーの価格表示は店舗・カテゴリで揺れる（「本体 298円（税込321円）」
 * 「100gあたり 158円」など）ため、**数値をすべて拾ってから選ぶ** 方針を取る。
 * 断定できない場合は raw を残し、後から人が確認できるようにする。
 */

/** 全角→半角、記号ゆらぎの吸収。 */
export function normalizeText(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 文字列から「円 / ¥ が付いた数値」をすべて抜き出す。
 * 単位付き（100gあたり等）は unitPrice フラグを立てて区別する。
 */
export function extractPrices(text) {
  const t = normalizeText(text);
  const out = [];
  const re = /(?:¥\s*([0-9][0-9,]*)|([0-9][0-9,]*)\s*円)/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const value = Number((m[1] ?? m[2]).replace(/,/g, ''));
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000) continue;
    const before = t.slice(Math.max(0, m.index - 14), m.index);
    out.push({
      value,
      taxIncluded: /税込/.test(before) || /税込/.test(t.slice(re.lastIndex, re.lastIndex + 6)),
      taxExcluded: /(本体|税抜|税別)/.test(before),
      unitPrice: /(あたり|当り|当たり|\/\s*(?:100)?\s*(?:g|ml|kg|l))\s*$/i.test(before),
    });
  }
  return out;
}

/**
 * 表示価格を1つに決める。
 *  1. 「税込」と明示された値
 *  2. 単位あたり価格でない値のうち最大（税込は税抜以上になるため）
 *  3. どれも取れなければ null
 * 判断材料を残すため candidates と raw も返す。
 */
export function pickPrice(text) {
  const raw = normalizeText(text);
  const cands = extractPrices(raw);
  const body = cands.filter((c) => !c.unitPrice);
  const pool = body.length ? body : cands;
  if (!pool.length) return { price: null, priceKind: 'unknown', candidates: [], priceRaw: raw };

  const taxIn = pool.filter((c) => c.taxIncluded);
  if (taxIn.length) {
    return {
      price: Math.max(...taxIn.map((c) => c.value)),
      priceKind: 'tax_included',
      candidates: pool.map((c) => c.value),
      priceRaw: raw,
    };
  }
  const price = Math.max(...pool.map((c) => c.value));
  const kind = pool.length > 1 ? 'max_of_multiple' : 'single';
  return { price, priceKind: kind, candidates: pool.map((c) => c.value), priceRaw: raw };
}

/** 内容量・入数らしき表記（「300g」「6個入」など）。見つからなければ ''。 */
export function extractUnit(text) {
  const t = normalizeText(text);
  // \b は ASCII の単語境界しか見ないため、「10個入」のような日本語の単位では使えない
  const m = t.match(/(\d+(?:\.\d+)?)\s*(kg|g|ml|リットル|L|個入|個|本入|本|枚入|枚|袋入|袋|パック|尾|玉|束|缶|P)/i);
  return m ? m[0] : '';
}

/**
 * 商品名の突き合わせ用キー。
 * 記号・空白・容量表記を落として比較しやすくする（表示名はそのまま保持する）。
 */
export function nameKey(s) {
  return normalizeText(s)
    .toLowerCase()
    .replace(/[【】\[\]（）()《》<>「」『』]/g, ' ')
    .replace(/[!-\/:-@\[-`{-~、。・,．]/g, ' ')
    .replace(/\s+/g, '');
}

/** 2文字組（bigram）集合。1文字語も拾えるよう、短い語は文字集合にフォールバック。 */
function bigrams(s) {
  if (s.length <= 2) return new Set([s]);
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

/** Jaccard 類似度（0〜1）。 */
export function similarity(a, b) {
  const A = bigrams(nameKey(a));
  const B = bigrams(nameKey(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 商品名で最も近い候補を返す。
 * 完全一致 → 包含 → 類似度の順。閾値未満は null（誤マッチのほうが害が大きい）。
 */
export function bestMatch(name, candidates, { threshold = 0.6 } = {}) {
  const key = nameKey(name);
  if (!key) return null;

  let best = null;
  for (const c of candidates) {
    const ck = nameKey(c.name ?? c);
    if (!ck) continue;
    let score;
    if (ck === key) score = 1;
    else if (ck.includes(key) || key.includes(ck)) score = 0.9;
    else score = similarity(key, ck);
    if (!best || score > best.score) best = { item: c, score };
  }
  return best && best.score >= threshold ? best : null;
}
