// Turns the Kassabok artifact export (migration/export/ledger/*.json) into seed.sql for D1.
// Usage: node migration/to-sql.mjs  ->  migration/seed.sql
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanTx } from '../src/core.js';

const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, 'export', 'ledger');
const q = v => (v == null ? 'NULL' : typeof v === 'number' ? String(v) : "'" + String(v).replace(/'/g, "''") + "'");
const out = [];
let n = 0, skipped = 0;
for (const f of readdirSync(dir).filter(f => f.endsWith('.json')).sort()) {
  const doc = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  for (const [id, raw] of Object.entries(doc.tx || {})) {
    const r = cleanTx(raw);
    if (!r.ok) { console.warn(`skip ${id}: ${r.error}`); skipped++; continue; }
    const t = r.tx;
    out.push(`INSERT OR REPLACE INTO tx (id,date,period,cat,item,store,amount,toman,orig,qty,note,one_off,ord,source,created_by) VALUES (${[id, t.date, t.period, t.cat, t.item, t.store, t.amount, t.toman, t.orig, t.qty, t.note, t.oneOff ? 1 : 0, t.ord, 'import', 'artifact'].map(q).join(',')});`);
    n++;
  }
}
const sf = join(here, 'export', 'settings', 'main.json');
if (existsSync(sf)) {
  const s = JSON.parse(readFileSync(sf, 'utf8'));
  out.push(`INSERT OR REPLACE INTO settings (k,v) VALUES ('budgets', ${q(JSON.stringify(s.budgets || {}))});`);
  out.push(`INSERT OR REPLACE INTO settings (k,v) VALUES ('income', ${q(JSON.stringify(+s.income || 0))});`);
}
writeFileSync(join(here, 'seed.sql'), out.join('\n') + '\n');
console.log(`seed.sql: ${n} transactions${skipped ? `, ${skipped} skipped` : ''}`);
