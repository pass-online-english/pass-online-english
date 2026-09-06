/**
 * Playwright のブラウザ操作まわり。
 *
 * - ログインは人がやる。スクリプトは ID / パスワードを一切扱わない。
 * - 保存するのはログイン後のセッション（Cookie / localStorage）だけで、
 *   置き場所はリポジトリ外・パーミッション 0600（paths.sessionPath）。
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { profileDir } from './paths.mjs';
import { pageExtract, pageAutoScroll } from './extract.mjs';

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * ログイン済みの印。
 * プロファイルは probe を1回動かすだけでも作られるため、ディレクトリの有無では
 * 判定できない。login を最後まで終えたときだけ置く目印を見る。
 */
const LOGIN_MARKER = 'netsuper-login-done';

export function hasSession() {
  return fs.existsSync(`${profileDir()}/${LOGIN_MARKER}`);
}

/** login が完了したときに呼ぶ。 */
export function markLoggedIn() {
  const file = `${profileDir()}/${LOGIN_MARKER}`;
  fs.writeFileSync(file, `${new Date().toISOString()}\n`, { mode: 0o600 });
  return file;
}

/**
 * ログイン状態を保持したブラウザを開く。
 *
 * プロファイルを使い回すため、Cookie / localStorage / IndexedDB / Service Worker が
 * そのまま残る。認証情報をどこに置くサイトでもログイン状態を保てる。
 */
export async function openBrowser({ headed = false } = {}) {
  const dir = profileDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    return await chromium.launchPersistentContext(dir, {
      headless: !headed,
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1280, height: 900 },
      userAgent: process.env.NETSUPER_USER_AGENT || DEFAULT_UA,
      // 実行環境に同梱の Chromium を使いたいときの逃げ道（CI / コンテナ用）
      executablePath: process.env.NETSUPER_CHROMIUM_PATH || undefined,
    });
  } catch (err) {
    if (/ProcessSingleton|SingletonLock|already (in use|running)/i.test(String(err.message))) {
      throw new Error(
        'このツールが開いたブラウザがまだ起動しています。\n' +
          '  そのウィンドウを閉じてから、もう一度実行してください。'
      );
    }
    throw err;
  }
}

/** プロファイル内の最初のページを使う（新しいタブを増やさない）。 */
export async function firstPage(context) {
  const [existing] = context.pages();
  return existing ?? context.newPage();
}

/**
 * ハッシュだけが違う遷移かどうか（https://example.com/#/a → https://example.com/#/b）。
 *
 * `#/…` で画面を切り替える SPA では、goto してもページが読み直されず、
 * 前の画面の DOM がそのまま残ることがある。その場合は明示的に reload する。
 */
export function isSameDocumentNavigation(from, to) {
  try {
    const a = new URL(from);
    const b = new URL(to);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search && a.hash !== b.hash;
  } catch {
    return false;
  }
}

/**
 * 価格らしきテキストが現れるまで待つ。
 * SPA は HTML が空の状態で返ってきて、あとから JS が描画するため、
 * domcontentloaded だけでは早すぎる。
 */
export async function waitForPrices(page, timeout = 15_000) {
  await page.waitForFunction(
    () => /(?:¥\s*\d|\d[\d,]*\s*円)/.test(document.body ? document.body.innerText : ''),
    undefined,
    { timeout, polling: 500 }
  );
}

/**
 * 一覧ページを開いて描画を待つ。
 * ネットワークが落ち着かないサイトもあるため networkidle は待ちすぎない。
 */
export async function openList(page, url, { waitMs = 1500, scroll = true } = {}) {
  const sameDoc = isSameDocumentNavigation(page.url(), url);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  if (sameDoc) await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  // 価格が出てこないページ（ログイン画面など）でも止まらないよう、待てなければ先に進む
  await waitForPrices(page).catch(() => {});
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
