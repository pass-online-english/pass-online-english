// すべての設定値はここに集約する。ハードコード禁止(要件26)。
// 優先順位: DEFAULT_CONFIG < CONFIG_JSON(環境変数) < 個別の環境変数

export const DEFAULT_CONFIG = {
  timezone: 'Asia/Tokyo',
  locale: 'ja-JP',

  // 天気の位置（既定: 東京駅）
  latitude: 35.681236,
  longitude: 139.767125,
  locationName: '東京',

  // 複数カレンダー。種類はコードに固定せず、ここで自由に定義する(要件11)。
  // person は色分け・TONIGHT・FREE TOGETHER のグルーピングに使う(要件12)。
  calendars: [
    { key: 'me',     calendarId: 'primary', displayName: '自分', color: '#4FC3F7', person: 'me',     enabled: true },
    { key: 'wife',   calendarId: '',        displayName: '妻',   color: '#F48FB1', person: 'wife',   enabled: false },
    { key: 'shared', calendarId: '',        displayName: '共通', color: '#A5D6A7', person: 'shared', enabled: false },
  ],

  // Google Tasks のリスト
  taskLists: [
    { id: '@default', name: 'Tasks', enabled: true },
  ],

  daysToDisplay: 7,
  maxEventsPerDay: 4,
  maxTodayEvents: 6,
  maxTasks: 6,

  // COMING UP(要件16)
  comingUp: {
    enabled: true,
    maxItems: 3,
    lookaheadDays: 30,
    importantCalendarId: '',
    importantTags: ['★', '【重要】', '#imp'],
  },

  // NEXT(要件6)
  nextIncludesAllDay: false,
  nextLookaheadHours: 36,

  tonightStartTime: '17:00',      // 要件8
  tomorrowEmphasisTime: '20:00',  // 要件9

  // 更新間隔(ミリ秒) 要件22
  refresh: {
    clock: 1000,
    calendar: 300000,   // 5分
    tasks: 300000,      // 5分
    weather: 1800000,   // 30分
    page: 21600000,     // 6時間ごとに全体リロード(常時表示端末のメモリ対策・デプロイ追従)
    retryBaseMs: 15000, // 失敗時リトライの初期値
    retryMaxMs: 300000, // 失敗時リトライの上限
  },

  // 夜間モード(要件25)
  nightMode: {
    enabled: true,
    start: '00:00',
    end: '06:00',
    dim: 0.62,
    reduce: true, // 情報量を減らし時計を中心にする
  },

  // 二人の共通空き時間(要件17)
  freeTogether: {
    enabled: true,
    persons: ['me', 'wife'],
    windowStart: '18:00',
    windowEnd: '23:00',
    weekendStart: '10:00',
    minMinutes: 60,
    maxItems: 3,
    days: 7,
  },

  // 天気コメントの判定閾値(要件15)
  weatherThresholds: {
    rainPop: 50,          // 降水確率(%)でこれ以上なら傘
    lightRainPop: 30,     // 念のため傘
    heavyRainMm: 5,       // 1日の降水量(mm)
    veryHotTemp: 35,
    hotTemp: 33,
    warmTemp: 28,
    coldTemp: 5,
    freezeTemp: 0,
    tempSwing: 10,        // 最高-最低の差
    windSpeed: 10,        // m/s
    uvIndex: 8,
    laundryPop: 20,       // これ未満なら洗濯日和
  },

  authorizedUsers: [],
};

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return override === undefined ? base : override;
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  for (const key of Object.keys(override)) {
    const b = isPlainObject(base) ? base[key] : undefined;
    const o = override[key];
    out[key] = isPlainObject(b) && isPlainObject(o) ? deepMerge(b, o) : o;
  }
  return out;
}

function parseJsonEnv(raw, label, warnings) {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (e) {
    warnings.push(label + ' のJSONを解析できませんでした: ' + e.message);
    return undefined;
  }
}

