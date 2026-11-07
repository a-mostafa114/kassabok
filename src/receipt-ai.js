// Reads receipts (photos, or text the regex parser can't handle) with an AI model.
// Free by default: Cloudflare Workers AI (the AI binding in wrangler.toml), within the free daily allowance.
// Optional: if the ANTHROPIC_API_KEY secret is set, Claude is used instead (paid per use, and it also reads PDFs).
import Anthropic from '@anthropic-ai/sdk';
import * as C from './core.js';

const CLAUDE_MODEL = 'claude-opus-5-5';
// Fast, accurate on Swedish receipts in testing, and cheap enough for ~100 receipts a day on the free allowance.
const FREE_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';

// Which reader is available: 'claude', 'free' or null.
export const readerOf = env => (env.ANTHROPIC_API_KEY ? 'claude' : env.AI ? 'free' : null);
export const READER_NAME = { claude: 'Claude', free: 'Cloudflare AI' };

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'chain', 'branch', 'date', 'total', 'currency', 'payment', 'items', 'problem'],
  properties: {
    type: { type: 'string', enum: ['receipt', 'transactions'] },
    chain: { type: 'string' },
    branch: { type: 'string' },
    date: { type: 'string' },
    total: { anyOf: [{ type: 'number' }, { type: 'null' }] },
    currency: { type: 'string' },
    payment: { type: 'string', enum: ['card', 'Swish', 'cash', ''] },
    problem: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'date', 'shop', 'orig', 'item', 'qty', 'amount', 'cat'],
        properties: {
          kind: { type: 'string', enum: ['product', 'discount', 'deposit'] },
          date: { type: 'string' },
          shop: { type: 'string' },
          orig: { type: 'string' },
          item: { type: 'string' },
          qty: { type: 'string' },
          amount: { type: 'number' },
          cat: { type: 'string', enum: C.CATS },
        },
      },
    },
  },
};

const SYSTEM = `You read shopping receipts and bank transaction lists for a personal expense ledger kept by people living in Sweden, and return what was spent as JSON.

First decide the type:
- "receipt": a shop receipt, one purchase with line items. Fill everything as described below.
- "transactions": a list of separate payments, such as a screenshot of a bank or card app, or a statement. Then:
  - items: one entry per payment, top to bottom, all with kind "product".
  - date: that payment's date as YYYY-MM-DD. Work out "Today"/"Idag", "Yesterday"/"Igår", weekday names and dates without a year from today's date, given below; a payment is never in the future.
  - shop: the merchant as shown, like "ICA" or "Anthropic".
  - item: what it was, if you can tell from the merchant: "Groceries (not itemized)" for supermarkets, "Claude subscription" for Anthropic, "Spotify subscription", "SL travel card" for SL, and so on; otherwise "<merchant> purchase".
  - amount: the amount spent as a positive number, in Swedish kronor (kr/SEK). If a foreign amount is also shown (like €22.50), use the kronor amount. A refund is negative. Leave out money coming in (salary, transfers, Swish received).
  - cat: as below, with software, apps, streaming and AI services as Subscriptions.
  - orig: the transaction text as shown. qty: empty string.
  - chain, branch and date (top level): empty strings. total: null. payment: "card".

For a receipt, the per-line date and shop are empty strings, and the rest is filled like this:
- items: copy every line of the purchase list that has an amount, in receipt order, one entry per line. This includes discount lines. Don't do any arithmetic: the app subtracts discounts itself.
  - kind: "product" for something bought; "discount" for a discount line, which is usually indented under its product and has a negative amount (Rabatt, Willys Plus, Extrapris, Medlemspris, Stammis, Kupong, "2 * Rabatt", and similar); "deposit" for bottle deposit (pant, +PANT) or returned bottles (pantretur, negative).
  - orig: the line's text exactly as printed, without the amount.
  - item: for products, a short English name with the size if one is printed (for example "Milk 1.5L", "Chicken fillet 900g", "Chocolate cake 400g"). Translate Swedish product names; keep brand names. For discounts, "Discount"; for deposits, "Bottle deposit".
  - qty: like "2 × 12.90" for multiples or "0.512 kg × 29.90/kg" for weighed goods (these details are often printed on the line or on a separate line under the product); empty string for a single item.
  - amount: the amount printed at the end of that line, exactly as printed, negative for discounts. For a product with a quantity, the line total (for example 2st*23,50 → 47.00).
  - cat: Groceries for food and drink from shops; Household for cleaning products, paper towels, toilet paper, bags, batteries and kitchen items; Personal care for hygiene and cosmetics; Health for medicine and pharmacy items; Café and Eating out for cafés and restaurants; otherwise the best match. A discount gets its product's category.
- chain: the shop's chain or name, like "Willys", "Lidl", "ICA Nära", "Coop". If only the branch is printed, work the chain out from clues such as the org number (556163-2232 is Willys) or loyalty programme names ("Willys Plus").
- branch: the branch or area exactly as printed (like "Vinsta" or "Hornstull"), or an empty string if none.
- date: the purchase date as YYYY-MM-DD, or an empty string if none is printed.
- total: the amount paid as printed (ATT BETALA, Totalt, Summa, Total), or null if not printed.
- currency: ISO code, usually SEK.
- payment: card, Swish, cash, or empty string if unclear.
- problem: empty string normally. If the input is neither a receipt nor a list of payments, or parts can't be read, say so briefly here; still return every line you can read.

Before answering, check that all the line amounts (products, discounts and deposits) add up to the printed total, and re-read the receipt if they don't. Ignore lines below the total, such as savings summaries ("Med Willys Plus har du sparat"), VAT tables and card details.`;

