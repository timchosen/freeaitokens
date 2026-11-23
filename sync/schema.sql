-- FreeAITokens sync: only hashes, sizes, times and versions. Contents live encrypted in R2.
-- All times are milliseconds since 1970.
CREATE TABLE IF NOT EXISTS licenses (
  key_hash TEXT PRIMARY KEY,
  plan TEXT NOT NULL,
  stripe_customer TEXT,
  stripe_ref TEXT,
  first_session TEXT UNIQUE NOT NULL,
  email_hash TEXT,
  paid_until INTEGER,
  revoked INTEGER,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS licenses_email ON licenses(email_hash);
CREATE INDEX IF NOT EXISTS licenses_ref ON licenses(stripe_ref);
CREATE INDEX IF NOT EXISTS licenses_customer ON licenses(stripe_customer);

CREATE TABLE IF NOT EXISTS vaults (key_hash TEXT PRIMARY KEY, version INTEGER NOT NULL, body TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS items (
  key_hash TEXT NOT NULL,
  id TEXT NOT NULL,
  version INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  size INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL,
  PRIMARY KEY (key_hash, id)
);
CREATE INDEX IF NOT EXISTS items_seq ON items(key_hash, seq);

CREATE TABLE IF NOT EXISTS counters (key_hash TEXT PRIMARY KEY, seq INTEGER NOT NULL, bytes INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS claims (claim_hash TEXT PRIMARY KEY, key_box TEXT NOT NULL, expires INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, seen INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS rates (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, window INTEGER NOT NULL);
