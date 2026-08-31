/**
 * 出力（JSON / CSV / Markdown）。
 * Claude Code が読みやすいよう、JSON は安定した構造、Markdown は表形式で出す。
 */
import fs from 'node:fs';
import path from 'node:path';
import { outputDir } from './env.mjs';

/** reports/<slug>-<YYYY-MM-DD_HHmm>/ を作って返す */
export function createRunDir(slug, { out } = {}) {
  if (out) {
    const dir = path.isAbsolute(out) ? out : path.resolve(process.cwd(), out);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const now = new Date();
  const stamp =
    `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}` +
    `_${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  const dir = path.join(outputDir(), `${slug}-${stamp}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeJSON(dir, name, data) {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return file;
}

export function writeText(dir, name, text) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return file;
}

function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'number' ? String(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** rows: オブジェクト配列。columns 未指定なら全行のキーの和集合を使う。 */
export function toCSV(rows, columns) {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = [cols.map(csvCell).join(',')];
  for (const row of rows) lines.push(cols.map((c) => csvCell(row[c])).join(','));
  // Excel が UTF-8 を正しく開けるよう BOM を付ける（日本語のクエリを扱うため）
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function writeCSV(dir, name, rows, columns) {
  return writeText(dir, `${name}.csv`, toCSV(rows, columns));
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * mdTable は formatter を `format(value, row)` として呼ぶため、
 * `format: fmtNum` のように関数を直接渡すと第2引数に行オブジェクトが入る。
 * 桁数として不正な値は 0 桁に落として扱う。
 */
function safeDigits(digits, fallback) {
  return Number.isInteger(digits) && digits >= 0 && digits <= 20 ? digits : fallback;
}

export function fmtNum(v, digits = 0) {
  if (!isNum(v)) return String(v ?? '');
  const d = safeDigits(digits, 0);
  return v.toLocaleString('ja-JP', { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtPct(v, digits = 2) {
  if (!isNum(v)) return '';
  return `${(v * 100).toFixed(safeDigits(digits, 2))}%`;
}

export function fmtSeconds(v) {
  if (!isNum(v)) return '';
  const s = Math.round(v);
  return `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒`;
}

/** 増減率。前期間が0のときは null（∞を出さない） */
export function delta(current, previous) {
  if (!isNum(current) || !isNum(previous)) return { abs: null, pct: null };
  const abs = current - previous;
  const pct = previous === 0 ? null : abs / previous;
  return { abs, pct };
}

export function fmtDelta(d, { digits = 1, unit = '' } = {}) {
  if (d?.abs === null || d?.abs === undefined) return '—';
  const sign = d.abs > 0 ? '+' : '';
  const absPart = `${sign}${fmtNum(d.abs, Number.isInteger(d.abs) ? 0 : digits)}${unit}`;
  if (d.pct === null) return `${absPart} (前期間0)`;
  const psign = d.pct > 0 ? '+' : '';
  return `${absPart} (${psign}${(d.pct * 100).toFixed(1)}%)`;
}

/**
 * Markdown テーブル。columns は { key, label, align?, format? } の配列。
 */
export function mdTable(rows, columns) {
  if (!rows.length) return '_該当データなし_\n';
  const head = `| ${columns.map((c) => c.label).join(' | ')} |`;
  const sep = `| ${columns.map((c) => (c.align === 'right' ? '---:' : c.align === 'center' ? ':---:' : '---')).join(' | ')} |`;
  const body = rows.map((row) => {
    const cells = columns.map((c) => {
      const v = c.format ? c.format(row[c.key], row) : row[c.key];
      return String(v ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
    });
    return `| ${cells.join(' | ')} |`;
  });
  return [head, sep, ...body].join('\n') + '\n';
}

/** 長いURL/タイトルを表示用に切る */
export function truncate(s, n = 60) {
  const str = String(s ?? '');
  return str.length <= n ? str : `${str.slice(0, n - 1)}…`;
}

export function relativeToCwd(p) {
  const rel = path.relative(process.cwd(), p);
  return rel.startsWith('..') ? p : rel;
}
