// Kassabok API — one Cloudflare Worker serving the REST API, the Telegram bot webhook
// and (via static assets in /public) the Telegram Mini App.
import * as C from './core.js';
import * as db from './db.js';
import { authenticate, safeEqual } from './auth.js';
import { handleUpdate, setupBot } from './bot.js';
import { handleMcp } from './mcp.js';
import { toCsv } from './csv.js';

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
const err = (status, message) => json({ error: message }, status);
const today = env => C.todayISO(env.TZ || 'Europe/Stockholm');

async function readJson(req) {
  try { return await req.json(); } catch { return undefined; }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    try {
      if (path === '/') return Response.redirect(url.origin + '/app/', 302);

      // Telegram -> bot
      if (path === '/telegram/webhook' && req.method === 'POST') {
        if (!safeEqual(req.headers.get('X-Telegram-Bot-Api-Secret-Token'), env.WEBHOOK_SECRET)) return err(401, 'bad secret');
        const update = await readJson(req);
        // Handled before replying: work left to waitUntil() is cut off after 30 s, and reading a
        // receipt with Claude can take about that long. Telegram waits for the reply.
        if (update) await handleUpdate(update, env, url.origin).catch(e => console.error('bot error', e && e.stack || e));
        return new Response('ok');
      }

      // One-time setup: registers webhook, commands and the Mini App menu button.
      if (path === '/setup') {
        if (!env.API_KEY || !safeEqual(url.searchParams.get('key'), env.API_KEY)) return err(401, 'Pass ?key=<API_KEY>.');
        return json(await setupBot(env, url.origin));
      }

      // claude.ai connector (MCP) for the household ledger
      if (path.startsWith('/mcp/')) return (await handleMcp(req, env, path)) || err(404, 'Not found');

      if (path === '/api/health') return json({ ok: true, today: today(env) });
      if (!path.startsWith('/api/')) return err(404, 'Not found');
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });

      const who = await authenticate(req, env);
      if (!who) return err(401, 'Unauthorised. Open Kassabok from the Telegram bot, or send "Authorization: Bearer <API_KEY>".');
      // The API key belongs to the original household (ledger 1); Mini App users get their own ledger.
      const acct = who.via === 'api' ? { ledgerId: 1 } : await db.account(env, who.user);
      if (!acct) return err(403, 'This Kassabok isn’t open to new users.');
      const res = await api(req, env, url, path, who, db.ledger(env.DB, acct.ledgerId));
      for (const [k, v] of Object.entries(cors())) res.headers.set(k, v);
      return res;
    } catch (e) {
      console.error(e && e.stack || e);
      return err(500, 'Something went wrong on the server.');
    }
  },
};

