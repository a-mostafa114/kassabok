import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../src/core.js';
import { verifyInitData } from '../src/auth.js';
import { createHmac } from 'node:crypto';

test('periods run 25th to 24th', () => {
  assert.equal(C.periodOf('2026-11-07'), '2026-10');
  assert.equal(C.periodOf('2026-10-25'), '2026-10');
  assert.equal(C.periodOf('2026-10-24'), '2026-09');
  assert.equal(C.periodOf('2026-01-03'), '2025-12');
  assert.equal(C.pDays('2026-10'), 31);
  assert.equal(C.pLabel('2026-12'), '25 Dec – 24 Jan 2027');
  assert.equal(C.elapsed('2026-10', '2026-11-07'), 14);
});

test('quick add parsing matches the artifact', () => {
  const t = '2026-11-07';
  assert.deepEqual(C.parseQuick('23.80 Lidl snacks yesterday', t), { date: '2026-11-06', amount: 23.8, toman: 0, store: 'Lidl', item: 'Snacks', cat: 'Groceries' });
  const a = C.parseQuick('129 kr Apotek 3 Nov', t);
  assert.equal(a.amount, 129); assert.equal(a.date, '2026-11-03'); assert.equal(a.cat, 'Health');
  const r = C.parseQuick('12000000 toman rent', t);
  assert.equal(r.toman, 12000000); assert.equal(r.amount, 0); assert.equal(r.cat, 'Rent');
  assert.equal(C.parseQuick('45 Willys', t).item, 'Groceries (not itemized)');
  assert.equal(C.parseQuick('89 Lidl (Kista) bread', t, ['Lidl (Kista)']).store, 'Lidl (Kista)');
  assert.equal(C.parseQuick('30 fika', t).cat, 'Café');
  assert.equal(C.parseQuick('20 Lidl stuff', t, [], [{ store: 'Lidl', cat: 'Household', n: 5 }]).cat, 'Household');
});

test('cleanTx validates', () => {
  assert.equal(C.cleanTx({ date: '2026-02-30', item: 'x', amount: 1 }).ok, false);
  assert.equal(C.cleanTx({ date: '2026-02-03', item: '', amount: 1 }).ok, false);
  assert.equal(C.cleanTx({ date: '2026-02-03', item: 'x' }).ok, false);
  assert.equal(C.cleanTx({ date: '2026-02-03', item: 'x', amount: 0 }).ok, true);
  const r = C.cleanTx({ date: '2026-02-03', item: 'x', amount: '12,50', cat: 'Nope' });
  assert.equal(r.tx.amount, 12.5); assert.equal(r.tx.cat, 'Other'); assert.equal(r.tx.period, '2026-01');
});

test('receipt parsing', () => {
  const txt = `Sthlm Kista\nLidl Sverige KB\nOrg.nr: 969667-6312\nBananer        12.90\nMjölk 1,5l     15.90\nRabatt: Mjölk  -3.00\nChips 2 st * 10.00   20.00\nTotalt   45.80\nKort`;
  const r = C.parseReceiptText(txt, ['Lidl (Kista)']);
  assert.equal(r.store, 'Lidl (Kista)');
  assert.equal(r.items.length, 3);
  assert.equal(r.items[1].amount, 12.9);
  assert.equal(r.items[1].item, 'Milk 1.5L');
  assert.equal(r.total, 45.8);
});

test('summary + projection + bills', () => {
  const prev = [
    { date: '2026-09-26', cat: 'Rent', item: 'Rent', store: '', amount: 8000 },
    { date: '2026-09-28', cat: 'Phone/Mobile', item: 'Hallon', store: 'Hallon', amount: 199 },
    { date: '2026-10-01', cat: 'Groceries', item: 'Food', store: 'Lidl', amount: 300 },
  ];
  const cur = [
    { date: '2026-10-26', cat: 'Rent', item: 'Rent', store: '', amount: 8000 },
    { date: '2026-10-27', cat: 'Groceries', item: 'Food', store: 'Lidl', amount: 140, note: 'After discount (-10.00)' },
  ];
  const s = C.summary('2026-10', cur, prev, { budgets: { Groceries: 3000 } }, '2026-10-28');
  assert.equal(s.total, 8140);
  assert.equal(s.projection.elapsed, 4);
  assert.equal(s.projection.perDay, 35);
  assert.equal(s.bills.find(b => b.name === 'Rent').status, 'paid');
  assert.equal(s.bills.find(b => b.name === 'Hallon').status, 'due');
  assert.equal(s.projection.unpaid, 199);
  assert.equal(s.projection.total, C.round2(8140 + 35 * 27 + 199));
  assert.equal(s.discounts, 10);
  assert.equal(s.budgetTotal, 3000);
  assert.equal(s.cumulative.length, 4);
});

