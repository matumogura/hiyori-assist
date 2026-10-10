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
})();
