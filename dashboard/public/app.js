/* Home Dashboard - フロントエンド
 * 方針(要件19): Fire TV の Silk ブラウザなど古めの環境でも壊れないよう、
 * ES5 + XMLHttpRequest のみを使用（アロー関数/テンプレート文字列/fetch/Promise を使わない）。
 * 時刻計算は「サーバーから受け取った固定オフセット(分)」で行い、Intl のタイムゾーン実装に依存しない。
 */
(function () {
  'use strict';

  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  var SOURCES = ['calendar', 'tasks', 'weather'];
  var SOURCE_LABEL = { calendar: 'カレンダー', tasks: 'タスク', weather: '天気' };

  var CFG = null;              // /api/config の config
  var TZ = 540;                // タイムゾーンオフセット(分)
  var skewMs = 0;              // 端末時計とサーバー時刻の差
  var SRC = { calendar: null, tasks: null, weather: null };
  var localError = { calendar: null, tasks: null, weather: null };
  var fails = { calendar: 0, tasks: 0, weather: 0 };
  var timers = {};
  var lastTickAt = Date.now();
  var lastRenderedMinute = -1;
  var authReloaded = false;

  /* ---------------- utils ---------------- */

  function $(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function pad(n) { return n < 10 ? '0' + n : '' + n; }

  function now() { return Date.now() + skewMs; }

  /* 1画面に収める TV/デスクトップ表示か（iPhone は縦スクロール前提で情報を多めに出す） */
  function isTvLayout() {
    return (window.innerWidth || document.documentElement.clientWidth || 0) >= 900;
  }

  function P(ms) {
    var d = new Date(ms + TZ * 60000);
    return {
      y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
      h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), w: d.getUTCDay()
    };
  }

  function dayKey(ms) { var p = P(ms); return p.y + '-' + pad(p.mo) + '-' + pad(p.d); }
  function hhmm(ms) { var p = P(ms); return pad(p.h) + ':' + pad(p.mi); }
  function todayKey() { return dayKey(now()); }

  function keyParts(key) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key || '');
    return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
  }

  function keyToMs(key, hour, minute) {
    var p = keyParts(key);
    if (!p) return NaN;
    return Date.UTC(p.y, p.mo - 1, p.d, hour || 0, minute || 0, 0) - TZ * 60000;
  }

  function addDaysKey(key, n) {
    var p = keyParts(key);
    if (!p) return key;
    var d = new Date(Date.UTC(p.y, p.mo - 1, p.d));
    d.setUTCDate(d.getUTCDate() + n);
    return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
  }

  function weekdayOfKey(key) {
    var p = keyParts(key);
    if (!p) return 0;
    return new Date(Date.UTC(p.y, p.mo - 1, p.d)).getUTCDay();
  }

  function shortDate(key) {
    var p = keyParts(key);
    return p ? p.mo + '/' + p.d : key;
  }

  function hhmmToMin(value, fallback) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
    if (!m) return fallback;
    return (+m[1]) * 60 + (+m[2]);
  }

  function minToHHMM(min) {
    var m = ((min % 1440) + 1440) % 1440;
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  }

  function httpGet(path, onOk, onErr) {
    var xhr = new XMLHttpRequest();
    var finished = false;
    var startedAt = Date.now();
    function fail(msg) { if (!finished) { finished = true; onErr(msg); } }
    try {
      xhr.open('GET', path, true);
    } catch (e) { fail('open'); return; }
    xhr.timeout = 20000;
    xhr.onreadystatechange = function () {
      if (xhr.readyState !== 4 || finished) return;
      finished = true;
      if (xhr.status >= 200 && xhr.status < 300) {
        var parsed;
        try { parsed = JSON.parse(xhr.responseText); }
        catch (e) { onErr('レスポンス解析エラー'); return; }
        onOk(parsed, startedAt);
      } else if (xhr.status === 401 || xhr.status === 403) {
        onErr('AUTH:' + xhr.status);
      } else if (xhr.status === 0) {
        onErr('オフライン');
      } else {
        onErr('HTTP ' + xhr.status);
      }
    };
    xhr.ontimeout = function () { fail('タイムアウト'); };
    xhr.onerror = function () { fail('通信エラー'); };
    try { xhr.send(); } catch (e) { fail('送信エラー'); }
  }

  /* ---------------- data accessors ---------------- */

  function events() {
    var s = SRC.calendar;
    return (s && s.data && s.data.events) ? s.data.events : [];
  }
  function tasks() {
    var s = SRC.tasks;
    return (s && s.data && s.data.tasks) ? s.data.tasks : [];
  }
  function weather() {
    var s = SRC.weather;
    return (s && s.data) ? s.data : null;
  }
  function dailyFor(key) {
    var w = weather();
    if (!w || !w.daily) return null;
    for (var i = 0; i < w.daily.length; i++) if (w.daily[i].date === key) return w.daily[i];
    return null;
  }
  function eventsOn(key) {
    var out = [];
    var all = events();
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.allDay ? (e.startDay <= key && key <= e.endDay) : e.startDay === key) out.push(e);
    }
    out.sort(function (a, b) {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.startMs - b.startMs;
    });
    return out;
  }

  function personList() {
    var seen = {}, out = [];
    var cals = (CFG && CFG.calendars) || [];
    for (var i = 0; i < cals.length; i++) {
      var p = cals[i].person || cals[i].key;
      if (seen[p]) continue;
      seen[p] = true;
      out.push({ person: p, label: cals[i].displayName, color: cals[i].color });
    }
    return out;
  }

  function calChip(e) {
    return '<span class="who" style="color:' + esc(e.color) + '">' + esc(e.calendarName) + '</span>';
  }

  function calDot(e) {
    return '<span class="dot-cal" style="background:' + esc(e.color) + '"></span>';
  }

  function remainText(ms) {
    var mins = Math.floor(ms / 60000);
    if (mins <= 0) return 'まもなく';
    if (mins < 60) return 'あと' + mins + '分';
    var h = Math.floor(mins / 60), m = mins % 60;
    if (h < 24) return 'あと' + h + '時間' + (m ? m + '分' : '');
    return 'あと' + Math.floor(h / 24) + '日' + (h % 24 ? (h % 24) + '時間' : '');
  }

  /* ---------------- renderers ---------------- */

  function renderClock() {
    var t = now();
    var p = P(t);
    $('clock').innerHTML = pad(p.h) + ':' + pad(p.mi);
    $('date').innerHTML = p.mo + '月' + p.d + '日';
    $('weekday').innerHTML = WD[p.w] + '曜日 · ' + p.y;
    applyNightMode(p);
  }

  function applyNightMode(p) {
    var nm = CFG && CFG.nightMode;
    var body = document.body;
    if (!nm || !nm.enabled) { body.className = ''; return; }
    var minutes = p.h * 60 + p.mi;
    var start = hhmmToMin(nm.start, 0);
    var end = hhmmToMin(nm.end, 360);
    var isNight = start <= end ? (minutes >= start && minutes < end) : (minutes >= start || minutes < end);
    var cls = isNight ? (nm.reduce ? 'night night-reduce' : 'night') : '';
    if (body.className !== cls) body.className = cls;
    if (isNight && nm.dim) body.style.setProperty('--night-dim', String(nm.dim));
  }

  function renderWeatherNow() {
    var w = weather();
    if (!w || !w.current) return;
    var c = w.current;
    var d = dailyFor(todayKey());
    $('wn-icon').innerHTML = esc(c.icon || '·');
    $('wn-temp').innerHTML = (c.temp === null || c.temp === undefined ? '--' : Math.round(c.temp)) + '°';
    $('wn-sub').innerHTML = esc(c.label || '') + (w.locationName ? ' · ' + esc(w.locationName) : '');
    if (d) {
      $('wn-range').innerHTML =
        '<span class="hi">' + d.tmax + '°</span> / <span class="lo">' + d.tmin + '°</span>'
        + (d.pop === null ? '' : ' <span class="pop">☂' + d.pop + '%</span>');
    }
  }

  function renderNext() {
    var t = now();
    var all = events();
    var includeAllDay = CFG.nextIncludesAllDay;
    var lookaheadMs = (CFG.nextLookaheadHours || 36) * 3600000;
    var ongoing = [];
    var next = null;

    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (e.allDay && !includeAllDay) continue;
      if (!e.allDay && e.startMs <= t && e.endMs > t) { ongoing.push(e); continue; }
      if (e.startMs > t && e.startMs - t <= lookaheadMs && !next) next = e;
    }

    var html = '';
    for (var j = 0; j < Math.min(2, ongoing.length); j++) {
      var o = ongoing[j];
      html += '<div class="next-now"><span class="lab">NOW</span>'
        + '<span class="ttl">' + calDot(o) + esc(o.title) + '</span>'
        + '<span class="who" style="color:' + esc(o.color) + ';margin-left:auto">〜' + hhmm(o.endMs) + '</span></div>';
    }

    if (next) {
      var sameDay = next.startDay === todayKey();
      var prefix = sameDay ? '' : (next.startDay === addDaysKey(todayKey(), 1) ? '明日 ' : shortDate(next.startDay) + ' ');
      var diff = next.startMs - t;
      html += '<div class="next-time">' + esc(prefix) + (next.allDay ? '終日' : hhmm(next.startMs)) + '</div>'
        + '<div class="next-title">' + esc(next.title) + '</div>'
        + '<div class="next-meta">' + calDot(next) + esc(next.calendarName)
        + (next.location ? ' · ' + esc(next.location) : '') + '</div>'
        + '<div class="next-remain' + (diff <= 30 * 60000 ? ' soon' : '') + '">' + esc(remainText(diff)) + '</div>';
    } else if (!ongoing.length) {
      html += '<div class="empty">この先の予定はありません</div>';
    }
    $('next-body').innerHTML = html;
  }

  function weatherCommentHtml(list, keepCount) {
    var keep = (keepCount === undefined) ? 1 : keepCount;
    var html = '';
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      html += '<div class="wcomment ' + (i < keep ? 'keep ' : '') + esc(c.level) + '"><span class="ic">' + esc(c.icon) + '</span>'
        + '<span class="tx">' + esc(c.text) + '</span>'
        + (c.detail ? '<span class="de">' + esc(c.detail) + '</span>' : '') + '</div>';
    }
    return html;
  }

  function eventRowHtml(e, isPast) {
    var time = e.allDay ? '<span class="time allday">終日</span>'
      : '<span class="time">' + hhmm(e.startMs) + '</span>';
    return '<div class="row' + (isPast ? ' past low' : '') + '">' + time + calDot(e)
      + '<span class="ttl">' + esc(e.title) + '</span>' + calChip(e) + '</div>';
  }

  /* 与えられたカード本文が枠に収まるまで末尾の行を落とし、「+N件」を出す。
     .keep が付いた要素（天気コメント・期限超過タスク等）は最後まで残す。 */
  function fitBody(el, unit, baseHidden) {
    if (!el || !el.children) return;
    var hidden = baseHidden || 0;
    var moreEl = null;

    function ensureMore() {
      if (!moreEl) {
        moreEl = document.createElement('div');
        moreEl.className = 'more';
        el.appendChild(moreEl);
      }
      moreEl.innerHTML = '+' + hidden + (unit || '件');
    }
    if (hidden > 0) ensureMore();

    function pick(lowOnly) {
      for (var i = el.children.length - 1; i >= 0; i--) {
        var child = el.children[i];
        var cls = ' ' + child.className + ' ';
        if (child === moreEl) continue;
        if (cls.indexOf(' keep') >= 0) continue;
        if (lowOnly && cls.indexOf(' low') < 0) continue;
        return child;
      }
      return null;
    }

    var guard = 0;
    while (el.scrollHeight > el.clientHeight + 1 && guard++ < 80) {
      // 優先度の低い行（終了済みの予定など）から先に落とす
      var last = pick(true) || pick(false);
      if (!last) break;
      var isLabel = /task-group-title|empty|none/.test(last.className);
      el.removeChild(last);
      if (!isLabel) hidden++;
      ensureMore();
    }
    // 見出しだけが末尾に残らないようにする
    for (var g2 = 0; g2 < 8; g2++) {
      var tail = null;
      for (var n = el.children.length - 1; n >= 0; n--) {
        if (el.children[n] !== moreEl) { tail = el.children[n]; break; }
      }
      if (!tail || !/task-group-title|pname/.test(tail.className)) break;
      el.removeChild(tail);
    }

    if (moreEl && hidden === 0) el.removeChild(moreEl);
  }

  function renderToday() {
    var t = now();
    var key = todayKey();
    var list = eventsOn(key);
    var limit = CFG.maxTodayEvents || 6;
    var hidden = 0;

    // 表示枠が足りない場合は「終了済み」から順に省略する
    if (list.length > limit) {
      var upcoming = [], past = [];
      for (var i = 0; i < list.length; i++) {
        (!list[i].allDay && list[i].endMs <= t ? past : upcoming).push(list[i]);
      }
      var keepPast = Math.max(0, limit - upcoming.length);
      hidden = list.length - Math.min(limit, upcoming.length + keepPast);
      list = past.slice(past.length - keepPast).concat(upcoming).slice(0, limit);
      list.sort(function (a, b) {
        if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
        return a.startMs - b.startMs;
      });
    }

    var html = '';
    var remaining = 0;
    for (var q = 0; q < list.length; q++) if (list[q].allDay || list[q].endMs > t) remaining++;

    if (list.length && remaining === 0) {
      // 今日の予定がすべて終了しているときは、行を占有せず1行で伝える
      html += '<div class="row keep"><span class="ttl">今日の予定は終了（' + list.length + '件）</span></div>';
      hidden = 0;
    } else {
      for (var k = 0; k < list.length; k++) {
        html += eventRowHtml(list[k], !list[k].allDay && list[k].endMs <= t);
      }
      if (!list.length) html += '<div class="empty">今日の予定はありません</div>';
    }

    // 今日やるべきタスク（期限超過 + 今日期限）を統合表示(要件7)
    var ts = tasks();
    var todayTasks = [];
    for (var m = 0; m < ts.length; m++) if (ts[m].due && ts[m].due <= key) todayTasks.push(ts[m]);
    // 1画面に収める TV では要注意分だけを出し、一覧は TASKS カードに任せる
    var taskLimit = Math.min(todayTasks.length, isTvLayout() ? 2 : 4);
    hidden += todayTasks.length - taskLimit;
    for (var n = 0; n < taskLimit; n++) {
      var overdue = todayTasks[n].due < key;
      // 期限超過は先頭1件だけを必ず残す（残りは TASKS カードに任せ、予定の表示枠を優先）
      html += '<div class="task ' + (overdue ? (n === 0 ? 'overdue keep' : 'overdue') : 'today') + '">'
        + '<span class="mark">' + (overdue ? '⚠' : '☑') + '</span>'
        + '<span class="ttl">' + esc(todayTasks[n].title) + '</span>'
        + (overdue ? '<span class="due">' + esc(shortDate(todayTasks[n].due)) + '期限</span>' : '') + '</div>';
    }

    var w = weather();
    if (w && w.comments && w.comments.today) html += weatherCommentHtml(w.comments.today.slice(0, 2));

    $('today-body').innerHTML = html;
    fitBody($('today-body'), '件', hidden);
  }

  function renderTonight() {
    var t = now();
    var key = todayKey();
    var startMin = hhmmToMin(CFG.tonightStartTime, 17 * 60);
    var startMs = keyToMs(key, Math.floor(startMin / 60), startMin % 60);
    var endMs = keyToMs(addDaysKey(key, 1), 0, 0);
    var persons = personList();
    var byPerson = {};
    var i;
    for (i = 0; i < persons.length; i++) byPerson[persons[i].person] = [];

    var todays = eventsOn(key);
    for (i = 0; i < todays.length; i++) {
      var e = todays[i];
      if (e.allDay) continue;
      if (e.endMs <= Math.max(startMs, t)) continue;   // 終了済みは除外(要件6/8)
      if (e.startMs >= endMs) continue;
      if (byPerson[e.person]) byPerson[e.person].push(e);
    }

    var html = '';
    for (i = 0; i < persons.length; i++) {
      var p = persons[i];
      var list = byPerson[p.person] || [];
      var nameCell = '<span class="pname" style="color:' + esc(p.color) + '">' + esc(p.label) + '</span>';
      if (!list.length) {
        html += '<div class="prow"><span class="pname" style="color:' + esc(p.color) + '">' + esc(p.label)
          + '</span><span class="pev none">予定なし</span></div>';
      } else {
        for (var j = 0; j < list.length; j++) {
          html += '<div class="prow">' + (j === 0 ? nameCell : '<span class="pname"></span>')
            + '<span class="pev"><span class="t">' + hhmm(list[j].startMs) + '</span>'
            + esc(list[j].title) + '</span></div>';
        }
      }
    }

    var w = weather();
    if (w && w.comments && w.comments.tonight) html += weatherCommentHtml(w.comments.tonight);
    $('tonight-body').innerHTML = html;
    fitBody($('tonight-body'), '件', 0);
  }

  function renderTomorrow() {
    var key = addDaysKey(todayKey(), 1);
    var d = dailyFor(key);
    var list = eventsOn(key);
    var html = '';

    if (d) {
      html += '<div class="tomorrow-head keep"><span class="ic">' + esc(d.icon) + '</span>'
        + '<span class="tp"><span class="hi">' + d.tmax + '°</span> / <span class="lo">' + d.tmin + '°</span></span>'
        + (d.pop === null ? '' : '<span class="pop">☂' + d.pop + '%</span>') + '</div>';
    }
    for (var i = 0; i < list.length; i++) html += eventRowHtml(list[i], false);
    if (!list.length) html += '<div class="empty">予定なし</div>';

    var ts = tasks();
    for (var j = 0; j < ts.length; j++) {
      if (ts[j].due !== key) continue;
      html += '<div class="task today"><span class="mark">☑</span><span class="ttl">' + esc(ts[j].title) + '</span></div>';
    }

    var w = weather();
    if (w && w.comments && w.comments.tomorrow) html += weatherCommentHtml(w.comments.tomorrow.slice(0, 2));

    $('tomorrow-body').innerHTML = html;
    fitBody($('tomorrow-body'), '件', 0);

    // 指定時刻以降は TOMORROW を強調(要件9)
    var p = P(now());
    var emph = (p.h * 60 + p.mi) >= hhmmToMin(CFG.tomorrowEmphasisTime, 20 * 60);
    $('card-tomorrow').className = 'card card-tomorrow' + (emph ? ' emphasis' : '');
  }

  function renderWeek() {
    var t = now();
    var today = todayKey();
    var days = CFG.daysToDisplay || 7;
    var maxEvents = CFG.maxEventsPerDay || 4;
    var html = '<div class="week">';
    var overflow = [];

    for (var i = 0; i < days; i++) {
      var key = addDaysKey(today, i);
      var wd = weekdayOfKey(key);
      var d = dailyFor(key);
      var list = eventsOn(key);
      var cls = 'day' + (i === 0 ? ' today' : '') + (wd === 0 ? ' weekend' : '') + (wd === 6 ? ' sat' : '');
      overflow.push(Math.max(0, list.length - maxEvents));

      html += '<div class="' + cls + '">'
        + '<div class="day-head"><div class="day-date">' + shortDate(key)
        + '<span class="wd">' + WD[wd] + (i === 0 ? '·今日' : (i === 1 ? '·明日' : '')) + '</span></div>'
        + '<div class="day-weather">'
        + (d ? '<span class="ic">' + esc(d.icon) + '</span><span class="hi">' + d.tmax + '</span>/'
             + '<span class="lo">' + d.tmin + '</span>'
             + (d.pop === null ? '' : '<span class="pop">' + d.pop + '%</span>')
           : '—')
        + '</div></div><div class="day-events">';

      if (!list.length) {
        html += '<div class="empty">—</div>';
      } else {
        for (var j = 0; j < Math.min(maxEvents, list.length); j++) {
          var e = list[j];
          var pastCls = (!e.allDay && e.endMs <= t) ? ' past low' : '';
          html += '<div class="ev' + pastCls + '">'
            + '<span class="t">' + (e.allDay ? '終日' : hhmm(e.startMs)) + '</span>'
            + calDot(e) + '<span class="n">' + esc(e.title) + '</span></div>';
        }
      }
      html += '</div></div>';
    }
    html += '</div>';
    $('week-body').innerHTML = html;

    var cols = $('week-body').getElementsByClassName('day-events');
    for (var c = 0; c < cols.length; c++) fitBody(cols[c], '件', overflow[c] || 0);
  }

  function renderTasks() {
    var key = todayKey();
    var max = CFG.maxTasks || 6;
    var ts = tasks();
    var overdue = [], today = [], soon = [];
    for (var i = 0; i < ts.length; i++) {
      var task = ts[i];
      if (task.due && task.due < key) overdue.push(task);
      else if (task.due === key) today.push(task);
      else soon.push(task);
    }

    var html = '';
    var shown = 0;
    var groups = [
      { cls: 'overdue', title: '🔴 期限超過', list: overdue, mark: '⚠', keep: true },
      { cls: 'today', title: '今日', list: today, mark: '☑', keep: false },
      { cls: 'soon', title: '近日', list: soon, mark: '·', keep: false }
    ];
    for (var g = 0; g < groups.length; g++) {
      var grp = groups[g];
      if (!grp.list.length || shown >= max) continue;
      html += '<div class="task-group-title ' + grp.cls + (grp.keep ? ' keep' : '') + '">' + grp.title + '</div>';
      for (var j = 0; j < grp.list.length && shown < max; j++, shown++) {
        var t2 = grp.list[j];
        html += '<div class="task ' + grp.cls + (grp.keep ? ' keep' : '') + '"><span class="mark">' + grp.mark + '</span>'
          + '<span class="ttl">' + esc(t2.title) + '</span>'
          + (t2.due && grp.cls !== 'today' ? '<span class="due">' + esc(shortDate(t2.due)) + '</span>' : '')
          + '</div>';
      }
    }
    if (!ts.length) html += '<div class="empty">タスクはありません</div>';
    $('tasks-body').innerHTML = html;
    fitBody($('tasks-body'), ' tasks', Math.max(0, ts.length - shown));
  }

  function renderComingUp() {
    if (!CFG.comingUp || !CFG.comingUp.enabled) {
      $('coming-title').style.display = 'none';
      $('coming-body').style.display = 'none';
      return;
    }
    var after = addDaysKey(todayKey(), (CFG.daysToDisplay || 7) - 1);
    var all = events();
    var out = [];
    for (var i = 0; i < all.length && out.length < (CFG.comingUp.maxItems || 3); i++) {
      if (all[i].important && all[i].startDay > after) out.push(all[i]);
    }
    var html = '';
    for (var j = 0; j < out.length; j++) {
      html += '<div class="coming"><span class="d">' + shortDate(out[j].startDay) + '</span>'
        + calDot(out[j]) + '<span class="n">' + esc(out[j].title) + '</span></div>';
    }
    if (!out.length) html += '<div class="empty">—</div>';
    $('coming-body').innerHTML = html;
    fitBody($('coming-body'), '件', 0);
  }

  /* 二人の共通空き時間(要件17)。予定の隙間をルールベースで算出する。 */
  function computeFreeTogether() {
    var ft = CFG.freeTogether || {};
    if (!ft.enabled) return [];
    var persons = ft.persons && ft.persons.length ? ft.persons : null;
    var t = now();
    var today = todayKey();
    var out = [];
    var minMs = (ft.minMinutes || 60) * 60000;

    for (var i = 0; i < (ft.days || 7) && out.length < (ft.maxItems || 3); i++) {
      var key = addDaysKey(today, i);
      var wd = weekdayOfKey(key);
      var isWeekend = (wd === 0 || wd === 6);
      var startMin = hhmmToMin(isWeekend ? ft.weekendStart : ft.windowStart, isWeekend ? 600 : 1080);
      var endMin = hhmmToMin(ft.windowEnd, 1380);
      var winStart = keyToMs(key, Math.floor(startMin / 60), startMin % 60);
      var winEnd = keyToMs(key, Math.floor(endMin / 60), endMin % 60);
      if (i === 0) winStart = Math.max(winStart, t + 15 * 60000);
      if (winEnd - winStart < minMs) continue;

      // 対象人物の予定を「埋まっている時間」として集める
      var busy = [];
      var list = eventsOn(key);
      var blockedAllDay = false;
      for (var j = 0; j < list.length; j++) {
        var e = list[j];
        if (persons && indexOf(persons, e.person) < 0) continue;
        if (e.allDay) { blockedAllDay = true; break; }
        if (e.endMs <= winStart || e.startMs >= winEnd) continue;
        busy.push([Math.max(e.startMs, winStart), Math.min(e.endMs, winEnd)]);
      }
      if (blockedAllDay) continue;

      busy.sort(function (a, b) { return a[0] - b[0]; });
      var cursor = winStart;
      var found = null;
      for (var k = 0; k < busy.length; k++) {
        if (busy[k][0] - cursor >= minMs) { found = cursor; break; }
        if (busy[k][1] > cursor) cursor = busy[k][1];
      }
      if (found === null && winEnd - cursor >= minMs) found = cursor;
      if (found !== null) out.push({ key: key, wd: WD[wd], startMs: found });
    }
    return out;
  }

  function indexOf(arr, v) {
    for (var i = 0; i < arr.length; i++) if (arr[i] === v) return i;
    return -1;
  }

  function renderFree() {
    if (!CFG.freeTogether || !CFG.freeTogether.enabled) {
      $('card-free').style.display = 'none';
      return;
    }
    var list = computeFreeTogether();
    var html = '';
    for (var i = 0; i < list.length; i++) {
      html += '<div class="free"><span class="d">' + esc(list[i].wd) + '</span>'
        + '<span class="t">' + hhmm(list[i].startMs) + '〜</span></div>';
    }
    if (!list.length) html += '<div class="empty">—</div>';
    $('free-body').innerHTML = html;
    fitBody($('free-body'), '件', 0);
  }

  function renderStatus() {
    var html = '';
    if (CFG && CFG.demoMode) html += '<span class="badge">DEMO DATA</span>';
    for (var i = 0; i < SOURCES.length; i++) {
      var name = SOURCES[i];
      var s = SRC[name];
      var err = localError[name] || (s && s.status === 'error' ? s.error : null);
      var lastOk = s && s.lastSuccessAt ? hhmm(s.lastSuccessAt) : null;
      if (err) {
        html += '<span class="st err"><span class="dot"></span>⚠ ' + SOURCE_LABEL[name] + '更新失敗'
          + (lastOk ? ' 最終正常 ' + lastOk : '') + '</span>';
      } else if (s) {
        var partial = s.data && s.data.errors && s.data.errors.length;
        html += '<span class="st' + (partial ? ' stale' : '') + '"><span class="dot"></span>'
          + SOURCE_LABEL[name] + ' ' + (lastOk || '--:--')
          + (partial ? ' (一部失敗)' : '') + '</span>';
      } else {
        html += '<span class="st stale"><span class="dot"></span>' + SOURCE_LABEL[name] + ' 取得中</span>';
      }
    }
    $('status').innerHTML = html;
  }

  function safe(name, fn) {
    try { fn(); } catch (e) {
      if (window.console && console.warn) console.warn('render error: ' + name, e);
    }
  }

  function render() {
    if (!CFG) return;
    safe('clock', renderClock);
    safe('weatherNow', renderWeatherNow);
    safe('next', renderNext);
    safe('today', renderToday);
    safe('tonight', renderTonight);
    safe('tomorrow', renderTomorrow);
    safe('week', renderWeek);
    safe('tasks', renderTasks);
    safe('comingUp', renderComingUp);
    safe('free', renderFree);
    safe('status', renderStatus);
  }

  /* ---------------- polling / 自動復旧(要件24) ---------------- */

  function updateSkew(serverTime, startedAt) {
    if (!serverTime) return;
    var rtt = Date.now() - startedAt;
    var estimated = serverTime + rtt / 2 - Date.now();
    if (Math.abs(estimated) > 5000) skewMs = estimated;  // 端末時計が大きくズレている場合のみ補正
  }

  function intervalFor(source) {
    var r = (CFG && CFG.refresh) || {};
    if (source === 'calendar') return r.calendar || 300000;
    if (source === 'tasks') return r.tasks || 300000;
    return r.weather || 1800000;
  }

  function backoffFor(source) {
    var r = (CFG && CFG.refresh) || {};
    var base = r.retryBaseMs || 15000;
    var max = r.retryMaxMs || 300000;
    var n = Math.min(fails[source], 6);
    return Math.min(max, base * Math.pow(2, n - 1));
  }

  function schedule(source, delay) {
    if (timers[source]) clearTimeout(timers[source]);
    timers[source] = setTimeout(function () { fetchSource(source); }, delay);
  }

  function fetchSource(source, force) {
    httpGet('/api/' + source + (force ? '?force=1' : ''), function (res, startedAt) {
      updateSkew(res.serverTime, startedAt);
      SRC[source] = res;
      localError[source] = (res.status === 'error') ? (res.error || '取得失敗') : null;
      fails[source] = (res.status === 'error') ? fails[source] + 1 : 0;
      render();
      schedule(source, res.status === 'error' ? backoffFor(source) : intervalFor(source));
    }, function (err) {
      if (err.indexOf('AUTH:') === 0) {
        if (!authReloaded) { authReloaded = true; setTimeout(function () { location.reload(); }, 3000); }
        localError[source] = '認証切れ';
        render();
        return;
      }
      fails[source]++;
      localError[source] = err;
      render();
      schedule(source, backoffFor(source));
    });
  }

  function refreshAll(force) {
    for (var i = 0; i < SOURCES.length; i++) fetchSource(SOURCES[i], force);
  }

  function tick() {
    var t = Date.now();
    // 端末のスリープ復帰など、時刻が大きく飛んだら即座に再取得(要件24)
    if (t - lastTickAt > 120000) refreshAll(true);
    lastTickAt = t;

    var p = P(now());
    if (p.mi !== lastRenderedMinute) {
      lastRenderedMinute = p.mi;
      render();               // 分が変わったら全体を再描画（NEXT の残り時間・日付跨ぎ対応）
    } else {
      safe('clock', renderClock);
    }
  }

  function boot() {
    httpGet('/api/config', function (res, startedAt) {
      CFG = res.config;
      TZ = typeof CFG.tzOffsetMinutes === 'number' ? CFG.tzOffsetMinutes : 540;
      updateSkew(res.serverTime, startedAt);
      render();
      refreshAll(false);

      setInterval(tick, (CFG.refresh && CFG.refresh.clock) || 1000);

      // 常時表示端末のメモリ肥大化・デプロイ追従のための定期リロード
      var pageMs = CFG.refresh && CFG.refresh.page;
      if (pageMs && pageMs > 0) setTimeout(function () { location.reload(); }, pageMs);
    }, function (err) {
      if (err.indexOf('AUTH:') === 0) { location.reload(); return; }
      $('status').innerHTML = '<span class="st err"><span class="dot"></span>設定の取得に失敗 (' + esc(err) + ') 再試行します</span>';
      setTimeout(boot, 10000);
    });
  }

  if (window.addEventListener) {
    window.addEventListener('online', function () { refreshAll(true); });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) refreshAll(false);
    });
    window.addEventListener('focus', function () { safe('clock', renderClock); });
  }

  boot();
})();
