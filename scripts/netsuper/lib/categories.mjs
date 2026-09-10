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

/**
 * JSON を歩いて「売場」らしきオブジェクトを集める。
 * ID が Category を指し、名前を持つものだけを採る。
 */
export function collectCategories(payloads, { type = 'Category' } = {}) {
  const byId = new Map();

  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    const id = node.id;
    const decoded = decodeGlobalId(id);
    if (decoded && decoded.type === type) {
      const name = normalizeText(node.name ?? node.title ?? '');
      // 名前のないものは表示できないので採らない
      if (name && !byId.has(id)) byId.set(id, { id, name });
    }
    for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
  };

  for (const payload of payloads) walk(payload);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
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
