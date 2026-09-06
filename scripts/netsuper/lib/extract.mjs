/**
 * 商品一覧の抽出ロジック。
 *
 * ネットスーパーは店舗ごとに HTML がまったく違うため、
 * **セレクタを決め打ちしない**。「価格らしきテキストを含む末端ノード」を起点に、
 * 同じ形をした親要素が最も多く並ぶ階層＝商品カードとみなす。
 * セレクタが設定ファイルにあればそちらを優先する（自動判定は保険）。
 *
 * この関数はブラウザ内で評価される（page.evaluate に渡す）ため、
 * 外側の変数を参照してはいけない。ヘルパーはすべて内側に置くこと。
 */
export function pageExtract(options) {
  const opts = options || {};
  const sel = opts.selectors || {};
  const MAX_DEPTH = 10;
  const MIN_ITEMS = opts.minItems || 3;

  const PRICE_RE = /(?:¥\s*[0-9][0-9,]*|[0-9][0-9,]*\s*円)/;
  const SOLD_OUT_RE = /(売り切れ|売切|完売|在庫(切れ|なし|無し)|SOLD\s*OUT|お取り扱いできません|取扱い?終了)/i;
  const NOISE_RE =
    /^(カートに入れる|カートへ入れる|カート|追加|購入|お気に入り(に追加)?|数量|個数|変更|削除|詳細|もっと見る|\+|-|×|\d+)$/i;
  const NAMEISH_RE = /(name|title|ttl|product|item[-_]?name|goods)/i;

  const text = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');
  const hasPrice = (s) => PRICE_RE.test(s);

  function isSkippable(el) {
    const tag = el.tagName;
    return tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE' || tag === 'SVG';
  }

  /** 価格文字列を含む、これ以上分解できない要素。 */
  function findPriceNodes(root) {
    const out = [];
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (isSkippable(el)) continue;
      const t = text(el);
      if (!hasPrice(t)) continue;
      let childHasPrice = false;
      for (const c of el.children) {
        if (!isSkippable(c) && hasPrice(text(c))) { childHasPrice = true; break; }
      }
      if (!childHasPrice) out.push(el);
    }
    return out;
  }

  /** 同じ形のカードを見分けるための署名。class が無い場合は data-* とタグ構成で代用。 */
  function signature(el) {
    const cls = (el.getAttribute('class') || '')
      .split(/\s+/)
      .filter(Boolean)
      .filter((c) => !/^(is|has)-|^(active|selected|hover|open)$/i.test(c))
      .sort()
      .join('.');
    if (cls) return `${el.tagName.toLowerCase()}.${cls}`;
    const data = [...el.attributes]
      .filter((a) => a.name.startsWith('data-') && !/id|key|index|sku|code/i.test(a.name))
      .map((a) => a.name)
      .sort()
      .join(',');
    const kids = [...el.children].map((c) => c.tagName.toLowerCase()).join('>');
    return `${el.tagName.toLowerCase()}|${data}|${kids}`;
  }

  function cssEscape(s) {
    return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1');
  }

  /** 署名から CSS セレクタを作る。作れない／一致しない場合は null。 */
  function selectorFor(el, expectedCount) {
    const classes = (el.getAttribute('class') || '').split(/\s+/).filter(Boolean);
    const candidates = [];
    if (classes.length) candidates.push(`${el.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`);
    for (const a of el.attributes) {
      if (a.name.startsWith('data-') && !/id|key|index|sku|code/i.test(a.name)) {
        candidates.push(`${el.tagName.toLowerCase()}[${a.name}]`);
      }
    }
    for (const c of candidates) {
      try {
        const n = document.querySelectorAll(c).length;
        if (n >= expectedCount && n <= expectedCount * 1.5) return c;
      } catch { /* 無効なセレクタは無視 */ }
    }
    return null;
  }

  /** 価格ノードの祖先をたどり、「1カード＝1価格」が最も多く成立する階層を選ぶ。 */
  function detectCards(priceNodes) {
    let best = null;
    const diagnostics = [];
    for (let depth = 1; depth <= MAX_DEPTH; depth += 1) {
      const counts = new Map();
      for (const pn of priceNodes) {
        let a = pn;
        for (let i = 0; i < depth && a; i += 1) a = a.parentElement;
        if (!a || a === document.body || a === document.documentElement) continue;
        counts.set(a, (counts.get(a) || 0) + 1);
      }
      const groups = new Map();
      for (const [el, n] of counts) {
        const key = signature(el);
        if (!groups.has(key)) groups.set(key, { key, depth, els: [], multi: false });
        const g = groups.get(key);
        g.els.push(el);
        if (n > 1) g.multi = true;
      }
      for (const g of groups.values()) {
        if (g.multi || g.els.length < MIN_ITEMS) continue;
        diagnostics.push({ key: g.key, depth: g.depth, count: g.els.length });
        // 件数が同じなら祖先側（depth が大きいほう）を採る。商品リンクや画像まで含んだ
        // まとまりになり、商品名を拾いやすい。1カード1価格の条件があるので隣の商品とは混ざらない。
        if (!best || g.els.length > best.els.length || (g.els.length === best.els.length && g.depth > best.depth)) {
          best = g;
        }
      }
    }
    diagnostics.sort((a, b) => b.count - a.count || b.depth - a.depth);
    return { best, diagnostics: diagnostics.slice(0, 8) };
  }

  /** カード内から商品名らしいテキストを選ぶ。 */
  function pickName(card, priceEl) {
    let best = null;
    for (const el of card.querySelectorAll('*')) {
      if (isSkippable(el)) continue;
      if (priceEl && (el === priceEl || priceEl.contains(el) || el.contains(priceEl))) continue;
      const t = text(el);
      if (!t || t.length > 120) continue;
      // 子要素にテキストがあるものは中間ノード。末端だけを見る。
      let childText = false;
      for (const c of el.children) if (text(c)) { childText = true; break; }
      if (childText) continue;
      if (NOISE_RE.test(t) || hasPrice(t)) continue;

      let score = Math.min(t.length, 60);
      if (el.closest('a[href]')) score += 30;
      const attr = `${el.getAttribute('class') || ''} ${el.getAttribute('data-testid') || ''}`;
      if (NAMEISH_RE.test(attr)) score += 200;
      if (/^(h[1-6])$/i.test(el.tagName)) score += 40;
      if (SOLD_OUT_RE.test(t)) score -= 500;
      if (!best || score > best.score) best = { score, text: t };
    }
    if (best) return best.text;
    const img = card.querySelector('img[alt]');
    return img && img.alt ? img.alt.trim() : '';
  }

  function absUrl(u) {
    try { return new URL(u, document.baseURI).href; } catch { return ''; }
  }

  function readCard(card, index) {
    let priceEl = null;
    if (sel.price) priceEl = card.querySelector(sel.price);
    if (!priceEl) {
      const inner = findPriceNodes(card);
      priceEl = inner.length ? inner[0] : null;
    }
    const nameEl = sel.name ? card.querySelector(sel.name) : null;
    const link = card.querySelector('a[href]');
    const img = [...card.querySelectorAll('img')].find((i) => i.src && !i.src.startsWith('data:'));
    const raw = text(card);
    return {
      index,
      name: (nameEl ? text(nameEl) : '') || pickName(card, priceEl),
      priceText: priceEl ? text(priceEl) : '',
      url: link ? absUrl(link.getAttribute('href')) : '',
      image: img ? img.src : '',
      soldOut: SOLD_OUT_RE.test(raw),
      rawText: raw.slice(0, 300),
    };
  }

  // ── 本体 ────────────────────────────────────────────
  if (sel.item) {
    const cards = [...document.querySelectorAll(sel.item)];
    return {
      mode: 'configured',
      selectors: { item: sel.item, name: sel.name || null, price: sel.price || null },
      count: cards.length,
      items: cards.map(readCard),
      diagnostics: [],
    };
  }

  const priceNodes = findPriceNodes(document.body || document.documentElement);
  const { best, diagnostics } = detectCards(priceNodes);
  if (!best) {
    return {
      mode: 'failed',
      selectors: { item: null, name: null, price: null },
      count: 0,
      items: [],
      diagnostics,
      priceNodeCount: priceNodes.length,
    };
  }
  const cards = best.els;
  return {
    mode: 'auto',
    selectors: { item: selectorFor(cards[0], cards.length), name: null, price: null },
    signature: best.key,
    depth: best.depth,
    count: cards.length,
    items: cards.map(readCard),
    diagnostics,
    priceNodeCount: priceNodes.length,
  };
}

/** ページ末尾まで少しずつスクロールして遅延読み込みを促す（ブラウザ内で評価）。 */
export function pageAutoScroll(options) {
  const opts = options || {};
  const step = opts.step || 900;
  const pause = opts.pause || 350;
  const maxRounds = opts.maxRounds || 40;
  return new Promise((resolve) => {
    let rounds = 0;
    let lastHeight = -1;
    let stable = 0;
    const timer = setInterval(() => {
      window.scrollBy(0, step);
      rounds += 1;
      const h = document.body ? document.body.scrollHeight : 0;
      const atBottom = window.innerHeight + window.scrollY >= h - 4;
      if (h === lastHeight && atBottom) stable += 1;
      else stable = 0;
      lastHeight = h;
      if (stable >= 3 || rounds >= maxRounds) {
        clearInterval(timer);
        resolve({ rounds, height: h });
      }
    }, pause);
  });
}
