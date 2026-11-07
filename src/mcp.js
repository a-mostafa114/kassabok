// MCP server (Streamable HTTP, JSON responses) so claude.ai can use the household ledger as a connector:
// the Kassabok artifact reads and writes through it, and Claude chats can query it.
// URL: https://<worker>/mcp/<MCP_SECRET>  (add it in claude.ai → Settings → Connectors). Ledger 1 only.
import * as C from './core.js';
import * as db from './db.js';
import { safeEqual } from './auth.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const HOUSEHOLD = 1;

const txProps = {
  date: { type: 'string', description: 'YYYY-MM-DD' },
  item: { type: 'string', description: 'What was bought, short English name, e.g. "Bread" or "Claude subscription".' },
  amount: { type: 'number', description: 'Amount in Swedish kronor (kr). Negative for refunds/discounts.' },
  store: { type: 'string', description: 'Shop or merchant, e.g. "Willys (Vinsta)". Optional.' },
  cat: { type: 'string', enum: C.CATS, description: 'Category. Optional: guessed from item and store when left out.' },
  toman: { type: 'number', description: 'Amount paid in Iranian toman instead of kr (rent). Optional.' },
  note: { type: 'string', description: 'Optional note.' },
  qty: { type: 'string', description: 'Optional quantity, e.g. "2 × 12.90".' },
  orig: { type: 'string', description: 'Optional original receipt text.' },
  oneOff: { type: 'boolean', description: 'Optional: a one-off expense, kept out of everyday averages.' },
};

