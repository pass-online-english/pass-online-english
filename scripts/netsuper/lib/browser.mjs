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
import { extractProducts, dedupeProducts } from './apidata.mjs';

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
/**
 * 使うブラウザ。
 * 既定は Playwright に同梱の Chromium。`chrome` を指定すると、
 * パソコンにインストールされている Google Chrome を使う。
 * 同梱の Chromium は描画まわりが簡素なため、それで動かないアプリがある。
 */
function browserChannel(channel) {
  const value = (channel || process.env.NETSUPER_BROWSER_CHANNEL || '').trim();
  return value || undefined;
}

export async function openBrowser({ headed = false, channel } = {}) {
  const dir = profileDir();
  const wanted = browserChannel(channel);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    return await chromium.launchPersistentContext(dir, {
      channel: wanted,
      // NETSUPER_HEADLESS=1 は画面のない環境（検証用）で headed を打ち消すための逃げ道
      headless: process.env.NETSUPER_HEADLESS === '1' ? true : !headed,
      // Ctrl+C を Playwright に横取りさせない。記録済みの価格を保存してから終わるため
      handleSIGINT: false,
      // 画面をキャンバスに描くアプリ（Flutter など）は描画機能が無いと起動しない。
      // 画面を出さない実行でもソフトウェア描画で動くようにしておく。
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-sandbox'],
      locale: 'ja-JP',
      timezoneId: 'Asia/Tokyo',
      viewport: { width: 1280, height: 900 },
      userAgent: process.env.NETSUPER_USER_AGENT || DEFAULT_UA,
      // 実行環境に同梱の Chromium を使いたいときの逃げ道（CI / コンテナ用）
      executablePath: wanted ? undefined : process.env.NETSUPER_CHROMIUM_PATH || undefined,
    });
  } catch (err) {
    const message = String(err.message);
    if (/ProcessSingleton|SingletonLock|already (in use|running)/i.test(message)) {
      throw new Error(
        'このツールが開いたブラウザがまだ起動しています。\n' +
          '  そのウィンドウを閉じてから、もう一度実行してください。'
      );
    }
    if (wanted && /executable doesn't exist|Chromium distribution|not found/i.test(message)) {
      throw new Error(
        `${wanted} が見つかりませんでした。\n` +
          '  Google Chrome をインストールするか、--chrome を外して実行してください。'
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

function parseUrl(u) {
  try {
    return new URL(u);
  } catch {
    return null;
  }
}

/** 画面の中身が変わったかどうかを見るための指紋。 */
async function contentSignature(page) {
  return page
    .evaluate(() => {
      const body = document.body;
      return `${body ? body.innerText.length : 0}:${document.querySelectorAll('*').length}`;
    })
    .catch(() => '');
}

/**
 * SPA の起動を待つ。
 *
 * 「本文が空でなくなったら起動完了」では早すぎる。外枠の HTML に見出しが
 * 入っているだけの段階でルータはまだ動いておらず、そこで画面遷移を指示しても
 * 無視されて何も描画されない。DOM の変化が止まるまで待つ。
 */
async function waitForSettled(page, { interval = 300, stableRounds = 3, timeout = 20_000 } = {}) {
  const deadline = Date.now() + timeout;
  let last = null;
  let stable = 0;
  while (Date.now() < deadline) {
    await sleep(interval);
    const sig = await contentSignature(page);
    stable = sig && sig === last ? stable + 1 : 0;
    last = sig;
    if (stable >= stableRounds) return true;
  }
  return false;
}

/**
 * ハッシュルーティングの画面遷移。
 *
 * アプリのルータに任せて `location.hash` を変える。これが本来の遷移経路で、
 * ルータが初期化されないまま描画されない事故を避けられる。
 * hashchange を見ていないアプリのために、変化しなければ読み直しに切り替える。
 */
async function navigateHash(page, target, { timeout = 8_000 } = {}) {
  const before = await contentSignature(page);
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, target.hash);

  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await sleep(300);
    const now = await contentSignature(page);
    if (now && now !== before) return 'router';
  }

  await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
  return 'reload';
}

const PRICE_TEXT_RE = /(?:¥\s*\d|\d[\d,]*\s*円)/;

/** フレーム内の本文テキスト（取れなければ空文字）。 */
async function frameText(frame) {
  return frame.evaluate(() => (document.body ? document.body.innerText : '')).catch(() => '');
}

/**
 * 価格らしきテキストが現れるまで待つ。
 * SPA は HTML が空の状態で返ってきて、あとから JS が描画するため、
 * domcontentloaded だけでは早すぎる。
 * 中身が iframe に入っているサイトもあるので、全フレームを見る。
 */
export async function waitForPrices(page, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (PRICE_TEXT_RE.test(await frameText(frame))) return true;
    }
    await sleep(500);
  }
  return false;
}

