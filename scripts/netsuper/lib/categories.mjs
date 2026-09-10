/**
 * 受信データから売場（カテゴリ）の一覧を拾う。
 *
 * 売場が数十あると URL を手で集めるのは現実的でない。アプリはメニューを
 * 表示するために一覧を受け取っているので、そこから取る。
 */
import { normalizeText } from './price.mjs';

/** Relay 形式の ID（base64 の "Category:1" など）から種別を読む。 */
export function decodeGlobalId(id) {
  if (typeof id !== 'string' || id.length > 64) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(id)) return null;
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const m = decoded.match(/^([A-Za-z]+):(.+)$/);
    return m ? { type: m[1], value: m[2] } : null;
  } catch {
    return null;
  }
}

/** JSON が文字列として埋め込まれていることがある（キャッシュ用の塊など）。 */
function parseEmbedded(text) {
  if (typeof text !== 'string' || text.length < 24 || text.length > 5_000_000) return null;
  const head = text.trimStart()[0];
  if (head !== '{' && head !== '[') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * JSON を歩いて、ID の種別ごとに「名前つきのもの」を集める。
 *
 * 文字列として埋め込まれた JSON の中も見る。売場の一覧がキャッシュ用の
 * 塊（文字列）に入っていることがあるため。
 */
export function collectByIdType(payloads) {
  const byType = new Map();
  const seen = new Set();

  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 40) return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child, depth + 1);
      return;
    }
    const decoded = decodeGlobalId(node.id);
    if (decoded) {
      const name = normalizeText(node.name ?? node.title ?? '');
      if (!byType.has(decoded.type)) byType.set(decoded.type, new Map());
      const bucket = byType.get(decoded.type);
      // 名前のないものは表示できないので採らない
      if (name && !bucket.has(node.id)) bucket.set(node.id, { id: node.id, name });
      seen.add(decoded.type);
    }
    for (const value of Object.values(node)) {
      if (value && typeof value === 'object') walk(value, depth + 1);
      else {
        const embedded = parseEmbedded(value);
        if (embedded) walk(embedded, depth + 1);
      }
    }
  };

  for (const payload of payloads) walk(payload);
  const out = new Map();
  for (const [type, bucket] of byType) {
    out.set(type, [...bucket.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja')));
  }
  return out;
}

/**
 * JSON を歩いて「売場」らしきオブジェクトを集める。
 * ID が Category を指し、名前を持つものだけを採る。
 */
export function collectCategories(payloads, { type = 'Category' } = {}) {
  return collectByIdType(payloads).get(type) ?? [];
}

/**
 * 既知の売場URLを雛形にして、ID の部分だけ差し替える。
 * URL の形を推測はしない（雛形の最後の区切り以降を ID とみなす）。
 */
export function applyCategoryTemplate(categories, templateUrl) {
  const cut = templateUrl.lastIndexOf('/');
  if (cut === -1) throw new Error(`売場URLの雛形として使えません: ${templateUrl}`);
  const prefix = templateUrl.slice(0, cut + 1);
  return categories.map((c) => ({ name: c.name, url: `${prefix}${c.id}` }));
}
