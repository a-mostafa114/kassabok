// Three ways in:
//  1. Telegram webhook  -> X-Telegram-Bot-Api-Secret-Token header must equal WEBHOOK_SECRET
//  2. Mini App          -> "Authorization: tma <initData>", HMAC-signed by Telegram with the bot token
//  3. Scripts / other   -> "Authorization: Bearer <API_KEY>" (the original household's ledger, ledger 1)
// Which ledger a Telegram user sees is decided by db.account().

const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? enc.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
export function safeEqual(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
export async function verifyInitData(initData, botToken, maxAgeSec = 86400) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const check = [...params.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('\n');
  const secret = await hmac('WebAppData', botToken);
  const sig = hex(await hmac(secret, check));
  if (!safeEqual(sig, hash)) return null;
  const authDate = +params.get('auth_date');
  if (!authDate || Date.now() / 1000 - authDate > maxAgeSec) return null;
  try { return JSON.parse(params.get('user') || 'null'); } catch { return null; }
}

// Returns { id, via, user? } for a genuine API caller, or null.
export async function authenticate(req, env) {
  const h = req.headers.get('Authorization') || '';
  const [scheme, ...rest] = h.split(' ');
  const cred = rest.join(' ');
  if (/^bearer$/i.test(scheme) && env.API_KEY && safeEqual(cred, env.API_KEY)) return { id: 'api', via: 'api' };
  if (/^tma$/i.test(scheme) && env.BOT_TOKEN) {
    const user = await verifyInitData(cred, env.BOT_TOKEN);
    if (user && user.id) return { id: String(user.id), via: 'app', name: user.first_name, user };
  }
  return null;
}
