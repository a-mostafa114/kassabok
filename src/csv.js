import { groupOf, periodOf } from './core.js';

const cell = v => {
  const s = v == null ? '' : String(v);
  // Quote when needed; prefix formula-looking text so spreadsheets don't execute it.
  const safe = /^[=+\-@\t\r]/.test(s) && isNaN(+s) ? "'" + s : s;
  return /[",\n;]/.test(safe) ? '"' + safe.replace(/"/g, '""') + '"' : safe;
};

export function toCsv(rows) {
  const head = ['date', 'period', 'item', 'store', 'category', 'group', 'amount_sek', 'toman', 'qty', 'original', 'note', 'id'];
  const lines = [head.join(',')];
  for (const t of [...rows].sort((a, b) => a.date.localeCompare(b.date) || a.ord - b.ord))
    lines.push([t.date, t.p || periodOf(t.date), t.item, t.store, t.cat, groupOf(t), t.amount.toFixed(2), t.toman || '', t.qty, t.orig, t.note, t.id].map(cell).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
