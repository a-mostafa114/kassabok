// Kassabok domain logic, ported from the Kassabok artifact.
// Budget periods run from the 25th of one month to the 24th of the next,
// keyed by the month they start in ("2026-10" = 25 Oct – 24 Nov).
// All date math is done on UTC midnights so the Worker's clock zone never matters.

export const CATS = ['Groceries', 'Household', 'Personal care', 'Café', 'Eating out', 'Rent', 'Housing', 'Insurance', 'Phone/Mobile', 'Subscriptions', 'Transport', 'Travel', 'Health', 'Clothing', 'Gifts', 'Other'];
const GROUP = { Rent: 'fixed', Insurance: 'fixed', 'Phone/Mobile': 'fixed', Subscriptions: 'fixed', Transport: 'fixed', Housing: 'oneoff', Travel: 'oneoff' };
export const groupOf = t => (t.oneOff ? 'oneoff' : GROUP[t.cat] || 'everyday');
export const GROUPS = { fixed: 'Fixed costs', everyday: 'Everyday', oneoff: 'One-off' };

/* ---------- formatting ---------- */
const nf2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
export const kr = n => nf2.format(n || 0) + ' kr';
export const kr0 = n => nf0.format(Math.round(n || 0)) + ' kr';
export const tm = n => nf0.format(n || 0) + ' toman';
export const round2 = v => Math.round(v * 100) / 100;
export const num = s => {
  if (typeof s === 'number') return s;
  const v = parseFloat(String(s || '').replace(/\s/g, '').replace(',', '.'));
  return isNaN(v) ? 0 : v;
};

/* ---------- dates ---------- */
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = n => String(n).padStart(2, '0');
const D = (y, m, d) => new Date(Date.UTC(y, m, d));
export const isoOf = d => d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
export const parseISO = s => { const [y, m, d] = String(s).split('-').map(Number); return D(y, (m || 1) - 1, d || 1); };
export const addDays = (d, n) => D(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);
export const isISO = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && isoOf(parseISO(s)) === s;
export const todayISO = (tz = 'Europe/Stockholm') => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

