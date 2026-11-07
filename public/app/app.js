(() => {
'use strict';
const TG = window.Telegram && window.Telegram.WebApp;
if (TG) { TG.ready(); TG.expand(); }
const $ = (q, r = document) => r.querySelector(q);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(3)) { if (c == null || c === false) continue; el.append(c instanceof Node ? c : String(c)); }
  return el;
}
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const kr = n => nf2.format(n || 0) + ' kr', kr0 = n => nf0.format(Math.round(n || 0)) + ' kr', tm = n => nf0.format(n || 0) + ' toman';
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], WD = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
const pd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d)); };
const fmtDay = s => { const d = pd(s); return WD[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
const css = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const haptic = t => { try { TG && TG.HapticFeedback && TG.HapticFeedback.notificationOccurred(t); } catch { } };

/* ---------- API ---------- */
const KEY_LS = 'kassabok-api-key';
function authHeader() {
  if (TG && TG.initData) return 'tma ' + TG.initData;
  try { const k = localStorage.getItem(KEY_LS); if (k) return 'Bearer ' + k; } catch { }
  return '';
}
// Yes/no question, using Telegram's native dialog inside Telegram.
const askConfirm = msg => new Promise(res => {
  if (TG && TG.showConfirm && TG.isVersionAtLeast && TG.isVersionAtLeast('6.2')) { try { TG.showConfirm(msg, ok => res(!!ok)); return; } catch { } }
  res(window.confirm(msg));
});
const dupMessage = d => {
  const one = e => `${fmtDay(e.date)} · ${e.item} · ${e.toman ? tm(e.toman) : kr(e.amount)}${e.store ? ' · ' + e.store : ''}`;
  const head = d.kind === 'itemised' ? 'A receipt from that shop that day already adds up to this amount:' : 'This looks like a duplicate of:';
  return `⚠️ ${head}\n${d.matches.slice(0, 3).map(one).join('\n')}${d.matches.length > 3 ? `\n…and ${d.matches.length - 3} more` : ''}\n\nAdd it anyway?`;
};

async function api(path, opts = {}) {
  const r = await fetch('/api' + path, { ...opts, headers: { authorization: authHeader(), 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Request failed'), { status: r.status });
  return j;
}

/* ---------- state ---------- */
const S = { meta: null, sel: null, tab: 'overview', sum: {}, trends: null, settings: null };
let charts = [];
const killCharts = () => { charts.forEach(c => c.destroy()); charts = []; };

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}

async function boot() {
  if (!authHeader()) return askKey();
  try {
    S.meta = await api('/meta');
  } catch (e) {
    $('#tab-overview').replaceChildren(h('div', { class: 'empty' }, e.status === 401 ? 'Open Kassabok from the Telegram bot: tap the Kassabok button next to the message box.' : e.status === 403 ? 'This Kassabok isn’t open to new users.' : 'Couldn’t reach the ledger. Check your connection and reopen.'));
    return;
  }
  S.sel = S.meta.currentPeriod;
  const fc = $('#fcat'); S.meta.categories.forEach(c => fc.append(h('option', { value: c, text: c })));
  bind();
  const hash = location.hash.slice(1);
  setTab(['overview', 'trends', 'tx', 'budgets'].includes(hash) ? hash : 'overview');
}

function askKey() {
  const inp = h('input', { type: 'password', placeholder: 'API key', style: 'height:40px;border:1px solid var(--line);border-radius:10px;padding:0 10px;width:100%' });
  $('#tab-overview').replaceChildren(h('div', { class: 'card' },
    h('h2', { text: 'Open this from Telegram' }),
    h('p', { class: 'sub', text: 'Kassabok signs you in through Telegram. Open it from the bot’s menu button. In a normal browser you can use the API key instead.' }),
    inp, h('div', { style: 'height:8px' }),
    h('button', { class: 'btn primary', onclick: () => { try { localStorage.setItem(KEY_LS, inp.value.trim()); } catch { } location.reload(); } }, 'Use API key')));
  $('#fab').hidden = true;
}

function bind() {
  document.querySelectorAll('.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
  $('#pPrev').addEventListener('click', () => shift(-1));
  $('#pNext').addEventListener('click', () => shift(1));
  $('#fab').addEventListener('click', () => openAdd());
  let deb; $('#fq').addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(renderTx, 250); });
  $('#fcat').addEventListener('change', renderTx); $('#fscope').addEventListener('change', renderTx);
}
function shift(n) {
  const ks = S.meta.periods.map(p => p.period), i = ks.indexOf(S.sel) + n;
  if (i < 0 || i >= ks.length) return;
  S.sel = ks[i]; render();
}
function setTab(t) {
  S.tab = t;
  document.querySelectorAll('.tabs button').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
  document.querySelectorAll('.tab').forEach(s => (s.hidden = s.id !== 'tab-' + t));
  history.replaceState(null, '', '#' + t);
  render();
}
function header() {
  const ks = S.meta.periods.map(p => p.period), p = S.meta.periods.find(x => x.period === S.sel);
  $('#pLabel').textContent = p ? p.label : S.sel;
  $('#pBadge').textContent = S.sel === S.meta.currentPeriod ? 'Current period' : S.sel < S.meta.currentPeriod ? 'Closed' : 'Upcoming';
  $('#pPrev').disabled = ks.indexOf(S.sel) <= 0;
  $('#pNext').disabled = ks.indexOf(S.sel) >= ks.length - 1;
  $('.pnav').style.display = S.tab === 'trends' ? 'none' : '';
}
async function refresh() {
  S.sum = {}; S.trends = null;
  try { S.meta = await api('/meta'); } catch { }
  render();
}
function render() {
  header(); killCharts();
  if (S.tab === 'overview') renderOverview();
  else if (S.tab === 'trends') renderTrends();
  else if (S.tab === 'tx') renderTx();
  else renderBudgets();
}
const whenChart = fn => (window.Chart ? fn() : addEventListener('load', fn, { once: true }));
function chartDefaults() {
  const C = window.Chart; if (!C) return;
  C.defaults.color = css('--muted') || '#737d8e';
  C.defaults.borderColor = css('--line') || 'rgba(0,0,0,.1)';
  C.defaults.font.family = '-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif';
  C.defaults.font.size = 11;
  C.defaults.plugins.legend.display = false;
  C.defaults.maintainAspectRatio = false;
}

/* ---------- OVERVIEW ---------- */
async function getSum(k) { return S.sum[k] || (S.sum[k] = await api('/summary?period=' + k)); }
async function renderOverview() {
  const box = $('#tab-overview'), k = S.sel;
  if (!S.sum[k]) box.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  let s; try { s = await getSum(k); } catch (e) { box.replaceChildren(h('div', { class: 'empty', text: e.message })); return; }
  if (S.tab !== 'overview' || S.sel !== k) return;
  if (!s.count) { box.replaceChildren(h('div', { class: 'empty' }, h('b', { text: 'Nothing recorded for this period yet.' }), h('br'), 'Tap + or message the bot, like “45 Willys bread”.')); return; }
  box.replaceChildren(hero(s), kpis(s), splitCard(s), paceCard(s), dailyCard(s), catCard(s), billsCard(s), calCard(s), storesCard(s));
}
function deltaChip(a, b, label) {
  if (!b) return null;
  const p = Math.round((a / b - 1) * 100);
  return h('span', { class: 'chip ' + (p > 0 ? 'up' : p < 0 ? 'down' : '') }, (p > 0 ? '▲ ' : p < 0 ? '▼ ' : '') + Math.abs(p) + '% ' + label);
}
function hero(s) {
  const cur = s.status === 'current';
  const ref = cur ? s.prev.sameDay : s.prev.total;
  const budget = s.budgetTotal;
  const pct = budget ? Math.min(100, (s.total / budget) * 100) : 0;
  return h('div', { class: 'card hero' },
    h('div', { class: 'muted small', text: cur ? `Spent so far · day ${s.projection.elapsed} of ${s.days}` : 'Spent this period' }),
    h('div', { class: 'big num', text: kr(s.total) }),
    h('div', { class: 'row' },
      deltaChip(s.total, ref, cur ? 'vs same day last period' : 'vs last period'),
      cur ? h('span', { class: 'chip' }, 'Projected ~' + kr0(s.projection.total)) : null,
      s.toman ? h('span', { class: 'chip' }, tm(s.toman)) : null),
    budget ? [h('div', { class: 'meter' }, h('i', { class: s.total > budget ? 'over' : '', style: `width:${pct}%` })),
      h('div', { class: 'small muted', style: 'margin-top:4px', text: s.total <= budget ? `${kr0(budget - s.total)} left of ${kr0(budget)} budget` : `${kr0(s.total - budget)} over the ${kr0(budget)} budget` })] : null);
}
function kpis(s) {
  const k = (l, v, f) => h('div', { class: 'kpi' }, h('div', { class: 'l', text: l }), h('div', { class: 'v num', text: v }), f ? h('div', { class: 'f', text: f }) : null);
  return h('div', { class: 'kpis' },
    k('Everyday / day', kr0(s.projection.perDay), 'groceries, café, household…'),
    k('Entries', String(s.count), s.trips + ' shopping trips'),
    k('Discounts saved', kr0(s.discounts), 'from receipts'),
    s.status === 'current' ? k('Bills still due', kr0(s.projection.unpaid), s.bills.filter(b => b.status !== 'paid').length + ' bills') : k('Last period', kr0(s.prev.total), s.prev.period));
}
const GC = () => ({ fixed: css('--s1'), everyday: css('--s2'), oneoff: css('--s3') });
const GN = { fixed: 'Fixed', everyday: 'Everyday', oneoff: 'One-off' };
function splitCard(s) {
  const c = GC(), tot = Math.max(1, s.groups.fixed + s.groups.everyday + s.groups.oneoff);
  return h('div', { class: 'card' }, h('h2', { text: 'Where it went' }),
    h('div', { class: 'split' }, ['fixed', 'everyday', 'oneoff'].filter(g => s.groups[g] > 0).map(g => h('i', { style: `width:${(s.groups[g] / tot) * 100}%;background:${c[g]}` }))),
    h('div', { class: 'legend' }, ['fixed', 'everyday', 'oneoff'].map(g => h('span', null, h('i', { style: `background:${c[g]}` }), `${GN[g]} ${kr0(s.groups[g])}`))));
}
function paceCard(s) {
  const cv = h('canvas');
  const el = h('div', { class: 'card' }, h('h2', { text: 'Pace' }), h('p', { class: 'sub', text: 'Cumulative spending, this period vs last' }),
    h('div', { class: 'chart tall' }, cv),
    h('div', { class: 'legend', style: 'margin-top:8px' }, h('span', null, h('i', { style: `background:${css('--s1')}` }), 'This period'), h('span', null, h('i', { style: `background:${css('--cmp')}` }), 'Last period'), s.budgetTotal ? h('span', null, h('i', { style: `background:${css('--crit')}` }), 'Budget') : null));
  whenChart(() => {
    chartDefaults();
    const labels = s.daily.map(d => { const x = pd(d.date); return x.getUTCDate() + ' ' + MON[x.getUTCMonth()]; });
    const ds = [
      { label: 'This period', data: s.cumulative, borderColor: css('--s1'), backgroundColor: css('--s1') + '22', fill: true, tension: .25, pointRadius: 0, borderWidth: 2.5 },
      { label: 'Last period', data: s.prevCumulative.slice(0, labels.length), borderColor: css('--cmp'), borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5, tension: .25 },
    ];
    if (s.budgetTotal) ds.push({ label: 'Budget', data: labels.map(() => s.budgetTotal), borderColor: css('--crit'), borderWidth: 1, pointRadius: 0, borderDash: [2, 3] });
    charts.push(new Chart(cv, { type: 'line', data: { labels, datasets: ds }, options: { interaction: { mode: 'index', intersect: false }, scales: { x: { ticks: { maxTicksLimit: 6 }, grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: v => kshort(v) } } }, plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${kr0(c.parsed.y)}` } } } } }));
  });
  return el;
}
const kshort = v => (Math.abs(v) >= 1000 ? (v / 1000).toFixed(Math.abs(v) >= 10000 ? 0 : 1) + 'k' : String(v));
function dailyCard(s) {
  const cv = h('canvas');
  const el = h('div', { class: 'card' }, h('h2', { text: 'Day by day' }), h('p', { class: 'sub', text: 'Everyday spending per day (bills and one-offs left out)' }), h('div', { class: 'chart' }, cv));
  whenChart(() => {
    chartDefaults();
    const labels = s.daily.map(d => pd(d.date).getUTCDate());
    charts.push(new Chart(cv, { type: 'bar', data: { labels, datasets: [
      { label: 'Everyday', data: s.daily.map(d => d.everyday), backgroundColor: s.daily.map(d => d.date === s.today ? css('--s1') : css('--s2')), borderRadius: 3 },
    ] }, options: { scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 10 } }, y: { beginAtZero: true, ticks: { callback: v => kshort(v) } } }, plugins: { tooltip: { callbacks: { title: i => fmtDay(s.daily[i[0].dataIndex].date), label: c => `Everyday: ${kr(c.parsed.y)}`, afterLabel: c => { const d = s.daily[c.dataIndex]; return d.all > d.everyday ? `+ ${kr(d.all - d.everyday)} bills / one-off` : ''; } } } } } }));
  });
  return el;
}
function catCard(s) {
  const rows = s.categories.filter(c => c.sum || c.budget);
  const notYet = s.categories.filter(c => !c.sum && !c.budget && c.prev);
  const max = Math.max(1, ...rows.map(c => Math.max(c.sum, c.prev, c.budget)));
  const c = GC();
  return h('div', { class: 'card' }, h('h2', { text: 'Categories' }), h('p', { class: 'sub', text: 'Grey tick = last period · dark tick = budget' }),
    h('div', { class: 'bars' }, rows.map(r => h('div', { class: 'bar', onclick: () => { $('#fcat').value = r.cat; $('#fscope').value = 'period'; setTab('tx'); } },
      h('span', { class: 'n', text: r.cat }),
      h('div', { class: 'track' }, h('div', { class: 'f', style: `width:${(r.sum / max) * 100}%;background:${c[r.group]}` }), r.prev ? h('div', { class: 'p', style: `left:${(r.prev / max) * 100}%` }) : null, r.budget ? h('div', { class: 'b', style: `left:${(r.budget / max) * 100}%` }) : null),
      h('span', { class: 'v' }, kr0(r.sum), h('small', { text: r.prev ? 'last ' + kr0(r.prev) : r.budget ? 'of ' + kr0(r.budget) : '' }))))),
    notYet.length ? h('p', { class: 'small muted', style: 'margin:12px 0 0', text: 'Nothing yet: ' + notYet.map(c => `${c.cat} (last ${kr0(c.prev)})`).join(', ') }) : null);
}
function billsCard(s) {
  if (!s.bills.length) return null;
  const lab = { paid: 'Paid', due: 'Due', late: 'Late', missed: 'Missed' };
  return h('div', { class: 'card' }, h('h2', { text: 'Recurring bills' }), h('p', { class: 'sub', text: 'Detected from last period’s fixed costs' }),
    h('div', { class: 'list' }, s.bills.map(b => h('div', { class: 'li' },
      h('span', { class: 't', text: b.name }), h('span', { class: 'a' }, b.toman ? tm(b.per) : kr0(b.per), h('div', { class: 'st ' + b.status, text: lab[b.status] })),
      h('span', { class: 'm', text: b.status === 'paid' ? `${b.paidN}/${b.expected} paid` : 'due ' + fmtDay(b.dueDate) })))));
}
function calCard(s) {
  const vals = s.daily.map(d => d.everyday).filter(v => v > 0).sort((a, b) => a - b);
  const qt = [0.2, 0.4, 0.6, 0.8].map(p => vals[Math.floor(p * (vals.length - 1))] || 0);
  const q = v => (v <= 0 ? '' : 'q' + (1 + qt.filter(t => v > t).length));
  const first = pd(s.daily[0].date).getUTCDay(), lead = (first + 6) % 7;
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('div', { class: 'c o' }));
  s.daily.forEach(d => cells.push(h('div', { class: `c ${q(d.everyday)} ${d.date > s.today ? 'f' : ''} ${d.date === s.today ? 'now' : ''}`, title: `${fmtDay(d.date)} · ${kr(d.everyday)} everyday`, onclick: () => toast(`${fmtDay(d.date)}: ${kr(d.all)} (${d.n} entries)`) }, pd(d.date).getUTCDate())));
  return h('div', { class: 'card' }, h('h2', { text: 'Calendar' }), h('p', { class: 'sub', text: 'Darker = more everyday spending. Tap a day.' }),
    h('div', { class: 'cal' }, ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => h('div', { class: 'd', text: d })), cells));
}
function storesCard(s) {
  if (!s.stores.length) return null;
  const max = s.stores[0].sum || 1;
  return h('div', { class: 'card' }, h('h2', { text: 'Stores' }),
    h('div', { class: 'bars' }, s.stores.slice(0, 8).map(st => h('div', { class: 'bar' }, h('span', { class: 'n', text: st.store }), h('div', { class: 'track' }, h('div', { class: 'f', style: `width:${(st.sum / max) * 100}%` })), h('span', { class: 'v' }, kr0(st.sum), h('small', { text: st.visits + ' visits' }))))));
}

/* ---------- TRENDS ---------- */
async function renderTrends() {
  const box = $('#tab-trends');
  if (!S.trends) { box.replaceChildren(h('div', { class: 'loading' }, 'Loading…')); try { S.trends = await api('/trends'); } catch (e) { box.replaceChildren(h('div', { class: 'empty', text: e.message })); return; } }
  if (S.tab !== 'trends') return;
  const T = S.trends;
  if (!T.periods.length) { box.replaceChildren(h('div', { class: 'empty', text: 'No data yet.' })); return; }
  const cv1 = h('canvas'), cv2 = h('canvas'), c = GC();
  box.replaceChildren(
    h('div', { class: 'card' }, h('h2', { text: 'Period totals' }), h('p', { class: 'sub', text: 'Each period runs 25th → 24th' }), h('div', { class: 'chart tall' }, cv1),
      h('div', { class: 'legend', style: 'margin-top:8px' }, ['fixed', 'everyday', 'oneoff'].map(g => h('span', null, h('i', { style: `background:${c[g]}` }), GN[g])))),
    h('div', { class: 'card' }, h('h2', { text: 'Everyday spending by weekday' }), h('p', { class: 'sub', text: 'Average per day, all periods' }), h('div', { class: 'chart' }, cv2)),
    h('div', { class: 'card' }, h('h2', { text: 'Top everyday items' }), h('p', { class: 'sub', text: 'What the money goes on, all periods' }),
      h('table', { class: 't' }, h('tr', null, h('th', { text: 'Item' }), h('th', { class: 'r', text: 'Times' }), h('th', { class: 'r', text: 'Total' })),
        T.topItems.map(i => h('tr', null, h('td', { text: i.item }), h('td', { class: 'r', text: String(i.n) }), h('td', { class: 'r', text: kr0(i.sum) }))))));
  whenChart(() => {
    chartDefaults();
    charts.push(new Chart(cv1, { type: 'bar', data: { labels: T.periods.map(p => p.short + ' ' + p.period.slice(2, 4)), datasets: ['fixed', 'everyday', 'oneoff'].map(g => ({ label: GN[g], data: T.periods.map(p => p[g]), backgroundColor: c[g], borderRadius: 4, stack: 'a' })) },
      options: { scales: { x: { stacked: true, grid: { display: false } }, y: { stacked: true, ticks: { callback: v => kshort(v) } } }, plugins: { tooltip: { mode: 'index', callbacks: { label: x => `${x.dataset.label}: ${kr0(x.parsed.y)}`, footer: i => 'Total: ' + kr0(T.periods[i[0].dataIndex].total) } } } } }));
    charts.push(new Chart(cv2, { type: 'bar', data: { labels: T.weekday.map(w => w.day), datasets: [{ data: T.weekday.map(w => w.avg), backgroundColor: css('--s2'), borderRadius: 4 }] },
      options: { scales: { x: { grid: { display: false } }, y: { beginAtZero: true } }, plugins: { tooltip: { callbacks: { label: x => kr0(x.parsed.y) + ' / day' } } } } }));
  });
}

/* ---------- TRANSACTIONS ---------- */
let txSeq = 0;
async function renderTx() {
  const my = ++txSeq, list = $('#txList');
  const p = new URLSearchParams({ limit: '500' });
  if ($('#fscope').value === 'period') p.set('period', S.sel);
  if ($('#fq').value.trim()) p.set('q', $('#fq').value.trim());
  if ($('#fcat').value) p.set('cat', $('#fcat').value);
  let r; try { r = await api('/transactions?' + p); } catch (e) { list.replaceChildren(h('div', { class: 'empty', text: e.message })); return; }
  if (my !== txSeq) return;
  $('#txSum').textContent = `${r.total} entries · ${kr(r.sum)}` + (r.total > r.items.length ? ` (showing ${r.items.length})` : '');
  if (!r.items.length) { list.replaceChildren(h('div', { class: 'empty', text: 'No matching entries.' })); return; }
  const days = new Map();
  for (const t of r.items) { if (!days.has(t.date)) days.set(t.date, []); days.get(t.date).push(t); }
  list.replaceChildren(...[...days].map(([d, ts]) => h('div', { class: 'day' },
    h('h3', null, h('span', { text: fmtDay(d) }), h('span', { class: 'num', text: kr(ts.reduce((s, t) => s + t.amount, 0)) })),
    h('div', { class: 'card' }, h('div', { class: 'list' }, ts.map(t => h('div', { class: 'li txi', onclick: () => openAdd(t) },
      h('span', { class: 't', text: t.item }),
      h('span', { class: 'a' + (t.amount < 0 ? ' neg' : ''), text: t.toman ? tm(t.toman) : kr(t.amount) }),
      h('span', { class: 'm', text: [t.store, t.cat, t.qty].filter(Boolean).join(' · ') }))))))));
}

/* ---------- ADD / EDIT SHEET ---------- */
function closeSheet() { $('#sheet').hidden = true; $('#sheet').replaceChildren(); if (TG && TG.BackButton) { TG.BackButton.offClick(closeSheet); TG.BackButton.hide(); } }
function openAdd(t) {
  const wrap = $('#sheet'); wrap.hidden = false;
  if (TG && TG.BackButton) { TG.BackButton.show(); TG.BackButton.onClick(closeSheet); }
  const edit = !!t; t = t || { date: S.meta.today, cat: 'Groceries', item: '', store: '', amount: '' };
  const f = {};
  const field = (label, el) => h('div', { class: 'fg' }, h('label', { text: label }), el);
  f.quick = h('input', { placeholder: '45 Willys bread yesterday', autocomplete: 'off' });
  const prev = h('div', { class: 'preview' });
  f.amount = h('input', { type: 'text', inputmode: 'decimal', value: t.amount === '' ? '' : String(t.amount), class: 'num' });
  f.toman = h('input', { type: 'text', inputmode: 'numeric', value: t.toman ? String(t.toman) : '' });
  f.item = h('input', { value: t.item });
  f.store = h('input', { value: t.store || '', list: 'storesDL' });
  f.date = h('input', { type: 'date', value: t.date });
  f.cat = h('select', null, S.meta.categories.map(c => h('option', { value: c, text: c, selected: c === t.cat })));
  f.note = h('input', { value: t.note || '' });
  const errEl = h('div', { class: 'err' });
  const dl = h('datalist', { id: 'storesDL' }, (S.meta.stores || []).map(s => h('option', { value: s })));
  let deb;
  f.quick.addEventListener('input', () => { clearTimeout(deb); deb = setTimeout(async () => {
    const v = f.quick.value.trim(); if (!v) { prev.replaceChildren(); return; }
    try {
      const { parsed: q } = await api('/quick', { method: 'POST', body: JSON.stringify({ text: v, dryRun: true }) });
      prev.replaceChildren(...[q.toman ? tm(q.toman) : q.amount != null ? kr(q.amount) : 'amount?', q.store || 'no store', q.cat, fmtDay(q.date), q.item || 'item?'].map(x => h('span', { class: 'chip', text: x })));
      f.amount.value = q.amount || ''; f.toman.value = q.toman || ''; f.item.value = q.item; f.store.value = q.store; f.date.value = q.date; f.cat.value = q.cat;
    } catch { }
  }, 250); });
  async function save() {
    errEl.textContent = '';
    const body = { date: f.date.value, cat: f.cat.value, item: f.item.value.trim(), store: f.store.value.trim(), amount: f.amount.value, toman: f.toman.value, note: f.note.value.trim() || (edit ? '' : 'Mini App') };
    if (edit) for (const k of ['orig', 'qty', 'oneOff', 'ord']) if (t[k] != null) body[k] = t[k];
    try {
      if (!edit) {
        const { duplicate: d } = await api('/transactions/check', { method: 'POST', body: JSON.stringify(body) });
        if (d && !(await askConfirm(dupMessage(d)))) return;
      }
      await api(edit ? '/transactions/' + t.id : '/transactions', { method: edit ? 'PATCH' : 'POST', body: JSON.stringify(body) });
      haptic('success'); closeSheet(); toast(edit ? 'Saved' : `Added ${body.toman ? tm(+body.toman) : kr(+String(body.amount).replace(',', '.'))} · ${body.item}`); refresh();
    } catch (e) { haptic('error'); errEl.textContent = e.message; }
  }
  let armed = false;
  const del = edit ? h('button', { class: 'btn danger', onclick: async ev => {
    if (!armed) { armed = true; ev.target.textContent = 'Tap again to delete'; return; }
    try { await api('/transactions/' + t.id, { method: 'DELETE' }); haptic('warning'); closeSheet(); toast('Deleted'); refresh(); } catch (e) { errEl.textContent = e.message; }
  } }, 'Delete') : null;
  const sheet = h('div', { class: 'sheet', onclick: e => e.stopPropagation() },
    h('h2', { text: edit ? 'Edit entry' : 'Add expense' }),
    edit ? (t.orig ? h('div', { class: 'small muted', text: 'Receipt: ' + t.orig + (t.qty ? ' · ' + t.qty : '') }) : null) : [field('Quick add', f.quick), prev],
    h('div', { class: 'fg2' }, field('Amount (kr)', f.amount), field('Date', f.date)),
    field('What', f.item),
    h('div', { class: 'fg2' }, field('Store', f.store), field('Category', f.cat)),
    h('div', { class: 'fg2' }, field('Toman (rent)', f.toman), field('Note', f.note)),
    dl, errEl,
    h('div', { class: 'btns' }, del, h('button', { class: 'btn', onclick: closeSheet }, 'Cancel'), h('button', { class: 'btn primary', onclick: save }, edit ? 'Save' : 'Add')));
  wrap.replaceChildren(sheet);
  wrap.onclick = closeSheet;
  if (!edit) setTimeout(() => f.quick.focus(), 50);
}

/* ---------- BUDGETS ---------- */
async function renderBudgets() {
  const box = $('#tab-budgets');
  box.replaceChildren(h('div', { class: 'loading' }, 'Loading…'));
  let st, s;
  try { [st, s] = await Promise.all([api('/settings'), getSum(S.sel)]); } catch (e) { box.replaceChildren(h('div', { class: 'empty', text: e.message })); return; }
  if (S.tab !== 'budgets') return;
  const inc = h('input', { class: 'binp', inputmode: 'decimal', value: st.income || '' });
  const inputs = {};
  const rows = S.meta.categories.map(c => {
    const spent = (s.categories.find(x => x.cat === c) || {}).sum || 0, prev = (s.categories.find(x => x.cat === c) || {}).prev || 0;
    inputs[c] = h('input', { class: 'binp', inputmode: 'decimal', value: st.budgets[c] || '', placeholder: '—' });
    return h('tr', null, h('td', { text: c }), h('td', { class: 'r', text: kr0(spent) }), h('td', { class: 'r muted', text: kr0(prev) }), h('td', { class: 'r' }, inputs[c]));
  });
  const save = async () => {
    const budgets = {}; for (const [c, el] of Object.entries(inputs)) { const v = parseFloat(el.value.replace(/\s/g, '').replace(',', '.')); if (v > 0) budgets[c] = v; }
    try { await api('/settings', { method: 'PUT', body: JSON.stringify({ budgets, income: parseFloat(inc.value.replace(',', '.')) || 0 }) }); haptic('success'); toast('Budgets saved'); S.sum = {}; } catch (e) { toast(e.message); }
  };
  box.replaceChildren(h('div', { class: 'card' },
    h('h2', { text: 'Monthly budgets' }), h('p', { class: 'sub', text: 'Per period (25th → 24th). Leave empty for no budget.' }),
    h('div', { class: 'fg2', style: 'align-items:center;margin-bottom:8px' }, h('label', { text: 'Household income (kr)' }), inc),
    h('table', { class: 't' }, h('tr', null, h('th', { text: 'Category' }), h('th', { class: 'r', text: 'Spent' }), h('th', { class: 'r', text: 'Last' }), h('th', { class: 'r', text: 'Budget' })), rows),
    h('div', { style: 'height:10px' }), h('button', { class: 'btn primary', style: 'width:100%', onclick: save }, 'Save budgets')));
}

boot();
})();
