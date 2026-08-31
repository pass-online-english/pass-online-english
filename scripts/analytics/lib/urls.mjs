/**
 * URL の正規化。
 *
 * Search Console は絶対URL（https://example.com/blog/toeic990.html）、
 * GA4 は パス（/blog/toeic990.html）を返すため、突き合わせ用のキーを作る。
 *
 * 【方針】ユーザー単位では結合しない。ページURLをキーにした集計値どうしの
 * 突き合わせのみを行う（Search Console は検索セッション、GA4 は
 * サイト内行動を測っており、そもそも母数の定義が異なるため）。
 */
import { siteOrigin } from './env.mjs';

/**
 * 突き合わせキーを作る。
 *  - オリジンを除去してパスにする
 *  - クエリ文字列・フラグメントを除去（GSC はクエリ付きURLをほぼ返さないため）
 *  - 末尾 index.html を / に寄せる
 *  - 末尾スラッシュを除去（ルートを除く）
 *  - 小文字化はしない（パスの大文字小文字は別リソースになりうるため）
 */
export function pageKey(input) {
  let s = String(input ?? '').trim();
  if (!s) return '';

  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).pathname;
    } catch {
      s = s.replace(/^https?:\/\/[^/]+/i, '');
    }
  }

  s = s.split('#')[0].split('?')[0];
  if (!s.startsWith('/')) s = `/${s}`;
  s = s.replace(/\/index\.html?$/i, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

/** 表示用の絶対URL。オリジンが不明なときはパスのまま返す。 */
export function absoluteUrl(key) {
  const origin = siteOrigin();
  if (!origin) return key;
  return `${origin}${key === '/' ? '/' : key}`;
}

/**
 * GA4 のパスと GSC のページがどれだけ重なったかを返す。
 * SITE_ORIGIN の設定ミスや、GA4 のホスト名混在を検知するために使う。
 */
export function joinCoverage(ga4Keys, gscKeys) {
  const a = new Set(ga4Keys);
  const b = new Set(gscKeys);
  const both = [...a].filter((k) => b.has(k));
  return {
    ga4Only: [...a].filter((k) => !b.has(k)),
    gscOnly: [...b].filter((k) => !a.has(k)),
    matched: both,
    matchRate: b.size === 0 ? null : both.length / b.size,
  };
}
