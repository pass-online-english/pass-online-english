// タイムゾーン関連のユーティリティ。
// クライアント側は「固定オフセット(分)」だけを受け取って計算するため、
// 古いブラウザの Intl 実装差異に依存しない。

/** 指定タイムゾーンの、その時点でのUTCオフセット(分)を返す。Asia/Tokyo なら 540。 */
export function tzOffsetMinutes(timeZone, date = new Date()) {
  try {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = {};
    for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
    const asUTC = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
    );
    return Math.round((asUTC - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  } catch (_e) {
    return 540; // Asia/Tokyo フォールバック
  }
}

/** UTCミリ秒 → 指定オフセットにおけるローカル日付要素 */
export function partsFor(ms, offsetMin) {
  const d = new Date(ms + offsetMin * 60000);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    weekday: d.getUTCDay(),
  };
}

const pad2 = (n) => (n < 10 ? '0' + n : String(n));

/** UTCミリ秒 → "YYYY-MM-DD"（ローカル日） */
export function dayKey(ms, offsetMin) {
  const p = partsFor(ms, offsetMin);
  return p.year + '-' + pad2(p.month) + '-' + pad2(p.day);
}

/** "YYYY-MM-DD"(+ 時刻) のローカル時刻 → UTCミリ秒 */
export function localToMs(dateStr, offsetMin, hour = 0, minute = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return NaN;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute, 0) - offsetMin * 60000;
}

/** "YYYY-MM-DD" に日数を足す */
export function addDays(dateStr, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return dateStr;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

/** "HH:MM" → 0時からの分。パースできなければ fallback。 */
export function hhmmToMinutes(value, fallback = 0) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
  if (!m) return fallback;
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return fallback;
  return h * 60 + mi;
}

export { pad2 };
