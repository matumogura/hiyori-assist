/**
 * content.js — 日程調整サービスの出欠入力画面に、ヒヨリと同じ入力手段を足す
 *
 *  対応サービス: 伝助（densuke.biz）／デイコード（character-sheets.appspot.com/schedule）／調整さん（chouseisan.com）
 *
 *  ・フリカレから取り込む
 *  ・テキストから取り込む
 *  ・まとめて入力
 *
 * どれも画面上の記号を押した状態にするだけで、サービスへの登録はしない。
 * 最後にそのサービスの登録ボタンを本人が押して初めて保存される。
 *
 * サービスごとの違い（候補の読み方・記号の読み方・押し方・パネルの置き場所）は
 * 下の「サイトごとの差」に閉じ込めてある。新しいサービスを足すときはそこに1つ足す。
 */
(() => {
  'use strict';
  if (window.__hiyoriAssist) return;
  window.__hiyoriAssist = true;

  const A = globalThis.HiyoriAvail;
  if (!A) return;

  const WD = ['日', '月', '火', '水', '木', '金', '土'];
  const p2 = (v) => String(v).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DATE_RE = /(?:(\d{4})\s*[\/年.\-]\s*)?(\d{1,2})\s*[\/月.\-]\s*(\d{1,2})\s*日?/;

  // ------------------------------------------------------------ サイトごとの差
  //
  // それぞれ次を返す。
  //   rows()          候補ごとの { id, label, ref }（ref はサイト側で使う手がかり）
  //   symbols(rows)   押せる記号を画面の並び順で [{ text, key, kind }]
  //                   key は current/setValue で使う値、kind は色分け（best/ok/maybe/plus/ng）
  //   current(row)    いまの値（空欄は '0'）
  //   setValue(row, key)  値を変える。変わったら true
  //   flashEl(row)    変えたときに光らせる要素
  //   tableEl()       パネルを右に並べる基準（この要素の右端に置く）
  //   frameEl()       パネルの上端と高さの基準
  //   inlineAnchor()  狭いときにパネルを差し込む位置（この要素の前）
  //   eventKey        入れ分けを覚える単位
  //   saveLabel       サービス側の登録ボタンの名前（案内の文に使う）
  //   anchorDate      年の無い候補日を補う基準日
  //   commentEl()     一言コメントの入力欄
  //   hasBlank        「未入力」の状態があるか（調整さんは最初から×で、空欄に戻せない）
  //   watch           入力欄があとから出てくるか（調整さんは「出欠を入力する」で出る）

  const SITES = [
    {
      id: 'densuke',
      name: '伝助',
      match: () => /(^|\.)densuke\.biz$/.test(location.hostname),
      saveLabel: '登録する',
      get eventKey() { return new URL(location.href).searchParams.get('cd') || location.pathname; },

      fields: () => [...document.querySelectorAll('input[type="hidden"][name^="join-"], select[name^="join-"]')],
      rows() {
        return this.fields().map((el) => ({ id: el.name.slice(5), label: densukeLabel(el), ref: el }));
      },
      symbols(rows) {
        const first = rows[0];
        const out = [];
        if (first.ref.tagName === 'SELECT') {
          for (const o of first.ref.options) if (o.value !== '0' && o.text.trim()) out.push({ text: o.text.trim(), key: o.value });
        } else {
          // ボタンは ◎(4) ○(3) △(2) ×(1) の順に並ぶ
          for (let i = 4; i >= 1; i--) {
            const sp = document.getElementById(first.id + i);
            if (!sp) continue;
            // 記号が画像のときは alt を見る。4番目が読めなければ ◎ とみなす
            const t = sp.textContent.trim() || sp.querySelector('img')?.alt?.trim() || (i === 4 ? '◎' : '');
            if (t) out.push({ text: t, key: String(i) });
          }
        }
        return out.map((s) => ({ ...s, kind: kindByText(s.text) }));
      },
      current: (row) => String(row.ref.value || '0'),
      setValue(row, key) {
        const el = row.ref;
        if (el.tagName === 'SELECT') {
          el.value = key;
          el.className = el.options[el.selectedIndex]?.className || '';
        } else {
          // 伝助の btnclick と同じ見た目の切り替えを、押し直し（解除）なしで行う
          for (let i = 1; i <= 4; i++) {
            const sp = document.getElementById(row.id + i);
            if (sp) sp.className = String(i) === key ? `btnsp btnac${key}` : 'btnsp btnna';
          }
          el.value = key;
        }
      },
      flashEl: (row) => row.ref.closest('td'),
      // 表（#regdiv）自体は動かさない。伝助のHTMLはフォームの閉じ方が崩れていて、
      // 表を別の要素に入れ直すと入力欄がフォームから外れ、登録できなくなるため。
      tableEl: () => document.getElementById('regdiv') || document.querySelector('input[name^="join-"]')?.closest('table'),
      frameEl() { return this.tableEl(); },
      inlineAnchor() {
        return document.getElementById('bulkdiv')
          || document.querySelector('a[href*="bulkview" i]')?.closest('div')
          || this.tableEl();
      },
      get anchorDate() {
        const m = document.body.innerText.match(/作成日時[：:]\s*(\d{4})年(\d{1,2})月(\d{1,2})日/);
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date();
      },
      // 伝助の表のボタンを手で押したとき
      isPageInput: (target) => !!target.closest?.('.btnsp') || !!target.name?.startsWith?.('join-'),
      commentEl: () => document.querySelector('input[name="membercomment"]'),
      hasBlank: true,
    },

    {
      id: 'daycode',
      name: 'デイコード',
      // デイコードの個人日程入力ページ（character-sheets.appspot.com/schedule/input）
      match: () => location.hostname === 'character-sheets.appspot.com' && location.pathname.startsWith('/schedule/input'),
      saveLabel: '日程登録',
      get eventKey() { return document.getElementById('key')?.value || new URL(location.href).searchParams.get('key') || location.pathname; },

      rows() {
        return [...document.querySelectorAll('input.dateStatus[id^="input_"]')].map((el) => {
          const idx = el.id.split('_')[1];
          const tr = document.getElementById(`row_${idx}`);
          const label = document.getElementById(`name_${idx}`)?.value || tr?.querySelector('.datetitle')?.textContent || '';
          return { id: idx, label: label.trim(), ref: { input: el, tr } };
        }).filter((r) => r.ref.tr);
      },
      // 記号はテンプレート次第（○△ / ◎○△ / ○ / ○①②③ / 全昼夜 / 自由入力）。
      // 文字では決めず、札の色クラスで値を決める（デイコードの input.js と同じ対応表）
      STATUS: { 'is-info': 'BEST', 'is-success': 'OK', 'is-warning': 'CONDITIONALLY', 'is-primary': 'CONDITIONALLY_PLUS', 'is-danger': 'NG' },
      KIND: { BEST: 'best', OK: 'ok', CONDITIONALLY: 'maybe', CONDITIONALLY_PLUS: 'plus', NG: 'ng' },
      statusOf(tag) {
        for (const [cls, st] of Object.entries(this.STATUS)) if (tag.classList.contains(cls)) return st;
        return null;
      },
      symbols(rows) {
        const out = [];
        for (const tag of rows[0].ref.tr.querySelectorAll('.statustag')) {
          const key = this.statusOf(tag);
          const text = tag.textContent.trim();
          if (key && text && !out.some((s) => s.key === key)) out.push({ text, key, kind: this.KIND[key] });
        }
        return out;
      },
      current(row) {
        const v = row.ref.input.value;
        return !v || v === 'CANDIDATE' ? '0' : v;
      },
      setValue(row, key) {
        const tags = [...row.ref.tr.querySelectorAll('.statustag')];
        // デイコード自身のクリック処理に任せる（未保存の警告などもそのまま効く）
        const selected = tags.find((t) => !t.classList.contains('is-light'));
        const target = key === '0' ? selected : tags.find((t) => this.statusOf(t) === key);
        if (target) target.click();
        // 万一クリック処理が効かなかったときは、同じ見た目と値を直接作る
        if (this.current(row) !== key) {
          for (const t of tags) t.classList.toggle('is-light', key === '0' || this.statusOf(t) !== key);
          row.ref.input.value = key === '0' ? 'CANDIDATE' : key;
        }
      },
      flashEl: (row) => row.ref.tr,
      tableEl: () => document.querySelector('.schedule_table') || document.querySelector('input.dateStatus')?.closest('table'),
      frameEl() { return this.tableEl()?.closest('.table-container') || this.tableEl(); },
      inlineAnchor() { return this.frameEl(); },
      anchorDate: new Date(),
      isPageInput: (target) => !!target.closest?.('.statustag, .allstatus'),
      commentEl: () => document.getElementById('comment'),
      hasBlank: true,
      // デイコードは外部サービスへの誘導が禁止。ヒヨリのロゴと「日程調整を作る」の案内を出さない
      noPromo: true,
      // 色と角の丸みをデイコード（Bulma）に寄せる
      theme: 'daycode',
      sideMax: 440,   // デイコードの部品は小さめなので、パネルも細めに
    },

    {
      id: 'chouseisan',
      name: '調整さん',
      match: () => /(^|\.)chouseisan\.com$/.test(location.hostname) && location.pathname === '/s',
      saveLabel: '入力する',
      get eventKey() { return new URL(location.href).searchParams.get('h') || location.pathname; },
      // 入力欄は「出欠を入力する」や名前のリンクを押したときに、下に作られる（Vue）
      watch: true,
      // 最初から全部×。未入力の状態は無い
      hasBlank: false,

      form: () => document.getElementById('f'),
      rows() {
        const f = this.form();
        if (!f) return [];
        return [...f.querySelectorAll('table.choice tr')].map((tr) => {
          const input = tr.querySelector('input[type="hidden"][name^="kouho"]');
          if (!input || !tr.querySelector('.oax')) return null;
          return { id: input.name, label: tr.querySelector('th')?.textContent.trim() || '', ref: { tr, input } };
        }).filter(Boolean);
      },
      // 押す札は画像なので、alt の末尾（まる／さんかく／ばつ）で読む。値は 1=○ 2=△ 3=×
      NAMES: { 'まる': '○', 'さんかく': '△', 'ばつ': '×' },
      symbols(rows) {
        return [...rows[0].ref.tr.querySelectorAll('.oax')].map((b, i) => {
          const text = this.NAMES[(b.alt || '').split('_').pop()] || ['○', '△', '×'][i] || String(i + 1);
          return { text, key: String(i + 1), kind: kindByText(text) };
        });
      },
      current: (row) => String(row.ref.input.value || '3'),
      setValue(row, key) {
        // 空欄が無いので、空欄に戻す指示は×にする
        const k = key === '0' ? '3' : key;
        // 調整さん自身のクリック処理に任せる（画面の状態と送る値を一緒に変えてくれる）
        row.ref.tr.querySelector(`.oax-${Number(k) - 1}`)?.click();
      },
      flashEl: (row) => row.ref.tr,
      tableEl() { return this.form()?.querySelector('table.choice'); },
      frameEl() { return document.getElementById('choice') || this.tableEl(); },
      inlineAnchor() { return document.getElementById('choice') || this.tableEl(); },
      anchorDate: new Date(),
      isPageInput: (target) => !!target.closest?.('.oax'),
      commentEl: () => document.querySelector('#f input[name="hitokoto"]'),
    },
  ];

  const SITE = SITES.find((s) => s.match());
  if (!SITE) return;

  function kindByText(t) {
    if (t === '×' || t === '✕') return 'ng';
    if (t === '△') return 'maybe';
    if (t === '◎') return 'best';
    return 'ok';
  }

  /** 伝助の候補名。行の見出し、「行と列を入れ替え」た表なら同じ列の見出し */
  function densukeLabel(el) {
    const td = el.closest('td');
    if (!td) return '';
    const tr = td.parentElement;
    const rowLabel = tr.cells[0] && tr.cells[0] !== td ? tr.cells[0].textContent.trim() : '';
    if (DATE_RE.test(rowLabel)) return rowLabel;
    const table = td.closest('table');
    for (const row of table ? [...table.rows] : []) {
      if (row === tr) break;
      const c = row.cells[td.cellIndex];
      if (c && DATE_RE.test(c.textContent)) return c.textContent.trim();
    }
    return rowLabel;
  }

  // 変えた行を光らせる色（ページに1回だけ足す）
  if (!document.getElementById('hiyori-flash-style')) {
    const flashStyle = document.createElement('style');
    flashStyle.id = 'hiyori-flash-style';
    flashStyle.textContent = `
      @keyframes hiyoriFlash { from { background-color: #e1f0f8; } to { background-color: transparent; } }
      .hiyori-flash, .hiyori-flash > th, .hiyori-flash > td { animation: hiyoriFlash 900ms cubic-bezier(0.23,1,0.32,1); }`;
    document.head.appendChild(flashStyle);
  }

  // ------------------------------------------------------------ パネルを作る
  //
  // 入力欄があとから出てくる（または作り直される）サイトがあるので、
  // パネルを作る処理を mount() にまとめ、片付けは返り値の関数で行う。
  function mount() {
  const cleanups = [];
  const listen = (target, type, fn, opts) => {
    target.addEventListener(type, fn, opts);
    cleanups.push(() => target.removeEventListener(type, fn, opts));
  };

  const rows = SITE.rows();
  if (!rows.length) return null;   // 入力画面ではない

  // ------------------------------------------------------------ 候補日の読み取り

  /** 年の無い日付を補う基準日 */
  const anchor = (() => {
    const d = new Date(SITE.anchorDate);
    d.setHours(0, 0, 0, 0);
    return d;
  })();

  function parseLabel(text) {
    const m = String(text).match(DATE_RE);
    if (!m) return null;
    const mo = +m[2], da = +m[3];
    if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
    let y = m[1] ? +m[1] : null;
    if (!y) {
      // 基準日の1か月前より後になる、いちばん近い年を選ぶ（12月に作った「1/5」は翌年）
      const floor = new Date(anchor); floor.setDate(floor.getDate() - 31);
      for (const cand of [anchor.getFullYear() - 1, anchor.getFullYear(), anchor.getFullYear() + 1]) {
        if (new Date(cand, mo - 1, da) >= floor) { y = cand; break; }
      }
    }
    const date = `${y}-${p2(mo)}-${p2(da)}`;
    const rest = String(text).replace(m[0], '').replace(/^\s*[（(]\s*[日月火水木金土祝]\s*[）)]/, '');
    return { date, rest };
  }

  /** 候補名に時間帯が書いてあれば、その帯だけを見る */
  function slotOf(rest) {
    const t = String(rest || '');
    if (/終日|全日|オール/.test(t)) return null;
    const day = /昼|日中|午前|午後|朝|ランチ/.test(t);
    const night = /夜|夕|晩|ディナー/.test(t);
    if (day && !night) return 'day';
    if (night && !day) return 'night';
    const h = t.match(/(\d{1,2})\s*[:：時]/);
    if (h) return +h[1] >= 17 ? 'night' : 'day';
    return null;
  }

  /**
   * 候補名の時刻（分）。「19:00〜」なら { start: 1140, end: null }、「19:00〜22:30」なら end も入る。
   * 時刻が無ければ null
   */
  function timeOf(rest) {
    const t = String(rest || '');
    const m = t.match(/(\d{1,2})\s*[:：時]\s*(\d{2})?/);
    if (!m) return null;
    const start = Math.min(+m[1], 24) * 60 + (+m[2] || 0);
    const after = t.slice(m.index + m[0].length);
    const e = after.match(/^\s*分?\s*[〜~～\-－ー―]\s*(\d{1,2})\s*[:：時]\s*(\d{2})?/);
    let end = e ? Math.min(+e[1], 48) * 60 + (+e[2] || 0) : null;
    if (end !== null && end <= start) end += 24 * 60;   // 22:00〜2:00 のように日をまたぐ
    return { start, end };
  }

  const candidates = rows.map((r) => {
    const parsed = parseLabel(r.label);
    let wd = null;
    if (parsed) wd = new Date(parsed.date + 'T00:00:00Z').getUTCDay();
    else {
      const w = r.label.match(/[（(]\s*([日月火水木金土])\s*[）)]/);
      if (w) wd = WD.indexOf(w[1]);
    }
    return { ...r, date: parsed?.date || null, slot: parsed ? slotOf(parsed.rest) : null, time: parsed ? timeOf(parsed.rest) : null, wd };
  });

  // ------------------------------------------------------------ 記号

  const SYMBOL_LIST = SITE.symbols(candidates);
  if (!SYMBOL_LIST.length) return null;
  /** 記号の文字 → サイト側の値 */
  const symbols = Object.fromEntries(SYMBOL_LIST.map((s) => [s.text, s.key]));
  /** 記号の文字 → 色分け */
  const KIND = Object.fromEntries(SYMBOL_LIST.map((s) => [s.text, s.kind]));
  /** 画面に並んでいる順 */
  const SYMS = SYMBOL_LIST.map((s) => s.text);

  // ------------------------------------------------------------ 表を操作する

  const current = (c) => SITE.current(c);

  function setValue(c, key) {
    key = String(key || '0');
    if (current(c) === key) return false;
    SITE.setValue(c, key);
    const el = SITE.flashEl(c);
    if (el) {
      el.classList.remove('hiyori-flash');
      void el.offsetWidth;
      el.classList.add('hiyori-flash');
    }
    return true;
  }


  // ------------------------------------------------------------ 判定

  /**
   * ヒヨリの {day, night}（true=空き false=不可 null=不明）を、入れ分けの区分に分ける。
   *   full  … 全日○（昼○ 夜○）
   *   day   … 昼だけ○（夜は × か不明）
   *   night … 夜だけ○（昼は × か不明）
   *   maybe … △（どちらも不明・△と書いた）
   *   half  … 昼か夜×（片方が×・もう片方は不明）
   *   ng    … 全日×（昼× 夜×）
   * 候補名に時間帯が書いてあるときは、その帯だけを見て full / maybe / ng にする。
   */
  function decide(c, st) {
    if (c.slot) {
      const v = st[c.slot];
      return v === true ? 'full' : v === false ? 'ng' : 'maybe';
    }
    const { day, night } = st;
    if (day === true && night === true) return 'full';
    if (day === true) return 'day';
    if (night === true) return 'night';
    if (day === false && night === false) return 'ng';
    if (day === false || night === false) return 'half';
    return 'maybe';
  }

  const has = (t) => (symbols[t] !== undefined ? t : null);
  const T = {
    best: has('◎'),
    ok: SYMS.find((t) => ['○', '〇', '◯'].includes(t)) || null,
    maybe: has('△'),
    ng: SYMBOL_LIST.find((s) => s.kind === 'ng')?.text || null,
    all: has('全'), day: has('昼'), night: has('夜'),
  };

  const CATS = [
    ['full', '全日○', '昼も夜も空き'],
    ['day', '昼だけ○', '夜は×か不明'],
    ['night', '夜だけ○', '昼は×か不明'],
    ['maybe', '△', '不明・△と書いた'],
    ['half', '昼か夜×', '片方×・片方不明'],
    ['ng', '全日×', '昼も夜も×'],
  ];

  /** いまの記号の組み合わせに合わせた初期の入れ分け */
  function defaultMapping() {
    const or = (...xs) => xs.find(Boolean) || '';
    const ng = or(T.ng);
    // 「全昼夜」のテンプレート：ヒヨリの区分がそのまま当てはまる。対応する札が無い区分は入れない
    if (T.all || T.day || T.night) {
      return { full: or(T.all), day: or(T.day), night: or(T.night), maybe: or(T.maybe), half: '', ng };
    }
    if (T.best) {
      return { full: T.best, day: or(T.ok), night: or(T.ok), maybe: or(T.maybe), half: or(T.maybe, ng), ng };
    }
    if (T.ok || T.maybe) {
      return { full: or(T.ok, T.maybe), day: or(T.maybe, T.ok), night: or(T.maybe, T.ok), maybe: or(T.maybe), half: or(T.maybe, ng), ng };
    }
    // 読めない記号だけのとき（①②③など）：並び順で、先頭を全日、2番目を片方だけに当てる
    const pos = SYMBOL_LIST.filter((s) => s.kind !== 'ng').map((s) => s.text);
    return { full: or(pos[0]), day: or(pos[1], pos[0]), night: or(pos[1], pos[0]), maybe: or(pos[2]), half: '', ng };
  }

  // 入れ分けは「サイト・ページ・記号の組み合わせ」ごとに覚える。
  // デイコードは記号のテンプレートを後から変えられるので、組み合わせが変わったら覚え直す。
  // 初めての組み合わせには、同じ組み合わせで最後に使った入れ分けを使う。
  const SIG = SYMBOL_LIST.map((s) => `${s.text}=${s.key}`).join('|');
  const MAP_KEY = `map:${SITE.id}:${SITE.eventKey}:${SIG}`;
  const MAP_DEFAULT_KEY = `mapDefault:${SIG}`;
  // v0.5 までの伝助の保存場所（読むだけ）
  const LEGACY_MAP_KEYS = SITE.id === 'densuke' ? [`map:${SITE.eventKey}`, `mapDefault:${SYMS.join('')}`] : [];
  let mapping = defaultMapping();

  function cleanMapping(m) {
    const base = defaultMapping();
    const out = {};
    for (const [k] of CATS) {
      const v = m && typeof m[k] === 'string' ? m[k] : base[k];
      out[k] = v === '' || symbols[v] !== undefined ? v : base[k];
    }
    return out;
  }

  /** 区分 → サイト側の値。「入れない」は null */
  const keyFor = (cat) => (mapping[cat] ? symbols[mapping[cat]] ?? null : null);

  /**
   * ふだんの都合を上限として重ねる。
   * 「カレンダーやテキストで空いている」と「その時間帯にふだん動ける」は別の情報なので、
   * 両方そろって初めて空きとみなす（ヒヨリ本体の worst と同じ考え方）。
   */
  function capByPattern(st, pattern, isHoliday) {
    const base = A.PATTERNS[pattern] || A.PATTERNS.free;
    const bd = isHoliday ? base[2] : base[0];
    const bn = isHoliday ? base[3] : base[1];
    return { day: A.worst(st.day, bd), night: A.worst(st.night, bn) };
  }

  const isHolidayOf = (holidays) => (d) => A.isWeekend(d) || holidays.has(d);

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

  // ------------------------------------------------------------ 設定の保存

  const DEFAULTS = {
    freecal: '', pattern: 'weekday', capByPattern: true, keepFilled: true, futureOnly: true, futureOnlyTx: true,
    comment: '', commentAuto: true, openEnd: '180',
    collapsed: false, tab: 'fc',
  };
  let settings = { ...DEFAULTS };
  const saveSettings = (patch) => {
    settings = { ...settings, ...patch };
    try { chrome.storage.local.set({ settings }); } catch (e) { /* 保存できなくても動作は続ける */ }
  };

  // ------------------------------------------------------------ 画面
  //
  // 見た目の方針（emilkowalski/skills を参考にした）
  //  ・よく使う操作を上、たまにしか触らない設定は一段奥（折りたたみ）に置く
  //  ・枠線ではなく、うすい影のリングで面を分ける
  //  ・押せるものは押した瞬間に少し縮む（scale 0.97 / 160ms）
  //  ・動きは transform と opacity だけ。出るときは ease-out、画面内の移動は ease-in-out、300ms 以内
  //  ・ホバーの変化はマウス環境だけ。動きを減らす設定では移動をやめて色の変化だけ残す
  //  ・結果はトーストでまとめて知らせ、その場で「元に戻す」を押せるようにする

  const host = document.createElement('div');
  host.id = 'hiyori-densuke';
  host.style.cssText = 'display:block;margin:10px 0 14px;';
  const root = host.attachShadow({ mode: 'open' });

  const ICON = {
    cal: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/></svg>',
    text: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 6h14M5 12h14M5 18h9"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>',
  };

  // ヒヨリのサービスページ（ロゴと案内の行き先）
  const SERVICE_URL = 'https://macchan.onrender.com/sched/';

  // ヒヨリのロゴ（マーク＋文字）。sched.html の LOGO_FULL と同じ絵。
  // 色は currentColor で決めるので、元絵を差し替えたら sched.html と一緒にここも書き換える。
  const LOGO_FULL = `<svg class="lg" viewBox="527.174 463.989 1007.01 279.91" fill="currentColor" aria-hidden="true"><path d="M838.65,548.554L838.65,514.332C838.65,501.495 828.228,491.072 815.391,491.072L582.865,491.072L582.865,463.989L815.391,463.989C843.176,463.989 865.734,486.547 865.734,514.332L865.734,693.557C865.734,721.342 843.176,743.899 815.391,743.899L711.821,743.899L711.821,716.816L815.391,716.816C828.228,716.816 838.65,706.394 838.65,693.557L838.65,579.288L711.821,579.288L711.821,548.554L838.65,548.554ZM1295.886,549.554L1295.886,529.408C1295.886,516.571 1287.542,509.072 1272.627,509.072L1169.131,509.072L1169.131,481.989L1275.743,481.989C1305.398,481.989 1322.97,497.338 1322.97,525.123L1322.97,676.557C1322.97,704.342 1300.412,726.899 1272.627,726.899L1169.057,726.899L1169.057,699.816L1272.627,699.816C1285.464,699.816 1295.886,689.394 1295.886,676.557L1295.886,580.288L1169.131,580.288L1169.131,549.554L1295.886,549.554ZM554.257,579.288L554.257,693.557C554.257,706.394 564.679,716.816 577.517,716.816L681.087,716.816L681.087,743.899L577.517,743.899C549.732,743.899 527.174,721.342 527.174,693.557L527.174,464.124L554.257,464.124L554.257,548.554L681.087,548.554L681.087,579.288L554.257,579.288ZM985.769,580.288L985.769,676.557C985.769,689.394 996.192,699.816 1009.029,699.816L1112.599,699.816L1112.599,726.899L1009.029,726.899C981.244,726.899 958.686,704.342 958.686,676.557L958.686,482.124L985.769,482.124L985.769,549.554L1112.599,549.554L1112.599,580.288L985.769,580.288ZM1507.098,481.422L1534.182,481.422L1534.182,667.565C1534.182,700.805 1510.777,726.515 1483.839,726.515L1380.269,726.515L1380.269,699.432L1483.839,699.432C1497.549,699.432 1507.098,684.482 1507.098,667.565L1507.098,481.422ZM1411.003,480.93L1411.003,580.072L1380.269,580.072L1380.269,480.93L1411.003,480.93ZM729.721,596.34L756.804,596.34L756.804,634.869C756.804,662.654 734.246,685.212 706.461,685.212L644.039,685.212L644.039,658.129L706.461,658.129C719.299,658.129 729.721,647.706 729.721,634.869L729.721,596.34ZM643.575,596.34L670.658,596.34L670.658,630.25L643.575,630.25L643.575,596.34Z"/></svg>`;

  const symClass = (t) => KIND[t] || 'ok';
  const undated = candidates.filter((c) => !c.date).length;
  // 候補名に時間（19:00〜、昼、夜など）が付いている候補があるか
  const SLOTTED = candidates.some((c) => c.slot);
  const TIMED = candidates.some((c) => c.time);
  const PATTERN_LABEL = {
    free: 'いつでも空いている', weekday: '平日の昼は仕事', shift: 'シフト制で不定休', nightly: '夜だけ参加できる',
  };
  const WIPE_LABEL = SITE.hasBlank ? '長押しで全部消す' : `長押しで全部${esc(T.ng || '×')}に`;
  const symOptions = (withBlank) => SYMS.map((t) => `<option value="${esc(t)}" class="o-${symClass(t)}">${esc(t)}</option>`).join('')
    + (withBlank ? '<option value="" class="o-blank">空欄</option>' : '');

  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }

    .wrap {
      --ink: #1f3a4a; --ink-2: #3c5868; --muted: #5d7685; --faint: #8fa5b1;
      --bg: #f3fafc; --card: #fff; --soft: #eaf2f5; --soft-2: #dcecf1;
      --ring: rgba(31, 58, 74, .09); --ring-strong: rgba(31, 58, 74, .16);
      --accent: #2b78ad; --accent-ink: #1f5f8c; --accent-soft: #e1f0f8;
      --best-ink: #2e5f8a; --best-bg: #eaf2f9; --best-dot: #3d7fae;
      --ok-ink: #25704f;   --ok-bg: #eaf6ef;   --ok-dot: #4fb585;
      --maybe-ink: #8a5f08; --maybe-bg: #fff5da; --maybe-dot: #e7b53c;
      --ng-ink: #bf3a3f;   --ng-bg: #fdeeee;   --ng-dot: #e2575b;
      --plus-ink: #1f6b73; --plus-bg: #e3f3f3;
      --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
      --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
      position: relative;
      font-family: system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic UI", Meiryo, sans-serif;
      font-size: 14.5px; line-height: 1.55; color: var(--ink);
      background: var(--bg);
      border-radius: 14px;
      box-shadow: 0 0 0 1px var(--ring), 0 1px 2px rgba(31,58,74,.04), 0 8px 24px rgba(31,58,74,.06);
      text-align: left;
      -webkit-font-smoothing: antialiased;
    }
    .wrap.side {
      position: sticky; top: 12px;
      max-height: calc(100vh - 24px); overflow: auto; overscroll-behavior: contain;
      scrollbar-width: thin; scrollbar-color: var(--soft-2) transparent;
    }

    /* ---- ヘッダー ---- */
    .top {
      display: flex; align-items: center; gap: 6px;
      padding: 10px 10px 10px 14px;
    }
    /* ロゴは高さだけ決めて横は形なり。ロゴの外のすきまは中（マークと文字の間）より広くとる */
    .brand {
      display: inline-flex; align-items: center; color: var(--accent);
      border-radius: 6px; padding: 2px; margin: -2px 4px -2px -2px;
      transition: opacity 140ms ease;
    }
    .brand .lg { height: 20px; width: auto; display: block; }
    .brand:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (hover: hover) and (pointer: fine) { .brand:hover { opacity: .78; } }
    .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
    .sub { color: var(--muted); font-size: 13.5px; }
    .sub.plain { color: var(--ink-2); font-size: 14px; font-weight: 700; }
    .spacer { flex: 1; }
    .body { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; padding: 0 8px 10px; }
    .body > *, details summary { min-width: 0; }
    .wrap.collapsed .body, .wrap.collapsed .toast-slot { display: none; }
    .wrap.collapsed .chev { transform: rotate(-90deg); }
    /* たたんだときは、幅の狭い1つのボタンにする。どこを押してもひらく */
    .wrap.collapsed { width: max-content; max-width: 100%; cursor: pointer;
      transition: box-shadow 140ms ease, background-color 140ms ease; }
    .wrap.collapsed .top { padding: 9px 8px 9px 14px; gap: 8px; }
    .wrap.collapsed #undo, .wrap.collapsed .top .spacer { display: none; }
    .wrap.collapsed .brand { pointer-events: none; }
    .wrap.collapsed .sub { color: var(--ink-2); font-weight: 700; }
    .wrap.collapsed #toggle { color: var(--accent); }
    @media (hover: hover) and (pointer: fine) {
      .wrap.collapsed:hover { background: var(--card); box-shadow: 0 0 0 1px var(--accent), 0 4px 14px rgba(31,58,74,.10); }
    }

    /* ---- デイコードの画面になじませる（Bulma の色と角） ---- */
    .wrap.theme-daycode {
      --ink: #363636; --ink-2: #4a4a4a; --muted: #7a7a7a; --faint: #a8a8a8;
      --bg: #fafafa; --card: #fff; --soft: #f5f5f5; --soft-2: #ededed;
      --ring: rgba(10, 10, 10, .08); --ring-strong: rgba(10, 10, 10, .16);
      --accent: #00b89c; --accent-ink: #00947e; --accent-soft: #ebfffc;
      font-family: BlinkMacSystemFont, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", Meiryo, Roboto, sans-serif;
      border-radius: 6px;
      box-shadow: 0 .5em 1em -.125em rgba(10,10,10,.1), 0 0 0 1px rgba(10,10,10,.06);
    }
    .theme-daycode .card { border-radius: 6px; box-shadow: 0 0 0 1px #ededed; }
    .theme-daycode button, .theme-daycode .day, .theme-daycode .tog span, .theme-daycode .seg,
    .theme-daycode input[type=text], .theme-daycode input[type=password], .theme-daycode textarea, .theme-daycode select,
    .theme-daycode .sub-row select.mini, .theme-daycode #replace, .theme-daycode .hold { border-radius: 4px; }
    .theme-daycode .seg-ind, .theme-daycode .seg button { border-radius: 3px; }
    .theme-daycode .day.preset { border-radius: 290486px; }
    .theme-daycode #replace { box-shadow: 0 0 0 1px #b5f0e5; }
    /* 大きさもデイコードの小さいボタン（高さ30px・12px）に合わせる */
    .wrap.theme-daycode { font-size: 13px; }
    .theme-daycode .top { padding: 8px 8px 8px 12px; }
    .theme-daycode .sub.plain, .theme-daycode.collapsed .sub { font-size: 13px; }
    .theme-daycode .body { gap: 6px; padding: 0 6px 8px; }
    .theme-daycode .card { padding: 10px; }
    .theme-daycode details.card { padding: 0; }
    .theme-daycode .card-h { margin-bottom: 8px; }
    .theme-daycode h2 { font-size: 12.5px; }
    .theme-daycode .stack { gap: 6px; }
    .theme-daycode .tally span { font-size: 12px; padding: 0 7px 0 5px; }
    .theme-daycode button { font-size: 12px; padding: 0 10px; height: 30px; }
    .theme-daycode .ghost { height: 26px; font-size: 12px; padding: 0 6px; }
    .theme-daycode .icon-btn { height: 26px; padding: 0 4px; }
    .theme-daycode .seg { padding: 2px; margin-bottom: 8px; }
    .theme-daycode .seg-ind { top: 2px; bottom: 2px; left: 2px; width: calc((100% - 4px) / 3); }
    .theme-daycode .seg button { height: 26px; font-size: 12px; }
    .theme-daycode input[type=text], .theme-daycode input[type=password], .theme-daycode select { height: 30px; padding: 0 8px; font-size: 12.5px; }
    .theme-daycode textarea { font-size: 12.5px; padding: 6px 8px; min-height: 84px; }
    .theme-daycode .check { font-size: 12px; }
    .theme-daycode .check input { width: 13px; height: 13px; }
    .theme-daycode .hint { font-size: 12px; }
    .theme-daycode .days, .theme-daycode .syms { gap: 4px; }
    .theme-daycode .day { height: 30px; font-size: 12.5px; }
    .theme-daycode .day.preset { height: 24px; padding: 0 9px; font-size: 11.5px; }
    .theme-daycode .tog span { height: 30px; font-size: 12px; }
    .theme-daycode .sym { height: 30px; font-size: 14px; }
    .theme-daycode .sym-clear { height: 30px; font-size: 12px; }
    .theme-daycode .hold { height: 30px; font-size: 12px; }
    .theme-daycode .sub-row { font-size: 12px; padding-top: 8px; }
    .theme-daycode .sub-row select.mini { height: 30px; font-size: 13.5px; padding: 0 24px 0 10px; }
    .theme-daycode .sub-row select[data-kind="blank"] { font-size: 12px; }
    .theme-daycode #replace { height: 30px; font-size: 12px; padding: 0 12px; }
    .theme-daycode details summary { padding: 8px 10px; }
    .theme-daycode .foot { font-size: 11.5px; padding: 0 12px 10px; }
    @media (hover: hover) and (pointer: fine) { .theme-daycode #replace:hover:not([disabled]) { background: #d8faf3; } }

    /* ---- 表の集計 ---- */
    .tally { display: flex; flex-wrap: wrap; gap: 4px; padding: 0 6px 2px; }
    .tally span {
      display: inline-flex; align-items: center; gap: 5px;
      padding: 1px 8px 1px 6px; border-radius: 999px;
      background: var(--card); box-shadow: 0 0 0 1px var(--ring);
      font-size: 13.5px; color: var(--ink-2); font-variant-numeric: tabular-nums;
    }
    .tally b { font-weight: 700; }
    .tally .t-best b { color: var(--best-ink); }
    .tally .t-ok b { color: var(--ok-ink); }
    .tally .t-maybe b { color: var(--maybe-ink); }
    .tally .t-ng b { color: var(--ng-ink); }
    .tally .t-plus b { color: var(--plus-ink); }
    .tally .t-none { color: var(--muted); }
    .tally .t-none b { color: var(--muted); font-weight: 600; }

    /* ---- 面 ---- */
    .card {
      background: var(--card); border-radius: 11px; padding: 12px;
      box-shadow: 0 0 0 1px var(--ring), 0 1px 1px rgba(31,58,74,.03);
    }
    .card-h { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; }
    h2 { margin: 0; font-size: 13.5px; font-weight: 700; color: var(--ink-2); letter-spacing: .02em; }
    .row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
    .stack { display: grid; gap: 8px; }
    .hint { color: var(--muted); font-size: 13px; line-height: 1.5; }
    .note { background: var(--maybe-bg); color: var(--maybe-ink); border-radius: 8px; padding: 6px 10px; font-size: 13.5px; }

    /* ---- 入力部品 ---- */
    input[type=text], input[type=password], textarea, select {
      font: inherit; color: var(--ink); background: var(--card); width: 100%;
      border: 0; border-radius: 8px; padding: 7px 10px;
      box-shadow: 0 0 0 1px var(--ring-strong);
      transition: box-shadow 140ms ease;
    }
    input[type=text]::placeholder, input[type=password]::placeholder, textarea::placeholder { color: var(--faint); }
    input[type=text]:focus, input[type=password]:focus, textarea:focus, select:focus {
      outline: none; box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px var(--accent-soft);
    }
    textarea { min-height: 96px; resize: vertical; line-height: 1.5; font-variant-numeric: tabular-nums; }
    select.mini { width: auto; padding: 4px 8px; }

    button {
      font: inherit; color: var(--ink); cursor: pointer;
      border: 0; border-radius: 8px; padding: 6px 12px; background: var(--soft);
      transition: transform 160ms var(--ease-out), background-color 140ms ease, color 140ms ease, opacity 140ms ease;
      -webkit-tap-highlight-color: transparent; user-select: none;
    }
    button:active:not([disabled]) { transform: scale(0.97); }
    button:focus-visible, .chip:focus-visible, .day:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    button[disabled] { opacity: .45; cursor: default; }
    .primary { background: var(--accent); color: #fff; font-weight: 600; }
    .ghost { background: transparent; color: var(--muted); padding: 5px 8px; display: inline-flex; align-items: center; gap: 4px; font-size: 13.5px; }
    .icon-btn { padding: 5px; display: inline-flex; }
    .chev { display: inline-flex; transition: transform 200ms var(--ease-out); }
    @media (hover: hover) and (pointer: fine) {
      button:hover:not([disabled]) { background: var(--soft-2); }
      .primary:hover:not([disabled]) { background: var(--accent-ink); }
      .ghost:hover:not([disabled]) { background: var(--soft); color: var(--ink); }
    }

    /* 処理中のくるくる。速めに回すと待ちが短く感じる */
    .spin {
      width: 12px; height: 12px; border-radius: 50%; display: none;
      border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
      animation: spin 600ms linear infinite;
    }
    button[aria-busy="true"] .spin { display: inline-block; }
    button[aria-busy="true"] .lbl { opacity: .8; }
    .primary { display: inline-flex; align-items: center; gap: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }

    .check { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; color: var(--ink-2); font-size: 13.5px; }
    .check input { accent-color: var(--accent); margin: 0; width: 14px; height: 14px; }

    /* ---- 取り込み元の切り替え ---- */
    .seg {
      position: relative; display: grid; grid-template-columns: 1fr 1fr 1fr;
      background: var(--soft); border-radius: 9px; padding: 3px; margin-bottom: 12px;
    }
    .seg-ind {
      position: absolute; top: 3px; bottom: 3px; left: 3px; width: calc((100% - 6px) / 3);
      background: var(--card); border-radius: 7px;
      box-shadow: 0 0 0 1px var(--ring), 0 1px 3px rgba(31,58,74,.08);
      transition: transform 220ms var(--ease-in-out);
    }
    .seg[data-tab="gc"] .seg-ind { transform: translateX(100%); }
    .seg[data-tab="tx"] .seg-ind { transform: translateX(200%); }
    .seg button[aria-selected="true"] .ico-g { color: #4f97c7; }
    .seg button {
      position: relative; background: transparent; padding: 5px 8px;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      color: var(--muted); font-weight: 600; font-size: 13.5px;
    }
    .seg button[aria-selected="true"] { color: var(--ink); }
    .seg button[aria-selected="true"] .ico-cal { color: #4f97c7; }
    @media (hover: hover) and (pointer: fine) {
      .seg button:hover:not([disabled]) { background: transparent; color: var(--ink); }
    }
    .pane { animation: paneIn 180ms var(--ease-out); }
    @keyframes paneIn { from { opacity: 0; transform: translateY(3px); } }
    .url-row { display: flex; gap: 6px; }
    .url-row input { flex: 1; min-width: 0; }
    .between { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }

    /* ---- まとめて入力 ---- */
    /* 曜日は文字そのものを押して選ぶ。7つを同じ幅で1列に */
    .days { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 5px; }
    .day {
      height: 36px; padding: 0; font-size: 15px; font-weight: 700; border-radius: 9px;
      background: var(--card); color: var(--ink-2); box-shadow: 0 0 0 1px var(--ring-strong);
    }
    .day[data-wd="0"] { color: #d0573b; } .day[data-wd="6"] { color: #2b78ad; }
    .day[aria-pressed="true"] { background: var(--accent); color: #fff; box-shadow: none; }
    /* 平日・土日は見出しの右に小さく */
    .presets { display: flex; gap: 4px; }
    .day.preset { height: 26px; padding: 0 10px; font-size: 12.5px; font-weight: 600; color: var(--muted); border-radius: 999px; }
    .day.preset[aria-pressed="true"] { color: #fff; }
    @media (hover: hover) and (pointer: fine) {
      .day:hover:not([aria-pressed="true"]) { background: var(--soft); }
    }

    /* 「空欄の日だけ」も押して切り替える札。入っているときは淡い色に ✓ */
    .tog { display: block; position: relative; cursor: pointer; }
    .tog[hidden] { display: none; }
    .tog input { position: absolute; opacity: 0; width: 1px; height: 1px; margin: 0; }
    .tog span {
      display: flex; align-items: center; justify-content: center; gap: 6px; height: 36px; border-radius: 9px;
      background: var(--card); color: var(--muted); font-size: 13.5px; font-weight: 700;
      box-shadow: 0 0 0 1px var(--ring-strong); user-select: none;
      transition: background-color 140ms ease, color 140ms ease, box-shadow 140ms ease;
    }
    .tog span::before { content: "✓"; opacity: 0; }
    .tog input:checked + span { background: var(--accent-soft); color: var(--accent-ink); box-shadow: 0 0 0 1px var(--accent); }
    .tog input:checked + span::before { opacity: 1; }
    .tog input:focus-visible + span { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (hover: hover) and (pointer: fine) { .tog:hover span { box-shadow: 0 0 0 1px var(--accent); } }

    /* 記号と「空欄に戻す」も曜日と同じ高さで横いっぱいに */
    .syms { display: grid; grid-template-columns: repeat(${SYMS.length}, minmax(0, 1fr))${SITE.hasBlank ? ' minmax(0, 1.7fr)' : ''}; gap: 5px; }
    .sym { font-size: 17px; font-weight: 700; height: 36px; padding: 0; border-radius: 9px; }
    .s-best { background: var(--best-bg); color: var(--best-ink); }
    .s-ok { background: var(--ok-bg); color: var(--ok-ink); }
    .s-maybe { background: var(--maybe-bg); color: var(--maybe-ink); }
    .s-ng { background: var(--ng-bg); color: var(--ng-ink); }
    .s-plus { background: var(--plus-bg); color: var(--plus-ink); }
    .sym-clear { font-size: 13.5px; font-weight: 600; color: var(--ink-2); height: 36px; padding: 0 6px; border-radius: 9px; }
    @media (hover: hover) and (pointer: fine) {
      .s-best:hover { background: #dce9f5 !important; } .s-ok:hover { background: #daf0e3 !important; }
      .s-maybe:hover { background: #ffecb8 !important; } .s-ng:hover { background: #fbdcdc !important; }
      .s-plus:hover { background: #d2ecec !important; }
    }

    /* 置き換え：選んでいる記号の色を欄に付ける。押すボタンは淡い青 */
    .sub-row select.mini {
      height: 34px; padding: 0 26px 0 12px; font-size: 16px; font-weight: 700; border-radius: 9px;
    }
    .sub-row select[data-kind="best"]  { background-color: var(--best-bg);  color: var(--best-ink);  box-shadow: 0 0 0 1px #c9dcee; }
    .sub-row select[data-kind="ok"]    { background-color: var(--ok-bg);    color: var(--ok-ink);    box-shadow: 0 0 0 1px #c3e5d2; }
    .sub-row select[data-kind="maybe"] { background-color: var(--maybe-bg); color: var(--maybe-ink); box-shadow: 0 0 0 1px #f3dc9c; }
    .sub-row select[data-kind="ng"]    { background-color: var(--ng-bg);    color: var(--ng-ink);    box-shadow: 0 0 0 1px #f3c9cb; }
    .sub-row select[data-kind="plus"]  { background-color: var(--plus-bg);  color: var(--plus-ink);  box-shadow: 0 0 0 1px #bfe0e0; }
    .sub-row select[data-kind="blank"] { background-color: var(--soft);     color: var(--muted);     font-size: 13.5px; }
    .sub-row select:focus { box-shadow: 0 0 0 1px var(--accent), 0 0 0 4px var(--accent-soft); }
    option { background: #fff; font-weight: 700; }
    option.o-best { color: var(--best-ink); } option.o-ok { color: var(--ok-ink); }
    option.o-maybe { color: var(--maybe-ink); } option.o-ng { color: var(--ng-ink); }
    option.o-plus { color: var(--plus-ink); } option.o-blank { color: var(--muted); font-weight: 400; }
    #replace { height: 34px; padding: 0 14px; border-radius: 9px; font-weight: 700;
      background: var(--accent-soft); color: var(--accent-ink); box-shadow: 0 0 0 1px #b9d8ec; }
    @media (hover: hover) and (pointer: fine) { #replace:hover:not([disabled]) { background: #d0e7f4; } }
    .sub-row {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      padding-top: 10px; margin-top: 2px; border-top: 1px solid var(--soft-2);
      color: var(--ink-2); font-size: 13.5px;
    }

    /* 長押しで消す。押している間だけ赤が左から満ちる。離すとすぐ戻る */
    .hold {
      position: relative; overflow: hidden; background: transparent; color: var(--ng-ink);
      box-shadow: 0 0 0 1px #f3c9cb; font-size: 13.5px; font-weight: 600;
      display: block; width: 100%; height: 36px; padding: 0; border-radius: 9px; margin-top: 4px;
    }
    .hold .fill {
      position: absolute; inset: 0; background: var(--ng-ink); color: #fff;
      display: flex; align-items: center; justify-content: center;
      clip-path: inset(0 100% 0 0);
      transition: clip-path 200ms var(--ease-out);
    }
    .hold.holding .fill { clip-path: inset(0 0 0 0); transition: clip-path 1200ms linear; }
    @media (hover: hover) and (pointer: fine) {
      .hold:hover:not([disabled]) { background: var(--ng-bg); }
    }

    /* ---- 設定（たまにしか触らないので一段奥） ---- */
    details.card { padding: 0; }
    details summary {
      list-style: none; cursor: pointer; padding: 10px 12px;
      display: flex; align-items: center; gap: 8px; border-radius: 11px;
    }
    details summary::-webkit-details-marker { display: none; }
    details summary:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    details summary .chev { color: var(--faint); transform: rotate(-90deg); }
    details[open] summary .chev { transform: rotate(0deg); }
    .sum { color: var(--muted); font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0; }
    .set-body { padding: 0 12px 12px; display: grid; gap: 12px; }
    details[open] .set-body { animation: paneIn 200ms var(--ease-out); }
    .label { font-size: 13px; color: var(--muted); margin-bottom: 4px; display: block; }
    .gclist { display: grid; gap: 6px; }
    .gcrow { display: flex; align-items: center; gap: 6px; }
    .gcrow .gcurl { flex: 1; min-width: 0; }
    .gcno { flex: none; width: 18px; height: 18px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-ink);
      font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
    .gcdel { color: var(--faint); }
    .gmore summary { cursor: pointer; color: var(--muted); font-size: 12.5px; list-style: none; padding: 2px 0; border-radius: 4px; }
    .gmore summary::-webkit-details-marker { display: none; }
    .gmore summary::before { content: "▸ "; } .gmore[open] summary::before { content: "▾ "; }
    .gmore[open] { display: grid; gap: 6px; }
    .gmore .label { margin: 4px 0 0; font-size: 12px; }

    .maptbl { display: grid; gap: 2px; }
    .maprow { display: flex; align-items: center; gap: 8px; padding: 3px 0; }
    .mapname { width: 124px; flex: none; font-size: 13.5px; line-height: 1.25; color: var(--ink); }
    .mapname small { display: block; color: var(--faint); font-size: 12px; }
    .chips { display: flex; gap: 2px; background: var(--soft); border-radius: 8px; padding: 2px; flex-wrap: wrap; }
    .chip {
      min-width: 36px; padding: 3px 0; font-size: 13.5px; font-weight: 700; border-radius: 6px;
      background: transparent; color: var(--faint);
    }
    .chip.c-none { min-width: auto; padding: 2px 8px; font-weight: 500; font-size: 12.5px; }
    .chip[aria-pressed="true"] { background: var(--card); box-shadow: 0 0 0 1px var(--ring), 0 1px 2px rgba(31,58,74,.08); }
    .chip[aria-pressed="true"].c-best { color: var(--best-ink); }
    .chip[aria-pressed="true"].c-ok { color: var(--ok-ink); }
    .chip[aria-pressed="true"].c-maybe { color: var(--maybe-ink); }
    .chip[aria-pressed="true"].c-ng { color: var(--ng-ink); }
    .chip[aria-pressed="true"].c-plus { color: var(--plus-ink); }
    .chip[aria-pressed="true"].c-none { color: var(--ink-2); }
    @media (hover: hover) and (pointer: fine) {
      .chip:hover:not([aria-pressed="true"]) { background: rgba(255,255,255,.6); color: var(--ink-2); }
    }

    .foot { padding: 0 14px 12px; color: var(--faint); font-size: 12.5px; display: flex; flex-wrap: wrap; gap: 2px 12px; justify-content: space-between; }
    .promo { color: var(--accent); text-decoration: none; font-weight: 600; white-space: nowrap; border-radius: 4px; }
    .promo span { display: inline-block; margin-left: 2px; transition: transform 160ms var(--ease-out); }
    .promo:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    @media (hover: hover) and (pointer: fine) {
      .promo:hover { text-decoration: underline; text-underline-offset: 2px; }
      .promo:hover span { transform: translate(1px, -1px); }
    }
    .wrap.collapsed .foot { display: none; }

    /* ---- トースト ---- */
    .toast-slot { position: sticky; bottom: 10px; height: 0; z-index: 3; }
    .toast {
      position: absolute; left: 10px; right: 10px; bottom: 0;
      display: flex; align-items: flex-start; gap: 10px;
      padding: 10px 10px 10px 12px; border-radius: 10px;
      background: #1f3a4a; color: #fff;
      box-shadow: 0 6px 20px rgba(17,25,28,.22), 0 1px 3px rgba(17,25,28,.18);
      opacity: 0; transform: translateY(8px) scale(0.98); pointer-events: none;
      transition: opacity 150ms ease-out, transform 150ms var(--ease-out);
    }
    .toast.show {
      opacity: 1; transform: none; pointer-events: auto;
      transition: opacity 220ms var(--ease-out), transform 220ms var(--ease-out);
    }
    .toast .t-body { flex: 1; min-width: 0; }
    .toast .t-main { font-weight: 600; font-size: 14px; }
    .toast .t-detail { color: rgba(255,255,255,.66); font-size: 13px; margin-top: 1px; }
    .toast.err .t-main { color: #ffb4b6; }
    .toast .t-dot { width: 7px; height: 7px; border-radius: 50%; background: #7fbbdd; margin-top: 6px; flex: none; }
    .toast.err .t-dot { background: #ff7a7e; }
    .toast .t-undo { background: rgba(255,255,255,.12); color: #fff; font-size: 13.5px; padding: 4px 10px; flex: none; }
    @media (hover: hover) and (pointer: fine) {
      .toast .t-undo:hover:not([disabled]) { background: rgba(255,255,255,.2); }
    }

    @media (prefers-reduced-motion: reduce) {
      *, *::before, *::after { animation: none !important; }
      button:active:not([disabled]) { transform: none; }
      .seg-ind, .chev { transition: none; }
      .toast, .toast.show { transform: none; }
      .hold.holding .fill { transition: clip-path 1200ms linear; }
    }
  </style>

  <div class="wrap${settings.collapsed ? ' collapsed' : ''}${SITE.theme ? ` theme-${SITE.theme}` : ''}">
    <div class="top">
      ${SITE.noPromo
        ? '<span class="sub plain">日程入力アシスト</span>'
        : `<a class="brand" href="${SERVICE_URL}" target="_blank" rel="noopener" title="ヒヨリのページを開く">${LOGO_FULL}<span class="vh">ヒヨリ</span></a>
      <span class="sub">日程入力アシスト</span>`}
      <span class="spacer"></span>
      <button type="button" class="ghost" id="undo" disabled title="直前の操作の前に戻します">${ICON.undo}元に戻す</button>
      <button type="button" class="ghost icon-btn" id="toggle" aria-expanded="true" aria-label="パネルをたたむ"><span class="chev">${ICON.chevron}</span></button>
    </div>

    <div class="body">
      <div class="tally" id="tally" aria-label="いまの表の入力状況"></div>

      ${undated ? `<div class="note">日付を読み取れない候補が${undated}件あります。取り込みの対象外です（まとめて入力は使えます）。</div>` : ''}

      <section class="card">
        <div class="seg" role="tablist" aria-label="取り込み元" data-tab="fc">
          <span class="seg-ind" aria-hidden="true"></span>
          <button type="button" role="tab" id="tab-fc" data-tab="fc" aria-selected="true" aria-controls="pane-fc"><span class="ico-cal">${ICON.cal}</span>フリカレ</button>
          <button type="button" role="tab" id="tab-gc" data-tab="gc" aria-selected="false" aria-controls="pane-gc"><span class="ico-g">${ICON.cal}</span>Google</button>
          <button type="button" role="tab" id="tab-tx" data-tab="tx" aria-selected="false" aria-controls="pane-tx">${ICON.text}テキスト</button>
        </div>

        <div class="pane stack" id="pane-fc" role="tabpanel" aria-labelledby="tab-fc">
          <div class="url-row">
            <input type="text" id="fc" placeholder="https://freecalend.com/open/mem000000_xxxx" autocomplete="off" spellcheck="false" aria-label="フリカレの公開URL">
            <button type="button" class="primary" id="sync"><span class="spin" aria-hidden="true"></span><span class="lbl">取り込む</span></button>
          </div>
          <div class="row" style="column-gap:16px">
            <label class="check"${SITE.hasBlank ? '' : ' hidden'}><input type="checkbox" id="keep"> 入力済みの日はそのまま</label>
            <label class="check"><input type="checkbox" id="future"> 本日以降の予定を更新</label>
          </div>
        </div>

        <div class="pane stack" id="pane-gc" role="tabpanel" aria-labelledby="tab-gc" hidden>
          <div class="gclist" id="gclist"></div>
          <div class="between">
            <button type="button" class="ghost" id="gcadd">＋ カレンダーを増やす</button>
            <button type="button" class="primary" id="gsync"><span class="spin" aria-hidden="true"></span><span class="lbl">取り込む</span></button>
          </div>
          <div class="row" style="column-gap:16px">
            <label class="check"${SITE.hasBlank ? '' : ' hidden'}><input type="checkbox" id="gkeep"> 入力済みの日はそのまま</label>
            <label class="check"><input type="checkbox" id="gfuture"> 本日以降の予定を更新</label>
          </div>
          <label class="check" id="gfcwrap"><input type="checkbox" id="gfc"> <span id="gfclbl">フリカレの予定も重ねる</span></label>
          <details class="gmore">
            <summary>アドレスの調べ方と、予定名の扱い</summary>
            <div class="hint">
              Googleカレンダーの「設定」→ 左で自分のカレンダーを選ぶ →「カレンダーの統合」→「iCal形式の非公開アドレス」をコピーして貼ります。カレンダーは5つまで足せて、どれかに予定があれば埋まっている日になります。<br>
              このアドレスは予定を読める鍵です。この拡張機能の中にだけ保存し、Google以外には送りません。他の人に見せないでください。
            </div>
            <label class="label" for="gtent">△にする語（予定名にこの語があれば△）</label>
            <input type="text" id="gtent" placeholder="例：仮, 未定, 調整中">
            <label class="label" for="gign">数えない語（予定名にこの語があれば無いものとする）</label>
            <input type="text" id="gign" placeholder="例：誕生日, リマインド">
          </details>
        </div>

        <div class="pane stack" id="pane-tx" role="tabpanel" aria-labelledby="tab-tx" hidden>
          <textarea id="tx" placeholder="9/14 ×&#10;9/15 夜&#10;2026/09/16 昼○ 夜×" aria-label="取り込むテキスト"></textarea>
          <div class="row"><label class="check"><input type="checkbox" id="futureTx"> 本日以降の予定を更新</label></div>
          <div class="between">
            <span class="hint">1行に1日付。「○」「昼○」「夜」などが読めます</span>
            <button type="button" class="primary" id="tximp"><span class="spin" aria-hidden="true"></span><span class="lbl">読み取る</span></button>
          </div>
        </div>
      </section>

      <section class="card stack">
        <div class="card-h">
          <h2>まとめて入力</h2>
          <span class="spacer"></span>
          <div class="presets" role="group" aria-label="曜日をまとめて選ぶ">
            <button type="button" class="day preset" data-preset="weekday" aria-pressed="false">平日</button>
            <button type="button" class="day preset" data-preset="weekend" aria-pressed="false">土日</button>
          </div>
        </div>
        <div class="days" role="group" aria-label="対象の曜日">
          ${WD.map((w, i) => `<button type="button" class="day" data-wd="${i}" aria-pressed="false">${w}</button>`).join('')}
        </div>
        <label class="tog"${SITE.hasBlank ? '' : ' hidden'}><input type="checkbox" id="onlyEmpty" checked><span>空欄の日だけに入れる</span></label>
        <div class="syms">
          ${SYMS.map((t) => `<button type="button" class="sym s-${symClass(t)}" data-key="${esc(symbols[t])}" aria-label="${esc(t)}を入れる">${esc(t)}</button>`).join('')}
          ${SITE.hasBlank ? '<button type="button" class="sym-clear" data-key="0">空欄に戻す</button>' : ''}
        </div>
        <button type="button" class="hold" id="wipe" aria-label="${WIPE_LABEL}">
          <span class="lbl">${WIPE_LABEL}</span>
          <span class="fill" aria-hidden="true">${WIPE_LABEL}</span>
        </button>
        <div class="sub-row">
          <span>表の</span>
          <select class="mini" id="rfrom" aria-label="置き換える記号">${symOptions(false)}</select>
          <span>を</span>
          <select class="mini" id="rto" aria-label="置き換え後">${symOptions(SITE.hasBlank)}</select>
          <span>に</span>
          <button type="button" id="replace">置き換える</button>
        </div>
      </section>

      <details class="card" id="settings">
        <summary>
          <span class="chev">${ICON.chevron}</span>
          <h2>設定</h2>
        </summary>
        <div class="set-body">
          <div>
            <label class="label" for="cmt">いつもの一言コメント</label>
            <div class="url-row">
              <input type="text" id="cmt" maxlength="500" placeholder="例：平日は21時以降なら参加できます" autocomplete="off">
              <button type="button" id="cmtput" title="いまのコメント欄に入れる">入れる</button>
            </div>
            <div style="margin-top:6px"><label class="check"><input type="checkbox" id="cmtauto"> コメント欄が空なら、開いたときに自動で入れる</label></div>
          </div>
          <div>
            <label class="label" for="pattern">ふだんの都合</label>
            <select id="pattern">
              ${Object.entries(PATTERN_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
            </select>
            <div style="margin-top:6px"><label class="check"><input type="checkbox" id="cap"> ふだんの都合で昼の予定を上書き</label></div>
          </div>
          <div${TIMED ? '' : ' hidden'}>
            <label class="label" for="openEnd">終わりの時刻が書かれていない候補</label>
            <select id="openEnd">
              <option value="120">開始から2時間</option>
              <option value="180">開始から3時間</option>
              <option value="240">開始から4時間</option>
              <option value="slot">時間帯の終わりまで</option>
            </select>
          </div>
          <div>
            <div class="between" style="margin-bottom:4px">
              <span class="label" style="margin:0">記号の入れ分け</span>
              <button type="button" class="ghost" id="mapreset">初期に戻す</button>
            </div>
            <div class="maptbl" role="group" aria-label="記号の入れ分け">
              ${CATS.map(([k, name, note]) => `
              <div class="maprow">
                <div class="mapname">${name}<small>${note}</small></div>
                <div class="chips" data-cat="${k}">
                  ${SYMS.map((t) => `<button type="button" class="chip c-${symClass(t)}" data-sym="${esc(t)}" aria-pressed="false" aria-label="${esc(name)}を${esc(t)}にする">${esc(t)}</button>`).join('')}
                  <button type="button" class="chip c-none" data-sym="" aria-pressed="false" aria-label="${esc(name)}の日は入れない">入れない</button>
                </div>
              </div>`).join('')}
            </div>
            ${SLOTTED ? `<div class="hint" style="margin-top:6px">この表の候補には時間があるので、その時間帯が空いているかだけで入れます（空き→全日○、不明→△、埋まり→全日×）。</div>` : ''}

          </div>
        </div>
      </details>
    </div>

    <div class="foot">
      <span>ここでの操作は、${esc(SITE.name)}の「${esc(SITE.saveLabel)}」を押すまで保存されません。</span>
      ${SITE.noPromo ? '' : `<a class="promo" href="${SERVICE_URL}" target="_blank" rel="noopener">ヒヨリで日程調整を作る<span aria-hidden="true">↗</span></a>`}
    </div>

    <div class="toast-slot">
      <div class="toast" id="toast" role="status" aria-live="polite">
        <span class="t-dot" aria-hidden="true"></span>
        <div class="t-body"><div class="t-main" id="t-main"></div><div class="t-detail" id="t-detail"></div></div>
        <button type="button" class="t-undo" id="t-undo">元に戻す</button>
      </div>
    </div>
  </div>`;

  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];

  // ------------------------------------------------------------ 置き場所
  //
  // 横に余裕があれば、入力表の右に並べて、スクロールしても付いてくるようにする。
  // 狭いときは表の上に置く。
  // サービス側の表は動かさず、パネルを body 直下に置いて表の位置に合わせて絶対配置する。
  const table = SITE.tableEl();
  const frame = SITE.frameEl() || table;
  const inlineAnchor = SITE.inlineAnchor() || frame;
  const SIDE_MIN = 380, SIDE_MAX = SITE.sideMax || 540, GAP = 20, EDGE = 16, STICKY_TOP = 12;
  const baseMargin = frame.style.marginBottom;
  let placed = null;

  function setStyle(el, prop, value) {
    if (el.style[prop] !== value) el.style[prop] = value;
  }

  function layout() {
    const wrap = $('.wrap');
    const r0 = table.getBoundingClientRect();
    const f = frame.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    // 伝助の #regdiv は、参加者が多いと画面の幅いっぱいに広がる（中の表は左に寄ったまま）。
    // 箱の右端で測ると「右に余白が無い」と判断して表の上に置いてしまうので、
    // 中の表の右端を使う。箱が表より狭い（横スクロールしている）ときは箱の右端まで。
    const inner = table.tagName === 'TABLE' ? null : table.querySelector('table');
    const ir = inner?.getBoundingClientRect();
    const right = ir && ir.width > 0 ? (r0.width > 0 ? Math.min(r0.right, ir.right) : ir.right) : r0.right;
    const r = { right, width: ir?.width || r0.width };
    const avail = Math.floor(vw - r.right - GAP - EDGE);

    if (avail >= SIDE_MIN && r.width > 0) {
      if (placed !== 'side') {
        document.body.appendChild(host);
        wrap.classList.add('side');
        placed = 'side';
      }
      const need = Math.min(wrap.scrollHeight, window.innerHeight - STICKY_TOP * 2);
      setStyle(host, 'position', 'absolute');
      setStyle(host, 'maxWidth', '');
      setStyle(host, 'margin', '0');
      setStyle(host, 'zIndex', '20');
      setStyle(host, 'left', `${Math.round(r.right + window.scrollX + GAP)}px`);
      setStyle(host, 'top', `${Math.round(f.top + window.scrollY)}px`);
      setStyle(host, 'width', `${Math.min(SIDE_MAX, avail)}px`);
      setStyle(host, 'height', `${Math.ceil(Math.max(f.height, need))}px`);
      // 表よりパネルが高いときは、表の下（コメント欄や登録ボタン）を押し下げて重ならないようにする
      const extra = Math.ceil(Math.max(0, need - f.height));
      setStyle(frame, 'marginBottom', extra ? `${extra + 12}px` : baseMargin);
    } else {
      if (placed !== 'inline') {
        inlineAnchor.parentNode.insertBefore(host, inlineAnchor);
        wrap.classList.remove('side');
        placed = 'inline';
      }
      for (const k of ['position', 'zIndex', 'left', 'top', 'width', 'height']) setStyle(host, k, '');
      setStyle(host, 'margin', '10px 0 14px');
      setStyle(host, 'maxWidth', '560px');
      setStyle(frame, 'marginBottom', baseMargin);
    }
  }

  let raf = 0;
  const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(layout); };
  layout();
  listen(window, 'resize', schedule);
  listen(window, 'load', schedule);
  // 広告の読み込みで表の位置がずれる・設定を開いてパネルの高さが変わる、に追従する
  const ro = new ResizeObserver(schedule);
  ro.observe(document.body);
  ro.observe(table);
  if (frame !== table) ro.observe(frame);
  ro.observe($('.wrap'));
  cleanups.push(() => ro.disconnect());

  // ------------------------------------------------------------ 表の集計

  function renderTally() {
    const count = { 0: 0 };
    for (const c of candidates) { const v = current(c); count[v] = (count[v] || 0) + 1; }
    $('#tally').innerHTML = SYMS.map((t) => `<span class="t-${symClass(t)}"><b>${esc(t)}</b>${count[symbols[t]] || 0}</span>`).join('')
      + (SITE.hasBlank ? `<span class="t-none"><b>空欄</b>${count[0] || 0}</span>` : '');
  }
  renderTally();
  // サービス側の表のボタンを手で押したときも数え直す（ページ自身の処理が終わってから）
  listen(document, 'click', (ev) => {
    if (SITE.isPageInput(ev.target)) setTimeout(renderTally, 0);
  }, true);
  listen(document, 'change', (ev) => {
    if (SITE.isPageInput(ev.target)) setTimeout(renderTally, 0);
  }, true);

  // ------------------------------------------------------------ トースト

  let toastTimer = 0;
  function toast(main, { detail = '', error = false, undo = false } = {}) {
    const el = $('#toast');
    $('#t-main').textContent = main;
    $('#t-detail').textContent = detail;
    $('#t-detail').hidden = !detail;
    $('#t-undo').hidden = !undo;
    el.classList.toggle('err', error);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, error ? 6000 : 4500);
  }
  function hideToast() { $('#toast').classList.remove('show'); }
  // 読んでいる間は消さない
  $('#toast').addEventListener('pointerenter', () => clearTimeout(toastTimer));
  $('#toast').addEventListener('pointerleave', () => { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, 2000); });

  // ------------------------------------------------------------ 設定の反映


  // ------------------------------------------------------------ 一言コメント

  function fillComment(force) {
    const el = SITE.commentEl?.();
    const text = settings.comment;
    if (!el || !text) return false;
    if (!force && el.value.trim()) return false;   // 書いてあるコメントは消さない
    if (el.value === text) return false;
    el.value = text;
    // 画面の仕組み（Vue など）にも変わったことを知らせる
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.classList.remove('hiyori-flash');
    void el.offsetWidth;
    el.classList.add('hiyori-flash');
    return true;
  }

  const TABS = ['fc', 'gc', 'tx'];
  function setTab(tab) {
    const t = TABS.includes(tab) ? tab : 'fc';
    $('.seg').dataset.tab = t;
    for (const b of $$('.seg [role=tab]')) b.setAttribute('aria-selected', String(b.dataset.tab === t));
    for (const x of TABS) $(`#pane-${x}`).hidden = t !== x;
  }

  function applySettingsToUi() {
    $('#pattern').value = A.PATTERNS[settings.pattern] ? settings.pattern : 'weekday';
    $('#keep').checked = !!settings.keepFilled;
    $('#future').checked = !!settings.futureOnly;
    $('#futureTx').checked = !!settings.futureOnlyTx;
    $('#gkeep').checked = !!settings.keepFilled;
    $('#gfuture').checked = !!settings.futureOnly;
    renderGcals();
    syncGfc();
    $('#gtent').value = settings.gcalTent ?? '仮, 未定';
    $('#gign').value = settings.gcalIgnore || '';
    $('#cap').checked = settings.capByPattern !== false;
    $('#openEnd').value = ['120', '180', '240', 'slot'].includes(settings.openEnd) ? settings.openEnd : '180';
    $('#fc').value = settings.freecal || '';
    if (root.activeElement !== $('#cmt')) $('#cmt').value = settings.comment || '';
    $('#cmtauto').checked = settings.commentAuto !== false;
    setTab(settings.tab);
    $('.wrap').classList.toggle('collapsed', !!settings.collapsed);
    $('#toggle').setAttribute('aria-expanded', String(!settings.collapsed));
    $('#toggle').setAttribute('aria-label', settings.collapsed ? 'パネルをひらく' : 'パネルをたたむ');
  }

  try {
    chrome.storage.local.get('settings', (got) => {
      settings = { ...DEFAULTS, ...(got?.settings || {}) };
      applySettingsToUi();
      if (settings.commentAuto !== false) fillComment(false);
    });
  } catch (e) { /* 初期値のまま */ }
  applySettingsToUi();
  // 設定画面や別のタブで変えた設定を取り込む（古い設定で上書きしないように）
  try {
    chrome.storage.onChanged.addListener((ch, area) => {
      if (area !== 'local' || !ch.settings?.newValue) return;
      settings = { ...DEFAULTS, ...ch.settings.newValue };
      applySettingsToUi();
    });
  } catch (e) { /* 取れなければそのまま */ }

  const toggleOpen = () => { saveSettings({ collapsed: !settings.collapsed }); applySettingsToUi(); schedule(); };
  $('#toggle').onclick = (ev) => { ev.stopPropagation(); toggleOpen(); };
  // たたんでいるときは、パネルのどこを押してもひらく
  $('.wrap').addEventListener('click', () => { if (settings.collapsed) toggleOpen(); });
  $('#pattern').onchange = () => { saveSettings({ pattern: $('#pattern').value }) };
  $('#keep').onchange = () => { saveSettings({ keepFilled: $('#keep').checked }); $('#gkeep').checked = $('#keep').checked; };
  $('#future').onchange = () => { saveSettings({ futureOnly: $('#future').checked }); $('#gfuture').checked = $('#future').checked; };
  $('#futureTx').onchange = () => saveSettings({ futureOnlyTx: $('#futureTx').checked });
  // 「入力済みの日はそのまま」「本日以降」はフリカレと Google で同じ設定を使う
  $('#gkeep').onchange = () => { saveSettings({ keepFilled: $('#gkeep').checked }); $('#keep').checked = $('#gkeep').checked; };
  $('#gfuture').onchange = () => { saveSettings({ futureOnly: $('#gfuture').checked }); $('#future').checked = $('#gfuture').checked; };
  $('#gtent').onchange = () => saveSettings({ gcalTent: $('#gtent').value });
  $('#gfc').onchange = () => saveSettings({ gcalWithFc: $('#gfc').checked });
  // フリカレの欄にURLがあるときだけ「重ねる」を選べる
  function syncGfc() {
    const has = !!($('#fc').value.trim() || settings.freecal);
    $('#gfc').disabled = !has;
    $('#gfc').checked = has && !!settings.gcalWithFc;
    $('#gfclbl').textContent = has ? 'フリカレの予定も重ねる（フリカレの欄のURL）' : 'フリカレの予定も重ねる（フリカレの欄にURLを入れると選べます）';
  }
  $('#fc').addEventListener('input', () => syncGfc());
  $('#gign').onchange = () => saveSettings({ gcalIgnore: $('#gign').value });
  $('#cap').onchange = () => saveSettings({ capByPattern: $('#cap').checked });
  $('#openEnd').onchange = () => saveSettings({ openEnd: $('#openEnd').value });
  $('#cmt').oninput = () => { saveSettings({ comment: $('#cmt').value }) };
  $('#cmtauto').onchange = () => { saveSettings({ commentAuto: $('#cmtauto').checked }) };
  $('#cmtput').onclick = () => {
    if (!$('#cmt').value.trim()) { $('#cmt').focus(); return toast('入れるコメントを書いてください', { error: true }); }
    if (!SITE.commentEl?.()) return toast('このページにはコメント欄が見つかりません', { error: true });
    toast(fillComment(true) ? 'コメント欄に入れました' : 'もう同じコメントが入っています');
  };
  $$('.seg [role=tab]').forEach((b) => {
    b.onclick = () => { if (settings.tab !== b.dataset.tab) { saveSettings({ tab: b.dataset.tab }); setTab(b.dataset.tab); } };
  });
  // 左右キーでタブを移る
  $('.seg').addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
    const cur = Math.max(0, TABS.indexOf(settings.tab));
    const next = TABS[(cur + (ev.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
    saveSettings({ tab: next }); setTab(next);
    $(`#tab-${next}`).focus();
    ev.preventDefault();
  });

  async function busy(btn, fn) {
    if (btn.getAttribute('aria-busy') === 'true') return;
    btn.setAttribute('aria-busy', 'true');
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
  }

  // ------------------------------------------------------------ 元に戻す
  //
  // 取り込み・まとめて入力・置き換えのたびに、直前の表の状態を1つだけ覚えておく。
  let undoSnap = null;
  const snapshot = () => candidates.map((c) => current(c));
  /** 表を書き換える処理を包む。1件でも変わったら、その前の状態に戻せるようにする */
  function withUndo(fn) {
    return async (...args) => {
      const before = snapshot();
      await fn(...args);
      const changed = snapshot().some((v, i) => v !== before[i]);
      if (changed) {
        undoSnap = before;
        $('#undo').disabled = false;
      }
      renderTally();
      return changed;
    };
  }
  function undo() {
    if (!undoSnap) return;
    let n = 0;
    candidates.forEach((c, i) => { if (setValue(c, undoSnap[i])) n++; });
    undoSnap = null;
    $('#undo').disabled = true;
    renderTally();
    toast(`${n}件を元に戻しました`);
  }
  $('#undo').onclick = undo;
  $('#t-undo').onclick = undo;

  /** 結果の知らせ。変わった件数があれば、その場で戻せるボタンを付ける */
  const report = (main, parts, changed) => toast(main, { detail: parts.join('・'), undo: changed > 0 });

  // ------------------------------------------------------------ 記号の入れ分け

  function renderMapping() {
    for (const box of $$('.chips')) {
      const v = mapping[box.dataset.cat];
      for (const b of box.querySelectorAll('.chip')) b.setAttribute('aria-pressed', String(b.dataset.sym === v));
    }
  }
  function saveMapping() {
    try { chrome.storage.local.set({ [MAP_KEY]: mapping, [MAP_DEFAULT_KEY]: mapping }); } catch (e) { /* 保存できなくても動作は続ける */ }
  }
  $$('.chips').forEach((box) => {
    box.onclick = (ev) => {
      const b = ev.target.closest('.chip');
      if (!b) return;
      mapping = { ...mapping, [box.dataset.cat]: b.dataset.sym };
      saveMapping();
      renderMapping();
    };
  });
  $('#mapreset').onclick = () => { mapping = defaultMapping(); saveMapping(); renderMapping(); };
  renderMapping();
  try {
    chrome.storage.local.get([MAP_KEY, MAP_DEFAULT_KEY, ...LEGACY_MAP_KEYS], (got) => {
      const saved = got?.[MAP_KEY] || got?.[MAP_DEFAULT_KEY] || LEGACY_MAP_KEYS.map((k) => got?.[k]).find(Boolean);
      if (saved) { mapping = cleanMapping(saved); renderMapping(); }
    });
  } catch (e) { /* 初期の入れ分けのまま */ }

  // ------------------------------------------------------------ フリカレ

  $('#sync').onclick = () => busy($('#sync'), withUndo(async () => {
    const url = $('#fc').value.trim();
    if (!url) { $('#fc').focus(); return toast('フリカレのURLを入れてください', { error: true }); }
    // 「本日以降の予定を更新」のときは、過ぎた日には触らない（取りに行く月も減らす）
    const future = $('#future').checked;
    const now = new Date();
    const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const allDated = candidates.filter((c) => c.date);
    const past = future ? allDated.filter((c) => c.date < today).length : 0;
    const dated = future ? allDated.filter((c) => c.date >= today) : allDated;
    if (!allDated.length) return toast('日付を読み取れる候補がありません', { error: true });
    if (!dated.length) return toast('本日以降の候補がありません', { detail: '過ぎた日も入れるときは「本日以降の予定を更新」を外してください', error: true });

    const months = [...new Set(dated.map((c) => c.date.slice(0, 7)))];
    const res = await send({ type: 'freecal', url, months });
    if (!res.ok) return toast('取り込めませんでした', { detail: res.message, error: true });
    saveSettings({ freecal: url });

    const isHoliday = isHolidayOf(new Set(res.holidays || []));
    const pattern = $('#pattern').value;
    const cap = $('#cap').checked;
    const keep = SITE.hasBlank && $('#keep').checked;

    // 読み込みの上限（1回3か月まで）で読まなかった月は、触らずにそのままにする
    const skippedMonths = new Set(res.skipped || []);
    let applied = 0, kept = 0, closed = 0, same = 0, noSym = 0, notRead = 0;
    for (const c of dated) {
      if (keep && current(c) !== '0') { kept++; continue; }
      const ym = `${+c.date.slice(0, 4)}-${+c.date.slice(5, 7)}`;
      if (res.closed[ym]) { closed++; continue; }
      if (skippedMonths.has(c.date.slice(0, 7))) { notRead++; continue; }
      let st = A.classifyCell(res.cells[c.date], { mode: 'auto', pattern, isHoliday: isHoliday(c.date) });
      if (cap) st = capByPattern(st, pattern, isHoliday(c.date));
      const key = keyFor(decide(c, st));
      if (!key) { noSym++; continue; }
      if (setValue(c, key)) applied++; else same++;
    }
    const parts = [];
    if (kept) parts.push(`入力済み ${kept}日はそのまま`);
    if (past) parts.push(`過ぎた日 ${past}日はそのまま`);
    if (same) parts.push(`変更なし ${same}日`);
    if (closed) parts.push(`非公開の月 ${closed}日`);
    if (noSym) parts.push(`「入れない」${noSym}日`);
    if (undated) parts.push(`日付を読めない候補 ${undated}件`);
    if (notRead) parts.push(`${[...skippedMonths].map((ym) => +ym.slice(5) + '月').join('・')}の${notRead}日は今回は読んでいません（1分ほどおいてもう一度押すと読みます）`);
    if (res.cached) parts.push('1時間以内に取得した内容');
    report(applied ? `${applied}日に入れました` : '変わった日はありません', parts, applied);
  }));

  // ------------------------------------------------------------ 時刻つきテキスト
  //
  // Googleカレンダー ○×テキスト（GAS）の出力を読む。
  //   昼 13-18時 / 夜 19-24時 ...                     ← 時間帯の区切り
  //   2026/09/17(木) 昼× 夜× ｜×10:00-12:00 △19:30-21:00  ← 「｜」のあとが埋まっている時刻（×予定 △仮）
  //   2026/09/18(金) 昼○ 夜○ ｜なし
  // 「｜」の無い行や古い形式は、これまでどおり昼・夜の記号だけで判定する。

  const DEFAULT_WINDOWS = { day: [13 * 60, 18 * 60], night: [19 * 60, 24 * 60] };

  /** 見出しの「昼 13-18時 / 夜 19-24時」を読む。無ければ null */
  function readWindows(text) {
    const m = String(text).match(/昼\s*(\d{1,2})\s*[-〜~～]\s*(\d{1,2})\s*時?\s*[/／・、]\s*夜\s*(\d{1,2})\s*[-〜~～]\s*(\d{1,2})\s*時/);
    if (!m) return null;
    return { day: [+m[1] * 60, +m[2] * 60], night: [+m[3] * 60, +m[4] * 60] };
  }

  /** 「×10:00-12:00 △19:30-21:00」「×終日」「なし」を分の区間にする */
  function readBusy(part) {
    const out = { busy: [], tent: [] };
    const re = /([×xX✕△▲?？])?\s*(終日|(\d{1,2}):(\d{2})\s*[-〜~～]\s*(\d{1,2}):(\d{2}))/g;
    let m;
    while ((m = re.exec(part))) {
      const range = m[2] === '終日' ? [0, 24 * 60] : [+m[3] * 60 + +m[4], +m[5] * 60 + +m[6]];
      if (range[1] <= range[0]) range[1] = 24 * 60;
      (/[△▲?？]/.test(m[1] || '') ? out.tent : out.busy).push(range);
    }
    return out;
  }

  /** 候補の開始時刻がどちらの時間帯に入るか。どちらでもなければ近いほう */
  function slotByWindows(start, w) {
    const inside = (r) => start >= r[0] && start < r[1];
    if (inside(w.night)) return 'night';
    if (inside(w.day)) return 'day';
    const dist = (r) => Math.min(Math.abs(start - r[0]), Math.abs(start - r[1]));
    return dist(w.night) <= dist(w.day) ? 'night' : 'day';
  }

  /** 時刻つきの候補を、予定の時刻と重なるかで判定する */
  function judgeByTime(c, busy, { windows, openEnd, cap, pattern, holiday }) {
    const w = windows || DEFAULT_WINDOWS;
    const start = c.time.start;
    const slot = slotByWindows(start, w);
    let end = c.time.end;
    if (end === null) end = openEnd === 'slot' ? Math.max(w[slot][1], start + 60) : start + Number(openEnd || 180);
    const hit = (list) => list.some(([s, e]) => s < end && e > start);
    let v = hit(busy.busy) ? false : hit(busy.tent) ? null : true;
    if (cap) {
      const base = A.PATTERNS[pattern] || A.PATTERNS.free;
      const b = slot === 'day' ? (holiday ? base[2] : base[0]) : (holiday ? base[3] : base[1]);
      v = A.worst(v, b);
    }
    return v === true ? 'full' : v === false ? 'ng' : 'maybe';
  }

  // ------------------------------------------------------------ テキスト

  /**
   * 「日付 記号」の行（時刻つきの形式も可）を読んで表に入れる。テキスト取り込みと Googleカレンダー取り込みの共通部分。
   * future … 過ぎた日には入れない / keep … 入力済みの日はそのまま / quiet … 機械が作った行なので行数の内訳は出さない
   */
  async function importText(text, { future = false, keep = false, quiet = false, extra = [] } = {}) {
    const unit = quiet ? '日' : '行';

    const dated = candidates.filter((c) => c.date);
    const dates = [...new Set(dated.map((c) => c.date))];
    const res = await send({ type: 'holidays' });
    const isHoliday = isHolidayOf(new Set(res.ok ? res.list : []));
    const pattern = $('#pattern').value;
    const cap = $('#cap').checked;

    // 時刻つきの形式（Googleカレンダー ○×テキスト）：見出しの時間帯の区切りと、行の「｜」のあとの予定の時刻
    const windows = readWindows(text);
    const openEnd = $('#openEnd').value;

    const cells = A.parseManual(text, { dates, defaultYear: +(dates[0] || '').slice(0, 4) || anchor.getFullYear() });
    // 「本日以降の予定を更新」のときは、過ぎた日の行は読んでも入れない
    const futureTx = !!future;
    const now = new Date();
    const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    let applied = 0, same = 0, outside = 0, noSym = 0, timed = 0, past = 0, kept = 0;
    const hitDates = new Set();
    for (const [d, raw] of Object.entries(cells)) {
      const targets = dated.filter((c) => c.date === d);
      if (!targets.length) { outside++; continue; }
      if (futureTx && d < today) { past++; hitDates.add(d); continue; }
      hitDates.add(d);
      // 「｜」から後ろは予定の時刻。記号の読み取りには混ぜない（「×10:00」の×を拾わないように）
      const bar = raw.search(/[｜|]/);
      const body = bar >= 0 ? raw.slice(0, bar).trim() || '×' : raw;
      const busy = bar >= 0 ? readBusy(raw.slice(bar + 1)) : null;
      const holiday = isHoliday(d);

      let st = A.classifyCell(body, { mode: 'auto', pattern, explicit: true, isHoliday: holiday });
      if (cap) st = capByPattern(st, pattern, holiday);
      for (const c of targets) {
        if (keep && current(c) !== '0') { kept++; continue; }
        let cat;
        if (busy && c.time) {
          cat = judgeByTime(c, busy, { windows, openEnd, cap, pattern, holiday });
          timed++;
        } else {
          cat = decide(windows && c.time ? { ...c, slot: slotByWindows(c.time.start, windows) } : c, st);
        }
        const key = keyFor(cat);
        if (!key) { noSym++; continue; }
        if (setValue(c, key)) applied++; else same++;
      }
    }
    const lines = text.split('\n').filter((l) => l.trim()).length;
    const ignored = Math.max(0, lines - Object.keys(cells).length);
    const parts = [];
    if (kept) parts.push(`入力済み ${kept}件はそのまま`);
    if (past) parts.push(`過ぎた日 ${past}${unit}はそのまま`);
    if (same) parts.push(`変更なし ${same}件`);
    if (outside && !quiet) parts.push(`候補に無い日付 ${outside}行`);
    if (ignored && !quiet) parts.push(`日付の無い行 ${ignored}行`);
    if (noSym) parts.push(`「入れない」${noSym}件`);
    if (timed) parts.push(`予定の時刻で判定 ${timed}件`);
    parts.push(...extra);
    if (!hitDates.size) return toast('候補日に合う行がありませんでした', { detail: parts.join('・'), error: true });
    report(applied ? `${applied}件入れました` : '変わった日はありません', parts, applied);
  }
  $('#tximp').onclick = () => busy($('#tximp'), withUndo(async () => {
    const text = $('#tx').value;
    if (!text.trim()) { $('#tx').focus(); return toast('読み取る文字が入っていません', { error: true }); }
    return importText(text, { future: $('#futureTx').checked });
  }));

  // ------------------------------------------------------------ Googleカレンダー（iCal の非公開アドレス）
  //
  // 予定は拡張機能の裏側（background.js）が Google から直接読み、予定名はそこから外に出さない。
  // ここに届くのは日ごとの「埋まっている時刻」と「仮の時刻」だけ。
  // それを Googleカレンダー ○×テキスト（GAS）と同じ形の文にして、テキスト取り込みに渡す。
  const hm = (min) => `${p2(Math.floor(min / 60))}:${p2(min % 60)}`;
  function gcalText(days, dates, windows) {
    const w = windows || DEFAULT_WINDOWS;
    const lines = [`昼 ${w.day[0] / 60}-${w.day[1] / 60}時 / 夜 ${w.night[0] / 60}-${w.night[1] / 60}時`];
    for (const d of dates) {
      const x = days[d] || { busy: [], tent: [] };
      const hit = (list, [a, b]) => list.some(([s, e]) => s < b && e > a);
      const mark = (win) => (hit(x.busy, win) ? '×' : hit(x.tent, win) ? '△' : '○');
      const rng = (list, sym) => list.map(([s, e]) => (s <= 0 && e >= 1440 ? `${sym}終日` : `${sym}${hm(s)}-${hm(Math.min(e, 1440))}`));
      const times = [...rng(x.busy, '×'), ...rng(x.tent, '△')];
      const wd = WD[new Date(d + 'T00:00:00Z').getUTCDay()];
      lines.push(`${d.replace(/-/g, '/')}(${wd}) 昼${mark(w.day)} 夜${mark(w.night)} ｜${times.length ? times.join(' ') : 'なし'}`);
    }
    return lines.join('\n');
  }
  const words = (s) => String(s || '').split(/[,、，\s]+/).map((x) => x.trim()).filter(Boolean);

  // 読み込むカレンダーの一覧。アドレスは伏せ字で並べ、5つまで足せる
  // （設定の反映から先に呼ばれるので、const ではなく function で書く）
  function gcalList() {
    const list = Array.isArray(settings.gcals) ? settings.gcals : (settings.gcal ? [settings.gcal] : []);
    return list.length ? list : [''];
  }
  /** 画面の欄に今入っているアドレス（保存前の書きかけも含む） */
  function gcalInputs() {
    const els = $$('.gcurl');
    return els.length ? els.map((el) => el.value.trim()) : gcalList();
  }
  function renderGcals() {
    const list = gcalList();
    $('#gclist').innerHTML = list.map((u, i) => `
      <div class="gcrow">
        <span class="gcno" aria-hidden="true">${i + 1}</span>
        <input type="password" class="gcurl" data-i="${i}" value="${esc(u)}" placeholder="iCal形式の非公開アドレス" autocomplete="off" spellcheck="false" aria-label="${i + 1}つめのGoogleカレンダーの非公開アドレス">
        <button type="button" class="ghost icon-btn gcdel" data-i="${i}" aria-label="${i + 1}つめのカレンダーを外す"${list.length === 1 && !u ? ' disabled' : ''}>✕</button>
      </div>`).join('');
    $('#gcadd').disabled = list.length >= 5;
    $$('.gcurl').forEach((el) => {
      el.onchange = () => {
        const next = gcalList().slice();
        next[+el.dataset.i] = el.value.trim();
        saveSettings({ gcals: next, gcal: undefined });
      };
    });
    $$('.gcdel').forEach((b) => {
      b.onclick = () => {
        const next = gcalInputs().filter((_, i) => i !== +b.dataset.i);
        saveSettings({ gcals: next.length ? next : [''], gcal: undefined });
        renderGcals();
      };
    });
  }
  $('#gcadd').onclick = () => {
    const list = gcalInputs();
    if (list.length >= 5) return;
    saveSettings({ gcals: [...list, ''], gcal: undefined });
    renderGcals();
    $$('.gcurl').at(-1)?.focus();
  };

  $('#gsync').onclick = () => busy($('#gsync'), withUndo(async () => {
    // 押す直前に書き換えた欄も拾う（change が来る前に押されることがある）
    const urls = $$('.gcurl').map((el) => el.value.trim());
    saveSettings({ gcals: urls.length ? urls : [''], gcal: undefined });
    const filled = urls.filter(Boolean);
    if (!filled.length) { $('.gcurl')?.focus(); return toast('Googleカレンダーの非公開アドレスを入れてください', { error: true }); }
    const future = $('#gfuture').checked;
    const now = new Date();
    const todayIso = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const dates = [...new Set(candidates.filter((c) => c.date).map((c) => c.date))]
      .filter((d) => !future || d >= todayIso).sort();
    if (!dates.length) return toast(future ? '本日以降の候補がありません' : '日付を読み取れる候補がありません', { error: true });

    const res = await send({
      type: 'gcal', urls: filled, from: dates[0], to: dates[dates.length - 1],
      tentative: words($('#gtent').value), ignore: words($('#gign').value),
    });
    if (!res.ok) return toast('取り込めませんでした', { detail: res.message, error: true });
    const extra = [];
    if (filled.length > 1) extra.push(`${res.read}つのカレンダーを重ねて判定`);

    // フリカレも重ねる：フリカレの記号（昼×・夜△など）を、その時間帯ぶんの「埋まっている／仮」の時刻に直して足す。
    // ふだんの都合はこのあとの判定で一度だけ効かせるので、ここでは書いてある記号だけを見る（pattern: free）
    const days = res.days || {};
    const fcUrl = ($('#fc').value.trim() || settings.freecal || '').trim();
    if ($('#gfc').checked && fcUrl) {
      const months = [...new Set(dates.map((d) => d.slice(0, 7)))];
      const fr = await send({ type: 'freecal', url: fcUrl, months });
      if (!fr.ok) {
        extra.push(`フリカレは重ねられませんでした（${fr.message}）`);
      } else {
        const w = DEFAULT_WINDOWS;
        const notRead = new Set(fr.skipped || []);
        let used = 0;
        for (const d of dates) {
          const ym = `${+d.slice(0, 4)}-${+d.slice(5, 7)}`;
          if (fr.closed?.[ym] || notRead.has(d.slice(0, 7))) continue;
          const st = A.classifyCell(fr.cells[d], { mode: 'auto', pattern: 'free', isHoliday: false });
          const x = (days[d] ||= { busy: [], tent: [] });
          for (const [slot, win] of [['day', w.day], ['night', w.night]]) {
            if (st[slot] === false) x.busy.push([...win]);
            else if (st[slot] === null) x.tent.push([...win]);
            else continue;
            used++;
          }
        }
        extra.push(`フリカレも重ねて判定${used ? `（${used}か所）` : ''}`);
        if (notRead.size) extra.push(`フリカレの${[...notRead].map((ym) => +ym.slice(5) + '月').join('・')}は今回は読んでいません`);
      }
    }
    for (const f of res.failed || []) extra.push(`${f.no}つめは読めませんでした（${f.message}）`);
    if (res.cached) extra.push('10分以内に読んだ内容');
    return importText(gcalText(days, dates), { future, keep: SITE.hasBlank && $('#gkeep').checked, quiet: true, extra });
  }));

  // ------------------------------------------------------------ まとめて入力

  const selectedWeekdays = () => new Set($$('.day[data-wd]').filter((x) => x.getAttribute('aria-pressed') === 'true').map((x) => +x.dataset.wd));
  const PRESET = { weekday: [1, 2, 3, 4, 5], weekend: [0, 6] };
  function syncPresets() {
    const sel = selectedWeekdays();
    for (const b of $$('.day[data-preset]')) {
      const want = PRESET[b.dataset.preset];
      b.setAttribute('aria-pressed', String(sel.size === want.length && want.every((d) => sel.has(d))));
    }
  }
  $$('.day[data-wd]').forEach((b) => {
    b.onclick = () => { b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')); syncPresets(); };
  });
  $$('.day[data-preset]').forEach((b) => {
    b.onclick = () => {
      const on = b.getAttribute('aria-pressed') !== 'true';
      const want = new Set(PRESET[b.dataset.preset]);
      for (const d of $$('.day[data-wd]')) d.setAttribute('aria-pressed', String(on && want.has(+d.dataset.wd)));
      syncPresets();
    };
  });

  $$('button[data-key]').forEach((b) => {
    b.onclick = withUndo(() => {
      const key = b.dataset.key;
      const wds = selectedWeekdays();
      const onlyEmpty = SITE.hasBlank && $('#onlyEmpty').checked && key !== '0';
      let applied = 0, skippedWd = 0, filled = 0;
      for (const c of candidates) {
        if (wds.size && !wds.has(c.wd)) { if (c.wd === null) skippedWd++; continue; }
        if (onlyEmpty && current(c) !== '0') { filled++; continue; }
        if (setValue(c, key)) applied++;
      }
      const parts = [];
      if (onlyEmpty && filled) parts.push(`入力済み ${filled}件はそのまま`);
      if (skippedWd) parts.push(`曜日を読めない候補 ${skippedWd}件は対象外`);
      const label = key === '0' ? `${applied}件を空欄に戻しました` : `${applied}件に${b.textContent.trim()}を入れました`;
      report(applied ? label : '変わった日はありません', parts, applied);
    });
  });

  // ------------------------------------------------------------ 記号の置き換え

  // 置き換えの初期値：先頭の記号を2番目の記号に（◎→○、全→昼 など）
  {
    const nonNg = SYMBOL_LIST.filter((s) => s.kind !== 'ng').map((s) => s.text);
    if (nonNg[0]) $('#rfrom').value = nonNg[0];
    $('#rto').value = nonNg[1] || '';
    // 選んでいる記号の色を、選ぶ欄そのものに付ける
    for (const sel of [$('#rfrom'), $('#rto')]) {
      const paint = () => { sel.dataset.kind = sel.value ? symClass(sel.value) : 'blank'; };
      sel.addEventListener('change', paint);
      paint();
    }
  }
  $('#replace').onclick = withUndo(() => {
    const fromSym = $('#rfrom').value;
    const toSym = $('#rto').value;
    const from = symbols[fromSym];
    const to = toSym ? symbols[toSym] : '0';
    if (from === to) return toast('同じ記号どうしです', { error: true });
    const wds = selectedWeekdays();
    let n = 0;
    for (const c of candidates) {
      if (wds.size && !wds.has(c.wd)) continue;
      if (current(c) === from && setValue(c, to)) n++;
    }
    if (!n) return toast(`${fromSym} の日はありませんでした`, { detail: wds.size ? '選んだ曜日の中で探しました' : '' });
    report(`${fromSym} を ${toSym || '空欄'} に${n}件置き換えました`, [], n);
  });

  // ------------------------------------------------------------ 長押しで全部消す
  //
  // 取り消しがあるので確認ダイアログは出さない。うっかり押しを防ぐため長押しにしている。
  const HOLD_MS = 1200;
  const wipeAll = withUndo(() => {
    let n = 0;
    for (const c of candidates) if (setValue(c, '0')) n++;
    const to = SITE.hasBlank ? '空欄' : (T.ng || '×');
    report(n ? `${n}件を${to}にしました` : `もともと全部${to}です`, [], n);
  });
  let holdTimer = 0, fired = false;
  const wipeBtn = $('#wipe');
  const startHold = () => {
    clearTimeout(holdTimer);
    fired = false;
    wipeBtn.classList.add('holding');
    holdTimer = setTimeout(() => { fired = true; wipeBtn.classList.remove('holding'); wipeAll(); }, HOLD_MS);
  };
  const endHold = () => { clearTimeout(holdTimer); wipeBtn.classList.remove('holding'); };
  wipeBtn.addEventListener('pointerdown', (ev) => { if (ev.button === 0) { wipeBtn.setPointerCapture(ev.pointerId); startHold(); } });
  wipeBtn.addEventListener('pointerup', endHold);
  wipeBtn.addEventListener('pointercancel', endHold);
  wipeBtn.addEventListener('lostpointercapture', endHold);
  wipeBtn.addEventListener('keydown', (ev) => {
    if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) { ev.preventDefault(); startHold(); }
  });
  wipeBtn.addEventListener('keyup', (ev) => { if (ev.key === ' ' || ev.key === 'Enter') endHold(); });
  wipeBtn.addEventListener('click', (ev) => {
    // 短く押しただけのときは、やり方を知らせる
    if (!fired && ev.detail !== 0) toast(SITE.hasBlank ? '長押しすると全部消えます' : `長押しすると全部${T.ng || '×'}になります`, { detail: 'あとから「元に戻す」もできます' });
    fired = false;
  });

  return () => {
    for (const fn of cleanups.splice(0)) { try { fn(); } catch (e) { /* 片付けの失敗は無視 */ } }
    try { frame.style.marginBottom = baseMargin; } catch (e) { /* 表がもう無い */ }
    host.remove();
  };
  }

  // ------------------------------------------------------------ 起動
  //
  // ふつうはすぐ作る。入力欄があとから出てくるサイトは、出てきたら作り、
  // 消えたら片付け、作り直されたら（別の人の入力に切り替えたなど）作り直す。
  if (!SITE.watch) {
    mount();
    return;
  }
  let unmount = null;
  let mountedFor = null;
  let pending = 0;
  const check = () => {
    pending = 0;
    const first = SITE.rows()[0]?.ref.input || null;
    if (first === mountedFor) return;
    if (unmount) { unmount(); unmount = null; }
    mountedFor = null;
    if (first) {
      unmount = mount();
      if (unmount) mountedFor = first;
    }
  };
  new MutationObserver(() => { if (!pending) pending = requestAnimationFrame(check); })
    .observe(document.body, { childList: true, subtree: true });
  check();
})();