export function periodOf(iso) {
  const d = parseISO(iso);
  if (d.getUTCDate() >= 25) return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1);
  const p = D(d.getUTCFullYear(), d.getUTCMonth() - 1, 1);
  return p.getUTCFullYear() + '-' + pad(p.getUTCMonth() + 1);
}
export const isPeriod = k => /^\d{4}-(0[1-9]|1[0-2])$/.test(k);
export const pStart = k => { const [y, m] = k.split('-').map(Number); return D(y, m - 1, 25); };
export const pEnd = k => { const [y, m] = k.split('-').map(Number); return D(y, m, 24); };
export const pDays = k => Math.round((pEnd(k) - pStart(k)) / 864e5) + 1;
export const pShift = (k, n) => { const [y, m] = k.split('-').map(Number); const d = D(y, m - 1 + n, 1); return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1); };
export const dayIdx = (k, iso) => Math.round((parseISO(iso) - pStart(k)) / 864e5);
export const fmtDay = iso => { const d = parseISO(iso); return WD[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };
export function pLabel(k) { const a = pStart(k), b = pEnd(k); return `${a.getUTCDate()} ${MON[a.getUTCMonth()]} – ${b.getUTCDate()} ${MON[b.getUTCMonth()]} ${b.getUTCFullYear()}`; }
export function pShort(k) { const a = pStart(k), b = pEnd(k); return MON[a.getUTCMonth()] + '–' + MON[b.getUTCMonth()]; }
export function elapsed(k, today) { const c = periodOf(today); if (k === c) return dayIdx(k, today) + 1; return k < c ? pDays(k) : 0; }

/* ---------- aggregation ---------- */
function discountOf(t) {
  let v = 0;
  if ((+t.amount || 0) < 0 && /discount|rabatt/i.test((t.item || '') + ' ' + (t.orig || ''))) v += -t.amount;
  const m = /after discount \(-\s*([\d.,]+)\)/i.exec(t.note || '');
  if (m) v += num(m[1]);
  return v;
}

export function agg(k, tx) {
  const days = pDays(k);
  const byDay = Array.from({ length: days }, () => ({ all: 0, every: 0, n: 0 }));
  const byCat = new Map(), byStore = new Map(), g = { fixed: 0, everyday: 0, oneoff: 0 }, trips = new Set();
  let total = 0, toman = 0, disc = 0;
  for (const t of tx) {
    const a = +t.amount || 0; total += a; toman += +t.toman || 0;
    const grp = groupOf(t); g[grp] += a;
    const i = dayIdx(k, t.date);
    if (i >= 0 && i < days) { byDay[i].all += a; byDay[i].n++; if (grp === 'everyday') byDay[i].every += a; }
    byCat.set(t.cat, (byCat.get(t.cat) || 0) + a);
    if (t.store) {
      const st = byStore.get(t.store) || { sum: 0, n: 0, visits: new Set() };
      st.sum += a; st.n++; st.visits.add(t.date); byStore.set(t.store, st); trips.add(t.date + '|' + t.store);
    }
    disc += discountOf(t);
  }
  return { k, tx, days, byDay, byCat, byStore, g, total, toman, disc, trips: trips.size, count: tx.length };
}

// Recurring bills: anything fixed (or paid in toman) last period is expected again this period.
export function bills(k, cur, prev, today) {
  if (!prev.count) return [];
  const pk = prev.k;
  const key = t => (t.toman ? 'toman|' + t.cat : t.cat + '|' + (t.store || t.item));
  const groups = new Map();
  for (const t of prev.tx) {
    if (!(t.toman > 0) && !(groupOf(t) === 'fixed' && t.amount > 0)) continue;
    const kk = key(t);
    const gr = groups.get(kk) || {
      key: kk, cat: t.cat, toman: !!t.toman, n: 0, sum: 0, days: [],
      name: t.toman ? 'Rent paid in toman' : t.cat === 'Rent' ? 'Rent' : ['Subscriptions', 'Insurance'].includes(t.cat) ? String(t.item).replace(/\s*\(.*\)$/, '') : t.store || t.item,
    };
    gr.n++; gr.sum += t.toman ? +t.toman : +t.amount; gr.days.push(dayIdx(pk, t.date)); groups.set(kk, gr);
  }
  const E = elapsed(k, today), cp = periodOf(today), isCur = k === cp, isPast = k < cp;
  const out = [];
  for (const gr of groups.values()) {
    gr.days.sort((a, b) => a - b);
    const paid = cur.tx.filter(t => key(t) === gr.key && (gr.toman ? t.toman > 0 : t.amount > 0));
    const paidN = paid.length, paidSum = paid.reduce((s, t) => s + (gr.toman ? +t.toman : +t.amount), 0);
    const per = gr.sum / gr.n;
    const dueIdx = gr.days[Math.min(paidN, gr.days.length - 1)];
    let status;
    if (paidN >= gr.n) status = 'paid';
    else if (isPast) status = 'missed';
    else if (isCur && E - 1 > dueIdx + 3) status = 'late';
    else status = 'due';
    out.push({
      name: gr.name, cat: gr.cat, toman: gr.toman, expected: gr.n, paidN, paidSum: round2(paidSum), per: round2(per),
      dueDate: isoOf(addDays(pStart(k), Math.min(dueIdx, pDays(k) - 1))), status,
      remaining: status === 'paid' ? 0 : round2(per * (gr.n - paidN)),
    });
  }
  const order = { late: 0, missed: 0, due: 1, paid: 2 };
  return out.sort((a, b) => order[a.status] - order[b.status] || a.dueDate.localeCompare(b.dueDate));
}

export function projection(k, cur, billList, today) {
  const E = elapsed(k, today), Dn = cur.days;
  const perDay = E ? cur.g.everyday / E : 0;
  const unpaid = billList.filter(b => !b.toman && b.status !== 'paid').reduce((s, b) => s + b.remaining, 0);
  return { total: round2(cur.total + perDay * (Dn - E) + unpaid), perDay: round2(perDay), unpaid: round2(unpaid), daysLeft: Dn - E, elapsed: E };
}

const cumsum = arr => { let s = 0; return arr.map(v => round2((s += v))); };

// Everything the Mini App's overview needs for one period, in one payload.
export function summary(k, curTx, prevTx, settings, today) {
  const cur = agg(k, curTx), prev = agg(pShift(k, -1), prevTx);
  const bl = bills(k, cur, prev, today);
  const pr = projection(k, cur, bl, today);
  const budgets = settings.budgets || {};
  const budgetTotal = Object.values(budgets).reduce((s, v) => s + (+v || 0), 0);
  const E = pr.elapsed;
  const cats = [...new Set([...cur.byCat.keys(), ...prev.byCat.keys(), ...Object.keys(budgets)])]
    .map(c => ({ cat: c, group: groupOf({ cat: c }), sum: round2(cur.byCat.get(c) || 0), prev: round2(prev.byCat.get(c) || 0), budget: +budgets[c] || 0 }))
    .filter(c => c.sum || c.prev || c.budget)
    .sort((a, b) => b.sum - a.sum || b.prev - a.prev);
  const stores = [...cur.byStore].map(([s, v]) => ({ store: s, sum: round2(v.sum), items: v.n, visits: v.visits.size }))
    .sort((a, b) => b.sum - a.sum).slice(0, 12);
  const prevCum = cumsum(prev.byDay.map(d => d.all));
  const curCum = cumsum(cur.byDay.map(d => d.all)).slice(0, Math.max(E, 0));
  return {
    period: k, label: pLabel(k), short: pShort(k), start: isoOf(pStart(k)), end: isoOf(pEnd(k)), days: cur.days,
    status: k === periodOf(today) ? 'current' : k < periodOf(today) ? 'closed' : 'upcoming', today,
    total: round2(cur.total), count: cur.count, toman: cur.toman, discounts: round2(cur.disc), trips: cur.trips,
    groups: { fixed: round2(cur.g.fixed), everyday: round2(cur.g.everyday), oneoff: round2(cur.g.oneoff) },
    prev: { period: prev.k, total: round2(prev.total), sameDay: E ? prevCum[Math.min(E, prevCum.length) - 1] || 0 : 0, groups: { fixed: round2(prev.g.fixed), everyday: round2(prev.g.everyday), oneoff: round2(prev.g.oneoff) } },
    projection: pr,
    income: +settings.income || 0, budgetTotal: round2(budgetTotal),
    categories: cats, stores, bills: bl,
    daily: cur.byDay.map((d, i) => ({ date: isoOf(addDays(pStart(k), i)), all: round2(d.all), everyday: round2(d.every), n: d.n })),
    cumulative: curCum, prevCumulative: prevCum,
  };
}

// Per-period totals for the trend chart, plus weekday pattern of everyday spending.
export function trends(allTx, today) {
  const byP = new Map();
  for (const t of allTx) { const p = t.p || periodOf(t.date); if (!byP.has(p)) byP.set(p, []); byP.get(p).push(t); }
  const keys = [...byP.keys()].sort();
  if (!keys.length) return { periods: [], weekday: [], topItems: [] };
  const all = []; for (let k = keys[0]; k <= keys[keys.length - 1]; k = pShift(k, 1)) all.push(k);
  const periods = all.map(k => {
    const a = agg(k, byP.get(k) || []);
    return { period: k, short: pShort(k), total: round2(a.total), fixed: round2(a.g.fixed), everyday: round2(a.g.everyday), oneoff: round2(a.g.oneoff), count: a.count, elapsed: elapsed(k, today), days: a.days };
  });
  const wdSum = Array(7).fill(0), wdDays = Array(7).fill(0), seen = new Set();
  const first = parseISO(isoOf(pStart(keys[0])));
  for (let d = first; isoOf(d) <= today && isoOf(d) <= isoOf(pEnd(keys[keys.length - 1])); d = addDays(d, 1)) { wdDays[d.getUTCDay()]++; seen.add(isoOf(d)); }
  for (const t of allTx) if (groupOf(t) === 'everyday' && seen.has(t.date)) wdSum[parseISO(t.date).getUTCDay()] += +t.amount || 0;
  const weekday = [1, 2, 3, 4, 5, 6, 0].map(i => ({ day: WD[i], avg: wdDays[i] ? round2(wdSum[i] / wdDays[i]) : 0 }));
  const items = new Map();
  for (const t of allTx) {
    if (groupOf(t) !== 'everyday') continue;
    const n = String(t.item || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
    if (!n) continue;
    const it = items.get(n) || { item: t.item, n: 0, sum: 0 }; it.n++; it.sum += +t.amount || 0; items.set(n, it);
  }
  const topItems = [...items.values()].sort((a, b) => b.sum - a.sum).slice(0, 15).map(x => ({ ...x, sum: round2(x.sum) }));
  return { periods, weekday, topItems };
}

/* ---------- quick-add parsing (same rules as the artifact) ---------- */
export function guessCat(text, store, history = []) {
  const s = String(text).toLowerCase();
  if (/plastkass|påse|disk|tvätt|hushållsp|toalettp|reng|städ|sopsäck|mixer|batteri|paper towel|dish|detergent|cleaning|plastic bag|toilet paper/.test(s)) return 'Household';
  if (/schampo|tandkr|tvål|deo|bindor|libresse|rakhyvel|shampoo|toothpaste|soap|apotek|pharmacy/.test(s)) return /apotek|pharmacy/.test(s) ? 'Health' : 'Personal care';
  if (/café|cafe|fika|latte|cappuccino|hot chocolate/.test(s)) return 'Café';
  if (/restaurang|restaurant|pizza|burger|kebab|sushi|lunch|dinner out|takeaway/.test(s)) return 'Eating out';
  if (/\bsl\b|sl-kort|travel card|biljett|bus|tunnelbana|pendeltåg/.test(s)) return 'Transport';
  if (/hallon|telia|tele2|comviq|telenor|mobil|phone/.test(s)) return 'Phone/Mobile';
  if (/prime|netflix|spotify|claude|subscription|youtube|icloud|hbo|disney/.test(s)) return 'Subscriptions';
  if (/hedvig|försäkr|insurance|if skade|folksam/.test(s)) return 'Insurance';
  if (/\brent\b|hyra/.test(s)) return 'Rent';
  if (/flight|flyg|hotel|pegasus|\bsas\b|ryanair|norwegian|airbnb/.test(s)) return 'Travel';
  if (/clothes|kläder|h&m|zara|shoes|skor|jacket/.test(s)) return 'Clothing';
  if (/gift|present|gåva/.test(s)) return 'Gifts';
  if (store) {
    const counts = new Map();
    for (const t of history) if ((t.store || '').toLowerCase() === store.toLowerCase()) counts.set(t.cat, (counts.get(t.cat) || 0) + (t.n || 1));
    const best = [...counts].sort((x, y) => y[1] - x[1])[0];
    if (best) return best[0];
  }
  return 'Groceries';
}

const CHAINS = ['Lidl', 'Willys', 'ICA', 'Hemköp', 'Coop', 'ÖoB', 'SL', 'Hallon', 'Amazon', 'Hedvig', 'Apotek', 'Systembolaget', 'Pressbyrån', '7-Eleven', 'IKEA', 'Clas Ohlson', 'Rusta', 'JYSK', 'Matvärlden', 'City Gross', 'Max', 'Espresso House'];
const monIdx = s => ({ jan: 0, feb: 1, mar: 2, apr: 3, may: 4, maj: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11 })[s.toLowerCase().slice(0, 3)];

// "23.80 Lidl snacks yesterday" -> { date, amount, toman, store, item, cat }
// knownStores: store names already in the ledger; history: [{store, cat, n}] for category guessing.
export function parseQuick(str, today, knownStores = [], history = []) {
  let s = ' ' + String(str).trim() + ' ';
  const now = parseISO(today);
  let date = today, m;
  if ((m = /\s(20\d\d-\d\d-\d\d)(?=\s)/.exec(s))) { date = m[1]; s = s.replace(m[1], ' '); }
  else if ((m = /\s(today|idag)(?=\s)/i.exec(s))) s = s.replace(m[1], ' ');
  else if ((m = /\s(yesterday|igår|igar)(?=\s)/i.exec(s))) { date = isoOf(addDays(now, -1)); s = s.replace(m[1], ' '); }
  else if ((m = /\s(\d{1,2})(?:st|nd|rd|th)?\s*(jan|feb|mar|apr|may|maj|jun|jul|aug|sep|sept|oct|okt|nov|dec)[a-z]*\.?(?=\s)/i.exec(s))) {
    const mi = monIdx(m[2]);
    let d = D(now.getUTCFullYear(), mi, +m[1]);
    if (d > addDays(now, 1)) d = D(now.getUTCFullYear() - 1, mi, +m[1]);
    date = isoOf(d); s = s.replace(m[0], ' ');
  } else if ((m = /\s(mon|tue|wed|thu|fri|sat|sun)[a-z]*(?=\s)/i.exec(s))) {
    const want = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(m[1].toLowerCase());
    let d = now; while (d.getUTCDay() !== want) d = addDays(d, -1);
    date = isoOf(d); s = s.replace(m[0], ' ');
  }
  const isToman = /\btoman\b/i.test(s); s = s.replace(/\btoman\b/gi, ' ');
  let amount = null;
  const toks = [...s.matchAll(/\s(-?\d+(?:[.,]\d{1,2})?)(\s*(?:sek|kr|:-))?(?=\s)/gi)];
  if (toks.length) {
    const pick = toks.find(x => x[2]) || toks.find(x => /[.,]/.test(x[1])) || toks.reduce((b, x) => (num(x[1]) > num(b[1]) ? x : b));
    amount = num(pick[1]);
    s = s.slice(0, pick.index) + ' ' + s.slice(pick.index + pick[0].length);
  }
  s = s.replace(/\b(sek|kr)\b/gi, ' ');
  let store = '';
  const fold = x => x.toLowerCase().replace(/[åäà]/g, 'a').replace(/[öø]/g, 'o').replace(/[éè]/g, 'e');
  const lowS = fold(s);
  const cands = [...new Set([...knownStores, ...CHAINS])].sort((a, b) => b.length - a.length);
  for (const c of cands) {
    const fc = fold(c), i = lowS.indexOf(fc);
    if (i >= 0 && /\s/.test(lowS[i - 1] || ' ') && /\s/.test(lowS[i + fc.length] || ' ')) { store = c; s = s.slice(0, i) + ' ' + s.slice(i + fc.length); break; }
  }
  let item = s.replace(/\s+/g, ' ').trim().replace(/^(at|from|on|for|på)\s+/i, '').replace(/\s+(at|from|on|på)$/i, '');
  item = item ? item.charAt(0).toUpperCase() + item.slice(1) : '';
  const cat = guessCat(item + ' ' + store, store, history);
  if (!item && store) item = cat === 'Groceries' ? 'Groceries (not itemized)' : cat === 'Phone/Mobile' ? `${store} mobile subscription` : cat === 'Transport' && store === 'SL' ? 'SL travel card' : cat === 'Insurance' ? `${store} insurance` : `${store} purchase`;
  return { date, amount: isToman ? 0 : amount, toman: isToman ? amount : 0, store, item, cat };
}

/* ---------- Swedish receipt text parsing ---------- */
const SV = [['sötpotatis', 'Sweet potato'], ['citron pressad', 'Lemon juice'], ['citronjuice', 'Lemon juice'], ['enoki', 'Enoki mushrooms'], ['kycklingmort', 'Chicken mortadella'], ['kycklingfil', 'Chicken fillet'], ['kyckling', 'Chicken'], ['hushållsp', 'Paper towels'], ['toalettp', 'Toilet paper'], ['plastkass', 'Plastic bag'], ['maskindisk', 'Dishwasher detergent'], ['diskmedel', 'Dish soap'], ['tvättmedel', 'Laundry detergent'], ['kakaopulver', 'Cocoa powder'], ['vispgr', 'Whipping cream'], ['grädd', 'Cream'], ['lättmjölk', 'Low-fat milk'], ['mjölk', 'Milk'], ['drickyoghurt', 'Drinking yoghurt'], ['yoghurt', 'Yoghurt'], ['färskost', 'Cream cheese'], ['ägg', 'Eggs'], ['lax', 'Salmon'], ['smör', 'Butter'], ['riven ost', 'Grated cheese'], ['ost', 'Cheese'], ['orientbröd', 'Flatbread'], ['bröd', 'Bread'], ['kanelbulle', 'Cinnamon bun'], ['kanel', 'Cinnamon'], ['banan', 'Bananas'], ['äpple cider', 'Apple cider-style drink'], ['äpple', 'Apples'], ['potatis', 'Potatoes'], ['vitlök', 'Garlic'], ['lök', 'Onion'], ['morot', 'Carrots'], ['morötter', 'Carrots'], ['vitkål', 'White cabbage'], ['kål', 'Cabbage'], ['spenat', 'Spinach'], ['champinjon', 'Mushrooms'], ['svamp', 'Mushrooms'], ['tomat', 'Tomatoes'], ['gurka', 'Cucumber'], ['paprika', 'Bell pepper'], ['citron', 'Lemon'], ['lime', 'Lime'], ['druvor', 'Grapes'], ['mandarin', 'Tangerines'], ['nektarin', 'Nectarines'], ['glassbåt', 'Ice cream wafers'], ['glass', 'Ice cream'], ['chips', 'Crisps'], ['choklad', 'Chocolate'], ['jubileumskaka', 'Jubileum biscuits'], ['kaka', 'Cake'], ['muffins', 'Muffins'], ['tortilla', 'Tortillas'], ['pumpakärnor', 'Pumpkin seeds'], ['tofu', 'Tofu'], ['nutella', 'Nutella'], ['socker', 'Sugar'], ['mjöl', 'Flour'], ['ris', 'Rice'], ['pasta', 'Pasta'], ['kaffe', 'Coffee'], ['juice', 'Juice'], ['läsk', 'Soda'], ['vatten', 'Water'], ['köttfärs', 'Minced meat'], ['färs', 'Minced meat'], ['kött', 'Meat'], ['fisk', 'Fish'], ['räkor', 'Prawns'], ['mascarpone', 'Mascarpone'], ['hummus', 'Hummus'], ['oliver', 'Olives'], ['schampo', 'Shampoo'], ['tandkräm', 'Toothpaste'], ['tvål', 'Soap'], ['pant', 'Bottle deposit']];
function translateSv(name) {
  const low = ' ' + name.toLowerCase();
  const size = (name.match(/\b\d+(?:[.,]\d+)?\s?(?:g|kg|ml|cl|l|p|st)\b/i) || [''])[0].toLowerCase().replace(',', '.').replace(/(\d)\s?p$/, '$1-pack').replace(/(\d)l$/, '$1L');
  for (const [sw, en] of SV) if (sw.length >= 5 ? low.includes(sw) : new RegExp('[^a-zåäö]' + sw).test(low)) return (en + (size ? ' ' + size : '')).trim();
  return name;
}
const tidy = s => { s = s.replace(/\s+/g, ' ').trim(); return s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s; };
const n2 = n => nf2.format(n || 0);

export function parseReceiptText(txt, knownStores = [], history = []) {
  const lines = txt.replace(/\r/g, '').split('\n'), low = txt.toLowerCase();
  const chain = /lidl|969667-6312/.test(low) ? 'Lidl' : /willys|556163-2232/.test(low) ? 'Willys' : /hemk[oö]p/.test(low) ? 'Hemköp' : /\bica\b/.test(low) ? 'ICA' : /\bcoop\b/.test(low) ? 'Coop' : /city gross/.test(low) ? 'City Gross' : /\b[öo]ob\b/.test(low) ? 'ÖoB' : '';
  const first = ((lines.find(l => l.trim()) || '').trim().split(',')[0] || '').trim();
  let store = chain;
  if (chain && first && !first.toLowerCase().includes(chain.toLowerCase()) && first.length < 30) {
    const br = first.replace(/^sthlm\s+/i, '').replace(/\.$/, '').replace(/\s+C$/, '').trim();
    const hit = knownStores.find(s => s.startsWith(chain + ' (') && s.slice(chain.length + 2).toLowerCase().startsWith(br.toLowerCase().slice(0, 5)));
    store = hit || `${chain} (${br})`;
  } else if (!chain) store = first.length < 30 ? tidy(first) : '';
  const dm = /(20\d\d)-(\d\d)-(\d\d)/.exec(txt);
  const pay = /swish/i.test(txt) ? 'Paid via Swish' : /\bkort\b|kontokort|mastercard|visa/i.test(txt) ? 'Paid by card' : '';
  const tmatch = /(?:ATT BETALA|Totalt|TOTAL|Summa)\s+(-?\d+[.,]\d{2})/i.exec(txt);
  const items = []; let stop = false;
  for (const raw of lines) {
    if (stop) break;
    const t = raw.trim(); if (!t) continue;
    if (/^(ATT BETALA|Totalt|TOTAL\b|Summa|Moms|Mottaget|Kort\b|Betalat|Kontant)/i.test(t)) { if (items.length) stop = true; continue; }
    if (/Org(\.nr)?\s*:|Tfn|^SEK$|^[-=]{3,}/i.test(t)) continue;
    let m = /^(?:\d+\s*\*\s*)?Rabatt:?\s*(.*?)\s+(-\d+[.,]\d{2})$/i.exec(t);
    if (m && items.length) { const v = num(m[2]), p = items[items.length - 1]; p.amount = round2(p.amount + v); p.disc = round2((p.disc || 0) - v); continue; }
    m = /^([\d.,]+)\s*kg\s*[x×*]\s*([\d.,]+)\s*(?:SEK|kr)?\s*\/\s*kg$/i.exec(t);
    if (m && items.length) { items[items.length - 1].qty = `${num(m[1]).toFixed(3)} kg × ${num(m[2]).toFixed(2)}/kg`; continue; }
    m = /^(.+?)\s+(\d+)\s*st\s*\*\s*([\d.,]+)\s+(-?\d+[.,]\d{2})(?:\s+[A-Z])?$/i.exec(t);
    if (m) { items.push({ orig: tidy(m[1]), qty: `${m[2]} × ${num(m[3]).toFixed(2)}`, amount: num(m[4]) }); continue; }
    m = /^(\+?)(.+?)\s{2,}(-?\d+[.,]\d{2})(?:\s+[A-Z])?$/.exec(t);
    if (m) {
      const name = m[2].trim();
      if (/^\+?\s*pant/i.test(m[1] + name)) items.push({ orig: tidy(name), item: 'Bottle deposit', amount: num(m[3]), cat: 'Groceries' });
      else items.push({ orig: tidy(name), amount: num(m[3]) });
    }
  }
  for (const it of items) {
    it.item = it.item || translateSv(it.orig);
    it.cat = it.cat || guessCat(it.orig + ' ' + it.item, store, history);
    it.note = [it.disc ? `After discount (-${n2(it.disc)})` : '', pay].filter(Boolean).join(' · ');
    delete it.disc;
  }
  return { store, date: dm ? dm[0] : null, total: tmatch ? num(tmatch[1]) : null, pay, items };
}

/* ---------- duplicate detection ---------- */
// Used everywhere entries are added (typed, receipts, bank screenshots, Mini App) to warn before adding
// something that's probably already in the ledger. `existing` is the ledger's entries around the same dates.
export const shopKey = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').trim().split(/\s+/)[0] || '';
const itemKey = s => String(s || '').toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9åäöéü]+/g, ' ').trim();
const dayGap = (a, b) => Math.abs((parseISO(a) - parseISO(b)) / 864e5);
const same = (a, b) => Math.abs((+a || 0) - (+b || 0)) < 0.005;

