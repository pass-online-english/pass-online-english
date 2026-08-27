/**
 * GA4 Data API (v1beta) クライアント。
 *
 * GA4 は dimension / metric の名称が改称されることがある
 * （例: conversions → keyEvents, landingPage → landingPagePlusQueryString）。
 * 本ファイルでは
 *   1) 既知の新旧対応表による自動フォールバック
 *   2) それでも通らない項目は「除外して続行」＋警告
 * を行い、名称変更でレポート全体が落ちないようにする。
 * 実際に有効な名称は `npm run analytics:schema` でプロパティから直接検証できる。
 */
import { google } from 'googleapis';
import { getAuthClient, explainApiError } from './auth.mjs';
import { ga4PropertyId } from './env.mjs';

/** 新名称 → 旧名称のフォールバック候補 */
const METRIC_FALLBACKS = {
  keyEvents: ['conversions'],
  sessionKeyEventRate: ['sessionConversionRate'],
};
const DIMENSION_FALLBACKS = {
  landingPagePlusQueryString: ['landingPage'],
  sessionDefaultChannelGroup: ['defaultChannelGroup', 'sessionDefaultChannelGrouping'],
  isKeyEvent: ['isConversionEvent'],
};

/** 実行中に確定した名称の置換結果（レポートの注記に載せる） */
export const schemaNotes = {
  substitutions: new Map(), // requested -> used
  dropped: new Set(),
  warnings: [],
};

let dataApi = null;
async function api() {
  if (!dataApi) dataApi = google.analyticsdata({ version: 'v1beta', auth: await getAuthClient() });
  return dataApi;
}

