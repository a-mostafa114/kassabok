-- One-time migration to accounts (run once on a database created before accounts existed):
--   npx wrangler d1 execute kassabok --remote --file=migration/accounts.sql
-- Everything already in the database becomes ledger 1, shared by the people in ALLOWED_USER_IDS.

CREATE TABLE IF NOT EXISTS ledgers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT OR IGNORE INTO ledgers (id, name) VALUES (1, 'Household');

CREATE TABLE IF NOT EXISTS users (
  tg_id      TEXT PRIMARY KEY,
  ledger_id  INTEGER NOT NULL,
  name       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ai_day     TEXT,
  ai_count   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS users_ledger ON users(ledger_id);

ALTER TABLE tx ADD COLUMN ledger_id INTEGER NOT NULL DEFAULT 1;
DROP INDEX IF EXISTS tx_period;
DROP INDEX IF EXISTS tx_date;
CREATE INDEX IF NOT EXISTS tx_ledger_period ON tx(ledger_id, period);
CREATE INDEX IF NOT EXISTS tx_ledger_date ON tx(ledger_id, date);

CREATE TABLE settings_new (
  ledger_id INTEGER NOT NULL,
  k         TEXT NOT NULL,
  v         TEXT NOT NULL,
  PRIMARY KEY (ledger_id, k)
);
INSERT INTO settings_new (ledger_id, k, v) SELECT 1, k, v FROM settings;
DROP TABLE settings;
ALTER TABLE settings_new RENAME TO settings;

ALTER TABLE pending ADD COLUMN ledger_id INTEGER NOT NULL DEFAULT 1;