// One entry: the same amount within 2 days at the same shop or for the same thing (banks often book a day
// or two late), or that day's entries at the same shop add up to it (one bank line vs an itemised receipt).
export function duplicatesOf(t, existing) {
  const sk = shopKey(t.store), ik = itemKey(t.item);
  const sameMoney = e => (+t.toman ? same(e.toman, t.toman) : !+e.toman && same(e.amount, t.amount));
  const singles = existing.filter(e => sameMoney(e) && dayGap(e.date, t.date) <= 2 && ((sk && shopKey(e.store) === sk) || (ik && itemKey(e.item) === ik)));
  if (singles.length) return { kind: 'same', matches: singles };
  if (sk && !+t.toman && t.amount > 0) {
    const day = existing.filter(e => e.date === t.date && shopKey(e.store) === sk);
    const total = list => list.reduce((s, e) => s + e.amount, 0);
    if (day.length > 1 && same(total(day), t.amount)) return { kind: 'itemised', matches: day };
    // The day may hold several receipts from that shop (or the same one twice): try each, as saved together.
    const groups = new Map();
    for (const e of day) if (e.added) groups.set(e.added, [...(groups.get(e.added) || []), e]);
    for (const g of groups.values()) if (g.length > 1 && same(total(g), t.amount)) return { kind: 'itemised', matches: g };
  }
  return null;
}

