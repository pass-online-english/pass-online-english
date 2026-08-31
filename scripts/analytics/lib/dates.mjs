/**
 * 期間の計算。すべて UTC 基準の YYYY-MM-DD 文字列で扱う。
 * GA4 / Search Console はどちらもプロパティのタイムゾーンで日付を解釈するため、
 * ここでは「暦日」の計算だけを行う。
 */
const DAY_MS = 86_400_000;

export function toISO(dateMs) {
  return new Date(dateMs).toISOString().slice(0, 10);
}

export function parseISO(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`日付は YYYY-MM-DD 形式で指定してください（受け取った値: ${s}）`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(ms)) throw new Error(`日付として解釈できません: ${s}`);
  return ms;
}

export function todayUTC() {
  return Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate()
  );
}

export function shiftDays(iso, days) {
  return toISO(parseISO(iso) + days * DAY_MS);
}

/** 両端を含む日数 */
export function lengthInDays(range) {
  return Math.round((parseISO(range.endDate) - parseISO(range.startDate)) / DAY_MS) + 1;
}

/**
 * 期間を決める。
 *  - --start / --end 指定があればそれを使う
 *  - なければ「今日 - lagDays」を終端に、days 日間（終端を含む）
 */
export function resolveRange({ days, start, end, lagDays = 0 } = {}) {
  if (start && end) {
    const range = { startDate: toISO(parseISO(start)), endDate: toISO(parseISO(end)) };
    if (parseISO(range.startDate) > parseISO(range.endDate)) {
      throw new Error(`--start が --end より後になっています（${range.startDate} > ${range.endDate}）`);
    }
    return range;
  }
  if (start && !end) {
    const startDate = toISO(parseISO(start));
    return { startDate, endDate: toISO(todayUTC() - lagDays * DAY_MS) };
  }

  const n = Number.parseInt(days ?? '28', 10);
  if (!Number.isFinite(n) || n < 1) throw new Error(`--days は1以上の整数で指定してください（受け取った値: ${days}）`);

  const endDate = toISO(todayUTC() - lagDays * DAY_MS);
  const startDate = shiftDays(endDate, -(n - 1));
  return { startDate, endDate };
}

/** 直前の同じ長さの期間 */
export function previousRange(range) {
  const len = lengthInDays(range);
  const endDate = shiftDays(range.startDate, -1);
  return { startDate: shiftDays(endDate, -(len - 1)), endDate };
}

/**
 * 前年同期。
 * 364日（= 52週）ずらすことで曜日を揃える。週次の増減を比較する際、
 * 暦日を揃えると曜日がずれて誤差になるため、既定は曜日揃えとする。
 */
export function yoyRange(range, { mode = 'weekday' } = {}) {
  if (mode === 'calendar') {
    const shiftYear = (iso) => {
      const [y, m, d] = iso.split('-').map(Number);
      return toISO(Date.UTC(y - 1, m - 1, d));
    };
    return { startDate: shiftYear(range.startDate), endDate: shiftYear(range.endDate) };
  }
  return {
    startDate: shiftDays(range.startDate, -364),
    endDate: shiftDays(range.endDate, -364),
  };
}

/**
 * --compare の値から比較期間を返す。
 *   none | previous | yoy | yoy-calendar
 */
export function comparisonRange(range, compare) {
  const mode = (compare ?? 'previous').toLowerCase();
  if (mode === 'none' || mode === 'off' || mode === 'false') return null;
  if (mode === 'previous' || mode === 'prev') return { ...previousRange(range), label: '前期間' };
  if (mode === 'yoy') return { ...yoyRange(range), label: '前年同期（曜日揃え / 364日前）' };
  if (mode === 'yoy-calendar') return { ...yoyRange(range, { mode: 'calendar' }), label: '前年同期（暦日揃え）' };
  throw new Error(`--compare の値が不正です: ${compare}（none | previous | yoy | yoy-calendar）`);
}

export function formatRange(range) {
  return `${range.startDate} 〜 ${range.endDate}（${lengthInDays(range)}日間）`;
}

/**
 * データ保持期間を超えていないか警告する。
 *  - Search Console: 16か月
 *  - GA4: プロパティのイベントデータ保持設定（既定2か月 / 最大14か月）に依存
 */
export function retentionWarnings(range, source) {
  const warnings = [];
  const ageDays = Math.round((todayUTC() - parseISO(range.startDate)) / DAY_MS);
  if (source === 'gsc' && ageDays > 16 * 30) {
    warnings.push(
      `Search Console のデータ保持期間は約16か月です。${range.startDate} は保持期間外の可能性があり、0行または欠損として返ります。`
    );
  }
  if (source === 'ga4' && ageDays > 14 * 30) {
    warnings.push(
      `GA4 のイベントデータ保持期間は最長14か月です。${range.startDate} は保持期間外の可能性があります。` +
        'GA4 → 管理 → データ設定 → データ保持 が「2か月」の場合、それより前は取得できません（設定変更はこのツールでは行いません）。'
    );
  }
  return warnings;
}
