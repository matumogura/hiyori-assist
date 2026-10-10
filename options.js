// 設定画面。出欠入力パネルと同じ settings（chrome.storage.local）を読み書きする。
// 他の項目を消さないよう、読み直してから必要なところだけ書き換える。
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX = 5;
let list = [''];

const load = () => new Promise((r) => chrome.storage.local.get('settings', (g) => r(g?.settings || {})));
const inputs = () => [...document.querySelectorAll('.url')].map((el) => el.value.trim());

function render() {
  $('#list').innerHTML = list.map((u, i) => `
    <div class="row">
      <span class="no">${i + 1}</span>
      <input type="password" class="url" value="${esc(u)}" placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autocomplete="off" spellcheck="false" aria-label="${i + 1}つめのアドレス">
      <button type="button" class="ghost del" data-i="${i}" aria-label="${i + 1}つめを外す">✕</button>
    </div>`).join('');
  $('#add').disabled = list.length >= MAX;
  document.querySelectorAll('.del').forEach((b) => {
    b.onclick = () => { list = inputs().filter((_, i) => i !== +b.dataset.i); if (!list.length) list = ['']; render(); };
  });
}

$('#add').onclick = () => { list = inputs(); if (list.length < MAX) list.push(''); render(); document.querySelectorAll('.url')[list.length - 1]?.focus(); };

$('#save').onclick = async () => {
  const urls = inputs();
  const bad = urls.findIndex((u) => u && !/^(https:|webcal:)\/\/calendar\.google\.com\/calendar\/ical\/\S+\.ics$/i.test(u));
  if (bad >= 0) { $('#saved').textContent = `${bad + 1}つめは「iCal形式の非公開アドレス」ではありません`; return; }
  const cur = await load();
  const settings = { ...cur, gcals: urls.length ? urls : [''], gcalTent: $('#tent').value, gcalIgnore: $('#ign').value };
  delete settings.gcal;
  chrome.storage.local.set({ settings }, () => {
    $('#saved').textContent = '保存しました';
    setTimeout(() => { $('#saved').textContent = ''; }, 2500);
  });
};

(async () => {
  const s = await load();
  list = Array.isArray(s.gcals) && s.gcals.length ? s.gcals : (s.gcal ? [s.gcal] : ['']);
  $('#tent').value = s.gcalTent ?? '仮, 未定';
  $('#ign').value = s.gcalIgnore || '';
  render();
})();
