/**
 * 最小限の CSV 読み込み。
 * 店頭価格メモは Excel / スプレッドシートで編集される前提なので、
 * BOM・引用符・CRLF・全角数字を吸収する。
 */
import { normalizeText } from './price.mjs';

/** ヘッダ付き CSV をオブジェクト配列に変換する。 */
export function parseCSV(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const nonEmpty = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => normalizeText(h));
  return nonEmpty.slice(1).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

const NAME_KEYS = ['商品名', '品名', '名前', 'name', 'item', '商品'];
const PRICE_KEYS = ['店頭価格', '価格', '店頭', 'price', 'store_price'];
const NOTE_KEYS = ['メモ', '備考', 'note', 'memo'];

function pick(obj, keys) {
  for (const k of keys) {
    const hit = Object.keys(obj).find((h) => h.toLowerCase() === k.toLowerCase());
    if (hit && obj[hit] !== '') return obj[hit];
  }
  return '';
}

/** 数値化。全角・カンマ・「円」を落とす。 */
export function toNumber(v) {
  const s = normalizeText(v).replace(/[,円¥\s]/g, '');
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * 店頭価格メモ CSV を読む。
 * 列名は「商品名 / 店頭価格 / メモ」を基本に、英語や別名も受け付ける。
 */
export function parseStorePrices(text) {
  const rows = parseCSV(text);
  const out = [];
  const errors = [];
  rows.forEach((r, i) => {
    const name = normalizeText(pick(r, NAME_KEYS));
    const price = toNumber(pick(r, PRICE_KEYS));
    if (!name) return;
    if (price === null) {
      errors.push(`${i + 2} 行目「${name}」の店頭価格を数値として読めませんでした`);
      return;
    }
    out.push({ name, storePrice: price, note: normalizeText(pick(r, NOTE_KEYS)) });
  });
  return { items: out, errors };
}
