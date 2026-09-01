// Open-Meteo(APIキー不要) の取得と、生活判断につながるルールベースの行動コメント(要件14/15)。
// 閾値はすべて config.weatherThresholds から取り、AI判定は行わない。

import { dayKey, addDays, hhmmToMinutes, partsFor, pad2 } from './time.js';

const WMO = {
  0:  { icon: '☀', label: '快晴' },
  1:  { icon: '🌤', label: '晴れ' },
  2:  { icon: '⛅', label: '晴れ時々くもり' },
  3:  { icon: '☁', label: 'くもり' },
  45: { icon: '🌫', label: '霧' },
  48: { icon: '🌫', label: '霧氷' },
  51: { icon: '🌦', label: '霧雨' },
  53: { icon: '🌦', label: '霧雨' },
  55: { icon: '🌦', label: '強い霧雨' },
  56: { icon: '🌧', label: '着氷性の霧雨' },
  57: { icon: '🌧', label: '着氷性の霧雨' },
  61: { icon: '☂', label: '小雨' },
  63: { icon: '☂', label: '雨' },
  65: { icon: '🌧', label: '強い雨' },
  66: { icon: '🌧', label: '着氷性の雨' },
  67: { icon: '🌧', label: '着氷性の雨' },
  71: { icon: '❄', label: '小雪' },
  73: { icon: '❄', label: '雪' },
  75: { icon: '❄', label: '大雪' },
  77: { icon: '❄', label: '霧雪' },
  80: { icon: '🌦', label: 'にわか雨' },
  81: { icon: '🌦', label: 'にわか雨' },
  82: { icon: '🌧', label: '激しいにわか雨' },
  85: { icon: '🌨', label: 'にわか雪' },
  86: { icon: '🌨', label: '強いにわか雪' },
  95: { icon: '⛈', label: '雷雨' },
  96: { icon: '⛈', label: '雹を伴う雷雨' },
  99: { icon: '⛈', label: '雹を伴う雷雨' },
};

export function describeCode(code) {
  return WMO[code] || { icon: '·', label: '—' };
}

function round(v, digits = 0) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return null;
  const f = Math.pow(10, digits);
  return Math.round(Number(v) * f) / f;
}

/** Open-Meteo から取得して正規化する */
export async function fetchWeather(config, options = {}) {
  const offsetMin = options.offsetMin;
  const span = (Number(config.weekStartOffset) || 0) + (Number(config.daysToDisplay) || 7) + 1;
  const days = Math.min(16, Math.max(8, span));
  const url = 'https://api.open-meteo.com/v1/forecast'
    + '?latitude=' + encodeURIComponent(config.latitude)
    + '&longitude=' + encodeURIComponent(config.longitude)
    + '&timezone=' + encodeURIComponent(config.timezone)
    + '&forecast_days=' + days
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day'
    + '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum,sunrise,sunset,uv_index_max,wind_speed_10m_max'
    + '&wind_speed_unit=ms';

  const res = await fetch(url);
  if (!res.ok) throw new Error('Open-Meteo の取得に失敗 (' + res.status + ')');
  const json = await res.json();
  if (!json || !json.daily) throw new Error('Open-Meteo のレスポンスが不正です');

  const cur = json.current || {};
  const current = {
    temp: round(cur.temperature_2m, 1),
    apparent: round(cur.apparent_temperature, 1),
    humidity: round(cur.relative_humidity_2m),
    precipitation: round(cur.precipitation, 1),
    wind: round(cur.wind_speed_10m, 1),
    code: cur.weather_code,
    isDay: cur.is_day !== 0,
    ...describeCode(cur.weather_code),
  };

  const d = json.daily;
  const daily = (d.time || []).map((date, i) => ({
    date,
    code: d.weather_code[i],
    ...describeCode(d.weather_code[i]),
    tmax: round(d.temperature_2m_max[i], 0),
    tmin: round(d.temperature_2m_min[i], 0),
    pop: round(d.precipitation_probability_max[i]),
    precipSum: round(d.precipitation_sum[i], 1),
    sunrise: d.sunrise ? String(d.sunrise[i]).slice(11, 16) : null,
    sunset: d.sunset ? String(d.sunset[i]).slice(11, 16) : null,
    uv: round(d.uv_index_max ? d.uv_index_max[i] : null, 1),
    wind: round(d.wind_speed_10m_max ? d.wind_speed_10m_max[i] : null, 1),
  }));

  const h = json.hourly || {};
  const hourly = (h.time || []).map((t, i) => ({
    time: t,                       // "YYYY-MM-DDTHH:MM"（config.timezone のローカル時刻）
    date: String(t).slice(0, 10),
    hour: Number(String(t).slice(11, 13)),
    temp: round(h.temperature_2m[i], 1),
    pop: round(h.precipitation_probability ? h.precipitation_probability[i] : null),
    precip: round(h.precipitation ? h.precipitation[i] : null, 1),
    code: h.weather_code ? h.weather_code[i] : null,
  }));

  const today = options.today || dayKey(Date.now(), offsetMin);
  const tomorrow = addDays(today, 1);

  return {
    fetchedAt: Date.now(),
    locationName: config.locationName,
    current,
    daily,
    hourly: hourly.filter((x) => x.date >= today && x.date <= addDays(today, 2)),
    comments: {
      today: buildDayComments(config, daily, hourly, today, { fromHour: partsFor(Date.now(), offsetMin).hour }),
      tonight: buildTonightComments(config, hourly, today),
      tomorrow: buildDayComments(config, daily, hourly, tomorrow, {}),
    },
  };
}

