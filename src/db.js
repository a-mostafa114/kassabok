// D1 data access. Rows are mapped to the same shape the artifact used.
// Every ledger query takes L = ledger(env.DB, ledgerId) and only ever touches that ledger's rows,
// so one account can never read or change another's data.
import { newId } from './core.js';

export const ledger = (db, id) => ({ db, id: +id });

const COLS = 'id, date, period, cat, item, store, amount, toman, orig, qty, note, one_off, ord, source, created_by, created_at, updated_at';
const fromRow = r => {
  const t = { id: r.id, date: r.date, p: r.period, cat: r.cat, item: r.item, store: r.store || '', amount: r.amount, ord: r.ord };
  if (r.toman) t.toman = r.toman;
  if (r.orig) t.orig = r.orig;
  if (r.qty) t.qty = r.qty;
  if (r.note) t.note = r.note;
  if (r.one_off) t.oneOff = true;
  if (r.source) t.source = r.source;
  if (r.created_at) t.added = r.created_at; // entries saved together (one receipt) share this
  return t;
};

export async function txByPeriod(L, period) {
  const { results } = await L.db.prepare(`SELECT ${COLS} FROM tx WHERE ledger_id = ? AND period = ? ORDER BY date DESC, ord DESC`).bind(L.id, period).all();
  return results.map(fromRow);
}
export async function txByPeriods(L, periods) {
  const ph = periods.map(() => '?').join(',');
  const { results } = await L.db.prepare(`SELECT ${COLS} FROM tx WHERE ledger_id = ? AND period IN (${ph}) ORDER BY date DESC, ord DESC`).bind(L.id, ...periods).all();
  return results.map(fromRow);
}
export async function allTx(L) {
  const { results } = await L.db.prepare(`SELECT ${COLS} FROM tx WHERE ledger_id = ? ORDER BY date DESC, ord DESC`).bind(L.id).all();
  return results.map(fromRow);
}
export async function searchTx(L, { period, q, cat, store, from, to, sort = 'new', limit = 200, offset = 0 }) {
  const w = ['ledger_id = ?'], b = [L.id];
  if (period) { w.push('period = ?'); b.push(period); }
  if (from) { w.push('date >= ?'); b.push(from); }
  if (to) { w.push('date <= ?'); b.push(to); }
  if (cat) { w.push('cat = ?'); b.push(cat); }
  if (store) { w.push('store = ?'); b.push(store); }
  if (q) { w.push("(item LIKE ? ESCAPE '\\' OR store LIKE ? ESCAPE '\\' OR note LIKE ? ESCAPE '\\' OR orig LIKE ? ESCAPE '\\')"); const like = '%' + q.replace(/[\\%_]/g, c => '\\' + c) + '%'; b.push(like, like, like, like); }
  const where = 'WHERE ' + w.join(' AND ');
  const order = sort === 'old' ? 'date ASC, ord ASC' : sort === 'big' ? 'amount DESC' : 'date DESC, ord DESC';
  const [rows, agg] = await Promise.all([
    L.db.prepare(`SELECT ${COLS} FROM tx ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...b, limit, offset).all(),
    L.db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS sum FROM tx ${where}`).bind(...b).first(),
  ]);
  return { items: rows.results.map(fromRow), total: agg.n, sum: Math.round(agg.sum * 100) / 100 };
}
export async function getTx(L, id) {
  const r = await L.db.prepare(`SELECT ${COLS} FROM tx WHERE id = ? AND ledger_id = ?`).bind(id, L.id).first();
  return r ? fromRow(r) : null;
}
const insertStmt = (L, id, t, source, by) => L.db.prepare(
  'INSERT INTO tx (id, ledger_id, date, period, cat, item, store, amount, toman, orig, qty, note, one_off, ord, source, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
).bind(id, L.id, t.date, t.period, t.cat, t.item, t.store, t.amount, t.toman, t.orig, t.qty, t.note, t.oneOff ? 1 : 0, t.ord, source, by);

