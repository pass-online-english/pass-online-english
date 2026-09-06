/**
 * Playwright のブラウザ操作まわり。
 *
 * - ログインは人がやる。スクリプトは ID / パスワードを一切扱わない。
 * - 保存するのはログイン後のセッション（Cookie / localStorage）だけで、
 *   置き場所はリポジトリ外・パーミッション 0600（paths.sessionPath）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { sessionPath } from './paths.mjs';
import { pageExtract, pageAutoScroll } from './extract.mjs';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function hasSession() {
  return fs.existsSync(sessionPath());
}

export async function launch({ headed = false } = {}) {
  return chromium.launch({
    headless: !headed,
    // 実行環境に同梱の Chromium を使いたいときの逃げ道（CI / コンテナ用）
    executablePath: process.env.NETSUPER_CHROMIUM_PATH || undefined,
  });
}

export async function newContext(browser, { useSession = true } = {}) {
  const file = sessionPath();
  const storageState = useSession && fs.existsSync(file) ? file : undefined;
  return browser.newContext({
    storageState,
    locale: 'ja-JP',
    timezoneId: 'Asia/Tokyo',
    viewport: { width: 1280, height: 900 },
    userAgent: process.env.NETSUPER_USER_AGENT || DEFAULT_UA,
  });
}

/** セッションを 0600 で保存する。 */
export async function saveSession(context) {
  const file = sessionPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  await context.storageState({ path: file });
  fs.chmodSync(file, 0o600);
  return file;
}

/**
 * 一覧ページを開いて描画を待つ。
 * ネットワークが落ち着かないサイトもあるため networkidle は待ちすぎない。
 */
export async function openList(page, url, { waitMs = 1500, scroll = true } = {}) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await sleep(waitMs);
  if (scroll) {
    await page.evaluate(pageAutoScroll, {}).catch(() => {});
    await sleep(600);
  }
}

/** 現在のページから商品を抽出する。 */
export async function extractFromPage(page, selectors) {
  return page.evaluate(pageExtract, { selectors: selectors || {} });
}

/**
 * ページ送り。
 *  none   … 1ページのみ
 *  scroll … 無限スクロール（openList のオートスクロールで完結）
 *  next   … 「次へ」ボタンを押せなくなるまで進む
 *  query  … URL に ?page=N を足していく
 */
export async function collectCategory(page, category, config, { onPage } = {}) {
  const pagination = config.pagination || {};
  const mode = pagination.mode || 'scroll';
  const maxPages = Math.max(1, pagination.maxPages || 20);
  const waitMs = config.waitMs ?? 1500;
  const all = [];
  const seen = new Set();
  let meta = null;

  const takeCurrent = async (pageNo) => {
    const res = await extractFromPage(page, config.selectors);
    if (!meta) meta = { mode: res.mode, selectors: res.selectors, signature: res.signature, depth: res.depth };
    let added = 0;
    for (const it of res.items) {
      const key = `${it.url || ''}|${it.name}|${it.priceText}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push({ ...it, category: category.name, sourceUrl: page.url(), pageNo });
      added += 1;
    }
    if (onPage) onPage({ pageNo, found: res.count, added, mode: res.mode, url: page.url() });
    return { res, added };
  };

  if (mode === 'query') {
    for (let i = 1; i <= maxPages; i += 1) {
      const param = pagination.queryParam || 'page';
      const u = new URL(category.url);
      if (i > 1) u.searchParams.set(param, String(i));
      await openList(page, u.href, { waitMs });
      const { res, added } = await takeCurrent(i);
      if (!res.count || added === 0) break;
    }
    return { items: all, meta };
  }

  await openList(page, category.url, { waitMs });
  await takeCurrent(1);
  if (mode === 'next') {
    const nextSelector = pagination.nextSelector;
    if (!nextSelector) throw new Error('pagination.mode が "next" ですが pagination.nextSelector が未設定です。');
    for (let i = 2; i <= maxPages; i += 1) {
      const next = page.locator(nextSelector).first();
      const usable = await next.isVisible().catch(() => false);
      if (!usable) break;
      const disabled = await next.isDisabled().catch(() => false);
      if (disabled) break;
      await next.click({ timeout: 10_000 }).catch(() => null);
      await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
      await sleep(waitMs);
      await page.evaluate(pageAutoScroll, {}).catch(() => {});
      const { added } = await takeCurrent(i);
      if (added === 0) break;
    }
  }
  return { items: all, meta };
}