function property() {
  return `properties/${ga4PropertyId()}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetryable(err) {
  const status = err?.code ?? err?.response?.status;
  return status === 429 || status === 500 || status === 503 || status === 504;
}

function errorText(err) {
  return err?.response?.data?.error?.message ?? err?.message ?? String(err);
}

/** エラーメッセージから、拒否されたフィールド名を拾う */
function offendingFields(err, candidates) {
  const text = errorText(err);
  return candidates.filter((name) => new RegExp(`\\b${name}\\b`).test(text));
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
 * runReport の実行。名称エラーが出たら置換 → 除外の順で再試行する。
 *
 * @param {object} spec
 * @param {string[]} spec.dimensions
 * @param {string[]} spec.metrics
 * @param {{startDate:string,endDate:string}[]} spec.dateRanges
 * @param {number} [spec.limit]
 * @param {object[]} [spec.orderBys]
 * @param {object} [spec.dimensionFilter]
 * @param {boolean} [spec.keepEmptyRows]
 */
export async function runReport(spec) {
  let dimensions = [...(spec.dimensions ?? [])];
  let metrics = [...(spec.metrics ?? [])];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const requestBody = buildBody({ ...spec, dimensions, metrics });
    try {
      const res = await callWithRetry(() => api().then((a) => a.properties.runReport({ property: property(), requestBody })));
      return normalize(res.data, { dimensions, metrics, spec });
    } catch (err) {
      const status = err?.code ?? err?.response?.status;
      if (status !== 400) throw new Error(explainApiError(err, 'GA4 Data API'));

      const badMetrics = offendingFields(err, metrics);
      const badDims = offendingFields(err, dimensions);
      if (!badMetrics.length && !badDims.length) throw new Error(explainApiError(err, 'GA4 Data API'));

      let changed = false;
      for (const name of badMetrics) {
        const next = pickFallback(name, METRIC_FALLBACKS, metrics);
        changed = applyChange(metrics, name, next) || changed;
      }
      for (const name of badDims) {
        const next = pickFallback(name, DIMENSION_FALLBACKS, dimensions);
        changed = applyChange(dimensions, name, next) || changed;
      }
      if (!changed) throw new Error(explainApiError(err, 'GA4 Data API'));
      if (!metrics.length) throw new Error(`GA4: 利用可能な指標が残りませんでした。\n${errorText(err)}`);
    }
  }
  throw new Error('GA4: 指標・ディメンション名の解決に失敗しました。`npm run analytics:schema` で有効な名称を確認してください。');
}

function pickFallback(name, table, alreadyUsed) {
  const tried = schemaNotes.substitutions.get(name);
  const candidates = (table[name] ?? []).filter((c) => c !== tried && !alreadyUsed.includes(c));
  return candidates[0] ?? null;
}

function applyChange(list, from, to) {
  const idx = list.indexOf(from);
  if (idx === -1) return false;
  if (to) {
    list[idx] = to;
    schemaNotes.substitutions.set(from, to);
    schemaNotes.warnings.push(`GA4: "${from}" は使用できないため "${to}" に置き換えました。`);
  } else {
    list.splice(idx, 1);
    schemaNotes.dropped.add(from);
    schemaNotes.warnings.push(`GA4: "${from}" は使用できないため取得対象から除外しました。`);
  }
  return true;
}

function buildBody(spec) {
  const body = {
    dateRanges: spec.dateRanges,
    dimensions: spec.dimensions.map((name) => ({ name })),
    metrics: spec.metrics.map((name) => ({ name })),
    limit: String(spec.limit ?? 10000),
    keepEmptyRows: spec.keepEmptyRows ?? false,
    returnPropertyQuota: true,
  };
  if (spec.orderBys) body.orderBys = spec.orderBys;
  else if (spec.metrics.length) body.orderBys = [{ metric: { metricName: spec.metrics[0] }, desc: true }];
  if (spec.dimensionFilter) body.dimensionFilter = spec.dimensionFilter;
  if (spec.offset) body.offset = String(spec.offset);
  return body;
}

function numeric(name, raw) {
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function normalize(data, { dimensions, metrics }) {
  const dimHeaders = (data.dimensionHeaders ?? []).map((h) => h.name);
  const metHeaders = (data.metricHeaders ?? []).map((h) => h.name);

  const rows = (data.rows ?? []).map((row) => {
    const obj = {};
    dimHeaders.forEach((name, i) => {
      obj[name] = row.dimensionValues?.[i]?.value ?? '';
    });
    metHeaders.forEach((name, i) => {
      obj[name] = numeric(name, row.metricValues?.[i]?.value);
    });
    return obj;
  });

  const totals = {};
  const totalRow = data.totals?.[0];
  if (totalRow) metHeaders.forEach((name, i) => { totals[name] = numeric(name, totalRow.metricValues?.[i]?.value); });

  return {
    dimensions: dimHeaders,
    metrics: metHeaders,
    requested: { dimensions, metrics },
    rows,
    totals,
    rowCount: data.rowCount ?? rows.length,
    /** 抽出（サンプリング）が行われた場合のみ true */
    sampled: Boolean(data.metadata?.samplingMetadatas?.length),
    /** カーディナリティ上限により (other) 行が発生した場合 true */
    hasOtherRow: Boolean(data.metadata?.subjectToThresholding) || rows.some((r) => Object.values(r).includes('(other)')),
  };
}

/**
 * 2期間を1リクエストで取得する（GA4 は dateRanges を最大4つまで受け付ける）。
 * 返り値の rows には dateRange キー（date_range_0 / date_range_1）が入る。
 */
export async function runComparisonReport(spec, current, comparison) {
  const dateRanges = comparison
    ? [
        { startDate: current.startDate, endDate: current.endDate, name: 'current' },
        { startDate: comparison.startDate, endDate: comparison.endDate, name: 'comparison' },
      ]
    : [{ startDate: current.startDate, endDate: current.endDate, name: 'current' }];

  const res = await runReport({ ...spec, dateRanges });

  if (!comparison) {
    return { current: res, comparison: null };
  }

  // dateRange ディメンションが自動付与されるので、期間ごとに分割する
  const split = { current: [], comparison: [] };
  for (const row of res.rows) {
    const bucket = row.dateRange === 'comparison' ? 'comparison' : 'current';
    const { dateRange, ...rest } = row;
    split[bucket].push(rest);
  }
  const dims = res.dimensions.filter((d) => d !== 'dateRange');
  return {
    current: { ...res, dimensions: dims, rows: split.current, totals: res.totals },
    comparison: { ...res, dimensions: dims, rows: split.comparison, totals: {} },
  };
}

/** プロパティのメタデータ（有効な dimension / metric 一覧）を取得 */
export async function getMetadata() {
  try {
    const res = await callWithRetry(() =>
      api().then((a) => a.properties.getMetadata({ name: `${property()}/metadata` }))
    );
    return res.data;
  } catch (err) {
    throw new Error(explainApiError(err, 'GA4 Data API (getMetadata)'));
  }
}