function num(raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function slug(value, index) {
  const s = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return s || 'cal' + index;
}

/**
 * 環境変数からアプリ設定を組み立てる。
 * ここで返す config は「秘密情報を含まない」ことを保証する（calendarId を除く）。
 */
export function loadConfig(env = {}) {
  const warnings = [];
  let config = DEFAULT_CONFIG;

  const fromJson = parseJsonEnv(env.CONFIG_JSON, 'CONFIG_JSON', warnings);
  if (fromJson) config = deepMerge(config, fromJson);

  const calendars = parseJsonEnv(env.CALENDARS_JSON, 'CALENDARS_JSON', warnings);
  if (Array.isArray(calendars)) config = deepMerge(config, { calendars });

  const taskLists = parseJsonEnv(env.TASK_LISTS_JSON, 'TASK_LISTS_JSON', warnings);
  if (Array.isArray(taskLists)) config = deepMerge(config, { taskLists });

  const scalar = {};
  if (env.TIMEZONE) scalar.timezone = env.TIMEZONE;
  if (num(env.LATITUDE) !== undefined) scalar.latitude = num(env.LATITUDE);
  if (num(env.LONGITUDE) !== undefined) scalar.longitude = num(env.LONGITUDE);
  if (env.LOCATION_NAME) scalar.locationName = env.LOCATION_NAME;
  if (num(env.DAYS_TO_DISPLAY) !== undefined) scalar.daysToDisplay = num(env.DAYS_TO_DISPLAY);
  if (num(env.MAX_EVENTS_PER_DAY) !== undefined) scalar.maxEventsPerDay = num(env.MAX_EVENTS_PER_DAY);
  if (num(env.MAX_TASKS) !== undefined) scalar.maxTasks = num(env.MAX_TASKS);
  if (env.TONIGHT_START_TIME) scalar.tonightStartTime = env.TONIGHT_START_TIME;
  if (env.TOMORROW_EMPHASIS_TIME) scalar.tomorrowEmphasisTime = env.TOMORROW_EMPHASIS_TIME;
  if (env.IMPORTANT_CALENDAR_ID) scalar.comingUp = { importantCalendarId: env.IMPORTANT_CALENDAR_ID };
  if (num(env.CALENDAR_REFRESH_INTERVAL) !== undefined) scalar.refresh = Object.assign(scalar.refresh || {}, { calendar: num(env.CALENDAR_REFRESH_INTERVAL) });
  if (num(env.TASK_REFRESH_INTERVAL) !== undefined) scalar.refresh = Object.assign(scalar.refresh || {}, { tasks: num(env.TASK_REFRESH_INTERVAL) });
  if (num(env.WEATHER_REFRESH_INTERVAL) !== undefined) scalar.refresh = Object.assign(scalar.refresh || {}, { weather: num(env.WEATHER_REFRESH_INTERVAL) });
  if (env.AUTHORIZED_USERS) {
    scalar.authorizedUsers = env.AUTHORIZED_USERS.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  }
  config = deepMerge(config, scalar);

  // カレンダー定義の正規化（key の自動採番・無効なものの除去）
  const usedKeys = {};
  config.calendars = (config.calendars || []).map((cal, i) => {
    let key = slug(cal.key || cal.person || cal.displayName, i);
    while (usedKeys[key]) key = key + '_' + i;
    usedKeys[key] = true;
    return {
      key,
      calendarId: String(cal.calendarId || '').trim(),
      displayName: cal.displayName || key,
      color: cal.color || '#8AB4F8',
      person: cal.person || key,
      enabled: cal.enabled !== false,
    };
  });

  config.taskLists = (config.taskLists || []).map((list) => ({
    id: String(list.id || '@default'),
    name: list.name || 'Tasks',
    enabled: list.enabled !== false,
  }));

  config.warnings = warnings;
  return config;
}

/** 有効なカレンダーだけを返す */
export function activeCalendars(config) {
  return config.calendars.filter((c) => c.enabled && c.calendarId);
}

/** ブラウザへ渡してよい設定だけを抜き出す（calendarId 等は渡さない） */
export function publicConfig(config, extra = {}) {
  return {
    timezone: config.timezone,
    locale: config.locale,
    locationName: config.locationName,
    calendars: config.calendars
      .filter((c) => c.enabled)
      .map((c) => ({ key: c.key, displayName: c.displayName, color: c.color, person: c.person })),
    daysToDisplay: config.daysToDisplay,
    maxEventsPerDay: config.maxEventsPerDay,
    maxTodayEvents: config.maxTodayEvents,
    maxTasks: config.maxTasks,
    comingUp: { enabled: config.comingUp.enabled, maxItems: config.comingUp.maxItems },
    nextIncludesAllDay: config.nextIncludesAllDay,
    nextLookaheadHours: config.nextLookaheadHours,
    tonightStartTime: config.tonightStartTime,
    tomorrowEmphasisTime: config.tomorrowEmphasisTime,
    refresh: config.refresh,
    nightMode: config.nightMode,
    freeTogether: config.freeTogether,
    ...extra,
  };
}
