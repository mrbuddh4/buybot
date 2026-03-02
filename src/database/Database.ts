import { Pool, PoolClient } from 'pg';
import { logger } from '../utils/logger';
import * as fs from 'fs';
import * as path from 'path';

export interface WatchedToken {
  id: number;
  chat_id: number;
  token_address: string;
  symbol: string;
  name: string;
  alert_media_type: 'photo' | 'animation' | null;
  alert_media_file_id: string | null;
  created_at: string;
}

export interface DetectedTransaction {
  id: number;
  token_address: string;
  tx_hash: string;
  type: string;
  trader_address: string;
  token_amount: string;
  eth_amount: string;
  transaction_value_usd: number | null;
  detected_at: string;
}

export interface LargestRecentBuy {
  tx_hash: string;
  trader_address: string;
  transaction_value_usd: number;
  detected_at: string;
}

export interface RecentTokenActivitySummary {
  volume24hUsd: number | null;
  buyers24h: number | null;
  sellers24h: number | null;
  biggestBuy24hUsd: number | null;
  holdersEstimate: number | null;
}

export interface TokenActivityAllTimeSummary {
  volumeAllTimeUsd: number | null;
  biggestBuyAllTimeUsd: number | null;
  buyTxCountAllTime: number;
  sellTxCountAllTime: number;
}

export interface AlertLinks {
  website_url: string | null;
  telegram_url: string | null;
  x_url: string | null;
}

export interface ChatSettings {
  min_buy_usdc: number;
  icon_multiplier: number;
  buy_icon_pattern: string;
  alert_media_type: 'photo' | 'animation' | null;
  alert_media_file_id: string | null;
}

export interface TraderPositionSnapshot {
  token_address: string;
  trader_address: string;
  holdings_token: string;
}

export class Database {
  private static instance: Database;
  private pool!: Pool;
  private singletonLockClient: PoolClient | null = null;
  private singletonLockName: string | null = null;

  private constructor() {}

  static getInstance(): Database {
    if (!Database.instance) {
      Database.instance = new Database();
    }
    return Database.instance;
  }

  async initialize(): Promise<void> {
    try {
      const connectionString = process.env.DATABASE_URL;
      if (connectionString && connectionString.includes('${{')) {
        throw new Error(
          'DATABASE_URL contains an unresolved template placeholder. Set a real PostgreSQL URL for local runs (e.g. postgres://user:pass@localhost:5432/db) or configure platform env vars.'
        );
      }
      this.pool = new Pool(
        connectionString
          ? {
              connectionString,
              ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
            }
          : {
              host: process.env.PGHOST || 'localhost',
              port: parseInt(process.env.PGPORT || '5432', 10),
              database: process.env.PGDATABASE || 'buybot',
              user: process.env.PGUSER || 'postgres',
              password: process.env.PGPASSWORD || '',
              ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined,
            }
      );

      await this.pool.query('SELECT 1');
      logger.info('PostgreSQL connected');
      await this.createTables();
    } catch (error) {
      const maybeAggregate = error as { errors?: unknown[] };
      if (Array.isArray(maybeAggregate.errors)) {
        const innerErrors = maybeAggregate.errors.map((inner: unknown) => `${inner}`).join(' | ');
        logger.error(`PostgreSQL aggregate connection errors: ${innerErrors}`);
      }
      logger.error('Error connecting to PostgreSQL:', error);
      throw error;
    }
  }

