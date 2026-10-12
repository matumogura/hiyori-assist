/**
 * background.js — フリカレと祝日の取得だけを受け持つ
 *
 * 伝助のページ（content.js）からは別サイトへ直接取りに行けないので、
 * 拡張機能の裏側でまとめて取得して返す。
 *
 * フリカレのサーバーに負担をかけないための決まり（ヒヨリ本体 app/sched/freecal.mjs と同じ考え方）
 * ・取得はユーザーが「取り込む」などを押したときだけ。定期的には読まない
 * ・数えるのは「フリカレに問い合わせた月の数」（1か月＝1回の通信）
 * ・同じ月は CACHE_MS のあいだ使い回す（月ごとに覚える）
 * ・1回に読むのは MAX_MONTHS_PER_LOAD か月まで。残りの月は読まず、判断しない月として返す
 * ・同じカレンダーを読みに行くのは COOLDOWN_MS に1回まで
 * ・1カレンダーあたり1日 MAX_MONTHS_PER_MEM_DAY か月、この拡張全体で1日 MAX_MONTHS_TOTAL_DAY か月まで
 * ・フリカレがエラーを返したら ERROR_PAUSE_MS のあいだ取得を止める
 * ・同じカレンダーを同時に読みに行かない（二度押し・複数のタブ）
 * ・ここからは書き込まない（フリカレへの書き込みは freecal.js が、ログイン中のフリカレのページから本人の操作で行う）
 */

// Googleカレンダー（iCal）の読み解き
importScripts('ics.js');

const ENDPOINT = 'https://freecalend.com/open/data';
const OLD_TS = '1602144014';
const FVERSION = '-1';
const CACHE_MS = 60 * 60 * 1000;
const MAX_MONTHS_PER_LOAD = 3;
const COOLDOWN_MS = 60 * 1000;
const MAX_MONTHS_PER_MEM_DAY = 12;
const MAX_MONTHS_TOTAL_DAY = 36;
const ERROR_PAUSE_MS = 30 * 60 * 1000;
const GAP_MS = 1000;
const HOLIDAY_URL = 'https://calendar.google.com/calendar/ical/'
  + 'ja.japanese%23holiday%40group.v.calendar.google.com/public/basic.ics';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const p2 = (v) => String(v).padStart(2, '0');
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};

function parseMem(src) {
  if (!src) return null;
  const s = String(src).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/mem(\d+)/);
  return m ? m[1] : null;
}

const quotaError = (msg) => Object.assign(new Error(msg), { code: 'quota' });

/** 今日の使用量 { total, mems: { [mem]: { months, lastAt } } }。古い日のぶんは捨てる */
async function usage() {
  const key = `fusage:${today()}`;
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => (k.startsWith('fusage:') && k !== key) || k.startsWith('quota:'));
  if (stale.length) await chrome.storage.local.remove(stale);
  return { key, u: all[key] || { total: 0, mems: {} }, pausedUntil: all.fpause || 0 };
}

/** 読みに行く前に回数を足しておく（途中で失敗しても数える＝失敗の連打も止まる） */
async function addUsage(mem, n) {
  const { key, u } = await usage();
  const m = u.mems[mem] || { months: 0, lastAt: 0 };
  u.mems[mem] = { months: m.months + n, lastAt: Date.now() };
  u.total += n;
  await chrome.storage.local.set({ [key]: u });
}

/**
 * 拡張機能からの取得には Origin: chrome-extension://… が付く。
 * ヒヨリのサーバーから取るときと同じ見え方にするため、
 * この拡張機能自身の通信（tabId -1）に限って Origin を外す。
 * フリカレのサイトを普通に開いたときの通信には影響しない。
 */
let ruleReady = null;
function ensureRule() {
  if (!chrome.declarativeNetRequest) return Promise.resolve();
  ruleReady ??= chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'origin', operation: 'remove' }] },
      condition: { urlFilter: '|https://freecalend.com/open/data', tabIds: [-1], resourceTypes: ['xmlhttprequest', 'other'] },
    }],
  }).catch(() => {});
  return ruleReady;
}

async function post(mem, keys) {
  await ensureRule();
  const payload = {
    data: keys.map((x) => [
      x.k, OLD_TS, OLD_TS,
      x.perm ? [[`ok-${mem}-all-r-cald`, true]] : [],
      [],
    ]),
  };
  const body = new URLSearchParams({
    target_mem_no: String(mem),
    version: '3',
    mem_no: '0',
    keys: encodeURIComponent(JSON.stringify(payload)),
    dokisuru: 'true',
    fversion: FVERSION,
  });
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
    body: body.toString(),
    credentials: 'omit',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try {
    return JSON.parse(await res.text());
  } catch (e) {
    throw new Error('応答を読み取れません。公開URLか確認してください');
  }
}

