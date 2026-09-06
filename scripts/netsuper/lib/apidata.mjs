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
const TAX_INCLUDED_KEYS = /(tax_?included|include[_]?tax|zeikomi|including_?tax|gross|税込)/i;
const TAX_EXCLUDED_KEYS = /(tax_?excluded|exclude[_]?tax|without_?tax|body_?price|\bnet\b|税抜|本体)/i;
const UNIT_KEYS = /(unit|volume|capacity|size|quantity|weight|内容量|規格)$/i;
const SOLD_OUT_KEYS = /(sold_?out|out_?of_?stock|品切|売切)/i;
const IN_STOCK_KEYS = /(in_?stock|is_?available|purchasable|orderable)/i;
const STOCK_COUNT_KEYS = /(stock|inventory|zaiko|quantity_?available)/i;
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

/**
 * 商品の下の階層にある価格を探す。
 *
 * 商品名は浅い階層、価格は深い階層、という作りが多い。例えば
 *   node.name
 *   node.defaultVariant.pricing.price.gross.amount
 * のように離れている。名前の見つかったオブジェクトから下だけを見るので、
 * 隣の商品の価格を拾うことはない（配列には降りない）。
 */
function scanNested(obj, depth = 0, path = '', acc = { prices: [], soldOut: false, unit: '' }) {
  if (depth > 4 || acc.prices.length > 20) return acc;
  for (const [key, value] of Object.entries(obj)) {
    const here = path ? `${path}.${key}` : key;
    if (PRICE_KEYS.test(key)) {
      const n = toAmount(value);
      if (plausiblePrice(n)) acc.prices.push({ key: here, value: n });
    }
    if (SOLD_OUT_KEYS.test(key) && value === true) acc.soldOut = true;
    if (IN_STOCK_KEYS.test(key) && value === false) acc.soldOut = true;
    if (STOCK_COUNT_KEYS.test(key) && typeof value === 'number' && value <= 0) acc.soldOut = true;
    if (!acc.unit && UNIT_KEYS.test(key) && typeof value === 'string') acc.unit = normalizeText(value);
    // 配列には降りない。隣の商品を巻き込まないため
    if (value && typeof value === 'object' && !Array.isArray(value)) scanNested(value, depth + 1, here, acc);
  }
  return acc;
}

/** オブジェクト1つを商品として読めるなら読む。読めなければ null。 */
function readProduct(obj) {
  let name = '';
  const prices = [];
  let unit = '';
  let soldOut = false;
  let id = '';
  let category = '';

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
    // 売場の名前は商品データ自体が持っていることがある（そちらのほうが確か）
    if (!category && /^(category|department|section|売場)$/i.test(key) && value && typeof value === 'object') {
      const label = value.name ?? value.title;
      if (typeof label === 'string') category = normalizeText(label);
    }
  }
  // 商品名と価格が別の階層に分かれている形
  //   { price: 198, product: { name: "トマト" } }
  // にも対応する。1段だけ下を見る。
  if (!name && prices.length) {
    for (const value of Object.values(obj)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      for (const [k, v] of Object.entries(value)) {
        if (!NAME_KEYS.test(k) || typeof v !== 'string') continue;
        const t = normalizeText(v);
        if (t && t.length <= 120 && !URL_LIKE.test(t)) { name = t; break; }
      }
      if (name) break;
    }
  }
  // 価格・在庫・内容量は、商品名より下の階層にあることが多い
  if (name) {
    const nested = scanNested(obj);
    if (!prices.length) prices.push(...nested.prices);
    if (nested.soldOut) soldOut = true;
    if (!unit) unit = nested.unit;
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
    category,
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

  /** JSON が文字列として埋め込まれていることがある（キャッシュ用の塊など）。 */
  const parseEmbedded = (text) => {
    if (text.length < 24 || text.length > 2_000_000) return null;
    const head = text.trimStart()[0];
    if (head !== '{' && head !== '[') return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  };

  const walk = (node) => {
    if (visited > maxNodes || node === null || typeof node !== 'object') return;
    visited += 1;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const product = readProduct(node);
    if (product) {
      found.push(product);
      // 商品として読めたら、その下の入れ子（規格・価格の内訳）は同じ商品の一部。
      // 二重に数えないよう、配列だけを見る（別の商品が並んでいることがあるため）。
      for (const value of Object.values(node)) if (Array.isArray(value)) walk(value);
      return;
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value);
      else if (typeof value === 'string') {
        const embedded = parseEmbedded(value);
        if (embedded) walk(embedded);
      }
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
export function describeShape(json, { maxDepth = 12, maxKeys = 40 } = {}) {
  const lines = [];
  const walk = (node, prefix, depth) => {
    if (depth > maxDepth || lines.length > 800) return;
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
