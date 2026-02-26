import dotenv from 'dotenv';
import { TelegramBot } from './bot/TelegramBot';
import { logger } from './utils/logger';
import { Database } from './database/Database';
import { MonitoringService } from './blockchain/MonitoringService';

// Load environment variables
dotenv.config();

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', { reason });
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
});

process.on('warning', (warning) => {
  logger.warn('Process warning', {
    name: warning.name,
    message: warning.message,
    stack: warning.stack,
  });
});

async function main() {
  try {
    logger.info('Starting Telegram Transaction Monitor Bot...', {
      context: 'startup',
      nodeVersion: process.version,
      pollingEnabled: (process.env.TELEGRAM_POLLING_ENABLED || 'true').toLowerCase() !== 'false',
      hasDatabaseUrl: !!process.env.DATABASE_URL,
      hasRedisUrl: !!process.env.redis_url,
    });

    // Validate required environment variables
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }
    if (!process.env.RPC_ENDPOINT) {
      throw new Error('RPC_ENDPOINT is required');
    }

    // Initialize database
    const database = Database.getInstance();
    logger.info('Connecting to database...', { context: 'startup.database' });
    await database.initialize();
    logger.info('Running migrations...', { context: 'startup.database' });
    await database.runMigrations();
    logger.info('Database initialized', { context: 'startup.database' });

    // Initialize and start bot
    const bot = new TelegramBot();
    logger.info('Starting Telegram bot...', { context: 'startup.telegram' });
    await bot.start();

    // Initialize monitoring service
    const monitoringService = MonitoringService.getInstance(bot.getBot());
    logger.info('Starting monitoring service...', { context: 'startup.monitoring' });
    await monitoringService.start();

    logger.info('Bot started successfully', { context: 'startup.complete' });

    // Handle shutdown
    process.on('SIGINT', async () => {
      logger.info('Shutting down bot...');
      await monitoringService.stop();
      await bot.stop();
      await database.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      logger.info('Shutting down bot...');
      await monitoringService.stop();
      await bot.stop();
      await database.close();
      process.exit(0);
    });

  } catch (error) {
    logger.error('Failed to start bot:', error);
    process.exit(1);
  }
}

main();