/**
 * months: [[2026,9],[2026,10]] → { cells:{'2026-09-16':'本文'}, closed:{'2026-9':true}, skipped:['2026-11'] }
 * 同じカレンダーを読み込み中なら、終わるのを待ってから（多くは使い回しで）答える
 */
const inflight = new Map();
async function loadCalendar(mem, months) {
  while (inflight.has(mem)) {
    try { await inflight.get(mem); } catch (e) { /* 失敗は呼んだ側に任せる */ }
  }
  const job = loadCalendarNow(mem, months);
  inflight.set(mem, job);
  try { return await job; } finally { if (inflight.get(mem) === job) inflight.delete(mem); }
}

async function loadCalendarNow(mem, months) {
  const session = chrome.storage.session;
  const list = [...new Map(months.map(([y, m]) => [`${y}-${m}`, [y, m]])).values()]
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cells = {}, closed = {}, skipped = [];
  const ckey = ([y, m]) => `cal:${mem}:${y}-${m}`;
  const got = await session.get(list.map(ckey));
  let need = [];
  for (const ym of list) {
    const hit = got[ckey(ym)];
    if (hit && Date.now() - hit.at < CACHE_MS) {
      Object.assign(cells, hit.cells);
      if (hit.closed) closed[`${ym[0]}-${ym[1]}`] = true;
    } else need.push(ym);
  }
  if (!need.length) return { cells, closed, skipped, fetchedAt: new Date().toISOString(), cached: true };

  // ここから先はフリカレに問い合わせる。止める理由が無いか順に確かめる
  const { u, pausedUntil } = await usage();
  if (Date.now() < pausedUntil) {
    throw quotaError(`フリカレの取得を一時的に止めています（あと${Math.ceil((pausedUntil - Date.now()) / 60000)}分）`);
  }
  const m = u.mems[mem] || { months: 0, lastAt: 0 };
  const wait = m.lastAt + COOLDOWN_MS - Date.now();
  if (wait > 0) throw quotaError(`同じカレンダーは1分に1回まで読めます（あと${Math.ceil(wait / 1000)}秒）`);
  const room = Math.min(MAX_MONTHS_PER_LOAD, MAX_MONTHS_PER_MEM_DAY - m.months, MAX_MONTHS_TOTAL_DAY - u.total);
  if (room <= 0) {
    throw quotaError(u.total >= MAX_MONTHS_TOTAL_DAY
      ? `今日のフリカレの取得量の上限です（1日${MAX_MONTHS_TOTAL_DAY}か月分）。明日また試してください`
      : `このカレンダーは今日の取得の上限です（1日${MAX_MONTHS_PER_MEM_DAY}か月分）。明日また試してください`);
  }
  // 近い月から読む。読み切れない月は判断しない月として返す
  for (const [y, mo] of need.slice(room)) skipped.push(`${y}-${p2(mo)}`);
  need = need.slice(0, room);
  await addUsage(mem, need.length);

  for (let i = 0; i < need.length; i++) {
    const [y, mo] = need[i];
    const keys = [{ k: `ng-${mem}-all-r-cald-${mem}-${y}-${mo}`, perm: false }];
    for (let d = 1; d <= daysInMonth(y, mo); d++) {
      keys.push({ k: `cald-${mem}-${y}-${mo}-${d}`, perm: true });
    }
    let rows;
    try {
      rows = await post(mem, keys);
    } catch (e) {
      // 「公開URLではない」以外の失敗（通信・HTTPエラー）は、しばらく止める
      if (!/公開URL/.test(e.message)) await chrome.storage.local.set({ fpause: Date.now() + ERROR_PAUSE_MS });
      throw e;
    }
    const monthCells = {};
    let isClosed = false;
    for (const row of rows) {
      if (row[0] !== 'set') continue;
      const hda = JSON.parse(row[1]);
      const key = hda[2];
      if (key.startsWith('ng-')) { isClosed = true; continue; }
      const p = key.split('-');
      if (p.length < 5) continue;
      monthCells[`${p[2]}-${p2(p[3])}-${p2(p[4])}`] = (hda[3] && hda[3][1]) || '';
    }
    await session.set({ [ckey(need[i])]: { at: Date.now(), cells: monthCells, closed: isClosed } });
    Object.assign(cells, monthCells);
    if (isClosed) closed[`${y}-${mo}`] = true;
    if (i < need.length - 1) await sleep(GAP_MS);
  }
  return { cells, closed, skipped, fetchedAt: new Date().toISOString(), cached: false };
}