/** 各フレームの状態。0件だったときの原因切り分けに使う。 */
export async function describeFrames(page) {
  const out = [];
  for (const frame of page.frames()) {
    const info = await frame
      .evaluate(() => ({
        url: location.href,
        title: document.title,
        textLength: document.body ? document.body.innerText.trim().length : 0,
        htmlLength: document.documentElement ? document.documentElement.innerHTML.length : 0,
        elements: document.querySelectorAll('*').length,
        // Vue / React などのマウント先が空のままかどうか
        mountPoint: (() => {
          const el = document.querySelector(
            '#loading, #splash, [class*="loading"], #app, #root, [data-server-rendered], main, body > div'
          );
          return el ? { selector: el.id ? `#${el.id}` : el.tagName.toLowerCase(), children: el.childElementCount } : null;
        })(),
      }))
      .catch((err) => ({ url: frame.url(), error: String(err.message).split('\n')[0] }));
    out.push(info);
  }
  return out;
}

/**
 * 一覧ページを開いて描画を待つ。
 * ネットワークが落ち着かないサイトもあるため networkidle は待ちすぎない。
 */
export async function openList(page, url, { waitMs = 1500, scroll = true, hashTimeout = 8_000 } = {}) {
  const target = new URL(url);
  const hashRoute = target.hash.length > 1;
  const current = parseUrl(page.url());
  const sameApp =
    Boolean(current) && current.origin === target.origin && current.pathname === target.pathname;

  if (!sameApp) {
    // `#/…` のURLをいきなり開くと、ルータが初期化されず何も描画しないアプリがある。
    // まずアプリ本体（ハッシュ抜き）を開いて、起動を待ってから画面を切り替える。
    const entry = hashRoute ? `${target.origin}${target.pathname}${target.search}` : url;
    await page.goto(entry, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (hashRoute) await waitForSettled(page);
  }

  let how = sameApp ? 'そのまま' : hashRoute ? 'アプリを開いてから遷移' : '直接';
  if (hashRoute && current?.hash === target.hash && sameApp) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    how = '同じ画面を読み直し';
  } else if (hashRoute) {
    const via = await navigateHash(page, target, { timeout: hashTimeout });
    how = `${how}（${via === 'router' ? 'ルータ' : '読み直し'}）`;
  } else if (sameApp) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
    how = '読み直し';
  }

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  // 価格が出てこないページ（ログイン画面など）でも止まらないよう、待てなければ先に進む
  const sawPrices = await waitForPrices(page);
  await sleep(waitMs);
  if (scroll) {
    await page.evaluate(pageAutoScroll, {}).catch(() => {});
    await sleep(600);
  }
  return { how, sawPrices };
}

/**
 * 現在のページから商品を抽出する。
 * 本体のフレームで取れなければ、iframe の中も順に見る
 * （売場を iframe に入れているサイトがあるため）。
 */
export async function extractFromPage(page, selectors) {
  const arg = { selectors: selectors || {} };
  const main = await page.evaluate(pageExtract, arg).catch(() => null);
  if (main && main.count > 0) return main;

  let best = main;
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    const res = await frame.evaluate(pageExtract, arg).catch(() => null);
    if (res && res.count > (best?.count ?? 0)) best = { ...res, frameUrl: frame.url() };
  }
  return best ?? { mode: 'failed', count: 0, items: [], selectors: {}, diagnostics: [] };
}

/**
 * アプリがサーバから受け取った JSON を記録する。
 *
 * 画面をキャンバスに描画するアプリ（Flutter など）では HTML に商品が存在しない。
 * その場合でも、アプリ自身が受け取っているデータを読めば商品を取り出せる。
 * こちらから API を呼ぶのではなく、アプリの通信を横で記録するだけ。
 */