// A whole receipt (several items from one shop on one day): at least half of its amounts are already there
// for that shop and day, or there's already one entry for the whole total within 2 days (from a bank screenshot).
export function receiptDuplicates(items, existing) {
  if (items.length < 2) return items.length ? duplicatesOf(items[0], existing) : null;
  const { date, store } = items[0], sk = shopKey(store);
  const day = existing.filter(e => e.date === date && (!sk || shopKey(e.store) === sk));
  const used = new Set();
  for (const it of items) {
    const j = day.findIndex((e, k) => !used.has(k) && same(e.amount, it.amount));
    if (j >= 0) used.add(j);
  }
  if (used.size >= Math.ceil(items.length / 2)) return { kind: 'items', count: used.size, matches: [...used].map(k => day[k]) };
  const total = round2(items.reduce((s, i) => s + i.amount, 0));
  if (sk) {
    const one = existing.filter(e => shopKey(e.store) === sk && same(e.amount, total) && dayGap(e.date, date) <= 2);
    if (one.length) return { kind: 'total', matches: one };
  }
  return null;
}

// The date range to load from the ledger to check these entries.
export function dupWindow(items) {
  const ds = items.map(i => i.date).filter(isISO).sort();
  return ds.length ? { from: isoOf(addDays(parseISO(ds[0]), -2)), to: isoOf(addDays(parseISO(ds[ds.length - 1]), 2)) } : null;
}

