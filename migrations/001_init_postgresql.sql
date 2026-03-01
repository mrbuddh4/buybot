-- PostgreSQL schema initialization for buybot

CREATE TABLE IF NOT EXISTS watched_tokens (
  id SERIAL PRIMARY KEY,
  chat_id BIGINT NOT NULL,
  token_address TEXT NOT NULL,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  alert_media_type TEXT,
  alert_media_file_id TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (chat_id, token_address)
);

CREATE TABLE IF NOT EXISTS detected_transactions (
  id SERIAL PRIMARY KEY,
  token_address TEXT NOT NULL,
  tx_hash TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  trader_address TEXT NOT NULL,
  token_amount TEXT NOT NULL,
  eth_amount TEXT NOT NULL,
  transaction_value_usd DOUBLE PRECISION,
  detected_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_alert_links (
  chat_id BIGINT PRIMARY KEY,
  website_url TEXT,
  telegram_url TEXT,
  x_url TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS chat_settings (
  chat_id BIGINT PRIMARY KEY,
  min_buy_usdc DOUBLE PRECISION DEFAULT 0,
  icon_multiplier INTEGER DEFAULT 1,
  buy_icon_pattern TEXT DEFAULT '🟢⚔️',
  alert_media_type TEXT,
  alert_media_file_id TEXT,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trader_positions (
  token_address TEXT NOT NULL,
  trader_address TEXT NOT NULL,
  holdings_token TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (token_address, trader_address)
);

CREATE INDEX IF NOT EXISTS idx_chat_tokens ON watched_tokens(chat_id);
CREATE INDEX IF NOT EXISTS idx_token_address ON watched_tokens(token_address);
CREATE INDEX IF NOT EXISTS idx_tx_hash ON detected_transactions(tx_hash);
CREATE INDEX IF NOT EXISTS idx_chat_alert_links ON chat_alert_links(chat_id);
CREATE INDEX IF NOT EXISTS idx_chat_settings ON chat_settings(chat_id);
CREATE INDEX IF NOT EXISTS idx_trader_positions ON trader_positions(token_address, trader_address);
