(function (global) {
'use strict';
/**
 * availability.js — 空き状況の解釈まわり（共通ロジック）
 *
 * ヒヨリ本体の app/sched/availability.mjs をそのまま移したもの。
 * 祝日の取得だけは background.js 側に置いている。
 * 本体の判定を直したら、ここにも同じ変更を入れること。
 *
 * 入力元がフリカレでも手入力でも、最終的にこの形に落とす。
 *   { day: true|false|null, night: true|false|null }
 *   true=空き  false=不可  null=要確認
 */

// 記号の異体字。人によって書き方が違うのでまとめて受け付ける
const SYM = {
  free: ['○', '〇', '◯', '⚪︎', '⚪', '⭕', '◎', 'O', 'o'],
  busy: ['×', '✕', '✖', '☓', 'x', 'X'],
  tentative: ['△', '▲', '▵', '?', '？'],
};
const SLOT_WORDS = {
  day: ['昼', '日中', '午後', '朝'],
  night: ['夜', '夕', '晩'],
};

// 行全体が記号のとき用。値は [昼, 夜]
const MARKS = (() => {
  const m = {};
  SYM.free.forEach((c) => { m[c] = [true, true]; });
  SYM.busy.forEach((c) => { m[c] = [false, false]; });
  SYM.tentative.forEach((c) => { m[c] = [null, null]; });
  m.OK = [true, true]; m.ok = [true, true]; m['空'] = [true, true];
  return m;
})();

// 「夜○」「昼×」のような帯つき記号。異体字の総当たりで生成する
const SLOT_MARKS = (() => {
  const m = {};
  for (const slot of Object.keys(SLOT_WORDS)) {
    for (const w of SLOT_WORDS[slot]) {
      SYM.free.forEach((c) => { m[w + c] = [slot, true]; });
      SYM.busy.forEach((c) => { m[w + c] = [slot, false]; });
      SYM.tentative.forEach((c) => { m[w + c] = [slot, null]; });
    }
  }
  return m;
})();

// 予定名と同じ行に混ざっていても拾ってよい記号。
// 「x」「O」「OK」は普通の文章にも出るので、行全体が一致したときだけ採用する
const SAFE_INLINE = ['×', '✕', '✖', '☓', '○', '〇', '◯', '⚪︎', '⚪', '⭕', '◎', '△', '▲', '▵'];

/**
 * 空欄の日の既定値。[平日昼, 平日夜, 休日昼, 休日夜]
 * 記号が書かれている日は、こちらより記号が優先される。
 */
const PATTERNS = {
  free: [true, true, true, true],        // いつでも可
  weekday: [false, true, true, true],    // 平日は日中仕事
  shift: [null, true, null, true],       // 不定休。昼は都度確認
  nightly: [false, true, false, true],   // 夜のみ活動
};

/**
 * セル本文（フリカレの1日ぶん、または手入力の1行）を解釈する。
 * @param {string|null|undefined} body
 * @param {{mode?:string, pattern?:string, isHoliday?:boolean}} o
 *   mode: 'auto'（記号優先）| 'symbol'（記号のみ）| 'strict'（記入あれば埋まり）
 *   explicit: 本人が書いた文字として読む。帯を指して「空き」と書いたら、
 *             書かれなかった帯は不可とみなす（カレンダーの読み取りでは使わない）
 */
function classifyCell(body, o = {}) {
  const mode = o.mode || 'auto';
  const pattern = o.pattern || 'free';
  const base = PATTERNS[pattern] || PATTERNS.free;
  const baseDay = o.isHoliday ? base[2] : base[0];
  const baseNight = o.isHoliday ? base[3] : base[1];
  const blank = () => mk(baseDay, baseNight);

  if (body === undefined || body === null) return blank();
  const lines = String(body).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!lines.length) return blank();
  if (mode === 'strict') return mk(false, false);

  // --- 1) 記号を最優先で読む
  let day, night, sawMark = false;
  const freeSlot = { day: false, night: false };
  const put = (slot, val) => {
    if (slot === 'day') day = val; else night = val;
    sawMark = true;
    if (val === true) freeSlot[slot] = true;
  };

  for (const l of lines) {
    if (SLOT_MARKS[l]) { put(SLOT_MARKS[l][0], SLOT_MARKS[l][1]); continue; }
    if (MARKS[l]) { day = MARKS[l][0]; night = MARKS[l][1]; sawMark = true; continue; }

    // 予定名と同居している場合。帯つきを先に探す
    let hitSlot = false;
    for (const k of Object.keys(SLOT_MARKS)) {
      if (l.includes(k)) { put(SLOT_MARKS[k][0], SLOT_MARKS[k][1]); hitSlot = true; }
    }
    if (hitSlot) continue;

    for (const k of SAFE_INLINE) {
      if (l.includes(k)) { day = MARKS[k][0]; night = MARKS[k][1]; sawMark = true; break; }
    }
  }

  if (sawMark) {
    // 本人が書いた文字のときは、書かれたとおりに読む。
    // 「夜○」は夜だけ空き。「昼×」は昼だけ不可で、夜は既定のまま。
    if (o.explicit) {
      const namedFree = freeSlot.day || freeSlot.night;
      if (day === undefined) day = namedFree ? false : baseDay;
      if (night === undefined) night = namedFree ? false : baseNight;
      return mk(day, night);
    }
    // ○を書いた帯がもともと既定でも空きだったなら、その記号は書く必要が
    // なかったことになる。それでも書いたのは「この帯だけ」の意味と読み、
    // 触れられていない帯が既定で空きなら要確認に落とす。
    const redundant =
      (freeSlot.day && baseDay === true) || (freeSlot.night && baseNight === true);
    if (day === undefined) day = (redundant && baseDay === true) ? null : baseDay;
    if (night === undefined) night = (redundant && baseNight === true) ? null : baseNight;
    return mk(day, night);
  }

  // --- 2) 記号が無い場合はテキストの有無だけを見る
  if (mode === 'symbol') return blank();
  return mk(false, false);
}

const mk = (day, night) => ({ day, night, label: label(day, night) });

/** 昼と夜の状態をそのまま読めるラベルにする */
function label(day, night) {
  const s = (v) => (v === true ? '○' : v === false ? '×' : '△');
  return `昼${s(day)} 夜${s(night)}`;
}

/**
 * 2つの状態を重ねる。悪いほうが勝つ（false < null < true）。
 * 「カレンダーに予定が無い」ことと「その時間帯は普段動ける」ことは
 * 別の情報なので、掛け合わせて初めて空きと言える。
 */
function worst(a, b) {
  if (a === false || b === false) return false;
  if (a === null || b === null) return null;
  return true;
}

/** 全員ぶんを畳む。1人でも不可なら不可、不明が混じれば要確認 */
function combine(statuses, slot) {
  let unknown = false;
  for (const s of statuses) {
    if (s[slot] === false) return 'ng';
    if (s[slot] === null) unknown = true;
  }
  return unknown ? 'maybe' : 'ok';
}

// 帯の名前だけが書かれていたら、その帯が空いている意味に読む。
// 「9/14 夜」は「夜なら空いている」。予定名が書いてあるときとは別扱いにする。
const SLOT_ONLY = {
  '昼': '昼○', '夜': '夜○', '朝': '朝○', '晩': '晩○',
  '全': '○', '終日': '○', '終日可': '○', '終日OK': '○',
};

/** 行の本文をそろえる。先頭の「(火)」のような曜日は落とす */
function normalizeManualBody(body) {
  const t = String(body || '').trim()
    .replace(/^[（(]\s*[日月火水木金土]\s*[）)]\s*/, '')
    .trim();
  return SLOT_ONLY[t] || t;
}

/**
 * 「2026-10-03 夜×」形式の手入力を読む。
 * 年が無い「10/3」のような行は、opt.dates の中から月日の合う日を探して補う。
 * 見つからなければ opt.defaultYear（無ければ今年）の日として返す。
 * 本文が空の行は × とみなす。
 */
function parseManual(text, opt = {}) {
  const out = {};
  if (!text) return out;

  const byMd = new Map();
  for (const d of opt.dates || []) if (!byMd.has(d.slice(5))) byMd.set(d.slice(5), d);
  const p2 = (v) => String(v).padStart(2, '0');

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    let d = null, body = '';

    let m = line.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s*(.*)$/);
    if (m) {
      d = `${m[1]}-${p2(m[2])}-${p2(m[3])}`;
      body = m[4];
    } else {
      m = line.match(/^(\d{1,2})[-/.](\d{1,2})\s*(.*)$/);
      if (!m) continue;
      const md = `${p2(m[1])}-${p2(m[2])}`;
      d = byMd.get(md) || `${opt.defaultYear || new Date().getFullYear()}-${md}`;
      body = m[3];
    }
    if (!d) continue;
    out[d] = normalizeManualBody(body) || '×';
  }
  return out;
}

const isWeekend = (date) => {
  const d = new Date(date + 'T00:00:00Z').getUTCDay();
  return d === 0 || d === 6;
};


global.HiyoriAvail = {
  SYM, MARKS, SLOT_MARKS, SAFE_INLINE, PATTERNS, SLOT_WORDS,
  classifyCell, combine, worst, label, parseManual, isWeekend,
};
})(globalThis);
