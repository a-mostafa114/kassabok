# Kassabok API

Your Kassabok household ledger as a real API, with a **Telegram bot** for adding expenses and a **Telegram Mini App** for charts and statistics.

It all runs as one free **Cloudflare Worker**, with a **D1** (SQLite) database:

```
Telegram bot ──webhook──▶  /telegram/webhook ┐
Mini App (in Telegram) ─▶  /app/  +  /api/*  ├─▶ Worker ─▶ D1 database
Scripts / other apps ───▶  /api/* (API key)  ┘
```

Cloudflare's free plan covers this easily (100,000 requests a day, 5 GB of database). It's always on and doesn't sleep. No credit card is needed.

---

## Deploy (about 15 minutes, one time)

You need Node.js 18+ on your computer and a free Cloudflare account (https://dash.cloudflare.com/sign-up).

### 1. Create the Telegram bot
1. In Telegram, open **@BotFather** and send `/newbot`. Pick a name, such as `Kassabok`, and a username ending in `bot`.
2. Copy the **token** it gives you (it looks like `123456789:AA...`).

### 2. Install and log in
```bash
cd kassabok-api
npm install
npx wrangler login
```

### 3. Create the database
```bash
npx wrangler d1 create kassabok
```
Copy the `database_id` it prints into `wrangler.toml` (replace `REPLACE_WITH_YOUR_D1_DATABASE_ID`). Then create the tables and import your existing ledger (406 transactions, Aug–Nov 2026):
```bash
npm run db:init
npm run db:import
```

### 4. Set the secrets
Each command asks you to paste a value:
```bash
npx wrangler secret put BOT_TOKEN        # the token from BotFather
npx wrangler secret put WEBHOOK_SECRET   # any long random string
npx wrangler secret put API_KEY          # any long random string, keep it private
```
(To generate random strings: `openssl rand -hex 24`.)

### 5. Deploy
```bash
npm run deploy
```
It prints your URL, for example `https://kassabok.<you>.workers.dev`.

### 6. Connect the bot (once)
Open this in a browser:
```
https://kassabok.<you>.workers.dev/setup?key=<your API_KEY>
```
You should see `"webhook":"ok"`. This registers the webhook, the command list and the **Kassabok** menu button that opens the Mini App.

### 7. Link your household
Your imported ledger is the household ledger (ledger 1). Store the Telegram user ids of the people who share it as a secret, so they stay out of the code (to find an id, message @userinfobot in Telegram):
```bash
npx wrangler secret put ALLOWED_USER_IDS
# paste: 123456789,987654321
```
Done. The ids are only checked the first time each person uses the bot; after that they stay linked to the household ledger.

---

## Accounts
Everyone who starts the bot gets their **own private ledger**. They see only their own entries, budgets and statistics, in the bot and in the Mini App.
- People listed in `ALLOWED_USER_IDS` share the household ledger (ledger 1).
- Anyone else gets a new, empty ledger the first time they message the bot or open the Mini App.
- `/deleteaccount` deletes a person's ledger and everything in it, after a confirmation. Shared ledgers can't be deleted this way.
- To stop new sign-ups, set `SIGNUP = "closed"` in `wrangler.toml` and redeploy. Existing users keep working.
- Each person can have `AI_DAILY_LIMIT` receipt photos (default 20) read per day, because the free AI allowance is shared by everyone.
- Group chats are ignored; the bot works in private chats only.
- Everyone uses the same rules: amounts in kr, periods 25th → 24th, Stockholm time.

The data of all users lives in your Cloudflare D1 database, so you (the owner of the Cloudflare account) can technically see it.

**Upgrading a database from before accounts:** back it up, then run the migration once and deploy:
```bash
npx wrangler d1 export kassabok --remote --output migration/export/backup.sql
npx wrangler d1 execute kassabok --remote --file=migration/accounts.sql
npm run deploy
```

---

## Using the bot

Just type expenses:

| You type | What gets saved |
|---|---|
| `45 Willys bread` | 45 kr · Bread · Willys · Groceries · today |
| `23.80 Lidl snacks yesterday` | dated yesterday |
| `129 kr Apotek 3 Nov` | Health, 3 Nov |
| `30 fika` | Café |
| `12000000 toman rent` | rent paid in toman |

Under each reply there are **🏷 Category** and **↩️ Undo** buttons.

**Receipts:** send a **photo** of a paper receipt or a screenshot, or paste the text of a digital receipt (Lidl Plus, Willys, ICA…). The bot itemises it, translates Swedish item names, applies discounts and checks the total. Then tap **Add all**. A caption on the photo (like `yesterday`) is used as a hint.

- Pasted Lidl/Willys/ICA text is read by the built-in parser.
- Photos, and text in formats the parser doesn't know, are read by **Cloudflare Workers AI** (Mistral Small 3.1), free within Cloudflare's daily allowance (about 100 receipts a day). Past the allowance the bot says so and you can paste the text instead; nothing is charged. A photo takes about 15–20 seconds.
- **Bank app screenshots** work too: each payment becomes its own entry with its own date and shop (amounts in kr, even when a foreign amount is shown). Possible duplicates are flagged, and you choose **Add new** or **Add all**.
- Entries read by AI have "Read by Cloudflare AI" in their note. Always glance at the preview: the bot warns when the items don't add up to the receipt total.
- **Total-only receipts:** if a receipt shows only the amount paid (a card slip, a till receipt without items, or just a "Total" line), the preview warns that the items must be entered too, and asks for the itemised receipt or the items typed one by one. You can still save it as one "Groceries (not itemized)" entry with **Add total only**. The artifact's receipt window warns the same way.

### Optional: Claude instead of the free model
Claude reads receipts more reliably and also reads PDFs, but the Claude API is paid per use (a few US cents per receipt) and is **not** included in a Claude Pro/Max subscription. To switch, create a key at https://platform.claude.com (add credit under **Billing**), then:
```bash
npx wrangler secret put ANTHROPIC_API_KEY
```
To go back to the free model: `npx wrangler secret delete ANTHROPIC_API_KEY`.

**Duplicate warnings:** before anything is added, the bot checks whether it's probably already in your ledger: the same amount within 2 days at the same shop or for the same thing, a bank payment that matches an itemised receipt from that shop and day, or a receipt whose amounts are mostly already there. Typed expenses then ask **Add anyway / Don't add**, receipts show a warning on the preview, bank screenshots list the possible duplicates separately, and the Mini App asks before saving.

Commands: `/summary` · `/today` · `/last` · `/cats` · `/bills` · `/budget` · `/undo` · `/export` (CSV file; `/export all` or `/export 2026-09`) · `/app` · `/deleteaccount`

## The Mini App

Tap **Kassabok** next to the message box. It has four tabs:
- **Overview:** spent so far, comparison with the same day last period, projection to period end, budget meter, fixed/everyday/one-off split, pace chart, day-by-day chart, categories (with last period and budget markers), recurring bills (paid/due/late), calendar heatmap, top stores. Use ‹ › to move between periods.
- **Trends:** period totals, average everyday spend per weekday, top items.
- **Entries:** search and filter, tap an entry to edit or delete it.
- **Budgets:** set a budget per category and your household income.
- **+ button:** add an expense (quick-add text or the full form).

Same rules as the original Kassabok: periods run **25th → 24th**, with the same categories and the same fixed/everyday/one-off groups.

---

## REST API

Base URL: your Worker URL. Authentication is `Authorization: Bearer <API_KEY>`, which gives access to the household ledger (ledger 1) only. The Mini App signs in automatically with Telegram `initData` and sees the signed-in person's own ledger.

| Method | Path | |
|---|---|---|
| GET | `/api/health` | no auth |
| GET | `/api/meta` | today, current period, periods, categories, stores |
| GET | `/api/summary?period=2026-10` | everything the overview shows (totals, projection, categories, bills, daily, cumulative) |
| GET | `/api/trends` | per-period totals, weekday averages, top items |
| GET | `/api/transactions?period=2026-10&q=&cat=&store=&from=&to=&sort=new\|old\|big&limit=&offset=` | `period=all` for every period |
| POST | `/api/transactions` | one object or an array (max 200) |
| POST | `/api/transactions/check` | one object; returns `{"duplicate": null}` or the entries it probably duplicates |
| GET / PATCH / PUT / DELETE | `/api/transactions/:id` | |
| POST | `/api/quick` | `{"text":"45 Willys bread"}` parses and saves; add `"dryRun":true` to only parse |
| GET / PUT | `/api/settings` | `{"budgets":{"Groceries":3000},"income":30000}` |
| GET | `/api/export.csv?period=2026-10` | or `period=all` |

A transaction looks like this:
```json
{ "date": "2026-11-07", "item": "Bread", "store": "Willys", "cat": "Groceries", "amount": 45, "toman": 0, "note": "", "oneOff": false }
```

Example:
```bash
curl -H "Authorization: Bearer $API_KEY" -H "content-type: application/json" \
  -d '{"text":"45 Willys bread"}' https://kassabok.<you>.workers.dev/api/quick
```

## claude.ai connector (for the Kassabok artifact and Claude chats)
The Worker is also an MCP server, so claude.ai can use the household ledger (ledger 1) as a connector. The Kassabok artifact reads and writes the ledger through it (so it stays in sync with Telegram), and its Ask Claude box can add and edit expenses.

1. Set a secret: `openssl rand -hex 24`, then `npx wrangler secret put MCP_SECRET` and paste it.
2. Your connector URL is `https://<your worker>/mcp/<MCP_SECRET>`. Anyone with this URL can read and change the household ledger, so keep it private.
3. In claude.ai → Settings → Connectors → **Add custom connector**: name it exactly **Kassabok** and paste the URL (no OAuth needed).

Tools: `get_overview`, `list_transactions`, `get_summary`, `add_transactions` (refuses likely duplicates unless `allow_duplicates`), `update_transaction`, `delete_transaction`, `set_budgets`. To revoke access, set a new `MCP_SECRET` and update the connector URL.

## Security
- Every database query is limited to the caller's own ledger, so one account can't read or change another's entries, even by guessing ids. Mini App requests are verified with Telegram's HMAC signature, and the signature is valid for 24 hours.
- The webhook only accepts calls that carry your `WEBHOOK_SECRET`.
- Secrets live in Cloudflare (`wrangler secret`) and never in the code.
- `migration/export/` and `migration/seed.sql` contain your financial data. They are in `.gitignore`, so don't commit them to a public repo.

## Local development
```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 execute kassabok --local --file=schema.sql
npx wrangler d1 execute kassabok --local --file=migration/seed.sql
npm run dev          # http://localhost:8787/app/  (paste "testkey" as the API key)
npm test             # unit tests for periods, parsing, stats, signature check, AI receipt mapping
```

## Files
```
src/index.js   router + REST API
src/bot.js     Telegram bot
src/core.js    Kassabok logic: periods, categories, quick-add and receipt parsing, stats
src/db.js      D1 queries
src/auth.js    API key + Telegram initData verification
src/receipt-ai.js  reading receipt photos with Workers AI (free) or Claude (optional)
src/mcp.js     claude.ai connector (MCP server) for the household ledger
public/app/    the Mini App (HTML/CSS/JS, Chart.js)
schema.sql     database tables (fresh install)
migration/     export from the Kassabok artifact → seed.sql; accounts.sql upgrades an older database
```
