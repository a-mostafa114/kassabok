// Telegram bot: quick add by plain text, receipts, summaries, and a button into the Mini App.
import * as C from './core.js';
import * as db from './db.js';
import { toCsv } from './csv.js';
import { readReceipt, toReceipt, toBase64, friendlyError, readerOf, READER_NAME } from './receipt-ai.js';

// TG_API can point at a mock server for local testing.
const TG = env => env.TG_API || 'https://api.telegram.org';
const API = env => `${TG(env)}/bot${env.BOT_TOKEN}`;
async function tg(env, method, body) {
  const r = await fetch(`${API(env)}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) console.error('telegram', method, j.description);
  return j;
}
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
const send = (env, chat, text, extra = {}) => tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...extra });
const edit = (env, chat, msg, text, extra = {}) => tg(env, 'editMessageText', { chat_id: chat, message_id: msg, text, parse_mode: 'HTML', ...extra });
// Replace a "working on it…" message if there is one, otherwise send a new message.
const reply = (env, chat, mid, text, extra = {}) => (mid ? edit(env, chat, mid, text, extra) : send(env, chat, text, extra));
const amt = t => (t.toman ? C.tm(t.toman) : C.kr(t.amount));
const today = env => C.todayISO(env.TZ || 'Europe/Stockholm');
const appBtn = (origin, text = '📊 Open Kassabok', path = '') => ({ text, web_app: { url: `${origin}/app/${path}` } });

const COMMANDS = [
  { command: 'summary', description: 'This period at a glance' },
  { command: 'today', description: "Today's spending" },
  { command: 'last', description: 'Last 10 entries' },
  { command: 'cats', description: 'Spending by category' },
  { command: 'bills', description: 'Recurring bills: paid / due' },
  { command: 'budget', description: 'Budget left this period' },
  { command: 'undo', description: 'Delete your last entry' },
  { command: 'export', description: 'Download this period as CSV' },
  { command: 'app', description: 'Open charts & stats' },
  { command: 'help', description: 'How to add expenses' },
];

export async function setupBot(env, origin) {
  const results = {};
  results.webhook = await tg(env, 'setWebhook', { url: `${origin}/telegram/webhook`, secret_token: env.WEBHOOK_SECRET, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
  results.commands = await tg(env, 'setMyCommands', { commands: COMMANDS });
  results.menu = await tg(env, 'setChatMenuButton', { menu_button: { type: 'web_app', text: 'Kassabok', web_app: { url: `${origin}/app/` } } });
  results.description = await tg(env, 'setMyShortDescription', { short_description: 'Your own expense ledger: type “45 Willys bread” or send a receipt photo.' });
  return Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.ok ? 'ok' : v.description || 'failed']));
}

const HELP = (origin, ledgerId) => `<b>Kassabok</b> — your expense ledger 🧾

<b>Add an expense</b> by just typing it:
• <code>45 Willys bread</code>
• <code>23.80 Lidl snacks yesterday</code>
• <code>129 kr Apotek 3 Nov</code>${ledgerId === 1 ? '\n• <code>12000000 toman rent</code>' : ''}

I guess the store, category and date. Tap a button under my reply to change the category or undo.

<b>Receipts:</b> send a photo of a paper receipt, a screenshot or PDF, or paste the text of a digital receipt (Lidl Plus, Willys, ICA…). I'll itemise it, translate the Swedish names and check the total.

/summary · /today · /last · /cats · /bills · /budget · /undo · /export

Charts and statistics: tap <b>Kassabok</b> next to the message box.
Budget periods run from the 25th to the 24th. To delete your account and everything in it: /deleteaccount`;

const WELCOME = name => `👋 Welcome${name ? ', ' + esc(name) : ''}! I’ve made you your own private ledger. Only you can see what you add here.\n\n`;
const aiLimit = env => Math.max(1, +env.AI_DAILY_LIMIT || 20);

export async function handleUpdate(u, env, origin) {
  if (u.update_id != null && !(await db.firstTime(env.DB, u.update_id))) return;
  if (u.callback_query) return onCallback(u.callback_query, env, origin);
  const msg = u.message;
  if (!msg || !msg.from) return;
  const chat = msg.chat.id, uid = msg.from.id;
  if (msg.chat.type !== 'private') return; // ledgers are personal: ignore group chats
  const acct = await db.account(env, msg.from);
  if (!acct) return send(env, chat, `This Kassabok isn’t open to new users. Your Telegram user id is <code>${uid}</code>.`);
  env = { ...env, L: db.ledger(env.DB, acct.ledgerId) };
  if (acct.isNew) {
    await send(env, chat, WELCOME(msg.from.first_name) + HELP(origin, acct.ledgerId), { reply_markup: { inline_keyboard: [[appBtn(origin)]] } });
    if (/^\/start\b/.test(msg.text || '')) return;
  }
  const media = receiptMedia(msg);
  if (media) return receiptFromMedia(env, chat, uid, media, (msg.caption || '').trim());
  const text = (msg.text || '').trim();
  if (!text) return send(env, chat, 'Send me an expense as text, like <code>45 Willys bread</code>, or a photo of a receipt.');

  const cmd = /^\/(\w+)(?:@\w+)?\s*(.*)$/s.exec(text);
  if (cmd) {
    const [, c, arg] = cmd;
    switch (c.toLowerCase()) {
      case 'start': case 'help': return send(env, chat, HELP(origin, env.L.id), { reply_markup: { inline_keyboard: [[appBtn(origin)]] } });
      case 'deleteaccount': return askDeleteAccount(env, chat, uid);
      case 'app': case 'stats': return send(env, chat, 'Charts, trends and every transaction:', { reply_markup: { inline_keyboard: [[appBtn(origin)]] } });
      case 'summary': case 'period': return send(env, chat, await summaryText(env, arg), { reply_markup: { inline_keyboard: [[appBtn(origin, '📊 See charts')]] } });
      case 'today': return send(env, chat, await todayText(env));
      case 'last': return send(env, chat, await lastText(env, Math.min(+arg || 10, 30)));
      case 'cats': return send(env, chat, await catsText(env));
      case 'bills': return send(env, chat, await billsText(env));
      case 'budget': return send(env, chat, await budgetText(env), { reply_markup: { inline_keyboard: [[appBtn(origin, '✏️ Set budgets', '#budgets')]] } });
      case 'undo': return undo(env, chat, uid);
      case 'export': return exportCsv(env, chat, arg);
      case 'add': return quickAdd(env, chat, uid, arg);
      default: return send(env, chat, 'I don’t know that command. /help lists what I can do.');
    }
  }
  // Multi-line text with several prices looks like a receipt.
  const priced = text.split('\n').filter(l => /-?\d+[.,]\d{2}\s*(?:kr|sek|:-)?\s*[A-Z]?\s*$/i.test(l.trim()));
  if (priced.length >= 2) return receipt(env, chat, uid, text);
  return quickAdd(env, chat, uid, text);
}

async function quickAdd(env, chat, uid, text) {
  const { stores, history } = await db.storeHistory(env.L);
  const p = C.parseQuick(text, today(env), stores, history);
  const r = C.cleanTx({ ...p, note: 'Telegram' });
  if (!r.ok || !p.item) return send(env, chat, 'I need an amount and what it was for, like <code>45 Willys bread</code>.');
  const dup = C.duplicatesOf(r.tx, await nearby(env, [r.tx]));
  if (dup) {
    const pid = await db.putPending(env.L, uid, [r.tx]);
    return send(env, chat, `⚠️ <b>Possible duplicate</b>\nYou’re adding: <b>${amt(r.tx)}</b> · ${esc(r.tx.item)}${r.tx.store ? ' · ' + esc(r.tx.store) : ''} · ${C.fmtDay(r.tx.date)}\n\n${dup.kind === 'itemised' ? 'A receipt from that shop that day already adds up to this:' : 'Already in your ledger:'}\n${dupList(dup.matches)}\n\nAdd it anyway?`, {
      reply_markup: { inline_keyboard: [[{ text: '✅ Add anyway', callback_data: `rcpt:${pid}` }, { text: '✖️ Don’t add', callback_data: `rcpx:${pid}` }]] },
    });
  }
  const [id] = await db.insertTx(env.L, [r.tx], 'bot', String(uid));
  const t = { ...r.tx, id };
  const s = await periodTotals(env, t.period);
  return send(env, chat, addedText(t, s), { reply_markup: txKeyboard(id) });
}

// Ledger entries around the dates of `items`, to check them for duplicates.
async function nearby(env, items) {
  const w = C.dupWindow(items);
  return w ? (await db.searchTx(env.L, { ...w, limit: 1000 })).items : [];
}
const dupLine = e => `• ${C.fmtDay(e.date)} · ${esc(e.item)} · ${e.toman ? C.tm(e.toman) : C.kr(e.amount)}${e.store ? ' · ' + esc(e.store) : ''}`;
const dupList = (matches, max = 4) => matches.slice(0, max).map(dupLine).join('\n') + (matches.length > max ? `\n…and ${matches.length - max} more` : '');

const addedText = (t, s) =>
  `✅ <b>${amt(t)}</b> · ${esc(t.item)}\n${esc(t.store || 'no store')} · ${esc(t.cat)} · ${C.fmtDay(t.date)}` +
  (s ? `\n<i>Period so far: ${C.kr0(s.total)}${s.budget ? ` of ${C.kr0(s.budget)} budget` : ''}</i>` : '');
const txKeyboard = id => ({ inline_keyboard: [[{ text: '🏷 Category', callback_data: `cat:${id}` }, { text: '↩️ Undo', callback_data: `del:${id}` }]] });

async function periodTotals(env, k) {
  const total = await db.periodTotal(env.L, k);
  const st = await db.getSettings(env.L);
  return { total, budget: Object.values(st.budgets || {}).reduce((a, b) => a + (+b || 0), 0) };
}

async function receipt(env, chat, uid, text) {
  const { stores, history } = await db.storeHistory(env.L);
  const r = C.parseReceiptText(text, stores, history);
  if (!r.items.length) {
    // A format the built-in parser doesn't know: let the AI read it.
    if (readerOf(env)) return aiReceipt(env, chat, uid, { text });
    if (!(r.total > 0)) return quickAdd(env, chat, uid, text.split('\n')[0]);
    r.items = [C.notItemizedItem(r.total)]; // only a total: the preview asks for the items
  }
  const date = r.date && C.isISO(r.date) ? r.date : today(env);
  return showReceipt(env, chat, uid, { ...r, date, items: r.items.map(it => ({ ...it, date, store: r.store })) });
}

// Itemised preview with "Add all" / "Cancel". r = { store, date, total, items, currency?, problem?, by? }
async function showReceipt(env, chat, uid, r, mid) {
  if (r.type === 'transactions') return showTransactions(env, chat, uid, r, mid);
  const items = r.items;
  const sum = C.round2(items.reduce((s, i) => s + i.amount, 0));
  const id = await db.putPending(env.L, uid, items);
  const dup = C.receiptDuplicates(items, await nearby(env, items));
  const lines = items.slice(0, 40).map(i => `• ${esc(i.item)} — ${C.kr(i.amount)} <i>${esc(i.cat)}</i>`);
  if (items.length > 40) lines.push(`…and ${items.length - 40} more`);
  const check = r.total != null ? (Math.abs(r.total - sum) < 0.01 ? ` ✓ matches receipt total` : ` ⚠️ receipt says ${C.kr(r.total)}`) : '';
  const notes = [];
  const onlyTotal = C.totalOnly(items);
  if (onlyTotal) {
    const shop = (r.store || '').split(' (')[0].trim();
    notes.push(`⚠️ <b>This receipt only shows the total, not what you bought.</b> Please enter the items too:\n` +
      `• send the itemised receipt (the digital one in the Lidl Plus, Willys or ICA app, or Kivra, lists every line), or a clearer photo of the whole paper receipt, or\n` +
      `• type each item, like <code>149.98 ${/^\S+$/.test(shop) ? esc(shop) + ' ' : ''}chicken fillet 2kg</code>\n` +
      `If you add the items, cancel this so the total isn’t counted twice.`);
  }
  if (dup) {
    const where = `${esc(r.store || 'that shop')} on ${C.fmtDay(r.date)}`;
    notes.push(dup.kind === 'items' ? `⚠️ <b>This receipt may already be in your ledger:</b> ${dup.count} of these ${items.length} amounts from ${where} are already there.`
      : dup.kind === 'total' ? `⚠️ <b>This receipt may already be in your ledger</b> as one payment of ${C.kr(sum)}:\n${dupList(dup.matches)}`
      : `⚠️ <b>Possible duplicate:</b>\n${dupList(dup.matches)}`);
  }
  if (r.currency && r.currency !== 'SEK') notes.push(`⚠️ This receipt is in ${esc(r.currency)}; amounts will be saved as kr.`);
  if (r.problem) notes.push(`<i>${esc(r.problem)}</i>`);
  if (r.by) notes.push(`<i>Read by ${esc(r.by)}. Check the items before adding.</i>`);
  const text = `🧾 <b>${esc(r.store || 'Receipt')}</b> · ${C.fmtDay(r.date)}\n${lines.join('\n')}\n\n<b>${plural(items.length, 'item', 'items')} · ${C.kr(sum)}</b>${check}` + (notes.length ? '\n\n' + notes.join('\n') : '');
  return reply(env, chat, mid, text, {
    reply_markup: { inline_keyboard: [[{ text: dup ? `⚠️ Add anyway (${items.length})` : onlyTotal ? '⚠️ Add total only' : `✅ Add all ${items.length}`, callback_data: `rcpt:${id}` }, { text: '✖️ Cancel', callback_data: `rcpx:${id}` }]] },
  });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
// Preview for a bank/card screenshot: one entry per payment, each with its own date and shop.
async function showTransactions(env, chat, uid, r, mid) {
  const have = await nearby(env, r.items);
  const items = r.items.map(i => ({ ...i, dupOf: C.duplicatesOf(i, have) }));
  const fresh = items.filter(i => !i.dupOf), dups = items.filter(i => i.dupOf);
  const line = i => `• ${C.fmtDay(i.date)} · ${esc(i.store || i.item)} — ${C.kr(i.amount)} <i>${esc(i.cat)}</i>`;
  const id = await db.putPending(env.L, uid, items.map(({ dupOf, ...i }) => ({ ...i, dup: !!dupOf })));
  const parts = [];
  if (fresh.length) parts.push(`🏦 <b>${plural(fresh.length, 'new payment', 'new payments')}</b> · ${C.kr(C.round2(fresh.reduce((s, i) => s + i.amount, 0)))}\n${fresh.slice(0, 40).map(line).join('\n')}${fresh.length > 40 ? `\n…and ${fresh.length - 40} more` : ''}`);
  if (dups.length) parts.push(`⚠️ <b>${dups.length === 1 ? 'Possible duplicate' : `${dups.length} possible duplicates`}</b> (already in your ledger):\n` +
    dups.map(i => `${line(i)}\n   ↳ matches ${i.dupOf.kind === 'itemised' ? `a receipt of ${i.dupOf.matches.length} items` : dupLine(i.dupOf.matches[0]).slice(2)}`).join('\n'));
  if (r.by) parts.push(`<i>Read by ${esc(r.by)}. Check the dates and amounts before adding.</i>`);
  const buttons = [];
  if (fresh.length) buttons.push({ text: `✅ Add ${fresh.length} new`, callback_data: `rcpt:${id}` });
  if (dups.length) buttons.push({ text: fresh.length ? `Add all ${items.length}` : `⚠️ Add anyway (${dups.length})`, callback_data: `rcpa:${id}` });
  buttons.push({ text: '✖️ Cancel', callback_data: `rcpx:${id}` });
  return reply(env, chat, mid, parts.join('\n\n'), { reply_markup: { inline_keyboard: [buttons] } });
}

/* ---------- receipts read by AI (see receipt-ai.js) ---------- */
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE = 5 * 1024 * 1024, MAX_PDF = 20 * 1024 * 1024; // image limit; Telegram's bot download limit

// Photo, image file or PDF -> { fileId, mediaType, size }; another kind of file -> { unsupported: true }; else null.
function receiptMedia(msg) {
  if (msg.photo?.length) { const p = msg.photo[msg.photo.length - 1]; return { fileId: p.file_id, mediaType: 'image/jpeg', size: p.file_size || 0 }; }
  const d = msg.document;
  if (!d) return null;
  const type = (d.mime_type || '').toLowerCase();
  if (IMAGE_TYPES.includes(type) || type === 'application/pdf') return { fileId: d.file_id, mediaType: type, size: d.file_size || 0 };
  return { unsupported: true, type };
}

async function receiptFromMedia(env, chat, uid, m, hint) {
  if (m.unsupported) {
    return send(env, chat, m.type.startsWith('image/')
      ? 'I can’t open that image format. Send it as a normal photo instead (not as a file).'
      : 'I can read receipts sent as a photo, a screenshot, an image file or a PDF.');
  }
  const who = readerOf(env);
  if (!who) return send(env, chat, 'Reading receipt photos isn’t set up on this bot. Paste the receipt text instead.');
  if (m.mediaType === 'application/pdf' && who !== 'claude') return send(env, chat, 'I can’t read PDFs for free. Send a screenshot of the receipt instead.');
  const max = m.mediaType === 'application/pdf' ? MAX_PDF : MAX_IMAGE;
  if (m.size > max) return send(env, chat, `That file is too big (over ${max / 1048576} MB). Send it as a normal photo instead, which Telegram compresses.`);
  return aiReceipt(env, chat, uid, { file: m, hint });
}

// input: { file, hint } for photos/PDFs, or { text } for pasted receipts.
async function aiReceipt(env, chat, uid, input) {
  if (!(await db.takeAiQuota(env.DB, uid, today(env), aiLimit(env)))) {
    return send(env, chat, `You’ve used today’s ${aiLimit(env)} receipt reads. Paste the receipt text instead, or try again tomorrow.`);
  }
  const wait = await send(env, chat, '🧾 Reading the receipt…');
  const mid = wait.result?.message_id;
  tg(env, 'sendChatAction', { chat_id: chat, action: 'typing' });
  try {
    let media = null;
    if (input.file) {
      const f = await tg(env, 'getFile', { file_id: input.file.fileId });
      if (!f.ok) throw new Error('Telegram wouldn’t give me the file.');
      const res = await fetch(`${TG(env)}/file/bot${env.BOT_TOKEN}/${f.result.file_path}`);
      if (!res.ok) throw new Error('Couldn’t download the file from Telegram.');
      const buf = await res.arrayBuffer();
      const max = input.file.mediaType === 'application/pdf' ? MAX_PDF : MAX_IMAGE;
      if (buf.byteLength > max) throw new Error(`The file is over ${max / 1048576} MB.`);
      media = { mediaType: input.file.mediaType, data: toBase64(buf) };
    }
    const t = today(env);
    const { stores } = await db.storeHistory(env.L);
    const by = READER_NAME[readerOf(env)];
    const r = toReceipt(await readReceipt(env, { media, text: input.text, hint: input.hint, today: t }), t, by, stores);
    if (!r.items.length) return reply(env, chat, mid, `🤔 I couldn’t find any items. ${esc(r.problem)}`.trim());
    return showReceipt(env, chat, uid, { ...r, by }, mid);
  } catch (e) {
    console.error('receipt', e && e.stack || e);
    return reply(env, chat, mid, `⚠️ I couldn’t read that receipt. ${esc(friendlyError(e))}`);
  }
}

async function onCallback(cq, env, origin) {
  const uid = cq.from.id, chat = cq.message?.chat.id, mid = cq.message?.message_id, data = cq.data || '';
  const answer = (text, alert) => tg(env, 'answerCallbackQuery', { callback_query_id: cq.id, text, show_alert: !!alert });
  const acct = await db.account(env, cq.from, { create: false });
  if (!acct) return answer('Not allowed.', true);
  env = { ...env, L: db.ledger(env.DB, acct.ledgerId) };
  const [op, id, arg] = data.split(':');

  if (op === 'acctdel') {
    const r = await db.deleteAccount(env.DB, uid);
    await edit(env, chat, mid, r.deleted
      ? `🗑 Your account and its ${r.entries} entries are deleted. Send /start any time to begin a new one.`
      : r.reason === 'shared' ? 'This ledger is shared with other people, so it can’t be deleted from here.' : 'There’s no account to delete.');
    return answer();
  }
  if (op === 'acctkeep') { await edit(env, chat, mid, 'Okay, nothing was deleted.'); return answer(); }

  if (op === 'del') {
    const t = await db.getTx(env.L, id);
    if (!t) return answer('Already removed.');
    await db.deleteTx(env.L, id);
    await edit(env, chat, mid, `🗑 <s>${amt(t)} · ${esc(t.item)}</s> — removed`);
    return answer('Removed');
  }
  if (op === 'cat') {
    const t = await db.getTx(env.L, id);
    if (!t) return answer('That entry no longer exists.');
    const rows = [];
    C.CATS.forEach((c, i) => { if (i % 3 === 0) rows.push([]); rows[rows.length - 1].push({ text: (c === t.cat ? '• ' : '') + c, callback_data: `set:${id}:${i}` }); });
    rows.push([{ text: '← Back', callback_data: `back:${id}` }]);
    await tg(env, 'editMessageReplyMarkup', { chat_id: chat, message_id: mid, reply_markup: { inline_keyboard: rows } });
    return answer();
  }
  if (op === 'set' || op === 'back') {
    let t = await db.getTx(env.L, id);
    if (!t) return answer('That entry no longer exists.');
    if (op === 'set') { const c = C.CATS[+arg]; if (c) { await db.setCat(env.L, id, c); t = { ...t, cat: c }; } }
    await edit(env, chat, mid, addedText(t, await periodTotals(env, t.p)), { reply_markup: txKeyboard(id) });
    return answer(op === 'set' ? `Category: ${t.cat}` : undefined);
  }
  if (op === 'rcpt' || op === 'rcpa' || op === 'rcpx') {
    const items = await db.takePending(env.L, id, uid);
    if (!items) return answer('This was already handled or expired.');
    if (op === 'rcpx') { await edit(env, chat, mid, '✖️ Not added.'); return answer(); }
    const chosen = op === 'rcpa' ? items : items.filter(i => !i.dup);
    const clean = chosen.map(i => C.cleanTx(i)).filter(r => r.ok).map(r => r.tx);
    const ids = await db.insertTx(env.L, clean, 'bot', String(uid));
    if (clean.length === 1) {
      // A single entry (a typed expense added despite the warning): show it like a normal quick add.
      await edit(env, chat, mid, addedText({ ...clean[0], id: ids[0] }, await periodTotals(env, clean[0].period)), { reply_markup: txKeyboard(ids[0]) });
      return answer('Added');
    }
    const sum = clean.reduce((s, t) => s + t.amount, 0);
    const shops = [...new Set(clean.map(t => t.store).filter(Boolean))];
    await edit(env, chat, mid, `✅ Added <b>${plural(clean.length, 'entry', 'entries')}</b>${shops.length === 1 ? ` from ${esc(shops[0])}` : ''} · ${C.kr(sum)}`, { reply_markup: { inline_keyboard: [[appBtn(origin, '📊 See this period')]] } });
    return answer('Added');
  }
  return answer();
}

async function askDeleteAccount(env, chat, uid) {
  if (env.L.id === 1 || (await db.ledgerMembers(env.DB, env.L.id)) > 1) return send(env, chat, 'This ledger is shared with other people, so it can’t be deleted from here.');
  const n = (await db.searchTx(env.L, { limit: 1 })).total;
  return send(env, chat, `Delete your account and all <b>${n} entries</b>, budgets and settings? This can’t be undone. You may want to /export all first.`, {
    reply_markup: { inline_keyboard: [[{ text: '🗑 Yes, delete everything', callback_data: 'acctdel' }, { text: 'Keep it', callback_data: 'acctkeep' }]] },
  });
}

async function undo(env, chat, uid) {
  const [t] = await db.lastTx(env.L, 1, String(uid));
  if (!t) return send(env, chat, 'Nothing to undo — you haven’t added anything from Telegram yet.');
  await db.deleteTx(env.L, t.id);
  return send(env, chat, `🗑 Removed <s>${amt(t)} · ${esc(t.item)}</s> (${C.fmtDay(t.date)})`);
}

async function load(env, k) {
  const [rows, settings] = await Promise.all([db.txByPeriods(env.L, [k, C.pShift(k, -1)]), db.getSettings(env.L)]);
  return C.summary(k, rows.filter(t => t.p === k), rows.filter(t => t.p !== k), settings, today(env));
}
const pct = (a, b) => (b ? Math.round((a / b - 1) * 100) : null);
const delta = (a, b) => { const p = pct(a, b); return p == null ? '' : p > 0 ? ` ▲${p}%` : p < 0 ? ` ▼${-p}%` : ' ='; };

async function summaryText(env, arg) {
  const k = C.isPeriod((arg || '').trim()) ? arg.trim() : C.periodOf(today(env));
  const s = await load(env, k);
  if (!s.count) return `<b>${s.label}</b>\nNothing recorded yet.`;
  const out = [`📒 <b>${s.label}</b>${s.status === 'current' ? ` · day ${s.projection.elapsed}/${s.days}` : ''}`, ''];
  out.push(`<b>Spent: ${C.kr(s.total)}</b>  (${s.count} entries)`);
  if (s.status === 'current' && s.prev.sameDay) out.push(`Same day last period: ${C.kr0(s.prev.sameDay)}${delta(s.total, s.prev.sameDay)}`);
  else if (s.prev.total) out.push(`Last period: ${C.kr0(s.prev.total)}${delta(s.total, s.prev.total)}`);
  out.push('', `Fixed ${C.kr0(s.groups.fixed)} · Everyday ${C.kr0(s.groups.everyday)} · One-off ${C.kr0(s.groups.oneoff)}`);
  if (s.status === 'current') {
    out.push(`Everyday pace: ${C.kr0(s.projection.perDay)}/day`);
    out.push(`<b>Projected: ~${C.kr0(s.projection.total)}</b>${s.projection.unpaid ? ` (incl. ${C.kr0(s.projection.unpaid)} bills still due)` : ''}`);
  }
  if (s.budgetTotal) out.push(`Budget: ${C.kr0(s.budgetTotal)} → ${s.total <= s.budgetTotal ? `${C.kr0(s.budgetTotal - s.total)} left` : `<b>${C.kr0(s.total - s.budgetTotal)} over</b>`}`);
  if (s.toman) out.push(`Paid in toman: ${C.tm(s.toman)}`);
  out.push('', '<b>Top categories</b>');
  for (const c of s.categories.filter(c => c.sum).slice(0, 5)) out.push(`• ${esc(c.cat)}: ${C.kr0(c.sum)}`);
  if (s.stores.length) out.push('', `Top store: ${esc(s.stores[0].store)} (${C.kr0(s.stores[0].sum)}, ${s.stores[0].visits} visits)`);
  if (s.discounts) out.push(`Saved with discounts: ${C.kr(s.discounts)}`);
  return out.join('\n');
}

async function todayText(env) {
  const t = today(env);
  const rows = (await db.searchTx(env.L, { from: t, to: t, sort: 'old', limit: 100 })).items;
  if (!rows.length) return `Nothing recorded for ${C.fmtDay(t)} yet.`;
  const sum = rows.reduce((s, r) => s + r.amount, 0);
  return `<b>${C.fmtDay(t)}</b> — ${C.kr(sum)}\n` + rows.map(r => `• ${esc(r.item)} — ${amt(r)} <i>${esc(r.store)}</i>`).join('\n');
}

async function lastText(env, n) {
  const rows = await db.lastTx(env.L, n);
  if (!rows.length) return 'The ledger is empty.';
  return `<b>Last ${rows.length} entries</b>\n` + rows.map(r => `${C.fmtDay(r.date)} · <b>${amt(r)}</b> · ${esc(r.item)} <i>${esc(r.store)}</i>`).join('\n');
}

async function catsText(env) {
  const s = await load(env, C.periodOf(today(env)));
  const rows = s.categories.filter(c => c.sum);
  if (!rows.length) return 'No spending this period yet.';
  const max = Math.max(...rows.map(c => c.sum), 1);
  const bar = v => '█'.repeat(Math.round((v / max) * 10)) || '▏';
  return `<b>Categories · ${s.short}</b>\n<pre>` + rows.map(c => `${c.cat.padEnd(13).slice(0, 13)} ${bar(c.sum).padEnd(10)} ${C.kr0(c.sum).padStart(9)}${c.budget ? ` /${C.kr0(c.budget)}` : ''}`).map(esc).join('\n') + '</pre>';
}

async function billsText(env) {
  const s = await load(env, C.periodOf(today(env)));
  if (!s.bills.length) return 'No recurring bills found (they’re detected from last period’s fixed costs).';
  const ic = { paid: '✅', due: '🕒', late: '⚠️', missed: '❌' };
  return `<b>Bills · ${s.short}</b>\n` + s.bills.map(b => `${ic[b.status]} ${esc(b.name)} — ${b.toman ? C.tm(b.per) : C.kr0(b.per)}${b.status === 'paid' ? '' : ` · due ${C.fmtDay(b.dueDate)}`}`).join('\n');
}

async function budgetText(env) {
  const s = await load(env, C.periodOf(today(env)));
  const rows = s.categories.filter(c => c.budget);
  if (!rows.length) return 'No budgets set yet. Open Kassabok → Budgets to set them.';
  const left = s.budgetTotal - s.total;
  return `<b>Budget · ${s.short}</b>\n` + rows.map(c => {
    const p = Math.round((c.sum / c.budget) * 100);
    return `${p > 100 ? '🔴' : p > 85 ? '🟡' : '🟢'} ${esc(c.cat)}: ${C.kr0(c.sum)} / ${C.kr0(c.budget)} (${p}%)`;
  }).join('\n') + `\n\n<b>${left >= 0 ? C.kr0(left) + ' left' : C.kr0(-left) + ' over'}</b> of ${C.kr0(s.budgetTotal)}`;
}

async function exportCsv(env, chat, arg) {
  const a = (arg || '').trim();
  const k = a === 'all' ? null : C.isPeriod(a) ? a : C.periodOf(today(env));
  const rows = k ? await db.txByPeriod(env.L, k) : await db.allTx(env.L);
  const fd = new FormData();
  fd.append('chat_id', String(chat));
  fd.append('caption', `${rows.length} transactions · ${k ? C.pLabel(k) : 'all periods'}`);
  fd.append('document', new Blob([toCsv(rows)], { type: 'text/csv' }), `kassabok-${k || 'all'}.csv`);
  await fetch(`${API(env)}/sendDocument`, { method: 'POST', body: fd });
}