  async runMigrations(): Promise<void> {
    const migrationsDir = path.resolve(process.cwd(), 'migrations');

    if (!fs.existsSync(migrationsDir)) {
      logger.info('No migrations directory found; skipping migrations');
      return;
    }

    const migrationFiles = fs
      .readdirSync(migrationsDir)
      .filter((file) => file.endsWith('.sql'))
      .sort();

    if (migrationFiles.length === 0) {
      logger.info('No SQL migration files found; skipping migrations');
      return;
    }

    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const filename of migrationFiles) {
      const alreadyApplied = await this.pool.query(
        'SELECT 1 FROM schema_migrations WHERE filename = $1 LIMIT 1',
        [filename]
      );

      if ((alreadyApplied.rowCount ?? 0) > 0) {
        continue;
      }

      const filePath = path.join(migrationsDir, filename);
      const sql = fs.readFileSync(filePath, 'utf8').trim();

      if (!sql) {
        await this.pool.query('INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING', [filename]);
        continue;
      }

      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING',
          [filename]
        );
        await client.query('COMMIT');
        logger.info(`Applied migration: ${filename}`);
      } catch (error) {
        await client.query('ROLLBACK');
        logger.error(`Failed migration: ${filename}`, error);
        throw error;
      } finally {
        client.release();
      }
    }
  }

  private async createTables(): Promise<void> {
    try {
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS watched_tokens (
          id SERIAL PRIMARY KEY,
          chat_id BIGINT NOT NULL,
          token_address TEXT NOT NULL,
          symbol TEXT NOT NULL,
          name TEXT NOT NULL,
          alert_media_type TEXT,
          alert_media_file_id TEXT,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(chat_id, token_address)
        )
      `);

      await this.pool.query(`
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
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS chat_alert_links (
          chat_id BIGINT PRIMARY KEY,
          website_url TEXT,
          telegram_url TEXT,
          x_url TEXT,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS chat_settings (
          chat_id BIGINT PRIMARY KEY,
          min_buy_usdc DOUBLE PRECISION DEFAULT 0,
          icon_multiplier INTEGER DEFAULT 1,
          buy_icon_pattern TEXT DEFAULT '🟢⚔️',
          alert_media_type TEXT,
          alert_media_file_id TEXT,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS trader_positions (
          token_address TEXT NOT NULL,
          trader_address TEXT NOT NULL,
          holdings_token TEXT NOT NULL,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          PRIMARY KEY (token_address, trader_address)
        )
      `);

      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS hourly_status_deliveries (
          id SERIAL PRIMARY KEY,
          bucket_start TIMESTAMPTZ NOT NULL,
          token_address TEXT NOT NULL,
          chat_id BIGINT NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(bucket_start, token_address, chat_id)
        )
      `);

      await this.addColumnIfMissing('chat_settings', 'alert_media_type', 'TEXT');
      await this.addColumnIfMissing('chat_settings', 'alert_media_file_id', 'TEXT');
      await this.addColumnIfMissing('chat_settings', 'buy_icon_pattern', "TEXT DEFAULT '🟢⚔️'");
      await this.addColumnIfMissing('watched_tokens', 'alert_media_type', 'TEXT');
      await this.addColumnIfMissing('watched_tokens', 'alert_media_file_id', 'TEXT');
      await this.addColumnIfMissing('detected_transactions', 'transaction_value_usd', 'DOUBLE PRECISION');

      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_tokens ON watched_tokens(chat_id)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_token_address ON watched_tokens(token_address)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_tx_hash ON detected_transactions(tx_hash)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_alert_links ON chat_alert_links(chat_id)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_chat_settings ON chat_settings(chat_id)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_trader_positions ON trader_positions(token_address, trader_address)`);
      await this.pool.query(`CREATE INDEX IF NOT EXISTS idx_hourly_status_deliveries_bucket ON hourly_status_deliveries(bucket_start)`);

      logger.info('Database tables created');
    } catch (error) {
      logger.error('Error creating tables:', error);
      throw error;
    }
  }

  async addWatchedToken(chatId: number, tokenAddress: string, symbol: string, name: string): Promise<void> {
    try {
      await this.pool.query(
        'INSERT INTO watched_tokens (chat_id, token_address, symbol, name) VALUES ($1, $2, $3, $4) ON CONFLICT (chat_id, token_address) DO NOTHING',
        [chatId, tokenAddress.toLowerCase(), symbol, name]
      );

      logger.info(`Token added to watchlist: ${symbol} for chat ${chatId}`);
    } catch (error) {
      logger.error('Error adding watched token:', error);
      throw error;
    }
  }

  async removeWatchedToken(chatId: number, tokenAddress: string): Promise<void> {
    try {
      await this.pool.query(
        'DELETE FROM watched_tokens WHERE chat_id = $1 AND token_address = $2',
        [chatId, tokenAddress.toLowerCase()]
      );

      logger.info(`Token removed from watchlist for chat ${chatId}`);
    } catch (error) {
      logger.error('Error removing watched token:', error);
      throw error;
    }
  }

  async getWatchedTokens(chatId: number): Promise<Array<{ symbol: string; address: string; name: string }>> {
    try {
      const { rows } = await this.pool.query(
        'SELECT token_address, symbol, name FROM watched_tokens WHERE chat_id = $1 ORDER BY created_at DESC',
        [chatId]
      );

      return rows.map(row => ({
        symbol: row.symbol,
        address: row.token_address,
        name: row.name,
      }));
    } catch (error) {
      logger.error('Error getting watched tokens:', error);
      throw error;
    }
  }

  async getAllWatchedTokens(): Promise<Array<{ token_address: string; symbol: string }>> {
    try {
      const { rows } = await this.pool.query(
        'SELECT token_address, MAX(symbol) AS symbol FROM watched_tokens GROUP BY token_address'
      );

      return rows;
    } catch (error) {
      logger.error('Error getting all watched tokens:', error);
      throw error;
    }
  }

  async isWatchingToken(chatId: number, tokenAddress: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'SELECT 1 FROM watched_tokens WHERE chat_id = $1 AND token_address = $2 LIMIT 1',
        [chatId, tokenAddress.toLowerCase()]
      );

      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      logger.error('Error checking if watching token:', error);
      throw error;
    }
  }

  async getTokenWatchers(tokenAddress: string): Promise<Array<{
    chat_id: number;
    alert_media_type: 'photo' | 'animation' | null;
    alert_media_file_id: string | null;
  }>> {
    try {
      const { rows } = await this.pool.query(
        'SELECT DISTINCT chat_id, alert_media_type, alert_media_file_id FROM watched_tokens WHERE token_address = $1',
        [tokenAddress.toLowerCase()]
      );

      return rows.map((row) => ({
        chat_id: row.chat_id,
        alert_media_type: row.alert_media_type === 'photo' || row.alert_media_type === 'animation'
          ? row.alert_media_type
          : null,
        alert_media_file_id: row.alert_media_file_id || null,
      }));
    } catch (error) {
      logger.error('Error getting token watchers:', error);
      throw error;
    }
  }

  async saveDetectedTransaction(
    tokenAddress: string,
    txHash: string,
    type: string,
    traderAddress: string,
    tokenAmount: string,
    ethAmount: string,
    transactionValueUsd: number | null = null
  ): Promise<boolean> {
    try {
      const result = await this.pool.query(
        `INSERT INTO detected_transactions
          (token_address, tx_hash, type, trader_address, token_amount, eth_amount, transaction_value_usd)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (tx_hash) DO NOTHING`,
        [tokenAddress.toLowerCase(), txHash, type, traderAddress, tokenAmount, ethAmount, transactionValueUsd]
      );

      const inserted = (result.rowCount ?? 0) > 0;
      if (inserted) {
        logger.info(`Transaction saved: ${txHash}`);
      }
      return inserted;
    } catch (error) {
      logger.error('Error saving detected transaction:', error);
      throw error;
    }
  }

  async hasDetectedTransaction(txHash: string): Promise<boolean> {
    try {
      const result = await this.pool.query(
        'SELECT 1 FROM detected_transactions WHERE tx_hash = $1 LIMIT 1',
        [txHash]
      );

      return (result.rowCount ?? 0) > 0;
    } catch (error) {
      logger.error('Error checking detected transaction:', error);
      throw error;
    }
  }

  async getLargestRecentBuyUsd(tokenAddress: string, lookbackHours: number = 24): Promise<LargestRecentBuy | null> {
    try {
      const safeLookbackHours = Number.isFinite(lookbackHours)
        ? Math.max(1, Math.min(168, Math.floor(lookbackHours)))
        : 24;

      const { rows } = await this.pool.query(
        `SELECT tx_hash, trader_address, transaction_value_usd, detected_at
         FROM detected_transactions
         WHERE token_address = $1
           AND type = 'buy'
           AND transaction_value_usd IS NOT NULL
           AND detected_at >= NOW() - ($2::text || ' hours')::interval
         ORDER BY transaction_value_usd DESC, detected_at DESC
         LIMIT 1`,
        [tokenAddress.toLowerCase(), safeLookbackHours]
      );

      const row = rows[0];
      if (!row) {
        return null;
      }

      const usdValue = Number(row.transaction_value_usd);
      if (!Number.isFinite(usdValue) || usdValue < 0) {
        return null;
      }

      return {
        tx_hash: String(row.tx_hash),
        trader_address: String(row.trader_address),
        transaction_value_usd: usdValue,
        detected_at: String(row.detected_at),
      };
    } catch (error) {
      logger.error('Error getting largest recent buy:', error);
      throw error;
    }
  }

  async getRecentTokenActivitySummary(
    tokenAddress: string,
    lookbackHours: number = 24
  ): Promise<RecentTokenActivitySummary> {
    try {
      const safeLookbackHours = Number.isFinite(lookbackHours)
        ? Math.max(1, Math.min(168, Math.floor(lookbackHours)))
        : 24;

      const [{ rows: activityRows }, { rows: holderRows }] = await Promise.all([
        this.pool.query(
          `SELECT
             SUM(transaction_value_usd) AS volume_24h_usd,
             COUNT(DISTINCT CASE WHEN type = 'buy' THEN trader_address END) AS buyers_24h,
             COUNT(DISTINCT CASE WHEN type = 'sell' THEN trader_address END) AS sellers_24h,
             MAX(CASE WHEN type = 'buy' THEN transaction_value_usd END) AS biggest_buy_24h_usd
           FROM detected_transactions
           WHERE token_address = $1
             AND detected_at >= NOW() - ($2::text || ' hours')::interval`,
          [tokenAddress.toLowerCase(), safeLookbackHours]
        ),
        this.pool.query(
          `SELECT COUNT(*)::int AS holders_estimate
           FROM trader_positions
           WHERE token_address = $1
             AND holdings_token ~ '^[0-9]+(\\.[0-9]+)?$'
             AND holdings_token::double precision > 0`,
          [tokenAddress.toLowerCase()]
        ),
      ]);

      const activity = activityRows[0] || {};
      const holdersRaw = holderRows[0]?.holders_estimate;

      const volume24hUsd = Number(activity.volume_24h_usd);
      const buyers24h = Number(activity.buyers_24h);
      const sellers24h = Number(activity.sellers_24h);
      const biggestBuy24hUsd = Number(activity.biggest_buy_24h_usd);
      const holdersEstimate = Number(holdersRaw);

      return {
        volume24hUsd: Number.isFinite(volume24hUsd) && volume24hUsd > 0 ? volume24hUsd : null,
        buyers24h: Number.isFinite(buyers24h) ? Math.max(0, Math.floor(buyers24h)) : null,
        sellers24h: Number.isFinite(sellers24h) ? Math.max(0, Math.floor(sellers24h)) : null,
        biggestBuy24hUsd: Number.isFinite(biggestBuy24hUsd) && biggestBuy24hUsd > 0 ? biggestBuy24hUsd : null,
        holdersEstimate: Number.isFinite(holdersEstimate) ? Math.max(0, Math.floor(holdersEstimate)) : null,
      };
    } catch (error) {
      logger.error('Error getting recent token activity summary:', error);
      return {
        volume24hUsd: null,
        buyers24h: null,
        sellers24h: null,
        biggestBuy24hUsd: null,
        holdersEstimate: null,
      };
    }
  }

  async getTokenActivitySummaryAllTime(tokenAddress: string): Promise<TokenActivityAllTimeSummary> {
    try {
      const { rows } = await this.pool.query(
        `SELECT
           SUM(transaction_value_usd) AS volume_all_time_usd,
           MAX(CASE WHEN type = 'buy' THEN transaction_value_usd END) AS biggest_buy_all_time_usd,
           COUNT(*) FILTER (WHERE type = 'buy') AS buy_tx_count_all_time,
           COUNT(*) FILTER (WHERE type = 'sell') AS sell_tx_count_all_time
         FROM detected_transactions
         WHERE token_address = $1`,
        [tokenAddress.toLowerCase()]
      );

      const row = rows[0] || {};
      const volumeAllTimeUsd = Number(row.volume_all_time_usd);
      const biggestBuyAllTimeUsd = Number(row.biggest_buy_all_time_usd);
      const buyTxCountAllTime = Number(row.buy_tx_count_all_time);
      const sellTxCountAllTime = Number(row.sell_tx_count_all_time);

      return {
        volumeAllTimeUsd: Number.isFinite(volumeAllTimeUsd) && volumeAllTimeUsd > 0 ? volumeAllTimeUsd : null,
        biggestBuyAllTimeUsd: Number.isFinite(biggestBuyAllTimeUsd) && biggestBuyAllTimeUsd > 0 ? biggestBuyAllTimeUsd : null,
        buyTxCountAllTime: Number.isFinite(buyTxCountAllTime) ? Math.max(0, Math.floor(buyTxCountAllTime)) : 0,
        sellTxCountAllTime: Number.isFinite(sellTxCountAllTime) ? Math.max(0, Math.floor(sellTxCountAllTime)) : 0,
      };
    } catch (error) {
      logger.error('Error getting token all-time activity summary:', error);
      return {
        volumeAllTimeUsd: null,
        biggestBuyAllTimeUsd: null,
        buyTxCountAllTime: 0,
        sellTxCountAllTime: 0,
      };
    }
  }

  async hasTokenHistoryWindow(tokenAddress: string, minimumHours: number = 24): Promise<boolean> {
    try {
      const safeHours = Number.isFinite(minimumHours)
        ? Math.max(1, Math.min(168, Math.floor(minimumHours)))
        : 24;

      const { rows } = await this.pool.query(
        `SELECT MIN(detected_at) AS first_detected_at
         FROM detected_transactions
         WHERE token_address = $1`,
        [tokenAddress.toLowerCase()]
      );

      const firstDetectedAtRaw = rows[0]?.first_detected_at;
      if (!firstDetectedAtRaw) {
        return false;
      }

      const firstDetectedAt = new Date(firstDetectedAtRaw);
      if (Number.isNaN(firstDetectedAt.getTime())) {
        return false;
      }

      const elapsedMs = Date.now() - firstDetectedAt.getTime();
      return elapsedMs >= safeHours * 60 * 60 * 1000;
    } catch (error) {
      logger.error('Error checking token history window:', error);
      return false;
    }
  }

  async claimHourlyStatusDelivery(tokenAddress: string, chatId: number, bucketStart: Date): Promise<boolean> {
    try {
      const { rowCount } = await this.pool.query(
        `INSERT INTO hourly_status_deliveries (bucket_start, token_address, chat_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (bucket_start, token_address, chat_id) DO NOTHING`,
        [bucketStart.toISOString(), tokenAddress.toLowerCase(), chatId]
      );

      return (rowCount ?? 0) > 0;
    } catch (error) {
      logger.error('Error claiming hourly status delivery:', error);
      return false;
    }
  }

  async acquireSingletonProcessLock(lockName: string = 'buybot-main'): Promise<void> {
    const normalizedLockName = lockName.trim() || 'buybot-main';

    if (this.singletonLockClient) {
      return;
    }

    try {
      const client = await this.pool.connect();
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [normalizedLockName]);

      this.singletonLockClient = client;
      this.singletonLockName = normalizedLockName;
      logger.info(`Acquired singleton process lock: ${normalizedLockName}`);
    } catch (error) {
      logger.error('Error acquiring singleton process lock:', error);
      throw error;
    }
  }

  async releaseSingletonProcessLock(): Promise<void> {
    if (!this.singletonLockClient || !this.singletonLockName) {
      return;
    }

    const client = this.singletonLockClient;
    const lockName = this.singletonLockName;

    this.singletonLockClient = null;
    this.singletonLockName = null;

    try {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', [lockName]);
      logger.info(`Released singleton process lock: ${lockName}`);
    } catch (error) {
      logger.error('Error releasing singleton process lock:', error);
    } finally {
      client.release();
    }
  }

  async getAlertLinks(chatId: number): Promise<AlertLinks> {
    try {
      const { rows } = await this.pool.query(
        'SELECT website_url, telegram_url, x_url FROM chat_alert_links WHERE chat_id = $1',
        [chatId]
      );
      const row = rows[0];

      if (!row) {
        return {
          website_url: null,
          telegram_url: null,
          x_url: null,
        };
      }

      return {
        website_url: row.website_url,
        telegram_url: row.telegram_url,
        x_url: row.x_url,
      };
    } catch (error) {
      logger.error('Error getting alert links:', error);
      throw error;
    }
  }

  async setAlertLink(chatId: number, platform: 'website' | 'telegram' | 'x', url: string): Promise<void> {
    const columnMap = {
      website: 'website_url',
      telegram: 'telegram_url',
      x: 'x_url',
    } as const;

    const columnName = columnMap[platform];

    try {
      await this.pool.query('INSERT INTO chat_alert_links (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [chatId]);
      await this.pool.query(
        `UPDATE chat_alert_links SET ${columnName} = $1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $2`,
        [url, chatId]
      );
    } catch (error) {
      logger.error('Error setting alert link:', error);
      throw error;
    }
  }

  async clearAlertLinks(chatId: number): Promise<void> {
    try {
      await this.pool.query(
        'DELETE FROM chat_alert_links WHERE chat_id = $1',
        [chatId]
      );
    } catch (error) {
      logger.error('Error clearing alert links:', error);
      throw error;
    }
  }

  async getChatSettings(chatId: number): Promise<ChatSettings> {
    try {
      const { rows } = await this.pool.query(
        'SELECT min_buy_usdc, icon_multiplier, buy_icon_pattern, alert_media_type, alert_media_file_id FROM chat_settings WHERE chat_id = $1',
        [chatId]
      );
      const row = rows[0];

      if (!row) {
        return {
          min_buy_usdc: 0,
          icon_multiplier: 1,
          buy_icon_pattern: '🟢⚔️',
          alert_media_type: null,
          alert_media_file_id: null,
        };
      }

      return {
        min_buy_usdc: Number(row.min_buy_usdc) || 0,
        icon_multiplier: Math.max(1, Number(row.icon_multiplier) || 1),
        buy_icon_pattern: String(row.buy_icon_pattern || '🟢⚔️').trim() || '🟢⚔️',
        alert_media_type: row.alert_media_type === 'photo' || row.alert_media_type === 'animation'
          ? row.alert_media_type
          : null,
        alert_media_file_id: row.alert_media_file_id || null,
      };
    } catch (error) {
      logger.error('Error getting chat settings:', error);
      throw error;
    }
  }

  async setMinBuyUsdc(chatId: number, minBuyUsdc: number): Promise<void> {
    try {
      await this.pool.query('INSERT INTO chat_settings (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [chatId]);
      await this.pool.query(
        'UPDATE chat_settings SET min_buy_usdc = $1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $2',
        [Math.max(0, minBuyUsdc), chatId]
      );
    } catch (error) {
      logger.error('Error setting min buy setting:', error);
      throw error;
    }
  }

  async setIconMultiplier(chatId: number, iconMultiplier: number): Promise<void> {
    try {
      await this.pool.query('INSERT INTO chat_settings (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [chatId]);
      await this.pool.query(
        'UPDATE chat_settings SET icon_multiplier = $1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $2',
        [Math.max(1, Math.min(5, Math.floor(iconMultiplier))), chatId]
      );
    } catch (error) {
      logger.error('Error setting icon multiplier:', error);
      throw error;
    }
  }

  async setBuyIconPattern(chatId: number, buyIconPattern: string): Promise<void> {
    try {
      const pattern = buyIconPattern.trim() || '🟢⚔️';
      await this.pool.query('INSERT INTO chat_settings (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [chatId]);
      await this.pool.query(
        'UPDATE chat_settings SET buy_icon_pattern = $1, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $2',
        [pattern, chatId]
      );
    } catch (error) {
      logger.error('Error setting buy icon pattern:', error);
      throw error;
    }
  }

  async setAlertMedia(chatId: number, mediaType: 'photo' | 'animation', fileId: string): Promise<void> {
    try {
      await this.pool.query('INSERT INTO chat_settings (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [chatId]);
      await this.pool.query(
        'UPDATE chat_settings SET alert_media_type = $1, alert_media_file_id = $2, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $3',
        [mediaType, fileId, chatId]
      );
    } catch (error) {
      logger.error('Error setting alert media:', error);
      throw error;
    }
  }

  async setWatchedTokenMedia(chatId: number, tokenAddress: string, mediaType: 'photo' | 'animation', fileId: string): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE watched_tokens SET alert_media_type = $1, alert_media_file_id = $2 WHERE chat_id = $3 AND token_address = $4',
        [mediaType, fileId, chatId, tokenAddress.toLowerCase()]
      );
    } catch (error) {
      logger.error('Error setting watched token media:', error);
      throw error;
    }
  }

  async clearWatchedTokenMedia(chatId: number, tokenAddress: string): Promise<void> {
    try {
      await this.pool.query(
        'UPDATE watched_tokens SET alert_media_type = NULL, alert_media_file_id = NULL WHERE chat_id = $1 AND token_address = $2',
        [chatId, tokenAddress.toLowerCase()]
      );
    } catch (error) {
      logger.error('Error clearing watched token media:', error);
      throw error;
    }
  }

  async clearAlertMedia(chatId: number): Promise<void> {
    try {
      await this.pool.query('INSERT INTO chat_settings (chat_id) VALUES ($1) ON CONFLICT (chat_id) DO NOTHING', [chatId]);
      await this.pool.query(
        'UPDATE chat_settings SET alert_media_type = NULL, alert_media_file_id = NULL, updated_at = CURRENT_TIMESTAMP WHERE chat_id = $1',
        [chatId]
      );
    } catch (error) {
      logger.error('Error clearing alert media:', error);
      throw error;
    }
  }

  async disableChatWatchers(chatId: number): Promise<void> {
    try {
      await this.pool.query(
        'DELETE FROM watched_tokens WHERE chat_id = $1',
        [chatId]
      );
      logger.warn(`Disabled watchlist for chat ${chatId} after Telegram delivery failure`);
    } catch (error) {
      logger.error('Error disabling chat watchers:', error);
      throw error;
    }
  }

  async getTraderPosition(tokenAddress: string, traderAddress: string): Promise<TraderPositionSnapshot | null> {
    try {
      const { rows } = await this.pool.query(
        'SELECT token_address, trader_address, holdings_token FROM trader_positions WHERE token_address = $1 AND trader_address = $2',
        [tokenAddress.toLowerCase(), traderAddress.toLowerCase()]
      );
      const row = rows[0];

      if (!row) {
        return null;
      }

      return {
        token_address: row.token_address,
        trader_address: row.trader_address,
        holdings_token: row.holdings_token,
      };
    } catch (error) {
      logger.error('Error getting trader position snapshot:', error);
      throw error;
    }
  }

  async setTraderPosition(tokenAddress: string, traderAddress: string, holdingsToken: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO trader_positions (token_address, trader_address, holdings_token)
         VALUES ($1, $2, $3)
         ON CONFLICT(token_address, trader_address)
         DO UPDATE SET holdings_token = EXCLUDED.holdings_token, updated_at = CURRENT_TIMESTAMP`,
        [tokenAddress.toLowerCase(), traderAddress.toLowerCase(), holdingsToken]
      );
    } catch (error) {
      logger.error('Error setting trader position snapshot:', error);
      throw error;
    }
  }

  private async addColumnIfMissing(tableName: string, columnName: string, columnType: string): Promise<void> {
    try {
      const exists = await this.pool.query(
        `SELECT 1
         FROM information_schema.columns
         WHERE table_name = $1 AND column_name = $2`,
        [tableName, columnName]
      );

      if (exists.rowCount === 0) {
        await this.pool.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
      }
    } catch (error) {
      throw error;
    }
  }

  async close(): Promise<void> {
    try {
      await this.releaseSingletonProcessLock();
      await this.pool.end();
      logger.info('PostgreSQL connection closed');
    } catch (error) {
      logger.error('Error closing PostgreSQL connection:', error);
      throw error;
    }
  }
}
