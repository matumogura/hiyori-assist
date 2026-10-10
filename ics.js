/**
 * ics.js — iCalendar を読んで、指定期間の予定を日付ごとに展開する
 *
 * 時刻はすべて日本時間の壁時計として扱う。
 * 「Z」付きの時刻だけ +9時間して合わせる。
 *
 * 対応している繰り返し: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY,
 *   INTERVAL, COUNT, UNTIL, BYDAY(WEEKLY), EXDATE, RECURRENCE-ID による個別変更
 * 対応していない: BYMONTHDAY / BYSETPOS など複雑な指定（元の日で近似する）
 */
(function (root) {
  const DAY_MS = 86400000;
  const WD = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

  /** 折り返された行を戻す */
  function unfold(text) {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n[ \t]/g, '');
  }

  /** 日時を「日本時間の壁時計」を表す数値にする */
  function parseDT(value, params) {
    const isDate = /VALUE=DATE(?!-TIME)/.test(params || '');
    let m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    const [, y, mo, d, H, M, S, z] = m;
    if (isDate || H === undefined) {
      return { ms: Date.UTC(+y, +mo - 1, +d), allDay: true };
    }
    let ms = Date.UTC(+y, +mo - 1, +d, +H, +M, +(S || 0));
    if (z) ms += 9 * 3600 * 1000;   // UTC表記なら日本時間に寄せる
    return { ms, allDay: false };
  }

  function parseEvents(text) {
    const lines = unfold(text).split('\n');
    const events = [];
    let cur = null;
    for (const line of lines) {
      if (line === 'BEGIN:VEVENT') { cur = { exdates: [] }; continue; }
      if (line === 'END:VEVENT') { if (cur) events.push(cur); cur = null; continue; }
      if (!cur) continue;

      const i = line.indexOf(':');
      if (i < 0) continue;
      const left = line.slice(0, i);
      const value = line.slice(i + 1);
      const semi = left.indexOf(';');
      const name = (semi < 0 ? left : left.slice(0, semi)).toUpperCase();
      const params = semi < 0 ? '' : left.slice(semi + 1);

      switch (name) {
        case 'UID': cur.uid = value; break;
        case 'SUMMARY': cur.summary = value.replace(/\\,/g, ',').replace(/\\n/gi, ' '); break;
        case 'STATUS': cur.status = value; break;
        case 'TRANSP': cur.transp = value; break;
        case 'RRULE': cur.rrule = value; break;
        case 'DTSTART': cur.start = parseDT(value, params); break;
        case 'DTEND': cur.end = parseDT(value, params); break;
        case 'RECURRENCE-ID': cur.recurrenceId = parseDT(value, params); break;
        case 'EXDATE':
          value.split(',').forEach((v) => {
            const p = parseDT(v.trim(), params);
            if (p) cur.exdates.push(p.ms);
          });
          break;
        default: break;
      }
    }
    return events.filter((e) => e.start);
  }

  function parseRRule(s) {
    const o = {};
    for (const part of String(s).split(';')) {
      const [k, v] = part.split('=');
      if (k) o[k.toUpperCase()] = v;
    }
    return o;
  }

  /** 繰り返しを展開して、期間内の発生を返す */
  function expand(events, fromMs, toMs) {
    // RECURRENCE-ID で個別に変更された回は、元の繰り返しから除く
    const overridden = new Set();
    events.forEach((e) => {
      if (e.recurrenceId && e.uid) overridden.add(e.uid + '@' + e.recurrenceId.ms);
    });

    const out = [];
    const push = (e, startMs) => {
      const dur = (e.end ? e.end.ms : e.start.ms + (e.start.allDay ? DAY_MS : 3600000))
        - e.start.ms;
      out.push({
        summary: e.summary || '',
        allDay: e.start.allDay,
        startMs,
        endMs: startMs + Math.max(dur, e.start.allDay ? DAY_MS : 60000),
      });
    };

    for (const e of events) {
      if (e.status === 'CANCELLED') continue;
      if (e.transp === 'TRANSPARENT') continue;      // 「予定あり」でない予定

      if (!e.rrule) {
        const endMs = e.end ? e.end.ms : e.start.ms + DAY_MS;
        if (endMs > fromMs && e.start.ms < toMs) push(e, e.start.ms);
        continue;
      }

      const r = parseRRule(e.rrule);
      const interval = Math.max(1, Number(r.INTERVAL || 1));
      const until = r.UNTIL ? (parseDT(r.UNTIL, '') || {}).ms : null;
      const count = r.COUNT ? Number(r.COUNT) : null;
      const byday = r.BYDAY ? r.BYDAY.split(',').map((x) => x.replace(/^[-\d]+/, '')) : null;
      const ex = new Set(e.exdates);

      let occ = 0, guard = 0;
      let cursor = e.start.ms;
      const startDow = new Date(e.start.ms).getUTCDay();

      while (guard++ < 2000) {
        if (cursor > toMs) break;
        if (until && cursor > until) break;
        if (count && occ >= count) break;

        let candidates = [cursor];
        if (r.FREQ === 'WEEKLY' && byday && byday.length) {
          // 週の頭は「日付」で求める。cursor には時刻が含まれているので、
          // いったん切り落としてから曜日ぶんを足し、最後に時刻を戻す
          const timeOfDay = e.start.ms - Math.floor(e.start.ms / DAY_MS) * DAY_MS;
          const weekStart = Math.floor(cursor / DAY_MS) * DAY_MS - startDow * DAY_MS;
          candidates = byday
            .map((d) => weekStart + WD.indexOf(d) * DAY_MS + timeOfDay)
            .filter((ms) => ms >= e.start.ms)
            .sort((a, b) => a - b);
        }

        for (const ms of candidates) {
          if (count && occ >= count) break;
          if (until && ms > until) break;
          occ++;
          if (ex.has(ms)) continue;
          if (e.uid && overridden.has(e.uid + '@' + ms)) continue;
          if (ms >= fromMs - DAY_MS && ms <= toMs) push(e, ms);
        }

        switch (r.FREQ) {
          case 'DAILY': cursor += interval * DAY_MS; break;
          case 'WEEKLY': cursor += interval * 7 * DAY_MS; break;
          case 'MONTHLY': cursor = addMonths(cursor, interval); break;
          case 'YEARLY': cursor = addMonths(cursor, interval * 12); break;
          default: cursor = toMs + 1; break;
        }
      }
    }
    return out;
  }

  function addMonths(ms, n) {
    const d = new Date(ms);
    const day = d.getUTCDate();
    const t = ms - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), day);
    const nd = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
    const last = new Date(Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth() + 1, 0)).getUTCDate();
    return Date.UTC(nd.getUTCFullYear(), nd.getUTCMonth(), Math.min(day, last)) + t;
  }

  const dateKey = (ms) => new Date(Math.floor(ms / DAY_MS) * DAY_MS).toISOString().slice(0, 10);

  /**
   * 発生を marks 形式に変換する。
   * 送るのは「カレンダーに予定があるか」という事実だけ。
   * 生活パターン（平日昼は仕事など）はサーバー側で重ねる。
   */
  function toMarks(occurrences, opt) {
    const { from, to, dayWindow, nightWindow, tentativePatterns, ignorePatterns } = opt;
    const fromMs = Date.parse(from + 'T00:00:00Z');
    const toMs = Date.parse(to + 'T00:00:00Z') + DAY_MS - 1;
    const state = {};   // date -> {day:'busy'|'tentative', night:...}

    const mark = (date, slot, sev) => {
      state[date] = state[date] || {};
      if (state[date][slot] !== 'busy') state[date][slot] = sev;
    };

    for (const o of occurrences) {
      const title = o.summary || '';
      if (ignorePatterns.some((p) => p && title.includes(p))) continue;
      const sev = tentativePatterns.some((p) => p && title.includes(p)) ? 'tentative' : 'busy';

      let cur = Math.floor(Math.max(o.startMs, fromMs) / DAY_MS) * DAY_MS;
      const lastMs = Math.min(o.endMs - 1, toMs);
      while (cur <= lastMs) {
        const date = dateKey(cur);
        for (const [slot, w] of [['day', dayWindow], ['night', nightWindow]]) {
          const ws = cur + w[0] * 3600000;
          const we = cur + w[1] * 3600000;
          if (o.allDay || (o.startMs < we && o.endMs > ws)) mark(date, slot, sev);
        }
        cur += DAY_MS;
      }
    }

    const marks = {};
    for (const [date, s] of Object.entries(state)) {
      const v = (x) => (x === 'busy' ? false : x === 'tentative' ? null : true);
      const day = v(s.day), night = v(s.night);
      if (day === true && night === true) continue;
      marks[date] = { day, night };
    }
    return marks;
  }

  const ICS = { unfold, parseEvents, expand, toMarks, dateKey, DAY_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = ICS;
  else root.ICS = ICS;
})(typeof window !== 'undefined' ? window : globalThis);