function findRainStart(hourlyOfDay, threshold, fromHour) {
  for (const x of hourlyOfDay) {
    if (fromHour !== undefined && x.hour < fromHour) continue;
    if (x.pop !== null && x.pop >= threshold) return x.hour;
  }
  return null;
}

/**
 * 1日分の行動コメントを組み立てる（純粋関数：テスト対象）。
 * @returns {Array<{icon:string,text:string,detail:string,level:string}>}
 */
export function buildDayComments(config, daily, hourly, date, options = {}) {
  const th = config.weatherThresholds || {};
  const day = daily.find((x) => x.date === date);
  const hours = hourly.filter((x) => x.date === date);
  const out = [];
  if (!day) return out;

  // --- 雨 ---
  const rainHour = findRainStart(hours, th.rainPop, options.fromHour);
  if (rainHour !== null) {
    const later = options.fromHour !== undefined && rainHour > options.fromHour;
    out.push({
      icon: '☂',
      text: later ? pad2(rainHour) + '時以降 雨' : '雨',
      detail: '傘推奨',
      level: 'alert',
    });
  } else if ((day.pop || 0) >= th.rainPop) {
    out.push({ icon: '☂', text: '雨の予報', detail: '傘推奨', level: 'alert' });
  } else if ((day.pop || 0) >= th.lightRainPop) {
    out.push({ icon: '🌂', text: '降水確率 ' + day.pop + '%', detail: '折りたたみ傘があると安心', level: 'warn' });
  }

  if ((day.precipSum || 0) >= th.heavyRainMm) {
    out.push({ icon: '🌧', text: 'まとまった雨 ' + day.precipSum + 'mm', detail: '長靴・移動時間に余裕を', level: 'alert' });
  }

  // --- 気温 ---
  if (day.tmax !== null && day.tmax >= th.veryHotTemp) {
    out.push({ icon: '🥵', text: '最高' + day.tmax + '℃', detail: '猛暑注意・水分補給', level: 'alert' });
  } else if (day.tmax !== null && day.tmax >= th.hotTemp) {
    out.push({ icon: '☀', text: '最高' + day.tmax + '℃', detail: '暑さ注意', level: 'warn' });
  }
  if (day.tmin !== null && day.tmin <= th.freezeTemp) {
    out.push({ icon: '🧊', text: '最低' + day.tmin + '℃', detail: '路面凍結注意', level: 'alert' });
  } else if (day.tmin !== null && day.tmin <= th.coldTemp) {
    out.push({ icon: '🧥', text: '最低' + day.tmin + '℃', detail: '厚手の上着を', level: 'warn' });
  }
  if (day.tmax !== null && day.tmin !== null && day.tmax - day.tmin >= th.tempSwing
      && day.tmax < th.veryHotTemp) {
    out.push({ icon: '🌡', text: '朝晩の寒暖差大', detail: '羽織るもの推奨', level: 'info' });
  }

  // --- その他 ---
  if (day.wind !== null && day.wind >= th.windSpeed) {
    out.push({ icon: '🌬', text: '強風 ' + day.wind + 'm/s', detail: '自転車・傘に注意', level: 'warn' });
  }
  if (day.uv !== null && day.uv >= th.uvIndex) {
    out.push({ icon: '😎', text: '紫外線が強い', detail: '日焼け対策を', level: 'info' });
  }
  if (out.length === 0 && (day.pop === null || day.pop < th.laundryPop) && day.code <= 2) {
    out.push({ icon: '🧺', text: '洗濯日和', detail: '', level: 'info' });
  }
  return out;
}

/** 夕方以降(tonightStartTime〜)の天気コメント */
export function buildTonightComments(config, hourly, date) {
  const th = config.weatherThresholds || {};
  const startHour = Math.floor(hhmmToMinutes(config.tonightStartTime, 17 * 60) / 60);
  const hours = hourly.filter((x) => x.date === date && x.hour >= startHour);
  const out = [];
  if (!hours.length) return out;

  const rainHour = findRainStart(hours, th.rainPop);
  if (rainHour !== null) {
    out.push({ icon: '☂', text: pad2(rainHour) + '時以降 雨', detail: '傘推奨', level: 'alert' });
  }
  const temps = hours.map((x) => x.temp).filter((t) => t !== null);
  if (temps.length) {
    const min = Math.min.apply(null, temps);
    if (min <= th.coldTemp) {
      out.push({ icon: '🧥', text: '夜は' + Math.round(min) + '℃', detail: '冷え込み注意', level: 'warn' });
    }
  }
  return out;
}
