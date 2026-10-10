/**
 * create.js — 伝助の「イベント新規作成」で、候補日程の入力を手伝う
 *
 *  ・期間と曜日でまとめて作る（平日と土日祝で時刻を分けられる）
 *  ・ヒヨリの日程調整から候補日（または確定日）を写す
 *  ・自分のフリカレで、予定が埋まっている日を消す
 *  ・日付順に並べ替えて、同じ行を消す
 *
 * どれも「候補日程」の欄の文字を書き換えるだけ。伝助への登録は本人が「確認画面へ」を押して行う。
 * 直前の状態は1つだけ覚えていて、「元に戻す」で戻せる。
 */
(() => {
  'use strict';
  if (window.__hiyoriCreate) return;
  const ta = document.getElementById('schedule') || document.querySelector('textarea[name="schedule"]');
  if (!ta) return;
  window.__hiyoriCreate = true;
  const A = globalThis.HiyoriAvail;

  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const p2 = (v) => String(v).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
  const fromIso = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const today = () => { const n = new Date(); return new Date(n.getFullYear(), n.getMonth(), n.getDate()); };
  const TILDE = '～';   // 伝助の例に合わせた全角のなみ線
  const MAX_LINES = 120;

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

  // ------------------------------------------------------------ 設定（出欠入力側の settings とは別に持つ）
  const DEFAULTS = {
    collapsed: true, tab: 'make',
    weekdays: [], holidayAsWeekend: true,
    timeWeekday: '21:00～', timeWeekend: '13:00～',
    span: 30, hiyori: '', hiyoriConfirmedOnly: false,
  };
  let cs = { ...DEFAULTS };
  let shared = {};   // 出欠入力側の設定（フリカレURL・ふだんの都合）を読むだけ
  const save = (patch) => {
    cs = { ...cs, ...patch };
    try { chrome.storage.local.set({ createSettings: cs }); } catch (e) { /* 保存できなくても動かす */ }
  };

  // ------------------------------------------------------------ 候補の行を読む
  const DATE_RE = /(?:(\d{4})\s*[\/年.\-]\s*)?(\d{1,2})\s*[\/月.\-]\s*(\d{1,2})\s*日?/;

  /** 年の無い日付は、今日から見て近い方の年にする（2か月より前なら来年） */
  function dateOfLine(line) {
    const m = line.match(DATE_RE);
    if (!m) return null;
    const mo = +m[2], d = +m[3];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    let y = m[1] ? +m[1] : today().getFullYear();
    if (!m[1]) {
      const cand = new Date(y, mo - 1, d);
      if (cand < new Date(today().getTime() - 60 * 864e5)) y++;
    }
    const dt = new Date(y, mo - 1, d);
    if (dt.getMonth() !== mo - 1) return null;
    return iso(dt);
  }
  /** 行に書かれた時間帯。時刻が17時より前なら昼、以降なら夜。無ければ null（どちらでもよい） */
  function slotOfLine(line) {
    const rest = line.replace(DATE_RE, '');
    const h = rest.match(/(\d{1,2})\s*[:：時]/);
    if (h) return +h[1] < 17 && +h[1] >= 5 ? 'day' : 'night';
    if (/夜|夕|晩/.test(rest)) return 'night';
    if (/昼|朝|午後|日中/.test(rest)) return 'day';
    return null;
  }
  const linesOf = () => ta.value.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l.trim());

  // ------------------------------------------------------------ 書き換え（直前の1回だけ戻せる）
  let undoValue = null;
  function write(lines) {
    undoValue = ta.value;
    ta.value = lines.join('\n') + (lines.length ? '\n' : '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    $('#undo').disabled = false;
    ta.classList.remove('hiyori-flash'); void ta.offsetWidth; ta.classList.add('hiyori-flash');
  }

  // ------------------------------------------------------------ パネル
  const host = document.createElement('div');
  host.id = 'hiyori-create';
  host.style.cssText = 'display:block;margin:8px 0;max-width:400px;';
  const root = host.attachShadow({ mode: 'open' });
  ta.parentNode.insertBefore(host, ta);

  if (!document.getElementById('hiyori-flash-style')) {
    const st = document.createElement('style');
    st.id = 'hiyori-flash-style';
    st.textContent = `
      @keyframes hiyoriFlash { from { background-color: #e1f0f8; } to { background-color: transparent; } }
      .hiyori-flash, .hiyori-flash > th, .hiyori-flash > td { animation: hiyoriFlash 900ms cubic-bezier(0.23,1,0.32,1); }`;
    document.head.appendChild(st);
  }

  const ICON = {
    cal: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  };

  const t0 = today();
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
      --ng: #bf3a3f; --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
      font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, sans-serif;
      font-size: 12.5px; line-height: 1.5; color: var(--ink); background: var(--bg);
      border-radius: 10px; box-shadow: 0 0 0 1px var(--ring), 0 4px 14px rgba(31,58,74,.06);
      text-align: left;
    }
    .top { display: flex; align-items: center; gap: 6px; padding: 7px 6px 7px 12px; }
    .ttl { font-weight: 700; color: var(--ink-2); font-size: 13px; }
    .spacer { flex: 1; }
    .body { display: grid; gap: 6px; padding: 0 6px 8px; }
    .card { background: var(--card); border-radius: 8px; padding: 10px; box-shadow: 0 0 0 1px var(--ring); display: grid; gap: 8px; }
    .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .lbl { color: var(--muted); font-size: 12px; min-width: 52px; }
    .hint { color: var(--muted); font-size: 11.5px; line-height: 1.5; }
    .msg { font-size: 12px; color: var(--accent-ink); min-height: 0; }
    .msg.err { color: var(--ng); }
    input[type=text], input[type=date], select {
      font: inherit; color: var(--ink); background: #fff; border: 0; border-radius: 6px;
      height: 28px; padding: 0 8px; box-shadow: 0 0 0 1px var(--ring-strong); min-width: 0;
    }
    input:focus, select:focus { outline: none; box-shadow: 0 0 0 1px var(--accent), 0 0 0 3px var(--accent-soft); }
    input[type=date] { width: 128px; }
    .time { width: 92px; }
    button {
      font: inherit; color: var(--ink); cursor: pointer; border: 0; border-radius: 6px;
      height: 28px; padding: 0 10px; background: var(--soft); font-size: 12px;
      transition: background-color 140ms ease, transform 160ms var(--ease-out);
      -webkit-tap-highlight-color: transparent; user-select: none;
    }
    button:active:not([disabled]) { transform: scale(0.97); }
    button[disabled] { opacity: .45; cursor: default; }
    button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    .primary { background: var(--accent); color: #fff; font-weight: 700; }
    .soft { background: var(--accent-soft); color: var(--accent-ink); font-weight: 700; box-shadow: 0 0 0 1px #b9d8ec; }
    .ghost { background: transparent; color: var(--muted); display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 6px; }
    .icon-btn { padding: 0 4px; height: 24px; display: inline-flex; align-items: center; }
    .chev { display: inline-flex; transition: transform 200ms var(--ease-out); }
    @media (hover: hover) and (pointer: fine) {
      button:hover:not([disabled]) { background: var(--soft-2); }
      .primary:hover:not([disabled]) { background: var(--accent-ink); }
      .soft:hover:not([disabled]) { background: #d0e7f4; }
      .ghost:hover:not([disabled]) { background: var(--soft); color: var(--ink); }
    }
    .grow { flex: 1; }
    /* たたんだときは幅の狭いボタン。どこを押してもひらく */
    .wrap.collapsed { width: max-content; cursor: pointer; }
    .wrap.collapsed .body, .wrap.collapsed #undo { display: none; }
    .wrap.collapsed .chev { transform: rotate(-90deg); }
    .wrap.collapsed #toggle { color: var(--accent); }
    @media (hover: hover) and (pointer: fine) {
      .wrap.collapsed:hover { background: var(--card); box-shadow: 0 0 0 1px var(--accent), 0 4px 14px rgba(31,58,74,.10); }
    }
    .ico { color: var(--accent); display: inline-flex; }
    /* タブ */
    .seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 2px; background: var(--soft); border-radius: 7px; padding: 2px; }
    .seg button { background: transparent; color: var(--muted); font-weight: 600; height: 26px; border-radius: 5px; padding: 0 4px; }
    .seg button[aria-selected="true"] { background: #fff; color: var(--ink); box-shadow: 0 0 0 1px var(--ring), 0 1px 3px rgba(31,58,74,.08); }
    /* 曜日 */
    .days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 4px; }
    .day { height: 28px; padding: 0; font-weight: 700; font-size: 12.5px; background: #fff; box-shadow: 0 0 0 1px var(--ring-strong); color: var(--ink-2); }
    .day[data-wd="0"] { color: #d0573b; } .day[data-wd="6"] { color: #2b78ad; }
    .day[aria-pressed="true"] { background: var(--accent); color: #fff; box-shadow: none; }
    .presets { display: flex; gap: 4px; }
    .preset { height: 22px; padding: 0 9px; border-radius: 999px; background: #fff; color: var(--muted); box-shadow: 0 0 0 1px var(--ring-strong); font-size: 11.5px; font-weight: 600; }
    .preset[aria-pressed="true"] { background: var(--accent); color: #fff; box-shadow: none; }
    .check { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; color: var(--ink-2); font-size: 12px; }
    .check input { accent-color: var(--accent); margin: 0; width: 13px; height: 13px; }
    .btnrow { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .btnrow button { height: 30px; }
    .full { width: 100%; height: 30px; }
  </style>

  <div class="wrap${cs.collapsed ? ' collapsed' : ''}">
    <div class="top">
      <span class="ico">${ICON.cal}</span>
      <span class="ttl">候補日程アシスト</span>
      <span class="spacer"></span>
      <button type="button" class="ghost" id="undo" disabled title="直前の書き換えの前に戻します">${ICON.undo}元に戻す</button>
      <button type="button" class="ghost icon-btn" id="toggle" aria-label="パネルをひらく"><span class="chev">${ICON.chev}</span></button>
    </div>
    <div class="body">
      <div class="seg" role="tablist" aria-label="補助の種類">
        <button type="button" role="tab" data-tab="make" aria-selected="true">まとめて作る</button>
        <button type="button" role="tab" data-tab="hiyori" aria-selected="false">ヒヨリから</button>
        <button type="button" role="tab" data-tab="tidy" aria-selected="false">整理する</button>
      </div>

      <section class="card" data-pane="make">
        <div class="row"><span class="lbl">期間</span>
          <input type="date" id="from" value="${iso(t0)}"> <span>${TILDE}</span>
          <input type="date" id="to" value="${iso(new Date(t0.getTime() + 30 * 864e5))}">
        </div>
        <div class="row" style="justify-content:space-between">
          <span class="lbl">曜日</span>
          <div class="presets">
            <button type="button" class="preset" data-preset="weekday" aria-pressed="false">平日</button>
            <button type="button" class="preset" data-preset="weekend" aria-pressed="false">土日</button>
          </div>
        </div>
        <div class="days" role="group" aria-label="曜日">
          ${WD.map((w, i) => `<button type="button" class="day" data-wd="${i}" aria-pressed="false">${w}</button>`).join('')}
        </div>
        <label class="check"><input type="checkbox" id="hol"> 祝日は土日と同じに扱う</label>
        <div class="row"><span class="lbl">平日の時刻</span><input type="text" class="time" id="tWd" placeholder="21:00${TILDE}">
          <span class="lbl" style="min-width:0;margin-left:6px">土日祝</span><input type="text" class="time" id="tWe" placeholder="13:00${TILDE}"></div>
        <div class="hint">曜日を選ばなければ毎日。時刻は空でもかまいません。</div>
        <div class="btnrow">
          <button type="button" class="soft" id="add">下に足す</button>
          <button type="button" class="primary" id="replace">入れ替える</button>
        </div>
      </section>

      <section class="card" data-pane="hiyori" hidden>
        <div class="row"><input type="text" id="hurl" class="grow" placeholder="ヒヨリの日程調整のURL" spellcheck="false">
          <button type="button" class="primary" id="hload">写す</button></div>
        <label class="check"><input type="checkbox" id="hconf"> 確定した日だけ写す</label>
        <div class="hint">「まとめて作る」の平日・土日祝の時刻を付けて、今の候補と入れ替えます。イベント名が空なら、ヒヨリの題名も入れます。</div>
      </section>

      <section class="card" data-pane="tidy" hidden>
        <button type="button" class="soft full" id="sort">日付順に並べ替えて、同じ行を消す</button>
        <div class="row"><input type="text" id="fc" class="grow" placeholder="自分のフリカレのURL" spellcheck="false"></div>
        <button type="button" class="soft full" id="fcfilter">フリカレで予定が埋まっている日を消す</button>
        <div class="hint">時刻が17時より前の候補は昼、それ以降は夜の予定で判断します。時刻の無い候補は、昼か夜のどちらかが空いていれば残します。</div>
      </section>
      <div class="msg" id="msg" role="status" aria-live="polite"></div>
    </div>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  const say = (text, err = false) => { const m = $('#msg'); m.textContent = text; m.classList.toggle('err', err); };

  // ------------------------------------------------------------ 開け閉め・タブ
  const wrap = $('.wrap');
  function applyUi() {
    wrap.classList.toggle('collapsed', !!cs.collapsed);
    $('#toggle').setAttribute('aria-label', cs.collapsed ? 'パネルをひらく' : 'パネルをたたむ');
    $$('.seg [data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === cs.tab)));
    $$('[data-pane]').forEach((p) => { p.hidden = p.dataset.pane !== cs.tab; });
    $$('.day').forEach((b) => b.setAttribute('aria-pressed', String(cs.weekdays.includes(+b.dataset.wd))));
    syncPresets();
    $('#hol').checked = !!cs.holidayAsWeekend;
    $('#tWd').value = cs.timeWeekday; $('#tWe').value = cs.timeWeekend;
    $('#hurl').value = cs.hiyori || ''; $('#hconf').checked = !!cs.hiyoriConfirmedOnly;
    if (!$('#fc').value) $('#fc').value = shared.freecal || '';
  }
  const toggle = () => { save({ collapsed: !cs.collapsed }); applyUi(); };
  $('#toggle').onclick = (e) => { e.stopPropagation(); toggle(); };
  wrap.addEventListener('click', () => { if (cs.collapsed) toggle(); });
  $$('.seg [data-tab]').forEach((b) => { b.onclick = () => { save({ tab: b.dataset.tab }); applyUi(); say(''); }; });

  // ------------------------------------------------------------ 曜日
  const PRESET = { weekday: [1, 2, 3, 4, 5], weekend: [0, 6] };
  function syncPresets() {
    for (const b of $$('.preset')) {
      const want = PRESET[b.dataset.preset];
      b.setAttribute('aria-pressed', String(cs.weekdays.length === want.length && want.every((w) => cs.weekdays.includes(w))));
    }
  }
  $$('.day').forEach((b) => {
    b.onclick = () => {
      const w = +b.dataset.wd;
      const set = new Set(cs.weekdays);
      set.has(w) ? set.delete(w) : set.add(w);
      save({ weekdays: [...set].sort() }); applyUi();
    };
  });
  $$('.preset').forEach((b) => {
    b.onclick = () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      save({ weekdays: on ? [...PRESET[b.dataset.preset]] : [] }); applyUi();
    };
  });
  $('#hol').onchange = () => save({ holidayAsWeekend: $('#hol').checked });
  $('#tWd').onchange = () => save({ timeWeekday: $('#tWd').value.trim() });
  $('#tWe').onchange = () => save({ timeWeekend: $('#tWe').value.trim() });
  $('#hconf').onchange = () => save({ hiyoriConfirmedOnly: $('#hconf').checked });

  // ------------------------------------------------------------ 行を作る
  async function holidaySet() {
    const res = await send({ type: 'holidays' });
    return new Set(res.ok ? res.list : []);
  }
  /** 日付1つを「11/14(金) 21:00～」の行にする */
  function lineFor(date, hol) {
    const d = fromIso(date);
    const w = d.getDay();
    const off = w === 0 || w === 6 || (cs.holidayAsWeekend && hol.has(date));
    const time = (off ? $('#tWe').value : $('#tWd').value).trim();
    return `${d.getMonth() + 1}/${d.getDate()}(${WD[w]})${time ? ' ' + time : ''}`;
  }

  async function make(mode) {
    const from = $('#from').value, to = $('#to').value;
    if (!from || !to) return say('期間を入れてください', true);
    if (from > to) return say('期間の始まりと終わりが逆です', true);
    const hol = await holidaySet();
    const out = [];
    for (let d = fromIso(from); iso(d) <= to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
      const date = iso(d), w = d.getDay();
      if (cs.weekdays.length) {
        const hit = cs.weekdays.includes(w)
          // 祝日を土日扱いにしているときは、土日を選んでいれば祝日も入れる
          || (cs.holidayAsWeekend && hol.has(date) && (cs.weekdays.includes(0) || cs.weekdays.includes(6)));
        if (!hit) continue;
      }
      out.push(lineFor(date, hol));
      if (out.length > MAX_LINES) return say(`${MAX_LINES}日を超えます。期間か曜日を絞ってください`, true);
    }
    if (!out.length) return say('条件に合う日がありません', true);
    const lines = mode === 'add' ? [...linesOf(), ...out] : out;
    write(lines);
    say(mode === 'add' ? `${out.length}件を下に足しました` : `${out.length}件に入れ替えました`);
  }
  $('#add').onclick = () => make('add');
  $('#replace').onclick = () => make('replace');

  // ------------------------------------------------------------ ヒヨリから写す
  $('#hload').onclick = async () => {
    const url = $('#hurl').value.trim();
    if (!url) return say('ヒヨリの日程調整のURLを入れてください', true);
    save({ hiyori: url });
    say('読み込んでいます');
    const res = await send({ type: 'hiyori', url });
    if (!res.ok) return say(res.message || '読み込めませんでした', true);
    const only = $('#hconf').checked;
    const dates = [...new Set(only ? (res.confirmed || []) : (res.dates || []))].sort();
    if (!dates.length) return say(only ? 'まだ確定した日がありません' : '候補日がありません', true);
    const hol = await holidaySet();
    write(dates.map((d) => lineFor(d, hol)));
    const name = document.querySelector('input[name="eventname"]');
    let named = false;
    if (name && !name.value.trim() && res.title) { name.value = res.title; named = true; }
    say(`${dates.length}件を写しました${named ? '（イベント名も入れました）' : ''}`);
  };

  // ------------------------------------------------------------ 整理する
  $('#sort').onclick = () => {
    const lines = linesOf();
    if (!lines.length) return say('候補日程が空です', true);
    const seen = new Set();
    const items = [];
    let dup = 0;
    lines.forEach((l, i) => {
      const key = l.replace(/\s+/g, ' ').trim();
      if (seen.has(key)) { dup++; return; }
      seen.add(key);
      items.push({ l, i, d: dateOfLine(l) });
    });
    // 日付の無い行は元の順のまま最後に回す。同じ日は元の順
    items.sort((a, b) => (a.d && b.d ? (a.d < b.d ? -1 : a.d > b.d ? 1 : a.i - b.i) : a.d ? -1 : b.d ? 1 : a.i - b.i));
    write(items.map((x) => x.l));
    say(`並べ替えました${dup ? `（同じ行を${dup}件消しました）` : ''}`);
  };

  $('#fcfilter').onclick = async () => {
    const url = $('#fc').value.trim();
    if (!url) return say('自分のフリカレのURLを入れてください', true);
    const lines = linesOf();
    const items = lines.map((l) => ({ l, d: dateOfLine(l), s: slotOfLine(l) }));
    const dated = items.filter((x) => x.d);
    if (!dated.length) return say('日付を読み取れる候補がありません', true);
    say('フリカレを読んでいます');
    const months = [...new Set(dated.map((x) => x.d.slice(0, 7)))];
    const res = await send({ type: 'freecal', url, months });
    if (!res.ok) return say(res.message || 'フリカレを読み込めませんでした', true);
    const hol = new Set(res.holidays || []);
    const pattern = shared.pattern || 'weekday';
    const skippedMonths = new Set(res.skipped || []);   // 読み込みの上限で読まなかった月
    let removed = 0;
    const keep = items.filter((x) => {
      if (!x.d) return true;
      const ym = `${+x.d.slice(0, 4)}-${+x.d.slice(5, 7)}`;
      if (res.closed?.[ym]) return true;            // 非公開の月は判断しない
      if (skippedMonths.has(x.d.slice(0, 7))) return true;
      const st = A ? A.classifyCell(res.cells[x.d], { mode: 'auto', pattern, isHoliday: hol.has(x.d) || [0, 6].includes(fromIso(x.d).getDay()) }) : null;
      if (!st) return true;
      // false＝埋まっている。null（要確認）は残す
      const busy = x.s ? st[x.s] === false : st.day === false && st.night === false;
      if (busy) removed++;
      return !busy;
    });
    const later = skippedMonths.size
      ? `。${[...skippedMonths].map((ym) => +ym.slice(5) + '月').join('・')}は今回は読んでいません（1分ほどおいてもう一度押すと読みます）` : '';
    if (!removed) return say('埋まっている日はありませんでした' + later);
    write(keep.map((x) => x.l));
    say(`予定が埋まっている${removed}件を消しました` + later);
  };

  $('#undo').onclick = () => {
    if (undoValue === null) return;
    ta.value = undoValue; undoValue = null;
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    $('#undo').disabled = true;
    say('元に戻しました');
  };

  // ------------------------------------------------------------ 設定を読む
  try {
    chrome.storage.local.get(['createSettings', 'settings'], (got) => {
      cs = { ...DEFAULTS, ...(got?.createSettings || {}) };
      shared = got?.settings || {};
      applyUi();
    });
  } catch (e) { /* 初期値のまま */ }
  applyUi();
})();
