/**
 * Google Search Console API (searchconsole v1) クライアント。
 * searchanalytics.query は 1リクエスト最大 25,000 行のため、startRow でページングする。
 */
import { google } from 'googleapis';
import { getAuthClient, explainApiError } from './auth.mjs';
import { searchConsoleSiteUrl } from './env.mjs';

const PAGE_SIZE = 25_000;

let gscApi = null;
async function api() {
  if (!gscApi) gscApi = google.searchconsole({ version: 'v1', auth: await getAuthClient() });
  return gscApi;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const status = err?.code ?? err?.response?.status;
  return status === 429 || status === 500 || status === 503 || status === 504;
}

async function callWithRetry(fn, { attempts = 4 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || i === attempts - 1) throw err;
      await sleep(2000 * 2 ** i);
    }
  }
  throw lastErr;
}

/**
 * 検索パフォーマンスの取得。
 *
 * @param {object} opts
 * @param {string} opts.startDate  YYYY-MM-DD
 * @param {string} opts.endDate    YYYY-MM-DD
 * @param {string[]} opts.dimensions  query | page | country | device | date | searchAppearance
 * @param {number} [opts.maxRows]  取得上限（既定 25000）
 * @param {object[]} [opts.dimensionFilterGroups]
 * @param {'web'|'image'|'video'|'news'|'discover'|'googleNews'} [opts.type]
 * @param {'final'|'all'} [opts.dataState]  all を指定すると未確定データも含む
 */
export async function querySearchAnalytics({
  startDate,
  endDate,
  dimensions = [],
  maxRows = PAGE_SIZE,
  dimensionFilterGroups,
  type = 'web',
  dataState = 'final',
} = {}) {
  const siteUrl = searchConsoleSiteUrl();
  const rows = [];

  for (let startRow = 0; rows.length < maxRows; startRow += PAGE_SIZE) {
    const rowLimit = Math.min(PAGE_SIZE, maxRows - rows.length);
    const requestBody = {
      startDate,
      endDate,
      dimensions,
      rowLimit,
      startRow,
      type,
      dataState,
      ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
    };

    let res;
    try {
      res = await callWithRetry(() => api().then((a) => a.searchanalytics.query({ siteUrl, requestBody })));
    } catch (err) {
      throw new Error(explainApiError(err, 'Search Console API'));
    }

    const page = res.data.rows ?? [];
    for (const row of page) {
      const obj = {};
      dimensions.forEach((d, i) => {
        obj[d] = row.keys?.[i] ?? '';
      });
      obj.clicks = row.clicks ?? 0;
      obj.impressions = row.impressions ?? 0;
      obj.ctr = row.ctr ?? 0;
      obj.position = row.position ?? 0;
      rows.push(obj);
    }
    if (page.length < rowLimit) break;
  }

  return {
    siteUrl,
    range: { startDate, endDate },
    dimensions,
    rows,
    /**
     * Search Console はプライバシー保護のため検索数の少ないクエリを開示しない。
     * そのため query 別の clicks 合計はサイト全体の clicks と一致しない（仕様）。
     */
    anonymizedQueriesPossible: dimensions.includes('query'),
  };
}

/** サイト全体の合計（ディメンションなし） */
export async function queryTotals({ startDate, endDate, type = 'web', dataState = 'final' } = {}) {
  const res = await querySearchAnalytics({ startDate, endDate, dimensions: [], maxRows: 1, type, dataState });
  const row = res.rows[0];
  return {
    clicks: row?.clicks ?? 0,
    impressions: row?.impressions ?? 0,
    ctr: row?.ctr ?? 0,
    position: row?.position ?? 0,
  };
}

/** アクセス可能なサイト一覧と権限レベル（doctor 用） */
export async function listSites() {
  try {
    const res = await callWithRetry(() => api().then((a) => a.sites.list({})));
    return res.data.siteEntry ?? [];
  } catch (err) {
    throw new Error(explainApiError(err, 'Search Console API (sites.list)'));
  }
}