/* ---------- validation ---------- */
// Normalises an incoming transaction; returns { ok, tx } or { ok:false, error }.
export function cleanTx(t) {
  if (!t || typeof t !== 'object') return { ok: false, error: 'Body must be a JSON object.' };
  const date = String(t.date || '');
  if (!isISO(date)) return { ok: false, error: 'date must be YYYY-MM-DD.' };
  const item = String(t.item || '').trim().slice(0, 200);
  if (!item) return { ok: false, error: 'item is required.' };
  const cat = CATS.includes(t.cat) ? t.cat : 'Other';
  const amount = round2(num(t.amount));
  const toman = Math.round(num(t.toman));
  if (!isFinite(amount) || Math.abs(amount) > 1e7) return { ok: false, error: 'amount is out of range.' };
  // 0 kr is allowed (fully discounted / free items) as long as an amount was actually given.
  const isNum = v => typeof v === 'number' ? isFinite(v) : /^\s*-?\d[\d\s]*([.,]\d+)?\s*$/.test(String(v ?? ''));
  if (t.amount != null && String(t.amount).trim() !== '' && !isNum(t.amount)) return { ok: false, error: 'amount must be a number.' };
  if (t.toman != null && String(t.toman).trim() !== '' && !isNum(t.toman)) return { ok: false, error: 'toman must be a number.' };
  if (!isNum(t.amount) && !toman) return { ok: false, error: 'amount or toman is required.' };
  const s = v => (v == null ? null : String(v).trim().slice(0, 300) || null);
  return {
    ok: true,
    tx: { date, period: periodOf(date), cat, item, store: String(t.store || '').trim().slice(0, 100), amount, toman: toman || 0, orig: s(t.orig), qty: s(t.qty), note: s(t.note), oneOff: !!t.oneOff, ord: Number.isFinite(+t.ord) && +t.ord > 0 ? Math.floor(+t.ord) : Date.now() },
  };
}
export const newId = () => 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
