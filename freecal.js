/**
 * freecal.js — フリカレ（ログイン中の自分のカレンダー）に書き込む
 *
 * できること
 *  ・Googleの予定を写す … Googleカレンダーの予定を「×」「昼×」「夜△」などの記号にして、日ごとの欄に入れる。
 *                          予定名は書かない（どこにも出さない）。
 *  ・確定日を書き込む   … ヒヨリで確定した日に「21:00〜24:00 題名」のような行を足す（時刻の入れ方は選べる）。
 *
 * 決まり
 *  ・書き込みはこのページから、ログイン中の本人の権限で行う。ヒヨリのサーバーは通さない。
 *  ・記号の行（VOCAB）だけを入れ替え、手書きの行には触れない。
 *  ・書く前に「現在 → 変更後」を見せ、本人が押したときだけ書く。自動では書かない。
 *  ・1回に書くのは MAX_CHANGES 日まで。1日ずつ間をあけて書き、書いた直後に読み直して確かめる。
 *  ・書く直前の中身を控えておき、「元に戻す」で戻せる。
 */
(() => {
  'use strict';
  if (window.__hiyoriFreecal) return;
  const MEM = Number((location.pathname.match(/mem(\d+)/) || [])[1] || 0);
  if (!MEM) return;
  window.__hiyoriFreecal = true;

  const ENDPOINT = '/open/data';
  const FVERSION = '1036';
  const OLD_TS = '1602144014';
  const MAX_CHANGES = 40;
  const GAP_MS = 400;
  const VOCAB = new Set(['×', '△', '昼×', '昼△', '夜×', '夜△']);
  const WIN = { day: [13 * 60, 18 * 60], night: [19 * 60, 24 * 60] };
  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const WD_ROMA = ['niti', 'getu', 'ka', 'sui', 'moku', 'kin', 'do'];
  const UNDO_KEY = `fcUndo:${MEM}`;

  const p2 = (n) => String(n).padStart(2, '0');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const enc = (o) => encodeURIComponent(JSON.stringify(o));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const words = (s) => String(s ?? '').split(/[,、，\s]+/).map((x) => x.trim()).filter(Boolean);

  // ------------------------------------------------------------ 拡張機能の裏側・保存領域
  const send = (msg) => new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, message: '拡張機能を再読み込みしてからページを開き直してください' });
        else resolve(res || { ok: false, message: '応答がありません' });
      });
    } catch (e) {
      resolve({ ok: false, message: '拡張機能を再読み込みしてからページを開き直してください' });
    }
  });
  const store = {
    get: (k) => new Promise((r) => { try { chrome.storage.local.get(k, (g) => r(g || {})); } catch (e) { r({}); } }),
    set: (o) => new Promise((r) => { try { chrome.storage.local.set(o, r); } catch (e) { r(); } }),
  };

  // ------------------------------------------------------------ フリカレとの通信（同じサイトなのでログイン中の本人として届く）
  async function postForm(params) {
    const res = await fetch(ENDPOINT, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: new URLSearchParams(params).toString(),
    });
    if (!res.ok) throw new Error(`フリカレがエラーを返しました（HTTP ${res.status}）`);
    return res.text();
  }
  const ncon = async () => (await (await fetch(`/ncon2/${MEM}`, { credentials: 'same-origin' })).text()).trim();

  async function readKeys(keys) {
    const text = await postForm({
      target_mem_no: String(MEM), version: '3', mem_no: String(MEM),
      keys: enc({ data: keys.map((k) => [k, OLD_TS, OLD_TS, [], []]) }),
      dokisuru: 'true', fversion: FVERSION,
    });
    let rows;
    try { rows = JSON.parse(text); } catch (e) { throw new Error('フリカレの応答を読み取れません。ログインし直してください'); }
    const map = new Map();
    for (const row of rows) {
      if (row[0] === 'set') { const h = JSON.parse(row[1]); map.set(h[2], h); }
      else if (row[0] === 'get') map.set(row[1], null);
      else if (row[0] === 'none') map.set(row[2], null);
    }
    return map;
  }

  // ------------------------------------------------------------ 日付と、新しく作る日の中身
  const dayKey = (y, m, d) => `cald-${MEM}-${y}-${m}-${d}`;
  const ngKey = (y, m) => `ng-${MEM}-all-r-cald-${MEM}-${y}-${m}`;
  const dateStr = (y, m, d) => `${y}-${p2(m)}-${p2(d)}`;
  const parseDate = (s) => { const [y, m, d] = s.split('-').map(Number); return { y, m, d }; };
  const jstMid = (y, m, d) => Date.UTC(y, m - 1, d) / 1000 - 9 * 3600;
  const dowOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const monthLabel = (n) => (n === 0 ? '今月' : n === 1 ? '来月' : `${n}ヶ月後`);
  const todayStr = () => { const t = new Date(); return dateStr(t.getFullYear(), t.getMonth() + 1, t.getDate()); };
  const addDays = (s, n) => { const { y, m, d } = parseDate(s); const t = new Date(Date.UTC(y, m - 1, d + n)); return t.toISOString().slice(0, 10); };
  const shortDate = (s) => { const { y, m, d } = parseDate(s); return `${m}/${d}(${WD[dowOf(y, m, d)]})`; };

  function buildMeta(y, m, d) {
    const now = new Date();
    const dow = dowOf(y, m, d);
    const ymd = y * 10000 + m * 100 + d;
    const days = Math.round((jstMid(y, m, d) - jstMid(now.getFullYear(), now.getMonth() + 1, now.getDate())) / 86400);
    const months = (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1));
    return [y, m, d, 0, 0, 0, dow, jstMid(y, m, d), WD[dow],
      ymd * 1000000, ymd * 10000, ymd, y * 100 + m,
      months, monthLabel(months), `${days}日後`, days, WD_ROMA[dow]];
  }
  const weekIndex = (y, m, d) => Math.floor((d - 1 + (dowOf(y, m, 1) + 6) % 7) / 7);

  let holidays = new Set();
  function buildValue(existing, y, m, d, body) {
    if (existing) { const v = existing[3].slice(); v[1] = body; return v; }
    if (d + 1 > daysInMonth(y, m)) throw new Error('月末日にはまだ何も書かれていないため、作れません（フリカレで一度何か書くと書き込めます）');
    const holi = [0, 6].includes(dowOf(y, m, d)) || holidays.has(dateStr(y, m, d)) ? ' day_holi' : '';
    return [buildMeta(y, m, d), body, null, '', '', '', holi, '',
      null, null, null, null, null, null, null, null,
      weekIndex(y, m, d), dayKey(y, m, d + 1)];
  }

  function monthsBetween(from, to) {
    const f = parseDate(from), t = parseDate(to);
    const out = [];
    let y = f.y, m = f.m;
    while (y < t.y || (y === t.y && m <= t.m)) { out.push([y, m]); if (++m > 12) { m = 1; y++; } }
    return out;
  }

  /** 期間の日を読む → { cells: Map(date -> hda|null), closed: [YYYY-MM] } */
  async function readRange(from, to) {
    const cells = new Map(), closed = [];
    const months = monthsBetween(from, to);
    if (months.length > 6) throw new Error('一度に読めるのは6か月分までです');
    for (let i = 0; i < months.length; i++) {
      const [y, m] = months[i];
      const keys = [ngKey(y, m)];
      for (let d = 1; d <= daysInMonth(y, m); d++) keys.push(dayKey(y, m, d));
      const map = await readKeys(keys);
      if (map.get(ngKey(y, m))) { closed.push(`${y}-${p2(m)}`); continue; }
      for (let d = 1; d <= daysInMonth(y, m); d++) {
        const ds = dateStr(y, m, d);
        if (ds >= from && ds <= to) cells.set(ds, map.get(dayKey(y, m, d)) || null);
      }
      if (i < months.length - 1) await sleep(GAP_MS);
    }
    return { cells, closed };
  }

  // 末尾の改行の違いは無視して比べる
  const norm = (b) => String(b || '').replace(/\n+$/, '');

  /** 1日ぶん書く。読んだときから変わっていたら書かない。書いたら読み直して確かめる */
  async function writeOne(c) {
    const { y, m, d } = parseDate(c.date);
    const key = dayKey(y, m, d);
    const fresh = (await readKeys([key])).get(key) || null;
    const freshBody = fresh ? fresh[3][1] : null;
    if (norm(freshBody) !== norm(c.before)) return { ...c, ok: false, reason: 'その間に書き換えられていたので飛ばしました' };
    let value;
    // フリカレは空の本文を「変更なし」として無視するので、空にするときは改行だけを書く（画面では空に見える）
    try { value = buildValue(fresh, y, m, d, c.after || '\n'); } catch (e) { return { ...c, ok: false, reason: e.message }; }
    const hda = ['hda', 'on', key, value, String(Math.floor(Date.now() / 1000)), null, 'e'];
    await postForm({
      target_mem_no: String(MEM),
      updsuru: enc({ data: [[hda, [], '', [], [], []]] }),
      dokisuru_1: 'true',
      lasttimes: enc({ data: [[MEM, await ncon()]] }),
      version: '3', fversion: FVERSION,
    });
    const after = (await readKeys([key])).get(key) || null;
    const afterBody = after ? after[3][1] : null;
    const ok = norm(afterBody) === norm(c.after);
    return { ...c, ok, reason: ok ? '' : '書き込めませんでした（ログイン中のカレンダーか確認してください）' };
  }

  // ------------------------------------------------------------ 本文の組み立て
  /** 記号の行だけ入れ替える。手書きの行は順序ごと残す */
  // この拡張が書く行：記号だけ（×・昼×・夜△…、「昼× 夜△」も）か、「予定名 記号」
  const MARK_RE = '(?:昼|夜)?[×△](?: (?:昼|夜)[×△])?';
  const MANAGED = new RegExp(`^(?:${MARK_RE}|.+ ${MARK_RE})$`);
  const isManaged = (l) => VOCAB.has(l.trim()) || MANAGED.test(l.trim());
  /**
   * この拡張が書いた行だけを入れ替える。手書きの行は順序ごと残す。
   * 予定名を書くときは、手書きで同じ予定名だけの行があれば、書く行にまとめる（二重に並ばないように）
   */
  function mergeMarks(current, line, names = []) {
    const kept = (current || '').split('\n').filter((l) => !isManaged(l) && !names.includes(l.trim()));
    const add = line ? line.split('\n') : [];
    return [...add, ...kept].join('\n').replace(/\n+$/, '');
  }
  function slotState(x, win) {
    const hit = (list) => (list || []).some(([s, e]) => s < win[1] && e > win[0]);
    if (hit(x?.busy)) return false;
    if (hit(x?.tent)) return null;
    return true;
  }
  /** 埋まっている時刻 → 「×」「昼×」「昼×\n夜△」など。空いていれば '' */
  function markOf(x) {
    const day = slotState(x, WIN.day), night = slotState(x, WIN.night);
    if (day === false && night === false) return '×';
    if (day === null && night === null) return '△';
    const s = (v) => (v === false ? '×' : v === null ? '△' : '');
    return [day !== true ? `昼${s(day)}` : '', night !== true ? `夜${s(night)}` : ''].filter(Boolean).join('\n');
  }
  /**
   * その日に書く行。
   *   mark  … 記号だけ（「昼×\n夜△」のように行を分ける。前のスクリプトと同じ形）
   *   both  … 「予定名 記号」を1行で（予定名が先、記号は改行なしで後ろ）
   *   names … 予定名だけ（予定があれば、○×の時間帯の外でも書く）
   */
  function lineOf(x, what) {
    const mark = markOf(x);
    const names = what === 'mark' ? [] : (x?.names || []);
    if (what === 'names') return names.join('、');
    if (!mark) return '';
    if (!names.length) return mark;
    return `${names.join('、')} ${mark.replace(/\n/g, ' ')}`;
  }

  // ------------------------------------------------------------ 画面
  const host = document.createElement('div');
  host.id = 'hiyori-freecal';
  host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .wrap {
      --ink: #1f3a4a; --ink-2: #3c5868; --muted: #5d7685; --faint: #8fa5b1;
      --bg: #f3fafc; --card: #fff; --soft: #eaf2f5; --soft-2: #dcecf1;
      --ring: rgba(31,58,74,.09); --ring-strong: rgba(31,58,74,.16);
      --accent: #2b78ad; --accent-ink: #1f5f8c; --accent-soft: #e1f0f8;
      --ng-ink: #bf3a3f; --ng-bg: #fdeeee; --ok-ink: #25704f; --ok-bg: #eaf6ef;
      font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif;
      font-size: 14px; line-height: 1.55; color: var(--ink);
      background: var(--bg); border-radius: 14px; width: 340px; max-width: calc(100vw - 32px);
      box-shadow: 0 0 0 1px var(--ring), 0 8px 24px rgba(31,58,74,.12);
    }
    .top { display: flex; align-items: center; gap: 8px; padding: 10px 12px; cursor: pointer; user-select: none; }
    .top b { font-size: 14px; }
    .spacer { flex: 1; }
    .chev { color: var(--muted); transition: transform .2s; }
    .wrap.collapsed { width: max-content; }
    .wrap.collapsed .body { display: none; }
    .wrap.collapsed .chev { transform: rotate(180deg); }
    .body { display: grid; gap: 8px; padding: 0 8px 10px; max-height: 70vh; overflow: auto; }
    .tabs { display: flex; gap: 4px; background: var(--soft); border-radius: 10px; padding: 3px; }
    .tabs button { flex: 1; background: transparent; padding: 6px; }
    .tabs button[aria-selected=true] { background: #fff; box-shadow: 0 0 0 1px var(--ring); font-weight: 700; }
    .seg { display: flex; gap: 2px; background: var(--soft); border-radius: 9px; padding: 2px; }
    .seg button { flex: 1; background: transparent; padding: 5px 4px; font-size: 13px; border-radius: 7px; white-space: nowrap; }
    .seg button[aria-checked=true] { background: #fff; box-shadow: 0 0 0 1px var(--ring); font-weight: 700; color: var(--accent-ink); }
    .card { background: var(--card); border-radius: 12px; padding: 10px; box-shadow: 0 0 0 1px var(--ring); display: grid; gap: 8px; }
    .row { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
    button { font: inherit; cursor: pointer; border: 0; border-radius: 9px; padding: 7px 12px; background: var(--soft); color: var(--ink); }
    button:hover:not([disabled]) { background: var(--soft-2); }
    button[disabled] { opacity: .45; cursor: default; }
    .primary { background: var(--accent); color: #fff; font-weight: 700; }
    .primary:hover:not([disabled]) { background: var(--accent-ink); }
    .ghost { background: transparent; color: var(--muted); }
    select, input[type=text] { font: inherit; color: var(--ink); background: #fff; border: 0; border-radius: 9px; padding: 6px 8px; box-shadow: 0 0 0 1px var(--ring-strong); min-width: 0; }
    input[type=text] { flex: 1; }
    .msg { font-size: 13px; color: var(--muted); }
    .msg.err { color: var(--ng-ink); }
    .msg.good { color: var(--ok-ink); }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    li label { display: grid; grid-template-columns: auto 74px 1fr; gap: 6px; align-items: start; font-size: 13px; padding: 4px 6px; border-radius: 8px; cursor: pointer; }
    li label:hover { background: var(--soft); }
    .d { font-weight: 700; white-space: nowrap; }
    .ch { white-space: normal; }
    .old { color: var(--muted); }
    .old b, .new b { font-weight: 400; font-size: 11.5px; color: var(--faint); margin-right: 4px; }
    .new { color: var(--ink); font-weight: 700; }
    .rm { color: var(--ng-ink); }
    .ch { display: grid; gap: 1px; }
    .all { font-size: 12.5px; color: var(--muted); }
  </style>
  <div class="wrap collapsed">
    <div class="top" id="toggle" role="button" tabindex="0" aria-expanded="false">
      <b>ヒヨリ</b><span class="msg">フリカレに書き込む</span><span class="spacer"></span><span class="chev">▾</span>
    </div>
    <div class="body">
      <div class="tabs" role="tablist">
        <button type="button" role="tab" data-tab="g" aria-selected="true">Googleの予定</button>
        <button type="button" role="tab" data-tab="h" aria-selected="false">確定日</button>
      </div>

      <section class="card" data-pane="g">
        <div class="row">
          <span>今日から</span>
          <select id="span">
            <option value="13">2週間</option>
            <option value="30" selected>1か月</option>
            <option value="60">2か月</option>
            <option value="90">3か月</option>
          </select>
          <span class="spacer"></span>
          <button type="button" id="gplan">変わる日を見る</button>
        </div>
        <div class="seg" role="radiogroup" aria-label="書く内容">
          <button type="button" role="radio" data-what="mark" aria-checked="true">○×だけ</button>
          <button type="button" role="radio" data-what="both" aria-checked="false">予定名と○×</button>
          <button type="button" role="radio" data-what="names" aria-checked="false">予定名だけ</button>
        </div>
        <div class="seg" role="radiogroup" aria-label="すでに書いてある内容">
          <button type="button" role="radio" data-keep="keep" aria-checked="true">手書きを残す</button>
          <button type="button" role="radio" data-keep="over" aria-checked="false">予定がある日は上書き</button>
        </div>
        <div class="msg err" id="gnamewarn" hidden>予定名がフリカレに書かれます。公開URLを知っている人にも見えます。</div>
        <div class="msg" id="gmsg">「×」「昼×」「夜△」などの行だけを入れ替え、手書きの行は残します。書き込む前に、フリカレを開いているほかのタブやアプリは閉じてください。</div>
        <div id="glist"></div>
      </section>

      <section class="card" data-pane="h" hidden>
        <div class="row"><input type="text" id="hurl" placeholder="ヒヨリの日程調整のURL" spellcheck="false" autocomplete="off"><button type="button" id="hplan">読む</button></div>
        <div class="row"><span>時刻</span><select id="htime" style="flex:1"></select></div>
        <label class="row" style="font-size:13px;cursor:pointer"><input type="checkbox" id="hshort">いつもの時間なら省く</label>
        <div class="msg" id="hmsg">確定した日に、題名の行を足します。</div>
        <div id="hlist"></div>
      </section>

      <div class="row" id="undoRow" hidden>
        <span class="msg" id="undoMsg"></span><span class="spacer"></span><button type="button" class="ghost" id="undo">元に戻す</button>
      </div>
    </div>
  </div>`;
  document.documentElement.appendChild(host);
  // パネルでの操作をフリカレのページに渡さない。
  // フリカレは画面全体でクリック・キー操作を拾っていて、パネルを押すと下にあるカレンダーの
  // 切り替えなどが動いてしまうため、パネルの外へ伝わる前に止める（パネルの中のボタンには影響しない）
  for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'wheel', 'contextmenu', 'input', 'change']) {
    host.addEventListener(type, (e) => e.stopPropagation());
  }
  const $ = (s) => root.querySelector(s);

  const wrap = $('.wrap');
  const toggle = () => {
    wrap.classList.toggle('collapsed');
    $('#toggle').setAttribute('aria-expanded', String(!wrap.classList.contains('collapsed')));
  };
  $('#toggle').onclick = toggle;
  $('#toggle').onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } };
  root.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => {
      root.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', String(x === b)));
      root.querySelectorAll('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== b.dataset.tab; });
    };
  });
  const say = (el, text, kind = '') => { el.textContent = text; el.className = `msg${kind ? ' ' + kind : ''}`; };

  /** 変更の一覧（チェックで選べる）と「書き込む」ボタン */
  function renderPlan(box, msgEl, changes, onDone) {
    if (!changes.length) { box.innerHTML = ''; return; }
    box.innerHTML = `
      <ul>${changes.map((c, i) => `
        <li><label>
          <input type="checkbox" data-i="${i}" checked>
          <span class="d">${esc(shortDate(c.date))}</span>
          <span class="ch"><span class="old"><b>いま</b>${c.before ? esc(c.before.replace(/\n+$/, '').replace(/\n/g, ' / ')) : '（空）'}</span><span class="new"><b>→</b>${c.after ? esc(c.after.replace(/\n/g, ' / ')) : '<span class="rm">（空にする）</span>'}</span></span>
        </label></li>`).join('')}
      </ul>
      <div class="row"><span class="all" id="cnt"></span><span class="spacer"></span><button type="button" class="primary" id="apply">書き込む</button></div>`;
    const picked = () => [...box.querySelectorAll('input[type=checkbox]')].filter((x) => x.checked).map((x) => changes[+x.dataset.i]);
    const upd = () => {
      const n = picked().length;
      box.querySelector('#cnt').textContent = `${n}日${n > MAX_CHANGES ? `（1回に${MAX_CHANGES}日まで）` : ''}`;
      box.querySelector('#apply').disabled = !n || n > MAX_CHANGES;
    };
    box.querySelectorAll('input[type=checkbox]').forEach((x) => { x.onchange = upd; });
    upd();
    box.querySelector('#apply').onclick = async (ev) => {
      const list = picked();
      ev.target.disabled = true;
      const results = await applyChanges(list, msgEl);
      box.innerHTML = '';
      onDone?.(results);
    };
  }

  /** 書く。書く前の中身を控えに残す */
  async function applyChanges(list, msgEl) {
    await store.set({ [UNDO_KEY]: { at: Date.now(), items: list.map((c) => ({ date: c.date, before: c.before, after: c.after })) } });
    const results = [];
    for (let i = 0; i < list.length; i++) {
      say(msgEl, `書き込み中… ${i + 1}/${list.length}`);
      try { results.push(await writeOne(list[i])); } catch (e) { results.push({ ...list[i], ok: false, reason: e.message }); }
      await sleep(GAP_MS);
    }
    // 書けた日だけを「元に戻す」の対象にする
    const done = results.filter((r) => r.ok);
    await store.set({ [UNDO_KEY]: { at: Date.now(), items: done.map((c) => ({ date: c.date, before: c.before, after: c.after })) } });
    // フリカレを開いている別のタブやアプリは、古い内容を書き戻すことがある。少し待って確かめる
    say(msgEl, '書き込みを確かめています…');
    await sleep(4000);
    const reverted = [];
    try {
      const keys = done.map((c) => { const { y, m, d } = parseDate(c.date); return dayKey(y, m, d); });
      const now = keys.length ? await readKeys(keys) : new Map();
      done.forEach((c, i) => { const h = now.get(keys[i]); if (norm(h ? h[3][1] : '') !== norm(c.after)) reverted.push(c); });
    } catch (e) { /* 確かめられなくても結果は出す */ }
    const ng = results.filter((r) => !r.ok);
    const okN = done.length - reverted.length;
    if (reverted.length || ng.length) {
      say(msgEl, `${okN}日書き込みました。${reverted.length + ng.length}日は反映されませんでした（${[...reverted, ...ng].map((r) => shortDate(r.date)).join('、')}）。`
        + 'フリカレを開いている別のタブやスマホのアプリが、古い内容を書き戻した可能性があります。それらを閉じてから、もう一度「変わる日を見る」から試してください。', 'err');
    } else {
      say(msgEl, `${okN}日書き込みました。ページを読み込み直すと表示されます。`, 'good');
    }
    showUndo();
    return results;
  }

  // ------------------------------------------------------------ Googleの予定を写す
  // 書く内容：mark（○×だけ）／both（予定名と○×）／names（予定名だけ）
  let gWhat = 'mark';
  const setWhat = (v) => {
    gWhat = ['mark', 'both', 'names'].includes(v) ? v : 'mark';
    root.querySelectorAll('[data-what]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.what === gWhat)));
    $('#gnamewarn').hidden = gWhat === 'mark';
  };
  // すでに書いてある内容：keep（手書きの行は残す）／over（Googleに予定がある日は、その日の欄をまるごと書き換える）
  let gKeep = 'keep';
  const setKeep = (v) => {
    gKeep = v === 'over' ? 'over' : 'keep';
    root.querySelectorAll('[data-keep]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.keep === gKeep)));
  };
  store.get('fcGKeep').then((g) => setKeep(g.fcGKeep));
  root.querySelectorAll('[data-keep]').forEach((b) => {
    b.onclick = () => { if (b.dataset.keep === gKeep) return; setKeep(b.dataset.keep); store.set({ fcGKeep: gKeep }); $('#glist').innerHTML = ''; };
  });
  // 前の版の保存値（'names' は「予定名と○×」だった）
  store.get(['fcGWhat2', 'fcGWhat']).then((g) => setWhat(g.fcGWhat2 || (g.fcGWhat === 'names' ? 'both' : 'mark')));
  root.querySelectorAll('[data-what]').forEach((b) => {
    b.onclick = () => { if (b.dataset.what === gWhat) return; setWhat(b.dataset.what); store.set({ fcGWhat2: gWhat }); $('#glist').innerHTML = ''; };
  });
  $('#gplan').onclick = async () => {
    const btn = $('#gplan'), msg = $('#gmsg');
    btn.disabled = true;
    $('#glist').innerHTML = '';
    try {
      const got = await store.get('settings');
      const s = got.settings || {};
      const urls = (Array.isArray(s.gcals) ? s.gcals : [s.gcal]).map((u) => String(u || '').trim()).filter(Boolean);
      if (!urls.length) {
        say(msg, 'Googleカレンダーのアドレスが未設定です。', 'err');
        const open = document.createElement('button');
        open.type = 'button';
        open.textContent = '設定を開く';
        open.onclick = () => send({ type: 'openOptions' });
        $('#glist').replaceChildren(open);
        return;
      }
      const withNames = gWhat !== 'mark';
      const from = todayStr(), to = addDays(from, Number($('#span').value));
      say(msg, 'Googleカレンダーを読んでいます…');
      const [g, h] = await Promise.all([
        send({ type: 'gcal', urls, from, to, tentative: words(s.gcalTent ?? '仮, 未定'), ignore: words(s.gcalIgnore), withNames }),
        send({ type: 'holidays' }),
      ]);
      if (!g.ok) { say(msg, g.message, 'err'); return; }
      if (h.ok) holidays = new Set(h.list);
      say(msg, 'フリカレを読んでいます…');
      const { cells, closed } = await readRange(from, to);
      const changes = [];
      for (const [date, hda] of cells) {
        const before = hda ? hda[3][1] || '' : '';
        const names = withNames ? (g.days[date]?.names || []) : [];
        const line = lineOf(g.days[date], gWhat);
        // 上書き：予定がある日は欄をまるごとこの行にする。予定が無い日は、手書きを消さないよう通常どおり
        const after = gKeep === 'over' && line
          ? line
          : mergeMarks(before, line, names.length ? [...names, names.join('、')] : []);
        // 末尾の改行だけの違いは変更とみなさない
        if (before.replace(/\n+$/, '') !== after) changes.push({ date, before, after });
      }
      const notes = [];
      if (g.failed?.length) notes.push(`読めなかったカレンダー：${g.failed.map((f) => `${f.no}つめ`).join('、')}`);
      if (closed.length) notes.push(`非公開の月は飛ばしました：${closed.join('、')}`);
      if (!changes.length) { say(msg, ['変わる日はありません。', ...notes].join(' '), 'good'); return; }
      say(msg, [`${changes.length}日が変わります。外したい日はチェックを外してください。`, ...notes].join(' '));
      renderPlan($('#glist'), msg, changes);
    } catch (e) {
      say(msg, e.message || String(e), 'err');
    } finally {
      btn.disabled = false;
    }
  };

  // ------------------------------------------------------------ 確定日を書き込む
  //
  // 時刻の入れ方は選べる。「日ごと」はヒヨリの画面の「確定した日」と同じ考え方で、
  // その日に全員が揃う帯（全・昼・夜）のうち、主催者が「やらない」にしていない帯の開催時間を入れる。
  const fmtHour = (h) => { const hh = Math.floor(h); return `${hh}:${h - hh ? '30' : '00'}`; };
  const BAND = { day: '昼', night: '夜' };
  const SLOT = { all: ['day', 'night'], day: ['day'], night: ['night'], ng: [] };
  const TIME_MODES = [
    ['auto', '日ごと（揃う時間帯）'],
    ['day', '昼の開催時間'],
    ['night', '夜の開催時間'],
    ['both', '昼と夜の開催時間'],
    ['none', '時刻を入れない'],
  ];
  let hctx = null;   // 読んだヒヨリとフリカレ { r, cells, closed, dates }

  /** その日に全員が揃う帯。答えていない人がいれば決めない */
  function commonSlot(r, date) {
    const ps = r.participants || [];
    if (!ps.length) return null;
    let day = true, night = true;
    for (const p of ps) {
      const a = r.answers?.[p.id]?.[date];
      if (!a) return null;
      const s = SLOT[a.value] || [];
      if (!s.includes('day')) day = false;
      if (!s.includes('night')) night = false;
    }
    return day && night ? 'all' : day ? 'day' : night ? 'night' : null;
  }
  /** 帯 → 「21:00〜24:00」。主催者が時間を決めていなければ「夜」 */
  function bandText(r, k) {
    const h = r.heldTimes?.[k];
    if (h && h !== 'off' && typeof h.start === 'number') return `${fmtHour(h.start)}〜${fmtHour(h.end)}`;
    return BAND[k];
  }
  function timePart(r, date, mode) {
    if (mode === 'none') return '';
    const off = (k) => r.heldTimes?.[k] === 'off';
    let bands;
    if (mode === 'auto') { const c = commonSlot(r, date); bands = c ? SLOT[c] : []; }
    else bands = mode === 'both' ? ['day', 'night'] : [mode];
    bands = bands.filter((k) => !off(k));
    if (!bands.length) return '';
    if ($('#hshort').checked) return abbreviate(r, date, bands);
    return bands.map((k) => bandText(r, k)).join('／');
  }
  /** 同じ集まりの行か（題名だけ・「題名 時刻」・前の形の「時刻 題名」）。時刻を変えて入れ直すときに古い行を外すため */
  const TIME_WORDS = /^[昼夜全日\d:〜／ ]+$/;
  function isSameEvent(line, title) {
    const l = line.trim();
    if (l === title) return true;
    if (l.startsWith(title + ' ') && TIME_WORDS.test(l.slice(title.length + 1))) return true;
    if (l.endsWith(' ' + title) && TIME_WORDS.test(l.slice(0, -title.length - 1))) return true;
    return false;
  }

  // ---- いつもの時間なら省く
  // ヒヨリの「自分の設定」の、ふだんの都合（平日の昼は仕事など）と参加できる時間をもとに、
  // その日がいつもどおりの帯・開始時刻なら題名だけにする。
  //   帯がいつもと違う   … 「題名 夜」「題名 昼」「題名 全日」
  //   開始だけ違う       … 「題名 22:00〜24:00」（いつもと違う帯の時間だけ）
  // [平日昼, 平日夜, 休日昼, 休日夜]。availability.js の PATTERNS と同じ
  const PATTERNS = {
    free: [true, true, true, true], weekday: [false, true, true, true],
    shift: [null, true, null, true], nightly: [false, true, false, true],
  };
  const PRESET_DEFAULT = { day: { on: true, start: 13 }, night: { on: true, start: 21 } };
  let me = null;   // { loggedIn, pattern, times }

  function usualBands(date) {
    const wd = new Date(date + 'T00:00:00Z').getUTCDay();
    const off = wd === 0 || wd === 6 || holidays.has(date);
    const pat = PATTERNS[me?.pattern] || PATTERNS.weekday;
    const times = me?.times || PRESET_DEFAULT;
    const [d, n] = off ? [pat[2], pat[3]] : [pat[0], pat[1]];
    return ['day', 'night'].filter((k, i) => [d, n][i] !== false && times[k]?.on !== false);
  }
  function abbreviate(r, date, bands) {
    const usual = usualBands(date);
    const times = me?.times || PRESET_DEFAULT;
    const startOf = (k) => { const h = r.heldTimes?.[k]; return h && h !== 'off' && typeof h.start === 'number' ? h.start : null; };
    const sameBands = bands.length === usual.length && bands.every((k) => usual.includes(k));
    const odd = bands.filter((k) => startOf(k) !== null && startOf(k) !== times[k]?.start);
    if (sameBands) return odd.map((k) => bandText(r, k)).join('／');            // 帯どおり。開始が違う帯だけ時刻
    const label = bands.length === 2 ? '全日' : BAND[bands[0]] || '';
    const extra = odd.map((k) => bandText(r, k)).join('／');
    return [label, extra].filter(Boolean).join(' ');
  }

  function buildHiyoriPlan() {
    const msg = $('#hmsg');
    $('#hlist').innerHTML = '';
    if (!hctx) return;
    const { r, cells, closed, dates } = hctx;
    const title = r.title || '日程調整';
    const mode = $('#htime').value;
    const changes = [];
    for (const date of dates) {
      if (!cells.has(date)) continue;   // 非公開の月
      const hda = cells.get(date);
      const before = hda ? hda[3][1] || '' : '';
      const t = timePart(r, date, mode);
      const line = t ? `${title} ${t}` : title;
      const kept = before.replace(/\n+$/, '').split('\n').filter((l) => l !== '' && !isSameEvent(l, title));
      const after = [...kept, line].join('\n');
      if (norm(before) !== after) changes.push({ date, before, after });
    }
    const notes = closed.length ? [`非公開の月は飛ばしました：${closed.join('、')}`] : [];
    if (!changes.length) { say(msg, ['確定日はすべて書き込み済みです。', ...notes].join(' '), 'good'); return; }
    if ($('#hshort').checked && !me?.loggedIn) notes.push('ヒヨリにログインしていないので、いつもの時間は「平日は夜・休日は全日、昼13時・夜21時から」として省いています。');
    say(msg, [`「${title}」を${changes.length}日に書きます。`, ...notes].join(' '));
    renderPlan($('#hlist'), msg, changes);
  }

  $('#htime').innerHTML = TIME_MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
  store.get(['fcHiyoriUrl', 'fcTimeMode', 'fcShort']).then((g) => {
    if (g.fcHiyoriUrl) $('#hurl').value = g.fcHiyoriUrl;
    if (TIME_MODES.some(([v]) => v === g.fcTimeMode)) $('#htime').value = g.fcTimeMode;
    $('#hshort').checked = g.fcShort !== false;
  });
  $('#hshort').onchange = () => { store.set({ fcShort: $('#hshort').checked }); buildHiyoriPlan(); };
  $('#htime').onchange = () => { store.set({ fcTimeMode: $('#htime').value }); buildHiyoriPlan(); };

  $('#hplan').onclick = async () => {
    const btn = $('#hplan'), msg = $('#hmsg');
    const url = $('#hurl').value.trim();
    $('#hlist').innerHTML = '';
    hctx = null;
    if (!url) { say(msg, 'ヒヨリの日程調整のURLを貼ってください', 'err'); return; }
    btn.disabled = true;
    try {
      say(msg, 'ヒヨリを読んでいます…');
      const [r, m, h] = await Promise.all([send({ type: 'hiyori', url }), send({ type: 'hiyoriMe' }), send({ type: 'holidays' })]);
      if (!r.ok) { say(msg, r.message, 'err'); return; }
      me = m.ok ? m : { loggedIn: false };
      if (h.ok) holidays = new Set(h.list);
      await store.set({ fcHiyoriUrl: url });
      const dates = [...new Set(r.confirmed || [])].sort();
      if (!dates.length) { say(msg, 'この日程調整には、まだ確定した日がありません。', 'err'); return; }
      say(msg, 'フリカレを読んでいます…');
      const { cells, closed } = await readRange(dates[0], dates[dates.length - 1]);
      hctx = { r, cells, closed, dates };
      buildHiyoriPlan();
    } catch (e) {
      say(msg, e.message || String(e), 'err');
    } finally {
      btn.disabled = false;
    }
  };

  // ------------------------------------------------------------ 元に戻す
  async function showUndo() {
    const u = (await store.get(UNDO_KEY))[UNDO_KEY];
    const has = u && u.items?.length;
    $('#undoRow').hidden = !has;
    if (has) {
      const t = new Date(u.at);
      $('#undoMsg').textContent = `${t.getMonth() + 1}/${t.getDate()} ${p2(t.getHours())}:${p2(t.getMinutes())} の書き込み（${u.items.length}日）`;
    }
  }
  $('#undo').onclick = async () => {
    const u = (await store.get(UNDO_KEY))[UNDO_KEY];
    if (!u?.items?.length) return showUndo();
    $('#undo').disabled = true;
    const msg = $('#undoMsg');
    // 書いたあとに手で直された日は、戻さない（writeOne が before と比べて飛ばす）
    const list = u.items.map((c) => ({ date: c.date, before: c.after, after: c.before }));
    const results = [];
    for (let i = 0; i < list.length; i++) {
      msg.textContent = `戻しています… ${i + 1}/${list.length}`;
      try { results.push(await writeOne(list[i])); } catch (e) { results.push({ ...list[i], ok: false, reason: e.message }); }
      await sleep(GAP_MS);
    }
    const ng = results.filter((r) => !r.ok);
    await store.set({ [UNDO_KEY]: null });
    $('#undo').disabled = false;
    $('#undoRow').hidden = false;
    msg.textContent = ng.length
      ? `${results.length - ng.length}日戻しました。${ng.map((r) => shortDate(r.date)).join('、')} は書き込みのあとに変わっていたため戻していません。`
      : `${results.length}日戻しました。ページを読み込み直すと表示されます。`;
    $('#undo').hidden = true;
    setTimeout(() => { $('#undo').hidden = false; showUndo(); }, 8000);
  };
  showUndo();
})();
