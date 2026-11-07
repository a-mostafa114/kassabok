-- Kassabok database (Cloudflare D1 / SQLite)
-- Each account is a ledger; every row of tx, settings and pending belongs to one ledger.
-- An existing database from before accounts: run migration/accounts.sql once instead.

CREATE TABLE IF NOT EXISTS ledgers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO ledgers (id, name) VALUES (1, 'Household');

-- Telegram users and the ledger they use (ledger 1 is shared by ALLOWED_USER_IDS)
CREATE TABLE IF NOT EXISTS users (
  tg_id      TEXT PRIMARY KEY,
  ledger_id  INTEGER NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ai_day     TEXT,                       -- day of the last AI receipt read, for the daily limit
  ai_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS users_ledger ON users(ledger_id);

CREATE TABLE IF NOT EXISTS tx (
  id         TEXT PRIMARY KEY,
  ledger_id  INTEGER NOT NULL DEFAULT 1,
  date       TEXT NOT NULL,              -- YYYY-MM-DD
  period     TEXT NOT NULL,              -- YYYY-MM (period starting the 25th of that month)
  cat        TEXT NOT NULL,
  item       TEXT NOT NULL,
  store      TEXT NOT NULL DEFAULT '',
  amount     REAL NOT NULL DEFAULT 0,    -- SEK
  toman      REAL NOT NULL DEFAULT 0,    -- rent paid in toman
  orig       TEXT,                       -- original receipt text
  qty        TEXT,
  note       TEXT,
  one_off    INTEGER NOT NULL DEFAULT 0,
  ord        INTEGER NOT NULL DEFAULT 0, -- ordering within a day (ms timestamp)
  source     TEXT,                       -- 'import' | 'bot' | 'app' | 'api'
  created_by TEXT,                       -- telegram user id, or 'api'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS tx_ledger_period ON tx(ledger_id, period);
CREATE INDEX IF NOT EXISTS tx_ledger_date ON tx(ledger_id, date);

-- per-ledger key/value settings: 'budgets' (JSON object cat -> SEK), 'income' (number)
CREATE TABLE IF NOT EXISTS settings (
  ledger_id INTEGER NOT NULL,
  k         TEXT NOT NULL,
  v         TEXT NOT NULL,
  PRIMARY KEY (ledger_id, k)
);

-- receipts parsed by the bot, waiting for the user to tap "Add all"
CREATE TABLE IF NOT EXISTS pending (
  id         TEXT PRIMARY KEY,
  ledger_id  INTEGER NOT NULL DEFAULT 1,
  user_id    TEXT NOT NULL,
  payload    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Telegram update ids already handled, so a retried webhook isn't processed twice
CREATE TABLE IF NOT EXISTS seen_updates (
  id INTEGER PRIMARY KEY,
  at INTEGER NOT NULL
);
