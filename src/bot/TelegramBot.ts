import TelegramBotAPI from 'node-telegram-bot-api';
import { logger } from '../utils/logger';
import { CommandHandler } from './CommandHandler';

export class TelegramBot {
  private bot: TelegramBotAPI;
  private commandHandler: CommandHandler;
  private pollingEnabled: boolean;
  private pollingStoppedDueToConflict: boolean = false;
  private botUserId: number | null = null;

  constructor() {
    const token = process.env.TELEGRAM_BOT_TOKEN!;
    this.pollingEnabled = (process.env.TELEGRAM_POLLING_ENABLED || 'true').toLowerCase() !== 'false';
    this.bot = new TelegramBotAPI(token, { polling: this.pollingEnabled });
    this.commandHandler = new CommandHandler(this.bot);
  }

  async start(): Promise<void> {
    try {
      // Set up command handlers
      if (this.pollingEnabled) {
        const me = await this.bot.getMe();
        this.botUserId = me.id;
        this.setupCommands();
        await this.registerCommandMenu();
      }
      
      // Set up error handler
      this.bot.on('polling_error', (error) => {
        logger.error('Polling error:', error);

        if (!this.pollingStoppedDueToConflict && `${error?.message || ''}`.includes('409')) {
          this.pollingStoppedDueToConflict = true;
          this.bot.stopPolling().catch((stopError) => {
            logger.error('Failed to stop polling after conflict:', stopError);
          });
          logger.warn('Telegram polling disabled due to 409 conflict; monitoring and alerts remain active for existing watchlist entries.');
        }
      });

      if (this.pollingEnabled) {
        logger.info('Telegram bot initialized');
      } else {
        logger.info('Telegram bot initialized in monitor-only mode (polling disabled)');
      }
    } catch (error) {
      logger.error('Error starting Telegram bot:', error);
      throw error;
    }
  }

  private setupCommands(): void {
    this.bot.onText(/\/links(?:@[A-Za-z0-9_]+)?$/, () => {
      // Intentionally ignored to avoid command collisions with other bots.
    });

    this.bot.onText(/\/start/, (msg) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleStart(msg));
    });
    this.bot.onText(/\/help/, (msg) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleHelp(msg));
    });
    this.bot.onText(/\/settings/, (msg) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleSettings(msg));
    });
    this.bot.onText(/\/watch (.+)/, (msg, match) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleWatch(msg, match));
    });
    this.bot.onText(/\/unwatch (.+)/, (msg, match) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleUnwatch(msg, match));
    });
    this.bot.onText(/\/watchlist/, (msg) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleWatchlist(msg));
    });
    this.bot.onText(/\/info (.+)/, (msg, match) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleInfo(msg, match));
    });
    this.bot.onText(/\/price (.+)/, (msg, match) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handlePrice(msg, match));
    });
    this.bot.onText(/\/setwebsite (.+)/, (msg, match) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleSetWebsite(msg, match));
    });
    this.bot.onText(/\/settelegram (.+)/, (msg, match) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleSetTelegram(msg, match));
    });
    this.bot.onText(/\/setx (.+)/, (msg, match) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleSetX(msg, match));
    });
    this.bot.onText(/\/buylinks/, (msg) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleLinks(msg));
    });
    this.bot.onText(/\/clearlinks/, (msg) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleClearLinks(msg));
    });
    this.bot.onText(/\/statusnow/, (msg) => {
      void this.executeCommandIfAuthorized(msg, () => this.commandHandler.handleStatusNow(msg));
    });
    this.bot.on('callback_query', (query) => this.commandHandler.handleCallbackQuery(query));
    this.bot.on('message', (msg) => this.commandHandler.handlePendingInput(msg));
    this.bot.on('new_chat_members', (msg) => {
      if (!this.botUserId || !msg.new_chat_members || msg.new_chat_members.length === 0) {
        return;
      }

      const botWasAdded = msg.new_chat_members.some((member) => member.id === this.botUserId);
      if (botWasAdded) {
        this.commandHandler.handleGroupAdded(msg).catch((error) => {
          logger.error('Error handling bot-added event:', error);
        });
      }
    });
  }

  private async executeCommandIfAuthorized(
    msg: TelegramBotAPI.Message,
    handler: () => Promise<void>
  ): Promise<void> {
    const chatType = msg.chat.type;
    const userId = msg.from?.id;

    if (!userId) {
      return;
    }

    if (chatType === 'private') {
      await handler();
      return;
    }

    if (chatType !== 'group' && chatType !== 'supergroup') {
      return;
    }

    try {
      const member = await this.bot.getChatMember(msg.chat.id, userId);
      const isAdmin = member.status === 'administrator' || member.status === 'creator';

      if (!isAdmin) {
        await this.bot.sendMessage(msg.chat.id, '❌ Only group admins can use bot commands.');
        return;
      }

      await handler();
    } catch (error) {
      logger.error('Failed to validate command permissions:', error);
      await this.bot.sendMessage(msg.chat.id, '❌ Unable to verify admin permissions right now.');
    }
  }

  private async registerCommandMenu(): Promise<void> {
    const privateCommands: TelegramBotAPI.BotCommand[] = [
      { command: 'start', description: 'Initialize the bot' },
      { command: 'watch', description: 'Watch a token address' },
      { command: 'unwatch', description: 'Unwatch a token address' },
      { command: 'watchlist', description: 'View watched tokens' },
      { command: 'info', description: 'Get token info' },
      { command: 'price', description: 'Check token price' },
      { command: 'settings', description: 'Open settings panel' },
      { command: 'buylinks', description: 'View alert button links' },
      { command: 'statusnow', description: 'Send status updates now' },
      { command: 'help', description: 'Show available commands' },
    ];

    const groupCommands: TelegramBotAPI.BotCommand[] = [
      { command: 'watch', description: 'Watch a token address' },
      { command: 'unwatch', description: 'Unwatch a token address' },
      { command: 'watchlist', description: 'View watched tokens' },
      { command: 'info', description: 'Get token info' },
      { command: 'price', description: 'Check token price' },
      { command: 'settings', description: 'Open group settings' },
      { command: 'statusnow', description: 'Send status updates now' },
      { command: 'help', description: 'Show available commands' },
    ];

    try {
      await this.bot.setMyCommands(privateCommands, { scope: { type: 'all_private_chats' } });
      await this.bot.setMyCommands(groupCommands, { scope: { type: 'all_group_chats' } });
      logger.info('Telegram command menu registered');
    } catch (error) {
      logger.error('Failed to register Telegram command menu:', error);
    }
  }

  async stop(): Promise<void> {
    if (this.pollingEnabled) {
      await this.bot.stopPolling();
    }
    logger.info('Telegram bot stopped');
  }

  getBot(): TelegramBotAPI {
    return this.bot;
  }
}