async function loadHolidays() {
  const got = await chrome.storage.local.get('holidays');
  const h = got.holidays;
  if (h && Date.now() - h.at < 7 * 24 * 3600 * 1000) return h.list;
  const list = [];
  try {
    const res = await fetch(HOLIDAY_URL, { credentials: 'omit' });
    if (res.ok) {
      const text = await res.text();
      const re = /DTSTART;VALUE=DATE:(\d{4})(\d{2})(\d{2})/g;
      let m;
      while ((m = re.exec(text))) list.push(`${m[1]}-${m[2]}-${m[3]}`);
    }
  } catch (e) { /* 取れなければ土日だけで判定 */ }
  if (list.length) await chrome.storage.local.set({ holidays: { at: Date.now(), list } });
  return list;
}

// ------------------------------------------------------------ Googleカレンダー（iCal の非公開アドレス）
//
// アドレスは予定を読める鍵なので、Google 以外には送らない（この拡張の保存領域にだけ置く）。
// 読んだ予定はこの中で日ごとの「埋まっている時刻」と「仮の時刻」に直し、予定名は外に出さない。
// 読んだ本文はメモリに10分だけ置く（保存はしない）。同じアドレスは30秒に1回まで読みに行く。
const GCAL_CACHE_MS = 10 * 60 * 1000;
const GCAL_COOLDOWN_MS = 30 * 1000;
const gcalCache = new Map();   // url -> { at, text }
const gcalLast = new Map();    // url -> 最後に読みに行った時刻