const cors = () => ({ 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS' });

async function api(req, env, url, path, who, D) {
  const q = url.searchParams, m = req.method, t0 = today(env);
  const periodParam = () => {
    const p = q.get('period') || C.periodOf(t0);
    if (!C.isPeriod(p)) throw Object.assign(new Error('period must be YYYY-MM'), { status: 400 });
    return p;
  };
  try {
    if (path === '/api/me' && m === 'GET') return json({ id: who.id, via: who.via, name: who.name, ledger: D.id });

    if (path === '/api/meta' && m === 'GET') {
      const [ps, st] = await Promise.all([db.periods(D), db.stores(D)]);
      const cur = C.periodOf(t0);
      const keys = ps.map(p => p.period);
      if (!keys.includes(cur)) keys.push(cur);
      keys.sort();
      return json({
        today: t0, currentPeriod: cur, categories: C.CATS, groups: C.GROUPS,
        periods: keys.map(k => ({ period: k, label: C.pLabel(k), short: C.pShort(k), count: ps.find(p => p.period === k)?.n || 0 })),
        stores: st.map(s => s.store),
      });
    }

    if (path === '/api/summary' && m === 'GET') {
      const k = periodParam();
      const [rows, settings] = await Promise.all([db.txByPeriods(D, [k, C.pShift(k, -1)]), db.getSettings(D)]);
      return json(C.summary(k, rows.filter(t => t.p === k), rows.filter(t => t.p !== k), settings, t0));
    }

    if (path === '/api/trends' && m === 'GET') return json(C.trends(await db.allTx(D), t0));

    if (path === '/api/transactions' && m === 'GET') {
      const scope = q.get('period') === 'all' ? null : q.get('period') ? periodParam() : null;
      const limit = Math.min(Math.max(+q.get('limit') || 200, 1), 1000), offset = Math.max(+q.get('offset') || 0, 0);
      for (const k of ['from', 'to']) if (q.get(k) && !C.isISO(q.get(k))) return err(400, `${k} must be YYYY-MM-DD`);
      return json(await db.searchTx(D, { period: scope, q: q.get('q') || '', cat: q.get('cat') || '', store: q.get('store') || '', from: q.get('from'), to: q.get('to'), sort: q.get('sort') || 'new', limit, offset }));
    }

    if (path === '/api/transactions' && m === 'POST') {
      const body = await readJson(req);
      const list = Array.isArray(body) ? body : [body];
      if (!list.length || list.length > 200) return err(400, 'Send 1–200 transactions.');
      const clean = [];
      for (const [i, t] of list.entries()) { const r = C.cleanTx(t); if (!r.ok) return err(400, (list.length > 1 ? `#${i}: ` : '') + r.error); clean.push(r.tx); }
      const ids = await db.insertTx(D, clean, who.via, who.id);
      return json({ ids, items: await Promise.all(ids.map(id => db.getTx(D, id))) }, 201);
    }

    if (path === '/api/quick' && m === 'POST') {
      const body = await readJson(req) || {};
      const { stores, history } = await db.storeHistory(D);
      const p = C.parseQuick(String(body.text || ''), t0, stores, history);
      if (body.dryRun) return json({ parsed: p });
      const r = C.cleanTx({ ...p, note: 'Quick add' });
      if (!r.ok) return err(400, 'Add an amount and what it was for, like "45 Willys bread".');
      const [id] = await db.insertTx(D, [r.tx], who.via, who.id);
      return json({ parsed: p, item: await db.getTx(D, id) }, 201);
    }

    // Would this entry be a duplicate? (The Mini App asks before adding.) Body: one transaction.
    if (path === '/api/transactions/check' && m === 'POST') {
      const r = C.cleanTx(await readJson(req));
      if (!r.ok) return json({ duplicate: null });
      const w = C.dupWindow([r.tx]);
      const near = (await db.searchTx(D, { ...w, limit: 1000 })).items;
      return json({ duplicate: C.duplicatesOf(r.tx, near) });
    }

    const mt = /^\/api\/transactions\/([A-Za-z0-9_-]{1,64})$/.exec(path);
    if (mt) {
      const id = mt[1];
      const cur = await db.getTx(D, id);
      if (!cur) return err(404, 'No such transaction.');
      if (m === 'GET') return json(cur);
      if (m === 'DELETE') { await db.deleteTx(D, id); return json({ deleted: cur }); }
      if (m === 'PATCH' || m === 'PUT') {
        const body = await readJson(req);
        if (!body || typeof body !== 'object') return err(400, 'Body must be a JSON object.');
        const r = C.cleanTx(m === 'PUT' ? body : { ...cur, ...body });
        if (!r.ok) return err(400, r.error);
        await db.updateTx(D, id, r.tx);
        return json(await db.getTx(D, id));
      }
      return err(405, 'Method not allowed');
    }

    if (path === '/api/settings') {
      if (m === 'GET') return json(await db.getSettings(D));
      if (m === 'PUT' || m === 'PATCH') {
        const body = await readJson(req) || {};
        const curS = await db.getSettings(D);
        const budgets = {};
        for (const [c, v] of Object.entries(body.budgets ?? curS.budgets)) if (C.CATS.includes(c) && +v > 0) budgets[c] = C.round2(+v);
        const next = { budgets, income: Math.max(0, C.round2(C.num(body.income ?? curS.income))) };
        await db.putSettings(D, next);
        return json(next);
      }
    }

    if (path === '/api/export.csv' && m === 'GET') {
      const k = q.get('period');
      const rows = k && k !== 'all' ? await db.txByPeriod(D, periodParam()) : await db.allTx(D);
      return new Response(toCsv(rows), { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="kassabok-${k || 'all'}.csv"` } });
    }

    return err(404, 'Not found');
  } catch (e) {
    if (e.status) return err(e.status, e.message);
    throw e;
  }
}
