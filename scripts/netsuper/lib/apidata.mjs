/**
 * アプリがサーバから受け取った JSON から商品を拾う。
 *
 * Flutter などで作られたアプリは画面をキャンバスに描画するため、HTML には
 * 商品が存在しない。一方で商品データは API から JSON で届いているので、
 * 「アプリが受け取ったもの」をそのまま読むほうが確実に取れる。
 *
 * API の形は店舗ごとに違うので、キー名を決め打ちしない。
 * 「名前らしき文字列」と「価格らしき数値」を併せ持つオブジェクトを商品とみなす。
 */
import { normalizeText, extractUnit } from './price.mjs';

const NAME_KEYS =
  /^(name|title|label|商品名|品名|(product|item|goods|display|full|short)_?(name|title))$/i;
const PRICE_KEYS = /(price|amount|kakaku|価格|値段)/i;
const TAX_INCLUDED_KEYS = /(tax_?included|include[_]?tax|zeikomi|including_?tax|税込)/i;
const TAX_EXCLUDED_KEYS = /(tax_?excluded|exclude[_]?tax|without_?tax|body_?price|税抜|本体)/i;
const UNIT_KEYS = /(unit|volume|capacity|size|quantity|weight|内容量|規格)$/i;
const SOLD_OUT_KEYS = /(sold_?out|out_?of_?stock|品切|売切)/i;
const IN_STOCK_KEYS = /(in_?stock|is_?available|purchasable|orderable)/i;
const STOCK_COUNT_KEYS = /(stock|inventory|zaiko)/i;
const URL_LIKE = /^(https?:|data:|\/\/)/i;

const MAX_PRICE = 1_000_000;

/** 数値として読めるなら数値を返す。オブジェクトなら中の金額らしき値を探す。 */
export function toAmount(value, depth = 0) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = normalizeText(value).replace(/[,¥円\s]/g, '');
    if (!/^\d+(\.\d+)?$/.test(s)) return null;
    return Number(s);
  }
  if (value && typeof value === 'object' && depth < 3) {
    const entries = Object.entries(value);
    // price: { taxIncluded: 198, taxExcluded: 183 } の形は税込を採る
    for (const [k, v] of entries) {
      if (!TAX_INCLUDED_KEYS.test(k)) continue;
      const n = toAmount(v, depth + 1);
      if (n !== null) return n;
    }
    // { amount: 298, currency: "JPY" } の形
    for (const [k, v] of entries) {
      if (!/(amount|value|price|gross|total)/i.test(k)) continue;
      const n = toAmount(v, depth + 1);
      if (n !== null) return n;
    }
    // 項目名が想定外でも、金額として使える数値が1つだけならそれを使う
    const numbers = entries
      .filter(([k]) => !/(id|count|quantity|decimal|digit|rate|ratio|percent)/i.test(k))
      .map(([, v]) => toAmount(v, depth + 1))
      .filter((n) => n !== null && n > 0);
    if (numbers.length === 1) return numbers[0];
  }
  return null;
}

function plausiblePrice(n) {
  return typeof n === 'number' && Number.isFinite(n) && n > 0 && n <= MAX_PRICE;
}

/** オブジェクト1つを商品として読めるなら読む。読めなければ null。 */
function readProduct(obj) {
  let name = '';
  const prices = [];
  let unit = '';
  let soldOut = false;
  let id = '';

  for (const [key, value] of Object.entries(obj)) {
    if (!name && NAME_KEYS.test(key) && typeof value === 'string') {
      const t = normalizeText(value);
      if (t && t.length <= 120 && !URL_LIKE.test(t)) name = t;
    }
    if (PRICE_KEYS.test(key)) {
      const n = toAmount(value);
      if (plausiblePrice(n)) prices.push({ key, value: n });
    }
    if (!unit && UNIT_KEYS.test(key) && typeof value === 'string') unit = normalizeText(value);
    if (SOLD_OUT_KEYS.test(key) && value === true) soldOut = true;
    if (IN_STOCK_KEYS.test(key) && value === false) soldOut = true;
    if (STOCK_COUNT_KEYS.test(key) && typeof value === 'number' && value <= 0) soldOut = true;
    if (!id && /^(id|sku|code|jan)$/i.test(key) && (typeof value === 'string' || typeof value === 'number')) {
      id = String(value);
    }
  }
  if (!name || !prices.length) return null;

  // 税込が明示されていればそれを、なければ税抜と明示されていないものを優先する
  const taxIn = prices.filter((p) => TAX_INCLUDED_KEYS.test(p.key));
  const neutral = prices.filter((p) => !TAX_EXCLUDED_KEYS.test(p.key));
  const pool = taxIn.length ? taxIn : neutral.length ? neutral : prices;
  const price = Math.max(...pool.map((p) => p.value));
  const priceKind = taxIn.length ? 'tax_included' : prices.length > 1 ? 'max_of_multiple' : 'single';

  return {
    id,
    name,
    price,
    priceKind,
    candidates: [...new Set(prices.map((p) => p.value))].sort((a, b) => a - b),
    unit: unit || extractUnit(name),
    soldOut,
  };
}

/**
 * JSON を丸ごと歩いて商品を集める。
 * 入れ子（edges/node、items[] など）の形を問わない。
 */
export function extractProducts(json, { maxNodes = 200_000 } = {}) {
  const found = [];
  let visited = 0;

  const walk = (node) => {
    if (visited > maxNodes || node === null || typeof node !== 'object') return;
    visited += 1;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const product = readProduct(node);
    if (product) found.push(product);
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
    }
  };
  walk(json);
  return found;
}

/**
 * 同じ商品を1件にまとめる。
 * id があれば id、なければ商品名で判断する。価格は最後に見たものを採る
 * （後から届いた応答のほうが新しいため）。
 */
export function dedupeProducts(products) {
  const byKey = new Map();
  for (const p of products) {
    const key = p.id ? `id:${p.id}` : `name:${p.name}`;
    byKey.set(key, { ...byKey.get(key), ...p });
  }
  return [...byKey.values()];
}

/**
 * JSON の「形」だけを書き出す（値は含めない）。
 *
 * 商品が取り出せなかったとき、どんな項目名で届いているかを知るために使う。
 * 住所や氏名などの中身は出さず、キーの並びと型だけを残す。
 */
export function describeShape(json, { maxDepth = 6, maxKeys = 40 } = {}) {
  const lines = [];
  const walk = (node, prefix, depth) => {
    if (depth > maxDepth || lines.length > 400) return;
    if (Array.isArray(node)) {
      lines.push(`${prefix}[] (${node.length})`);
      if (node.length) walk(node[0], `${prefix}[]`, depth + 1);
      return;
    }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node).slice(0, maxKeys)) {
        const path = prefix ? `${prefix}.${k}` : k;
        if (v === null) lines.push(`${path}: null`);
        else if (typeof v === 'object') walk(v, path, depth + 1);
        else lines.push(`${path}: ${typeof v}`);
      }
    }
  };
  walk(json, '', 0);
  return lines;
}