export async function insertTx(L, list, source, by) {
  const ids = list.map(() => newId() + Math.random().toString(36).slice(2, 4));
  await L.db.batch(list.map((t, i) => insertStmt(L, ids[i], t, source, by)));
  return ids;
}
export async function updateTx(L, id, t) {
  const r = await L.db.prepare(
    "UPDATE tx SET date=?, period=?, cat=?, item=?, store=?, amount=?, toman=?, orig=?, qty=?, note=?, one_off=?, ord=?, updated_at=datetime('now') WHERE id=? AND ledger_id=?"
  ).bind(t.date, t.period, t.cat, t.item, t.store, t.amount, t.toman, t.orig, t.qty, t.note, t.oneOff ? 1 : 0, t.ord, id, L.id).run();
  return r.meta.changes > 0;
}
export async function setCat(L, id, cat) {
  const r = await L.db.prepare("UPDATE tx SET cat=?, updated_at=datetime('now') WHERE id=? AND ledger_id=?").bind(cat, id, L.id).run();
  return r.meta.changes > 0;
}
export async function deleteTx(L, id) {
  const r = await L.db.prepare('DELETE FROM tx WHERE id = ? AND ledger_id = ?').bind(id, L.id).run();
  return r.meta.changes > 0;
}
export async function lastTx(L, n, by) {
  const q = by
    ? L.db.prepare(`SELECT ${COLS} FROM tx WHERE ledger_id = ? AND created_by = ? ORDER BY created_at DESC, ord DESC LIMIT ?`).bind(L.id, by, n)
    : L.db.prepare(`SELECT ${COLS} FROM tx WHERE ledger_id = ? ORDER BY date DESC, ord DESC LIMIT ?`).bind(L.id, n);
  return (await q.all()).results.map(fromRow);
}
export async function periods(L) {
  const { results } = await L.db.prepare('SELECT period, COUNT(*) AS n, SUM(amount) AS sum FROM tx WHERE ledger_id = ? GROUP BY period ORDER BY period').bind(L.id).all();
  return results;
}
export async function periodTotal(L, period) {
  const r = await L.db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM tx WHERE ledger_id = ? AND period = ?').bind(L.id, period).first();
  return r.s;
}
// Store names + how often each category was used there (for quick-add parsing).
export async function storeHistory(L) {
  const { results } = await L.db.prepare("SELECT store, cat, COUNT(*) AS n FROM tx WHERE ledger_id = ? AND store <> '' GROUP BY store, cat").bind(L.id).all();
  return { stores: [...new Set(results.map(r => r.store))], history: results };
}
export async function stores(L) {
  const { results } = await L.db.prepare("SELECT store, COUNT(*) AS n, SUM(amount) AS sum FROM tx WHERE ledger_id = ? AND store <> '' GROUP BY store ORDER BY n DESC").bind(L.id).all();
  return results;
}

export async function getSettings(L) {
  const { results } = await L.db.prepare('SELECT k, v FROM settings WHERE ledger_id = ?').bind(L.id).all();
  const o = { budgets: {}, income: 0 };
  for (const r of results) { try { o[r.k] = JSON.parse(r.v); } catch { } }
  return o;
}
export async function putSettings(L, s) {
  const put = (k, v) => L.db.prepare('INSERT INTO settings (ledger_id, k, v) VALUES (?, ?, ?) ON CONFLICT(ledger_id, k) DO UPDATE SET v = excluded.v').bind(L.id, k, v);
  await L.db.batch([put('budgets', JSON.stringify(s.budgets || {})), put('income', JSON.stringify(+s.income || 0))]);
}

export async function putPending(L, userId, payload) {
  const id = 'r' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
  await L.db.batch([
    L.db.prepare('DELETE FROM pending WHERE created_at < ?').bind(Date.now() - 864e5),
    L.db.prepare('INSERT INTO pending (id, ledger_id, user_id, payload, created_at) VALUES (?,?,?,?,?)').bind(id, L.id, String(userId), JSON.stringify(payload), Date.now()),
  ]);
  return id;
}
export async function takePending(L, id, userId) {
  const r = await L.db.prepare('SELECT payload FROM pending WHERE id = ? AND user_id = ? AND ledger_id = ?').bind(id, String(userId), L.id).first();
  if (!r) return null;
  await L.db.prepare('DELETE FROM pending WHERE id = ?').bind(id).run();
  return JSON.parse(r.payload);
}