export function attachApiCapture(page, { pattern, maxEntries = 500, maxBytes = 8_000_000 } = {}) {
  // 既定では JSON の応答をすべて記録する。宛先を絞ると、商品が載っている通信を
  // 取り逃したときに原因が分かりにくい。絞りたい場合だけ pattern を渡す。
  const re = pattern ? new RegExp(pattern, 'i') : /./;
  const entries = [];
  let bytes = 0;

  const onResponse = async (response) => {
    if (entries.length >= maxEntries || bytes > maxBytes) return;
    const url = response.url();
    if (!re.test(url)) return;
    const type = response.headers()['content-type'] ?? '';
    if (!/json/i.test(type)) return;
    try {
      const text = await response.text();
      bytes += text.length;
      // どの画面を見ているときに届いたか。売場ごとの仕分けに使う
      entries.push({ url, status: response.status(), pageUrl: page.url(), json: JSON.parse(text) });
    } catch {
      // 本文を読めない応答（リダイレクト・キャンセル）は無視する
    }
  };

  page.on('response', onResponse);
  return {
    entries,
    /** これまでに記録した応答から商品を取り出す（from 以降だけを見る）。 */
    products(from = 0) {
      const out = [];
      for (const entry of entries.slice(from)) {
        for (const p of extractProducts(entry.json)) out.push({ ...p, sourceUrl: entry.pageUrl || entry.url });
      }
      return dedupeProducts(out);
    },
    detach() {
      page.off('response', onResponse);
    },
  };
}

/**
 * 画面をスクロールしながら、新しいデータが届かなくなるまで待つ。
 *
 * キャンバスに描画するアプリでは DOM のスクロールが効かないため、
 * マウスホイールの操作として送る。
 */
export async function scrollAndHarvest(page, capture, { rounds = 25, pause = 1200, stableRounds = 3 } = {}) {
  const viewport = page.viewportSize() ?? { width: 1280, height: 900 };
  await page.mouse.move(viewport.width / 2, viewport.height / 2).catch(() => {});
  let stable = 0;
  let seen = capture.entries.length;
  for (let i = 0; i < rounds; i += 1) {
    await page.mouse.wheel(0, Math.round(viewport.height * 0.8)).catch(() => {});
    await page.evaluate(pageAutoScroll, { maxRounds: 2 }).catch(() => {});
    await sleep(pause);
    if (capture.entries.length === seen) {
      stable += 1;
      if (stable >= stableRounds) break;
    } else {
      stable = 0;
      seen = capture.entries.length;
    }
  }
  return capture.entries.length;
}

/**
 * ページ送り。
 *  none   … 1ページのみ
 *  scroll … 無限スクロール（openList のオートスクロールで完結）
 *  next   … 「次へ」ボタンを押せなくなるまで進む
 *  query  … URL に ?page=N を足していく
 *
 * 画面から取れなかった場合は、アプリがサーバから受け取った JSON から拾う
 * （capture が渡されているとき）。
 */
export async function collectCategory(page, category, config, { onPage, capture } = {}) {
  const pagination = config.pagination || {};
  const mode = pagination.mode || 'scroll';
  const maxPages = Math.max(1, pagination.maxPages || 20);
  const waitMs = config.waitMs ?? 1500;
  const all = [];
  const seen = new Set();
  const meta = { mode: null, selectors: null, domCount: 0, apiCount: 0 };
  const captureFrom = capture ? capture.entries.length : 0;

  const add = (item) => {
    const key = `${item.url || ''}|${item.name}|${item.priceText ?? item.price ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    all.push({ ...item, category: category.name, sourceUrl: page.url() });
    return true;
  };

  const takeCurrent = async (pageNo) => {
    const res = await extractFromPage(page, config.selectors);
    if (!meta.mode) {
      meta.mode = res.mode;
      meta.selectors = res.selectors;
      meta.signature = res.signature;
      meta.depth = res.depth;
    }
    let added = 0;
    for (const it of res.items) if (add({ ...it, pageNo, source: 'dom' })) added += 1;
    meta.domCount += added;
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
  } else {
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
  }

  if (capture) {
    // 画面をスクロールすると続きが読み込まれる。届いた JSON から商品を拾う。
    await scrollAndHarvest(page, capture, { rounds: maxPages * 2, pause: Math.max(800, waitMs) });
    let added = 0;
    for (const p of capture.products(captureFrom)) {
      if (add({ ...p, pageNo: 1, source: 'api', priceText: '', rawText: p.name })) added += 1;
    }
    meta.apiCount = added;
    if (added && onPage) onPage({ pageNo: 1, found: added, added, mode: 'api', url: page.url() });
  }

  return { items: all, meta };
}
