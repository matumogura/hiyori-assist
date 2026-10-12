/**
 * hiyori.js — ヒヨリの参加者ページで、Googleカレンダーから表に入れる
 *
 * ヒヨリのサイトは、iCal のアドレスも予定も一切持たない。
 *  ・アドレスはこの拡張機能の中（chrome.storage.local）にだけある
 *  ・予定は background.js が Google から直接読み、日ごとの「埋まっている／仮」の時刻に直す
 *  ・ここでそれを「全・昼・夜・×」に直し、ページの表のボタンを押す（＝手で押したのと同じ）
 *  ・サイトに届くのは、本人が「保存する」を押したときの表の答えだけ
 *
 * ページ側には「Google」タブとボタン（#gcimp・#gcset・#gckeep・#gcmsg）だけがあり、
 * この拡張機能が入っていることを <html data-hiyori-assist> で知らせると表示が切り替わる。
 */
(() => {
  'use strict';
  if (window.__hiyoriSched) return;
  window.__hiyoriSched = true;
  const A = globalThis.HiyoriAvail;

  // 入っていることをページに知らせる（ページはこの印を見てボタンを出す）
  document.documentElement.dataset.hiyoriAssist = chrome.runtime.getManifest().version;
  document.dispatchEvent(new CustomEvent('hiyori-assist-ready'));

  const p2 = (v) => String(v).padStart(2, '0');
  const DAY = { day: [13 * 60, 18 * 60], night: [19 * 60, 24 * 60] };
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
  const getSettings = () => new Promise((resolve) => {
    try { chrome.storage.local.get('settings', (got) => resolve(got?.settings || {})); } catch (e) { resolve({}); }
  });
  const words = (s) => String(s ?? '').split(/[,、，\s]+/).map((x) => x.trim()).filter(Boolean);
  const say = (text) => { const m = document.getElementById('gcmsg'); if (m) m.textContent = text; };

  /** 時間帯に、埋まっている(false)・仮(null)・空き(true) */
  function slotState(x, win) {
    const hit = (list) => (list || []).some(([s, e]) => s < win[1] && e > win[0]);
    if (hit(x?.busy)) return false;
    if (hit(x?.tent)) return null;
    return true;
  }
  /** ヒヨリ本体の toValue と同じ。どちらかが要確認なら決めない */
  function toValue(st) {
    if (st.day === null || st.night === null) return null;
    if (st.day && st.night) return 'all';
    if (st.day) return 'day';
    if (st.night) return 'night';
    return 'ng';
  }

  async function run(btn) {
    const tb = document.getElementById('tb');
    if (!tb) return say('日程の表が見つかりません');
    const s = await getSettings();
    const urls = (Array.isArray(s.gcals) ? s.gcals : (s.gcal ? [s.gcal] : [])).filter(Boolean);
    if (!urls.length) {
      say('Googleカレンダーのアドレスがまだ登録されていません。「アドレスの設定」から登録してください');
      return;
    }
    const now = new Date();
    const today = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}`;
    const all = [...new Set([...tb.querySelectorAll('button[data-d]')].map((b) => b.dataset.d))].sort();
    const dates = all.filter((d) => d >= today);   // 過ぎた日には入れない
    if (!dates.length) return say('本日以降の候補日がありません');

    btn.disabled = true;
    say('Googleカレンダーを読んでいます');
    try {
      const [res, hol] = await Promise.all([
        send({ type: 'gcal', urls, from: dates[0], to: dates[dates.length - 1], tentative: words(s.gcalTent ?? '仮, 未定'), ignore: words(s.gcalIgnore) }),
        send({ type: 'holidays' }),
      ]);
      if (!res.ok) return say(`取り込めませんでした（${res.message}）`);
      const holidays = new Set(hol.ok ? hol.list : []);
      const pattern = document.getElementById('pt')?.value || s.pattern || 'free';
      const base = (A?.PATTERNS || {})[pattern] || [true, true, true, true];
      const keep = !!document.getElementById('gckeep')?.checked;

      let applied = 0, same = 0, unclear = 0, kept = 0;
      for (const d of dates) {
        const row = [...tb.querySelectorAll(`button[data-d="${d}"]`)];
        const cur = row.find((b) => b.classList.contains('sel') && b.dataset.v);
        if (keep && cur) { kept++; continue; }
        const wd = new Date(d + 'T00:00:00Z').getUTCDay();
        const off = wd === 0 || wd === 6 || holidays.has(d);
        // ふだんの都合（平日の昼は仕事など）と、カレンダーの予定の悪いほう
        const worst = A?.worst || ((a, b) => (a === false || b === false ? false : a === null || b === null ? null : true));
        const st = {
          day: worst(off ? base[2] : base[0], slotState(res.days?.[d], DAY.day)),
          night: worst(off ? base[3] : base[1], slotState(res.days?.[d], DAY.night)),
        };
        const v = toValue(st);
        if (!v) { unclear++; continue; }
        if (cur?.dataset.v === v) { same++; continue; }
        row.find((b) => b.dataset.v === v)?.click();
        applied++;
      }
      const parts = [`${applied}日を入れました`];
      if (same) parts.push(`${same}日は変更なし`);
      if (kept) parts.push(`入力済みの${kept}日はそのまま`);
      if (unclear) parts.push(`仮の予定がある${unclear}日は入れていません`);
      if (dates.length < all.length) parts.push(`過ぎた${all.length - dates.length}日は対象外`);
      if (urls.length > 1) parts.push(`${res.read}つのカレンダーを重ねて判定`);
      for (const f of res.failed || []) parts.push(`${f.no}つめは読めませんでした（${f.message}）`);
      say(parts.join('、') + '。まだ保存していません');
    } finally {
      btn.disabled = false;
    }
  }

  // ページは何度も描き直されるので、押されたボタンを都度見る
  document.addEventListener('click', (ev) => {
    const imp = ev.target.closest?.('#gcimp');
    if (imp) { ev.preventDefault(); run(imp); return; }
    if (ev.target.closest?.('#gcset')) { ev.preventDefault(); send({ type: 'openOptions' }); }
  });

  // ------------------------------------------------------------ 自分の設定の「Googleカレンダー（拡張機能）」欄
  //
  // ページは <div id="hiyori-ext-settings"> という空の置き場だけを用意する。
  // 中身はこの拡張機能が閉じた Shadow DOM で描くので、ページのスクリプトからはアドレスを読めない。
  // 保存先はこの拡張機能の中（chrome.storage.local）だけ。ヒヨリのサーバーには送らない。
  const GMAX = 5;
  const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ICAL_RE = /^(https:|webcal:)\/\/calendar\.google\.com\/calendar\/ical\/\S+\.ics$/i;

  function mountSettings(slot) {
    if (slot.__hiyoriMounted) return;
    slot.__hiyoriMounted = true;
    const sr = slot.attachShadow({ mode: 'closed' });
    sr.innerHTML = `
    <style>
      :host { display: block; }
      * { box-sizing: border-box; }
      .box { display: grid; gap: 10px; margin-top: 10px; font: inherit; color: #1f3a4a; }
      .row { display: flex; align-items: center; gap: 8px; }
      .no { flex: none; width: 20px; height: 20px; border-radius: 50%; background: #e1f0f8; color: #1f5f8c; font-size: 11.5px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
      input { flex: 1; min-width: 0; font: inherit; color: inherit; background: #fff; border: 0; border-radius: 9px; padding: 9px 11px; box-shadow: 0 0 0 1px rgba(31,58,74,.16); }
      input:focus { outline: none; box-shadow: 0 0 0 1px #2b78ad, 0 0 0 4px #e1f0f8; }
      button { font: inherit; cursor: pointer; border: 0; border-radius: 9px; padding: 8px 14px; background: #eaf2f5; color: #1f3a4a; }
      button:hover:not([disabled]) { background: #dcecf1; }
      button[disabled] { opacity: .45; cursor: default; }
      .primary { background: #2b78ad; color: #fff; font-weight: 700; }
      .primary:hover:not([disabled]) { background: #1f5f8c; }
      .ghost { background: transparent; color: #5d7685; padding: 6px 8px; }
      .lbl { font-size: 13px; color: #5d7685; margin-top: 4px; }
      .hint { font-size: 12.5px; color: #5d7685; }
      .note { background: #fff6de; color: #8a6a10; border-radius: 10px; padding: 8px 12px; font-size: 12.5px; }
      .msg { font-size: 13px; color: #1f5f8c; }
      .msg.err { color: #bf3a3f; }
      details summary { cursor: pointer; font-size: 13px; color: #5d7685; }
      ol { margin: 6px 0 0; padding-left: 20px; font-size: 13px; color: #3c5868; }
    </style>
    <div class="box">
      <div class="lbl">iCal形式の非公開アドレス</div>
      <div id="list" style="display:grid;gap:8px"></div>
      <div><button type="button" class="ghost" id="add">＋ カレンダーを増やす</button></div>
      <details>
        <summary>アドレスの調べ方</summary>
        <ol>
          <li>パソコンで Googleカレンダーを開き、右上の歯車 →「設定」</li>
          <li>左の「マイカレンダーの設定」から、読みたいカレンダーを選ぶ</li>
          <li>「カレンダーの統合」の「iCal形式の非公開アドレス」をコピーして、上に貼る</li>
        </ol>
      </details>
      <div class="lbl">△にする語（予定名にこの語があれば△）</div>
      <input type="text" id="tent" placeholder="例：仮, 未定, 調整中">
      <div class="lbl">数えない語（予定名にこの語があれば無いものとする）</div>
      <input type="text" id="ign" placeholder="例：誕生日, リマインド">
      <div class="row"><button type="button" class="primary" id="save">保存</button><span class="msg" id="msg" aria-live="polite"></span></div>
      <div class="note">アドレスは予定を読める鍵です。この拡張機能の中にだけ保存し、Google以外には送りません。ヒヨリのサーバーにも送りません。予定名は△や数えない語の判定にだけ使います。</div>
    </div>`;
    const q = (s) => sr.querySelector(s);
    let list = [''];
    const inputs = () => [...sr.querySelectorAll('.url')].map((el) => el.value.trim());
    const render = () => {
      q('#list').innerHTML = list.map((u, i) => `
        <div class="row">
          <span class="no">${i + 1}</span>
          <input type="password" class="url" value="${escHtml(u)}" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocomplete="off" spellcheck="false" aria-label="${i + 1}つめのアドレス">
          <button type="button" class="ghost del" data-i="${i}" aria-label="${i + 1}つめを外す">✕</button>
        </div>`).join('');
      q('#add').disabled = list.length >= GMAX;
      sr.querySelectorAll('.del').forEach((b) => {
        b.onclick = () => { list = inputs().filter((_, i) => i !== +b.dataset.i); if (!list.length) list = ['']; render(); };
      });
    };
    q('#add').onclick = () => { list = inputs(); if (list.length < GMAX) list.push(''); render(); sr.querySelectorAll('.url')[list.length - 1]?.focus(); };
    const msg = (text, err) => { q('#msg').textContent = text; q('#msg').className = `msg${err ? ' err' : ''}`; };
    q('#save').onclick = async () => {
      const urls = inputs();
      const bad = urls.findIndex((u) => u && !ICAL_RE.test(u));
      if (bad >= 0) return msg(`${bad + 1}つめは「iCal形式の非公開アドレス」ではありません`, true);
      const cur = await getSettings();
      const next = { ...cur, gcals: urls.length ? urls : [''], gcalTent: q('#tent').value, gcalIgnore: q('#ign').value };
      delete next.gcal;
      try {
        chrome.storage.local.set({ settings: next }, () => { msg('保存しました'); setTimeout(() => msg(''), 2500); });
      } catch (e) {
        msg('拡張機能を再読み込みしてからページを開き直してください', true);
      }
    };
    getSettings().then((s) => {
      list = Array.isArray(s.gcals) && s.gcals.length ? s.gcals : (s.gcal ? [s.gcal] : ['']);
      q('#tent').value = s.gcalTent ?? '仮, 未定';
      q('#ign').value = s.gcalIgnore || '';
      render();
    });
  }

  // 画面は描き直されるので、置き場が出るたびに描く
  const findSlot = () => { const el = document.getElementById('hiyori-ext-settings'); if (el) mountSettings(el); };
  new MutationObserver(findSlot).observe(document.documentElement, { childList: true, subtree: true });
  findSlot();
})();
