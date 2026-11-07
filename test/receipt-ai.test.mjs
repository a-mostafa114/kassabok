import test from 'node:test';
import assert from 'node:assert/strict';
import { toReceipt, toBase64, storeName } from '../src/receipt-ai.js';
import * as C from '../src/core.js';

const P = (item, amount, extra = {}) => ({ kind: 'product', orig: item.toUpperCase(), item, qty: '', amount, cat: 'Groceries', ...extra });
const D = (amount, orig = 'Rabatt') => ({ kind: 'discount', orig, item: 'Discount', qty: '', amount, cat: 'Groceries' });
const base = { chain: 'Willys', branch: 'Vinsta', date: '2026-11-07', currency: 'SEK', payment: 'card', problem: '' };

test('toBase64 matches Node for large buffers', () => {
  const bytes = new Uint8Array(200000).map((_, i) => (i * 31) % 256);
  assert.equal(toBase64(bytes.buffer), Buffer.from(bytes).toString('base64'));
});

test('discount lines are subtracted from the product above them (Willys Vinsta receipt)', () => {
  const r = toReceipt({
    ...base, total: 111.2,
    items: [
      P('Lemons 500g', 14.9), D(-5, 'Rabatt:CITRONER'),
      P('Chocolate cake 400g', 47, { qty: '2 × 23.50' }), D(-12, 'Willys Plus:KLADDKAKA'),
      P('Mixed peppers', 59.8, { qty: '2 × 29.90' }), D(-20, '2 * Rabatt:PAPRIKA'),
      P('Cream 30%', 26.5),
    ],
  }, '2026-11-08', 'Cloudflare AI');
  assert.deepEqual(r.items.map(i => [i.item, i.amount]), [['Lemons 500g', 9.9], ['Chocolate cake 400g', 35], ['Mixed peppers', 39.8], ['Cream 30%', 26.5]]);
  assert.equal(r.items[1].note, 'After discount (-12.00) · Paid by card · Read by Cloudflare AI');
  assert.equal(r.items[1].qty, '2 × 23.50');
  assert.equal(r.store, 'Willys (Vinsta)');
  assert.equal(r.items[0].store, 'Willys (Vinsta)');
  assert.equal(C.round2(r.items.reduce((s, i) => s + i.amount, 0)), 111.2);
  for (const it of r.items) assert.ok(C.cleanTx(it).ok, JSON.stringify(it));
});

test('discounts the model already took off are not subtracted twice', () => {
  const r = toReceipt({ ...base, total: 44.9, items: [P('Lemons', 9.9), D(-5), P('Cake', 35), D(-12)] }, '2026-11-08');
  assert.deepEqual(r.items.map(i => i.amount), [9.9, 35]);
});

test('deposits, a discount with no product above it, and bad rows', () => {
  const r = toReceipt({
    ...base, total: 20,
    items: [D(-3, 'Kupong'), P('Soda 1.5L', 21), { kind: 'deposit', orig: '+PANT', item: 'x', qty: '', amount: 2, cat: 'Other' }, { kind: 'product', orig: '', item: '', qty: '', amount: 5, cat: 'Groceries' }, P('Bad', 'abc')],
  }, '2026-11-08');
  assert.deepEqual(r.items.map(i => [i.item, i.amount, i.cat]), [['Discount', -3, 'Groceries'], ['Soda 1.5L', 21, 'Groceries'], ['Bottle deposit', 2, 'Other']]);
});

test('missing or bad date falls back to today', () => {
  assert.equal(toReceipt({ date: '', items: [] }, '2026-11-07').date, '2026-11-07');
  assert.equal(toReceipt({ date: '2026-13-40', items: [] }, '2026-11-07').date, '2026-11-07');
});

test('store names reuse the ledger spelling only for the same branch', () => {
  const known = ['Willys (Hornstull)', 'Lidl (Långholmsgatan)', 'ICA Nära'];
  assert.equal(storeName('Willys', 'Vinsta', known), 'Willys (Vinsta)');
  assert.equal(storeName('willys', 'HORNSTULL', known), 'Willys (Hornstull)');
  assert.equal(storeName('Lidl', 'Långholmsg.', known), 'Lidl (Långholmsgatan)');
  assert.equal(storeName('ICA Nära', '', known), 'ICA Nära');
  assert.equal(storeName('', 'Vinsta', known), 'Vinsta');
  assert.equal(storeName('Coop', 'Coop', known), 'Coop');
});

test('bank screenshots become one entry per payment, with their own dates and shops', () => {
  const T = (date, shop, item, amount, cat) => ({ kind: 'product', date, shop, orig: shop, item, qty: '', amount, cat });
  const r = toReceipt({
    type: 'transactions', chain: '', branch: '', date: '', total: null, currency: 'SEK', payment: 'card', problem: '',
    items: [T('2026-11-07', 'Anthropic', 'Claude subscription', 251.62, 'Subscriptions'), T('2026-11-05', 'ica', 'Groceries (not itemized)', 66.49, 'Groceries'), T('2026-12-24', 'SL', '', 39, 'Transport'), T('2026-11-01', 'Zero', 'x', 0, 'Other')],
  }, '2026-11-07', 'Cloudflare AI', ['ICA', 'Willys (Vinsta)']);
  assert.equal(r.type, 'transactions');
  assert.deepEqual(r.items.map(i => [i.date, i.store, i.item, i.amount, i.cat]), [
    ['2025-12-24', 'SL', 'SL purchase', 39, 'Transport'], // a date "in the future" was last year
    ['2026-11-05', 'ICA', 'Groceries (not itemized)', 66.49, 'Groceries'], // matched the ledger's spelling
    ['2026-11-07', 'Anthropic', 'Claude subscription', 251.62, 'Subscriptions'],
  ]);
  for (const it of r.items) assert.ok(C.cleanTx(it).ok, JSON.stringify(it));
});

test('a receipt with only a total becomes one "not itemized" entry', () => {
  const r = toReceipt({ ...base, chain: 'ICA', branch: '', total: 66.49, items: [] }, '2026-11-07', 'AI');
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].item, C.NOT_ITEMIZED);
  assert.equal(r.items[0].amount, 66.49);
  assert.equal(r.items[0].store, 'ICA');
  assert.equal(C.totalOnly(r.items), true);
  // nothing readable at all: still no items
  assert.equal(toReceipt({ ...base, total: null, items: [] }, '2026-11-07').items.length, 0);
});
