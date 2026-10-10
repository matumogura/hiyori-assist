/**
 * background.js — フリカレと祝日の取得だけを受け持つ
 *
 * 伝助のページ（content.js）からは別サイトへ直接取りに行けないので、
 * 拡張機能の裏側でまとめて取得して返す。
 *
 * ヒヨリ本体（app/sched/freecal.mjs）と同じ考え方で、
 * ・取得はユーザーが「取り込む」を押したときだけ
 * ・同じ月は CACHE_MS のあいだ使い回す
 * ・1カレンダーあたり1日 MAX_FETCH_PER_DAY 回まで
 * ・書き込みは一切しない
 */

const ENDPOINT = 'https://freecalend.com/open/data';
const OLD_TS = '1602144014';
const FVERSION = '-1';
const CACHE_MS = 30 * 60 * 1000;
const MAX_FETCH_PER_DAY = 10;
const GAP_MS = 300;
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

async function consumeQuota(mem) {
  const key = `quota:${mem}:${today()}`;
  const got = await chrome.storage.local.get(key);
  const n = got[key] || 0;
  if (n >= MAX_FETCH_PER_DAY) {
    throw new Error(`今日の取得回数の上限です（${MAX_FETCH_PER_DAY}回）。明日また試してください`);
  }
  // 古い日付の回数は消しておく
  const all = await chrome.storage.local.get(null);
  const stale = Object.keys(all).filter((k) => k.startsWith('quota:') && !k.endsWith(today()));
  if (stale.length) await chrome.storage.local.remove(stale);
  await chrome.storage.local.set({ [key]: n + 1 });
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

/** months: [[2026,9],[2026,10]] → { cells:{'2026-09-16':'本文'}, closed:{'2026-9':true} } */
async function loadCalendar(mem, months) {
  const session = chrome.storage.session;
  const ckey = `cal:${mem}:${months.map((x) => x.join('-')).join('_')}`;
  const hit = (await session.get(ckey))[ckey];
  if (hit && Date.now() - hit.at < CACHE_MS) return { ...hit.data, cached: true };

  await consumeQuota(mem);

  const cells = {}, closed = {};
  for (const [y, m] of months) {
    const keys = [{ k: `ng-${mem}-all-r-cald-${mem}-${y}-${m}`, perm: false }];
    for (let d = 1; d <= daysInMonth(y, m); d++) {
      keys.push({ k: `cald-${mem}-${y}-${m}-${d}`, perm: true });
    }
    const rows = await post(mem, keys);
    for (const row of rows) {
      if (row[0] !== 'set') continue;
      const hda = JSON.parse(row[1]);
      const key = hda[2];
      if (key.startsWith('ng-')) { closed[`${y}-${m}`] = true; continue; }
      const p = key.split('-');
      if (p.length < 5) continue;
      cells[`${p[2]}-${p2(p[3])}-${p2(p[4])}`] = (hda[3] && hda[3][1]) || '';
    }
    await sleep(GAP_MS);
  }
  const data = { cells, closed, fetchedAt: new Date().toISOString() };
  await session.set({ [ckey]: { at: Date.now(), data } });
  return { ...data, cached: false };
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
