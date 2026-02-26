import dotenv from 'dotenv';
import { TelegramBot } from './bot/TelegramBot';
import { logger } from './utils/logger';
import { Database } from './database/Database';
import { MonitoringService } from './blockchain/MonitoringService';

// Load environment variables
dotenv.config();

async function main() {
  try {
    logger.info('Starting Telegram Transaction Monitor Bot...');

    // Validate required environment variables
    if (!process.env.TELEGRAM_BOT_TOKEN) {
      throw new Error('TELEGRAM_BOT_TOKEN is required');
    }
    if (!process.env.RPC_ENDPOINT) {
      throw new Error('RPC_ENDPOINT is required');
    }

    // Initialize database
    const database = Database.getInstance();
    await database.initialize();
    await database.runMigrations();
    logger.info('Database initialized');

    // Initialize and start bot
    const bot = new TelegramBot();
    await bot.start();

    // Initialize monitoring service
    const monitoringService = MonitoringService.getInstance(bot.getBot());
    await monitoringService.start();

    logger.info('Bot started successfully');

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