function gcalUrlOf(src) {
  let s = String(src || '').trim().replace(/^webcal:\/\//i, 'https://');
  if (!/^https:\/\/calendar\.google\.com\/calendar\/ical\/[^\s]+\.ics$/i.test(s)) return null;
  return s;
}

async function gcalText(url) {
  const hit = gcalCache.get(url);
  if (hit && Date.now() - hit.at < GCAL_CACHE_MS) return { text: hit.text, cached: true };
  const wait = (gcalLast.get(url) || 0) + GCAL_COOLDOWN_MS - Date.now();
  if (wait > 0) throw new Error(`少し待ってからもう一度押してください（あと${Math.ceil(wait / 1000)}秒）`);
  gcalLast.set(url, Date.now());
  let res;
  try {
    res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
  } catch (e) {
    throw new Error('Googleカレンダーにつながりません');
  }
  if (res.status === 404 || res.status === 403) throw new Error('アドレスが違うか、無効になっています。Googleカレンダーの設定でコピーし直してください');
  if (!res.ok) throw new Error(`Googleカレンダーから読めませんでした（HTTP ${res.status}）`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/.test(text)) throw new Error('カレンダーの形式ではありません。「iCal形式の非公開アドレス」か確認してください');
  gcalCache.set(url, { at: Date.now(), text });
  return { text, cached: false };
}

/** 区間をまとめる（重なり・つながりは1つに） */
function mergeRanges(list) {
  const a = list.slice().sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const r of a) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

const GCAL_MAX = 5;

/**
 * { urls:[…] (url 1つでも可), from:'YYYY-MM-DD', to, tentative:[語], ignore:[語] }
 * → { days: { 'YYYY-MM-DD': { busy:[[分,分]], tent:[[分,分]] } }, read, failed:[{ no, message }] }
 *   時刻は日本時間の0時からの分。複数のカレンダーは重ねる（どれかに予定があれば埋まっている）
 */
async function loadGcal(msg) {
  const raw = (Array.isArray(msg.urls) ? msg.urls : [msg.url]).map((u) => String(u || '').trim()).filter(Boolean);
  if (!raw.length) throw new Error('Googleカレンダーの「iCal形式の非公開アドレス」を貼ってください');
  if (raw.length > GCAL_MAX) throw new Error(`読み込めるカレンダーは${GCAL_MAX}つまでです`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(msg.from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(msg.to || '')) throw new Error('期間を読み取れません');
  const days = {}, failed = [];
  let read = 0, cached = true;
  for (let i = 0; i < raw.length; i++) {
    const url = gcalUrlOf(raw[i]);
    try {
      if (!url) throw new Error('「iCal形式の非公開アドレス」ではありません');
      const got = await gcalText(url);
      cached = cached && got.cached;
      addDays(days, got.text, msg);
      read++;
    } catch (e) {
      failed.push({ no: i + 1, message: e.message });
    }
  }
  if (!read) throw new Error(failed.map((f) => `${f.no}つめ：${f.message}`).join(' / '));
  for (const d of Object.values(days)) { d.busy = mergeRanges(d.busy); d.tent = mergeRanges(d.tent); }
  return { days, read, failed, cached };
}

/** 1つのカレンダーの予定を、日ごとの区間として days に足す（予定名はここから外に出さない） */
function addDays(days, text, msg) {
  const DAY = ICS.DAY_MS;
  const fromMs = Date.parse(msg.from + 'T00:00:00Z');
  const toMs = Date.parse(msg.to + 'T00:00:00Z') + DAY;
  const tent = (msg.tentative || []).filter(Boolean);
  const ignore = (msg.ignore || []).filter(Boolean);
  const occ = ICS.expand(ICS.parseEvents(text), fromMs, toMs);
  for (const o of occ) {
    const title = o.summary || '';
    if (ignore.some((w) => title.includes(w))) continue;
    const kind = tent.some((w) => title.includes(w)) ? 'tent' : 'busy';
    let day = Math.floor(Math.max(o.startMs, fromMs) / DAY) * DAY;
    const end = Math.min(o.endMs, toMs);
    while (day < end) {
      const s = o.allDay ? 0 : Math.max(0, (o.startMs - day) / 60000);
      const e = o.allDay ? 1440 : Math.min(1440, (o.endMs - day) / 60000);
      if (e > s) {
        const key = ICS.dateKey(day);
        const rec = (days[key] ||= { busy: [], tent: [] });
        rec[kind].push([Math.round(s), Math.round(e)]);
        // 予定名は、本人がフリカレに書くと選んだときだけ外に出す（msg.withNames）
        if (msg.withNames) {
          const name = title.replace(/\\;/g, ';').replace(/\\\\/g, '\\').replace(/\s+/g, ' ').trim().slice(0, 40);
          if (name) { rec.names ||= []; if (!rec.names.includes(name)) rec.names.push(name); }
        }
      }
      day += DAY;
    }
  }
}

/** ヒヨリの日程調整（参加用でも管理用でもよい）から、題名・候補日・確定日を読む */
const HIYORI_API = 'https://macchan.onrender.com/api/sched/events/';
const SETTINGS_URL = 'https://macchan.onrender.com/sched/#/me';
async function loadHiyori(url) {
  const s = String(url || '').trim();
  const m = s.match(/#\/e\/([A-Za-z0-9_-]+)/) || s.match(/^([A-Za-z0-9_-]{8,})$/);
  if (!m) throw new Error('ヒヨリの日程調整のURLを読み取れません');
  let res;
  try {
    res = await fetch(HIYORI_API + encodeURIComponent(m[1]), { credentials: 'omit' });
  } catch (e) {
    throw new Error('ヒヨリにつながりません。少し待ってからもう一度押してください');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new Error(data?.error || data?.message || 'この日程調整は見つかりません');
  return {
    title: data.title || '', dates: data.dates || [], confirmed: data.confirmed || [],
    heldTimes: data.heldTimes || {}, askTimes: !!data.askTimes,
    // 確定日に「揃う時間帯」を入れるため。名前は渡さない（id と答えだけ）
    participants: (data.participants || []).map((p) => ({ id: p.id })),
    answers: data.answers || {},
  };
}

/**
 * ヒヨリの「自分の設定」のうち、ふだんの都合と参加できる時間だけを読む（ログイン中のときだけ）。
 * フリカレに確定日を書くとき、いつもどおりの時間なら時刻を省くために使う。
 */
async function loadHiyoriMe() {
  try {
    const res = await fetch('https://macchan.onrender.com/api/sched/me', { credentials: 'include' });
    const d = await res.json().catch(() => null);
    if (!res.ok || !d?.loggedIn) return { loggedIn: false };
    return { loggedIn: true, pattern: d.profile?.pattern || null, times: d.profile?.times || null };
  } catch (e) {
    return { loggedIn: false };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg?.type === 'holidays') {
      return { ok: true, list: await loadHolidays() };
    }
    if (msg?.type === 'freecal') {
      const mem = parseMem(msg.url);
      if (!mem) throw new Error('フリカレのURLを読み取れません');
      const months = (msg.months || [])
        .map((s) => [Number(s.slice(0, 4)), Number(s.slice(5, 7))])
        .filter(([y, m]) => y > 2000 && m >= 1 && m <= 12)
        .slice(0, 12);
      if (!months.length) throw new Error('候補日から月を読み取れません');
      const [cal, holidays] = await Promise.all([loadCalendar(mem, months), loadHolidays()]);
      return { ok: true, mem, ...cal, holidays };
    }
    if (msg?.type === 'openOptions') {
      // 設定はヒヨリの「自分の設定」にまとめてある（拡張機能の欄はこの拡張機能が描く）
      chrome.tabs.create({ url: SETTINGS_URL });
      return { ok: true };
    }
    if (msg?.type === 'gcal') {
      return { ok: true, ...(await loadGcal(msg)) };
    }
    if (msg?.type === 'hiyoriMe') {
      return { ok: true, ...(await loadHiyoriMe()) };
    }
    if (msg?.type === 'hiyori') {
      return { ok: true, ...(await loadHiyori(msg.url)) };
    }
    throw new Error('unknown message');
  })()
    .then(sendResponse)
    .catch((e) => sendResponse({ ok: false, message: e.message || String(e) }));
  return true;
});

// ツールバーのアイコンを押したら、ヒヨリのサービスページを開く
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: 'https://macchan.onrender.com/sched/' });
});