// ArrayBuffer -> base64 without Node's Buffer (Workers don't have it by default).
export function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function contextText({ hint, today }) {
  const ctx = [`Today is ${today}.`];
  if (hint) ctx.push(`The user's note with the receipt: ${hint}`);
  return ctx.join('\n');
}

/**
 * media: { mediaType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif' | 'application/pdf', data: base64 } or null
 * text:  receipt text (when there's no media)
 * hint:  the photo caption, if any
 * Returns the raw JSON object described by SCHEMA.
 */
export function readReceipt(env, input) {
  const who = readerOf(env);
  if (who === 'claude') return readWithClaude(env, input);
  if (who === 'free') return readWithWorkersAI(env, input);
  throw new Error('No AI reader is set up.');
}

async function readWithWorkersAI(env, { media, text, ...rest }) {
  if (media?.mediaType === 'application/pdf') throw new Error('PDFs can’t be read for free. Send a screenshot of the receipt instead.');
  const user = media
    ? [{ type: 'image_url', image_url: { url: `data:${media.mediaType};base64,${media.data}` } }, { type: 'text', text: contextText(rest) }]
    : `<receipt>\n${text}\n</receipt>\n\n${contextText(rest)}`;
  const model = env.RECEIPT_MODEL || FREE_MODEL;
  const out = await env.AI.run(model, {
    messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
    response_format: { type: 'json_schema', json_schema: { name: 'receipt', schema: SCHEMA, strict: true } },
    // Qwen thinks by default; reading a receipt doesn't need it, and it's faster without.
    ...(model.includes('qwen') ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    max_completion_tokens: 6000,
    temperature: 0,
  });
  const msg = out?.choices?.[0]?.message;
  const content = msg?.content ?? out?.response;
  if (out?.choices?.[0]?.finish_reason === 'length') throw new Error('The receipt was too long to read in one go.');
  if (!content) throw new Error('The AI returned no answer.');
  return typeof content === 'string' ? JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '')) : content;
}