const TOOLS = [
  {
    name: 'get_overview',
    description: 'Today\'s date, the current budget period (periods run from the 25th to the 24th, keyed by the month they start in: "2026-10" = 25 Oct – 24 Nov), every period with its entry count, the categories, known stores, and the budgets and income.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'Ledger overview', readOnlyHint: true },
  },
  {
    name: 'list_transactions',
    description: 'Search the ledger. Returns {total, sum, items}; each item has id, date, item, store, cat, amount (kr), and toman/note/qty/orig when set. Newest first by default.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: '"YYYY-MM" for one budget period, or "all". Default: all.' },
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        q: { type: 'string', description: 'Text to find in item, store, note or receipt text.' },
        cat: { type: 'string', enum: C.CATS },
        store: { type: 'string', description: 'Exact store name.' },
        sort: { type: 'string', enum: ['new', 'old', 'big'] },
        limit: { type: 'integer', description: '1–2000, default 100.' },
        offset: { type: 'integer', description: 'For paging, default 0.' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Find transactions', readOnlyHint: true },
  },
  {
    name: 'get_summary',
    description: 'Everything about one budget period: total, comparison with last period, projection to period end, fixed/everyday/one-off split, categories with budgets, recurring bills (paid/due/late), top stores, and day-by-day totals.',
    inputSchema: { type: 'object', properties: { period: { type: 'string', description: '"YYYY-MM". Default: the current period.' } }, additionalProperties: false },
    annotations: { title: 'Period summary', readOnlyHint: true },
  },
  {
    name: 'add_transactions',
    description: 'Add one or more expenses. Entries that look like duplicates of what is already in the ledger (same amount within 2 days at the same shop or for the same thing) are NOT added unless allow_duplicates is true; they come back under "duplicates" with what they match, so you can ask the person first. Returns {added, duplicates}.',
    inputSchema: {
      type: 'object',
      properties: {
        transactions: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'object', properties: txProps, required: ['date', 'item', 'amount'], additionalProperties: false } },
        allow_duplicates: { type: 'boolean', description: 'Add even entries that look like duplicates. Only after the person confirmed.' },
      },
      required: ['transactions'],
      additionalProperties: false,
    },
    annotations: { title: 'Add expenses', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'update_transaction',
    description: 'Change fields of one transaction by id (from list_transactions). Only the fields given change. Returns the updated transaction.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, ...txProps }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Edit a transaction', readOnlyHint: false, destructiveHint: false },
  },
  {
    name: 'delete_transaction',
    description: 'Delete one transaction by id. Returns the deleted transaction.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    annotations: { title: 'Delete a transaction', readOnlyHint: false, destructiveHint: true },
  },
  {
    name: 'set_budgets',
    description: 'Set monthly budgets per category (kr per period; 0 removes one) and/or the household income. Returns the new settings.',
    inputSchema: {
      type: 'object',
      properties: {
        budgets: { type: 'object', description: 'Category → kr, e.g. {"Groceries": 3000}. Replaces all budgets.', additionalProperties: { type: 'number' } },
        income: { type: 'number' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Set budgets', readOnlyHint: false, destructiveHint: false },
  },
];

const today = env => C.todayISO(env.TZ || 'Europe/Stockholm');
class ToolError extends Error {}

async function callTool(name, a, env) {
  const L = db.ledger(env.DB, HOUSEHOLD), t0 = today(env);
  a = a && typeof a === 'object' ? a : {};
  switch (name) {
    case 'get_overview': {
      const [ps, st, settings] = await Promise.all([db.periods(L), db.stores(L), db.getSettings(L)]);
      const cur = C.periodOf(t0);
      const keys = ps.map(p => p.period); if (!keys.includes(cur)) keys.push(cur); keys.sort();
      return {
        today: t0, currentPeriod: cur, currency: 'SEK',
        periods: keys.map(k => ({ period: k, label: C.pLabel(k), count: ps.find(p => p.period === k)?.n || 0, total: C.round2(ps.find(p => p.period === k)?.sum || 0) })),
        categories: C.CATS, stores: st.slice(0, 80).map(s => s.store), budgets: settings.budgets || {}, income: settings.income || 0,
      };
    }
    case 'list_transactions': {
      const period = a.period && a.period !== 'all' ? String(a.period) : null;
      if (period && !C.isPeriod(period)) throw new ToolError('period must be "YYYY-MM" or "all".');
      for (const k of ['from', 'to']) if (a[k] && !C.isISO(String(a[k]))) throw new ToolError(`${k} must be YYYY-MM-DD.`);
      const limit = Math.min(Math.max(parseInt(a.limit) || 100, 1), 2000), offset = Math.max(parseInt(a.offset) || 0, 0);
      return db.searchTx(L, { period, from: a.from, to: a.to, q: String(a.q || ''), cat: String(a.cat || ''), store: String(a.store || ''), sort: a.sort || 'new', limit, offset });
    }
    case 'get_summary': {
      const k = a.period ? String(a.period) : C.periodOf(t0);
      if (!C.isPeriod(k)) throw new ToolError('period must be "YYYY-MM".');
      const [rows, settings] = await Promise.all([db.txByPeriods(L, [k, C.pShift(k, -1)]), db.getSettings(L)]);
      return C.summary(k, rows.filter(t => t.p === k), rows.filter(t => t.p !== k), settings, t0);
    }
    case 'add_transactions': {
      const list = Array.isArray(a.transactions) ? a.transactions : [];
      if (!list.length || list.length > 200) throw new ToolError('Send 1–200 transactions.');
      const { stores, history } = await db.storeHistory(L);
      const clean = [];
      for (const [i, t] of list.entries()) {
        const withCat = { ...t, cat: C.CATS.includes(t.cat) ? t.cat : C.guessCat(`${t.item || ''} ${t.store || ''}`, t.store, history), note: t.note || 'Added by Claude' };
        const r = C.cleanTx(withCat);
        if (!r.ok) throw new ToolError(`transactions[${i}]: ${r.error}`);
        clean.push(r.tx);
      }
      let fresh = clean, duplicates = [];
      if (!a.allow_duplicates) {
        const w = C.dupWindow(clean);
        const near = w ? (await db.searchTx(L, { ...w, limit: 1000 })).items : [];
        fresh = []; duplicates = [];
        clean.forEach((t, i) => {
          const d = C.duplicatesOf(t, near);
          if (d) duplicates.push({ index: i, entry: t, kind: d.kind, matches: d.matches.slice(0, 5) });
          else fresh.push(t);
        });
      }
      const ids = fresh.length ? await db.insertTx(L, fresh, 'claude', 'claude') : [];
      return {
        added: fresh.map((t, i) => ({ id: ids[i], date: t.date, item: t.item, store: t.store, cat: t.cat, amount: t.amount, toman: t.toman || 0 })),
        duplicates,
        message: duplicates.length ? `${duplicates.length} not added because they look like duplicates. Ask before adding them with allow_duplicates.` : undefined,
      };
    }
    case 'update_transaction': {
      const id = String(a.id || '');
      const cur = await db.getTx(L, id);
      if (!cur) throw new ToolError('No transaction with that id.');
      const { id: _, ...fields } = a;
      const r = C.cleanTx({ ...cur, ...fields });
      if (!r.ok) throw new ToolError(r.error);
      await db.updateTx(L, id, r.tx);
      return db.getTx(L, id);
    }
    case 'delete_transaction': {
      const id = String(a.id || '');
      const cur = await db.getTx(L, id);
      if (!cur) throw new ToolError('No transaction with that id.');
      await db.deleteTx(L, id);
      return { deleted: cur };
    }
    case 'set_budgets': {
      const cur = await db.getSettings(L);
      const budgets = {};
      for (const [c, v] of Object.entries(a.budgets ?? cur.budgets ?? {})) if (C.CATS.includes(c) && +v > 0) budgets[c] = C.round2(+v);
      const next = { budgets, income: Math.max(0, C.round2(C.num(a.income ?? cur.income))) };
      await db.putSettings(L, next);
      return next;
    }
    default:
      throw Object.assign(new Error(`Unknown tool: ${name}`), { rpc: -32602 });
  }
}

const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

async function handleMessage(m, env) {
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') return rpcError(m?.id, -32600, 'Invalid request');
  const isNotification = m.id === undefined || m.id === null;
  if (isNotification) return null; // notifications/initialized, notifications/cancelled, ...
  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      return rpcResult(m.id, {
        protocolVersion: PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'Kassabok', title: 'Kassabok household ledger', version: '1.0.0' },
        instructions: 'Kassabok is a household expense ledger in Swedish kronor. Budget periods run from the 25th to the 24th. Use get_overview first for today\'s date and the categories. add_transactions refuses likely duplicates unless allow_duplicates is true: ask the person before passing it.',
      });
    }
    case 'ping': return rpcResult(m.id, {});
    case 'tools/list': return rpcResult(m.id, { tools: TOOLS });
    case 'tools/call': {
      const name = m.params?.name;
      try {
        const out = await callTool(name, m.params?.arguments, env);
        return rpcResult(m.id, { content: [{ type: 'text', text: JSON.stringify(out) }], structuredContent: out });
      } catch (e) {
        if (e.rpc) return rpcError(m.id, e.rpc, e.message);
        const msg = e instanceof ToolError ? e.message : 'Something went wrong in the ledger.';
        if (!(e instanceof ToolError)) console.error('mcp tool', name, e && e.stack || e);
        return rpcResult(m.id, { content: [{ type: 'text', text: msg }], isError: true });
      }
    }
    case 'resources/list': return rpcResult(m.id, { resources: [] });
    case 'prompts/list': return rpcResult(m.id, { prompts: [] });
    default: return rpcError(m.id, -32601, `Method not found: ${m.method}`);
  }
}

// Returns a Response for /mcp/<secret>, or null when the path isn't the MCP endpoint (or the secret is wrong).
export async function handleMcp(req, env, path) {
  const m = /^\/mcp\/([^/]+)$/.exec(path);
  if (!m || !env.MCP_SECRET || !safeEqual(decodeURIComponent(m[1]), env.MCP_SECRET)) return null;
  const headers = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (req.method === 'GET') return new Response(null, { status: 405, headers: { allow: 'POST' } }); // no server-initiated stream
  if (req.method === 'DELETE') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } });
  let body;
  try { body = await req.json(); } catch { return new Response(JSON.stringify(rpcError(null, -32700, 'Parse error')), { status: 400, headers }); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(x => handleMessage(x, env)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return new Response(JSON.stringify(batch ? replies : replies[0]), { status: 200, headers });
}