// True the first time an update id is seen. Telegram resends an update if the webhook is slow to answer
// (reading a receipt photo can take a while), and this keeps the bot from handling it twice.
export async function firstTime(db, updateId) {
  try {
    const r = await db.prepare('INSERT OR IGNORE INTO seen_updates (id, at) VALUES (?, ?)').bind(updateId, Date.now()).run();
    if (Math.random() < 0.05) await db.prepare('DELETE FROM seen_updates WHERE at < ?').bind(Date.now() - 2 * 864e5).run();
    return r.meta.changes > 0;
  } catch (e) {
    console.error('seen_updates', e && e.message); // table missing: run schema.sql again
    return true;
  }
}

/* ---------- accounts ---------- */
// Each Telegram user belongs to one ledger. People listed in ALLOWED_USER_IDS share ledger 1 (the original
// household). Anyone else who messages the bot or opens the Mini App gets a new ledger of their own,
// unless SIGNUP = "closed".
const householdIds = env => new Set(String(env.ALLOWED_USER_IDS || '').split(/[\s,]+/).filter(Boolean));

// Returns { ledgerId, isNew } or null (not a user, and signup is closed or create is false).
export async function account(env, tgUser, { create = true } = {}) {
  const db = env.DB, uid = String(tgUser.id);
  const name = [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ').slice(0, 100);
  const row = await db.prepare('SELECT ledger_id FROM users WHERE tg_id = ?').bind(uid).first();
  if (row) return { ledgerId: row.ledger_id, isNew: false };
  if (householdIds(env).has(uid)) {
    await db.prepare('INSERT OR IGNORE INTO users (tg_id, ledger_id, name) VALUES (?, 1, ?)').bind(uid, name).run();
    return { ledgerId: 1, isNew: false };
  }
  if (!create || String(env.SIGNUP || 'open').toLowerCase() === 'closed') return null;
  const led = await db.prepare('INSERT INTO ledgers (name) VALUES (?) RETURNING id').bind(name).first();
  const ins = await db.prepare('INSERT OR IGNORE INTO users (tg_id, ledger_id, name) VALUES (?, ?, ?)').bind(uid, led.id, name).run();
  if (!ins.meta.changes) {
    // Another request from the same person signed them up a moment ago; keep that one.
    await db.prepare('DELETE FROM ledgers WHERE id = ?').bind(led.id).run();
    const again = await db.prepare('SELECT ledger_id FROM users WHERE tg_id = ?').bind(uid).first();
    return { ledgerId: again.ledger_id, isNew: false };
  }
  return { ledgerId: led.id, isNew: true };
}

export async function ledgerMembers(db, ledgerId) {
  const r = await db.prepare('SELECT COUNT(*) AS n FROM users WHERE ledger_id = ?').bind(ledgerId).first();
  return r.n;
}

// Deletes a one-person account and everything in it. Shared ledgers (and ledger 1) are never deleted here.
export async function deleteAccount(db, tgId) {
  const row = await db.prepare('SELECT ledger_id FROM users WHERE tg_id = ?').bind(String(tgId)).first();
  if (!row) return { deleted: false, reason: 'none' };
  const id = row.ledger_id;
  if (id === 1 || (await ledgerMembers(db, id)) > 1) return { deleted: false, reason: 'shared' };
  const res = await db.batch([
    db.prepare('DELETE FROM tx WHERE ledger_id = ?').bind(id),
    db.prepare('DELETE FROM settings WHERE ledger_id = ?').bind(id),
    db.prepare('DELETE FROM pending WHERE ledger_id = ?').bind(id),
    db.prepare('DELETE FROM users WHERE tg_id = ?').bind(String(tgId)),
    db.prepare('DELETE FROM ledgers WHERE id = ?').bind(id),
  ]);
  return { deleted: true, entries: res[0].meta.changes };
}

// Counts one AI receipt read for this person today; false once they've used their daily share.
// (The free Workers AI allowance is shared by everyone, so no single account can use it all up.)
export async function takeAiQuota(db, tgId, today, limit) {
  const r = await db.prepare(
    'UPDATE users SET ai_count = CASE WHEN ai_day = ? THEN ai_count + 1 ELSE 1 END, ai_day = ? WHERE tg_id = ? AND (ai_day IS NOT ? OR ai_count < ?)'
  ).bind(today, today, String(tgId), today, limit).run();
  return r.meta.changes > 0;
}
