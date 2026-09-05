/**
 * Google キーワードプランナーのエクスポートを読む。
 *
 * 【ファイルの実態】
 * 拡張子は .csv だが、中身は **UTF-16LE のタブ区切り**。
 * 先頭2行はタイトルと期間で、3行目がヘッダー。
 * ヘッダー名は英語・日本語が混在し、エクスポート方法によって列構成も変わる
 * （「検索のボリュームと予測」には Segmentation 列があり、
 *   「新しいキーワードを見つける」には無い）。
 * そのため列は名前の候補リストで探す。
 *
 * 【ボリュームの丸め】
 * 広告費を使っていないアカウントでは、月間平均検索ボリュームが
 * 50 / 500 / 5000 / 50000 のように代表値へ丸められる。
 * 画面上の「1000〜1万」に対応する値であり、正確な検索数ではない。
 * 順位づけには使えるが、絶対値として扱わないこと。
 */
import fs from 'node:fs';
import path from 'node:path';

/** ヘッダー名の候補。先に一致したものを採用する。 */
const COLUMN_ALIASES = {
  keyword: ['keyword', 'キーワード'],
  volume: ['avg. monthly searches', 'avg monthly searches', '月間平均検索ボリューム'],
  competition: ['competition', '競合性'],
  competitionIndex: ['competition (indexed value)', '競合性（インデックス値）', '競合性 (インデックス値)'],
  threeMonthChange: ['three month change', '3 か月の推移', '3か月の推移'],
  yoyChange: ['yoy change', '前年比の推移'],
  bidLow: ['top of page bid (low range)', 'ページ上部に掲載された広告の入札単価（低額帯）'],
  bidHigh: ['top of page bid (high range)', 'ページ上部に掲載された広告の入札単価（高額帯）'],
};

/**
 * 突き合わせ用にキーワードを正規化する。
 *
 * キーワードプランナーは日本語を分かち書きして出力する（「英 検 2 級 ライティング」）。
 * 一方 Search Console のクエリは素のまま（「英検2級 ライティング」）。
 * 空白をすべて除去し、全角英数を半角に寄せて比較する。
 */
export function normalizeKeyword(s) {
  return String(s ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, '')
    .trim();
}

/** UTF-16LE / UTF-8 / BOM付きを判別して文字列にする */
export function decodeFile(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le').replace(/^﻿/, '');
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    // UTF-16BE。バイトを入れ替えてから読む
    const swapped = Buffer.from(buffer);
    swapped.swap16();
    return swapped.toString('utf16le').replace(/^﻿/, '');
  }
  return buffer.toString('utf8').replace(/^﻿/, '');
}

/** タブ区切りかカンマ区切りかを、ヘッダー行から推定する */
function detectDelimiter(line) {
  return (line.match(/\t/g)?.length ?? 0) >= (line.match(/,/g)?.length ?? 0) ? '\t' : ',';
}

function splitRow(line, delimiter) {
  if (delimiter === '\t') return line.split('\t');
  // 簡易CSVパーサ（引用符対応）
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function findColumns(header) {
  const lower = header.map((h) => String(h ?? '').trim().toLowerCase());
  const index = {};
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES)) {
    index[key] = lower.findIndex((h) => aliases.includes(h));
  }
  return index;
}

function toNumber(raw) {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw).replace(/[,\s]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function toPercent(raw) {
  if (raw === undefined || raw === null) return null;
  const cleaned = String(raw).replace(/[,\s%]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '—') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n / 100 : null;
}

/**
 * 1ファイルを読んでキーワード行の配列を返す。
 * ヘッダー行が見つからない場合はエラーにする（黙って0件を返さない）。
 */
export function parseKeywordPlannerFile(filePath) {
  const text = decodeFile(fs.readFileSync(filePath));
  const lines = text.split(/\r?\n/);

  let headerIndex = -1;
  let columns = null;
  let delimiter = '\t';
  // 先頭数行はタイトル・期間などのため、ヘッダーを探しにいく
  for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
    if (!lines[i].trim()) continue;
    const d = detectDelimiter(lines[i]);
    const cols = findColumns(splitRow(lines[i], d));
    if (cols.keyword >= 0 && cols.volume >= 0) {
      headerIndex = i;
      columns = cols;
      delimiter = d;
      break;
    }
  }

  if (headerIndex === -1) {
    throw new Error(
      `キーワードプランナーのヘッダー行が見つかりません: ${path.basename(filePath)}\n` +
        '  「Keyword」と「Avg. monthly searches」（または「キーワード」「月間平均検索ボリューム」）の\n' +
        '  列を含むファイルを指定してください。'
    );
  }

  const rows = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    const cells = splitRow(line, delimiter);
    const keyword = String(cells[columns.keyword] ?? '').trim();
    // 集計行（Segmentation の「すべて」「日本」など）はキーワードが空
    if (!keyword) continue;

    rows.push({
      keyword,
      normalized: normalizeKeyword(keyword),
      volume: toNumber(cells[columns.volume]),
      competition: columns.competition >= 0 ? String(cells[columns.competition] ?? '').trim() || null : null,
      competitionIndex: columns.competitionIndex >= 0 ? toNumber(cells[columns.competitionIndex]) : null,
      threeMonthChange: columns.threeMonthChange >= 0 ? toPercent(cells[columns.threeMonthChange]) : null,
      yoyChange: columns.yoyChange >= 0 ? toPercent(cells[columns.yoyChange]) : null,
      bidLow: columns.bidLow >= 0 ? toNumber(cells[columns.bidLow]) : null,
      bidHigh: columns.bidHigh >= 0 ? toNumber(cells[columns.bidHigh]) : null,
      source: path.basename(filePath),
    });
  }

  return rows;
}

/**
 * ディレクトリ内の全ファイルを読み、正規化キーワードで重複排除する。
 * 同じキーワードが複数ファイルにある場合はボリュームが大きいほうを採用する。
 */
export function loadKeywordPlannerDir(dir) {
  if (!fs.existsSync(dir)) {
    return { keywords: [], files: [], missingDir: dir };
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => /\.(csv|tsv)$/i.test(f) && !f.startsWith('.'))
    .map((f) => path.join(dir, f));

  const byKey = new Map();
  const errors = [];
  for (const file of files) {
    let rows;
    try {
      rows = parseKeywordPlannerFile(file);
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    for (const row of rows) {
      const existing = byKey.get(row.normalized);
      if (!existing || (row.volume ?? 0) > (existing.volume ?? 0)) byKey.set(row.normalized, row);
    }
  }

  return {
    keywords: [...byKey.values()].sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)),
    files: files.map((f) => path.basename(f)),
    errors,
  };
}