test('Telegram initData signature', async () => {
  const token = '123:ABC';
  const user = JSON.stringify({ id: 42, first_name: 'F' });
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'q', user };
  const check = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(check).digest('hex');
  const good = new URLSearchParams({ ...fields, hash }).toString();
  assert.equal((await verifyInitData(good, token)).id, 42);
  assert.equal(await verifyInitData(good, '999:WRONG'), null);
  assert.equal(await verifyInitData(good.replace('42', '43'), token), null);
});

test('rejects non-numeric amounts', () => {
  assert.equal(C.cleanTx({ date: '2026-11-07', item: 'x', amount: 'abc' }).ok, false);
  assert.equal(C.cleanTx({ date: '2026-11-07', item: 'x', amount: '', toman: 'lots' }).ok, false);
  assert.equal(C.cleanTx({ date: '2026-11-07', item: 'x', amount: '', toman: '500000' }).ok, true);
  assert.equal(C.cleanTx({ date: '2026-11-07', item: 'x', amount: '1 234,50' }).tx.amount, 1234.5);
});

test('duplicate detection', () => {
  const E = (date, store, item, amount, extra = {}) => ({ id: 'x', date, store, item, amount, ...extra });
  const ledger = [
    E('2026-11-05', 'ICA', 'Groceries (not itemized)', 66.49),
    E('2026-11-07', 'Willys (Vinsta)', 'Lemons 500g', 9.9), E('2026-11-07', 'Willys (Vinsta)', 'Chocolate cake 400g', 35),
    E('2026-11-07', 'Willys (Vinsta)', 'Paprika mix', 39.8), E('2026-11-07', 'Willys (Vinsta)', 'Cream 30%', 26.5),
    E('2026-11-01', '', 'Rent', 0, { toman: 12000000 }),
    E('2026-11-03', '', 'Fika', 30),
  ];
  const d = (t) => C.duplicatesOf(t, ledger);
  assert.equal(d(E('2026-11-06', 'ICA Nära', 'x', 66.49)).kind, 'same');            // same shop, booked a day later
  assert.equal(d(E('2026-11-09', 'ICA', 'x', 66.49)), null);                        // 4 days later: a new purchase
  assert.equal(d(E('2026-11-05', 'Lidl', 'x', 66.49)), null);                       // other shop
  assert.equal(d(E('2026-11-03', '', 'fika', 30)).kind, 'same');                    // no shop, same thing
  assert.equal(d(E('2026-11-03', '', 'Lunch', 30)), null);                          // no shop, different thing
  assert.equal(d(E('2026-11-02', '', 'Rent', 0, { toman: 12000000 })).kind, 'same'); // toman
  const bank = d(E('2026-11-07', 'Willys', 'Groceries (not itemized)', 111.2));     // bank line vs itemised receipt
  assert.equal(bank.kind, 'itemised'); assert.equal(bank.matches.length, 4);
  // the same receipt entered twice that day: still matched, one receipt at a time
  const twice = [...ledger.filter(e => e.store === 'Willys (Vinsta)').map(e => ({ ...e, added: '21:01' })), ...ledger.filter(e => e.store === 'Willys (Vinsta)').map(e => ({ ...e, added: '21:43' }))];
  assert.equal(C.duplicatesOf(E('2026-11-07', 'Willys', 'x', 111.2), twice).kind, 'itemised');
  const rec = (items) => C.receiptDuplicates(items, ledger);
  const willys = [['Lemons', 9.9], ['Cake', 35], ['Peppers', 39.8], ['Cream', 26.5]].map(([i, a]) => E('2026-11-07', 'Willys (Vinsta)', i, a));
  assert.equal(rec(willys).kind, 'items');                                         // the same receipt again
  assert.equal(rec(willys.map(i => ({ ...i, date: '2026-11-08' }))), null);         // same shop, next day
  const ica = [E('2026-11-05', 'ICA', 'Milk', 20), E('2026-11-05', 'ICA', 'Bread', 46.49)];
  assert.equal(rec(ica).kind, 'total');                                             // receipt for a bank line already added
  assert.deepEqual(C.dupWindow([E('2026-11-05', '', '', 1), E('2026-11-07', '', '', 1)]), { from: '2026-11-03', to: '2026-11-09' });
});

test('receipts that show only the total are spotted', () => {
  const it = (item, amount, orig = null) => ({ item, orig, amount });
  assert.equal(C.totalOnly([C.notItemizedItem(66.49)]), true);
  assert.equal(C.totalOnly([it('Total', 120, 'TOTALT')]), true);
  assert.equal(C.totalOnly([it('Groceries', 47.14, 'Mat (ej specificerat)')]), true);
  assert.equal(C.totalOnly([it('Amount paid', 99), it('Bottle deposit', 3)]), true);
  // real items, even a single one, are itemised
  assert.equal(C.totalOnly([it('Cola', 18.83)]), false);
  assert.equal(C.totalOnly([it('Food processor', 499)]), false);
  assert.equal(C.totalOnly([it('Meat', 126, 'Kött'), it('Fresh dates 500g', 29.98)]), false);
  assert.equal(C.totalOnly([]), false);
});