async function readWithClaude(env, { media, text, ...rest }) {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL || undefined, maxRetries: 1 });
  const content = [];
  if (media) {
    content.push(media.mediaType === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: media.data } }
      : { type: 'image', source: { type: 'base64', media_type: media.mediaType, data: media.data } });
  } else {
    content.push({ type: 'text', text: `<receipt>\n${text}\n</receipt>` });
  }
  content.push({ type: 'text', text: contextText(rest) });

  const req = {
    model: CLAUDE_MODEL,
    max_tokens: 16000,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: SCHEMA } },
    system: SYSTEM,
    messages: [{ role: 'user', content }],
  };
  let res;
  try {
    // If Claude's safety classifiers decline, the API re-runs the request on a fallback model.
    res = await client.beta.messages.create({ ...req, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  } catch (e) {
    if (!(e instanceof Anthropic.BadRequestError)) throw e;
    res = await client.beta.messages.create(req); // the account may not have the fallback beta yet
  }
  if (res.stop_reason === 'refusal') throw new Error('Claude declined to read this receipt.');
  if (res.stop_reason === 'max_tokens') throw new Error('The receipt was too long to read in one go.');
  const block = res.content.find(b => b.type === 'text');
  if (!block) throw new Error('Claude returned no answer.');
  return JSON.parse(block.text);
}

// The model's JSON -> the { store, date, total, items } shape the bot's receipt preview and the ledger use.
// "Willys" + "Vinsta" -> "Willys (Vinsta)", reusing the spelling of a store already in the ledger when it's the same branch.
export function storeName(chain, branch, known = []) {
  chain = String(chain || '').trim(); branch = String(branch || '').trim();
  if (!chain || chain.toLowerCase() === branch.toLowerCase()) return chain || branch;
  const want = branch ? `${chain} (${branch})` : chain;
  const low = want.toLowerCase(), cl = chain.toLowerCase(), bl = branch.toLowerCase();
  return known.find(s => s.toLowerCase() === low)
    || (bl.length >= 4 && known.find(s => s.toLowerCase().startsWith(cl + ' (') && s.slice(chain.length + 2).toLowerCase().startsWith(bl.slice(0, 5))))
    || want;
}

export function toReceipt(r, today, by = 'AI', known = []) {
  if (r.type === 'transactions') return toTransactions(r, today, by, known);
  const pay = r.payment === 'Swish' ? 'Paid via Swish' : r.payment === 'card' ? 'Paid by card' : r.payment === 'cash' ? 'Paid in cash' : '';
  const date = C.isISO(r.date || '') ? r.date : today;
  const store = r.chain != null || r.branch != null ? storeName(r.chain, r.branch, known) : String(r.store || '').trim();
  const total = Number.isFinite(r.total) ? r.total : null;
  const rows = (r.items || []).filter(i => i && Number.isFinite(+i.amount));
  const str = v => String(v || '').trim();

  // Build ledger items; discount lines are subtracted from the product above them (if applyDiscounts).
  const build = applyDiscounts => {
    const out = [];
    for (const row of rows) {
      const amount = C.round2(+row.amount);
      const last = out[out.length - 1];
      if (row.kind === 'discount' && applyDiscounts && last && last.kind === 'product' && amount < 0) {
        last.amount = C.round2(last.amount + amount);
        last.disc = C.round2(last.disc - amount);
        continue;
      }
      if (row.kind === 'discount' && !applyDiscounts) continue;
      const kind = row.kind === 'deposit' ? 'deposit' : row.kind === 'discount' ? 'discount' : 'product';
      const item = kind === 'deposit' ? 'Bottle deposit' : str(row.item) || (kind === 'discount' ? 'Discount' : str(row.orig));
      if (!item) continue;
      out.push({ kind, item, orig: str(row.orig) || null, qty: str(row.qty) || null, amount, disc: 0, cat: C.CATS.includes(row.cat) ? row.cat : 'Groceries' });
    }
    return out;
  };
  const sum = list => C.round2(list.reduce((s, i) => s + i.amount, 0));
  const fits = list => total != null && Math.abs(sum(list) - total) < 0.005;

  let items = build(true);
  // If the model already took the discounts off the product amounts, applying them again undercounts;
  // in that case the products alone add up to the total.
  if (total != null && !fits(items)) {
    const alt = build(false);
    if (fits(alt)) items = alt;
  }
  return {
    type: 'receipt',
    store,
    date,
    total,
    currency: String(r.currency || 'SEK').toUpperCase(),
    problem: str(r.problem),
    items: items.map(i => ({
      item: i.item, orig: i.orig, qty: i.qty, amount: i.amount, cat: i.cat,
      note: [i.disc > 0 ? `After discount (-${i.disc.toFixed(2)})` : '', pay, `Read by ${by}`].filter(Boolean).join(' · '),
      date, store,
    })),
  };
}

// A bank/card transaction list: every line is its own purchase with its own date and shop.
function toTransactions(r, today, by, known) {
  const str = v => String(v || '').trim();
  const items = (r.items || []).filter(i => i && Number.isFinite(+i.amount) && +i.amount !== 0).map(i => {
    let date = C.isISO(str(i.date)) ? str(i.date) : today;
    if (date > today) { const y = String(+date.slice(0, 4) - 1) + date.slice(4); date = C.isISO(y) ? y : today; } // "5 Nov" read as next year
    const store = storeName(str(i.shop), '', known);
    const item = str(i.item) || (store ? `${store} purchase` : str(i.orig));
    return { item, orig: str(i.orig) || null, qty: null, amount: C.round2(+i.amount), cat: C.CATS.includes(i.cat) ? i.cat : 'Other', note: `From a bank screenshot · Read by ${by}`, date, store };
  }).filter(i => i.item);
  items.sort((a, b) => a.date.localeCompare(b.date));
  return { type: 'transactions', store: '', date: today, total: null, currency: 'SEK', problem: str(r.problem), items };
}

// A short, human explanation of what went wrong, for the bot's reply.
export function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'The Claude API key is wrong or was revoked.';
  if (e instanceof Anthropic.PermissionDeniedError) return 'The Claude API key isn’t allowed to do this.';
  if (e instanceof Anthropic.RateLimitError) return 'Claude is busy right now. Try again in a minute.';
  if (e instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${String(e.error?.error?.message || e.message).slice(0, 200)}`;
  if (e instanceof Anthropic.APIConnectionError) return 'Couldn’t reach Claude. Try again in a minute.';
  if (e instanceof Anthropic.APIError) return `Claude had a problem (${e.status}). Try again in a minute.`;
  if (e instanceof SyntaxError) return 'The AI’s answer was garbled. Try again, or paste the receipt text.';
  // Workers AI errors are plain Errors; 4006 means the free daily allowance is used up.
  if (/4006|neurons|daily free allocation/i.test(String(e?.message))) return 'Today’s free AI allowance is used up. Try again tomorrow, or paste the receipt text.';
  return String(e?.message || e).slice(0, 200);
}
