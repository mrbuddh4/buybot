import TelegramBot from 'node-telegram-bot-api';
import { Database } from '../database/Database';
import { PriceService } from '../blockchain/PriceService';
import { MonitoringService } from '../blockchain/MonitoringService';
import { TokenMetadataService } from '../blockchain/TokenMetadataService';
import { logger } from '../utils/logger';
import { validateEthereumAddress, validateHttpUrl } from '../utils/helpers';
import { formatWatchlistMessage } from '../utils/formatter';

type PendingConfigType =
  | 'website'
  | 'telegram'
  | 'x'
  | 'minbuy'
  | 'iconmult'
  | 'buyicons'
  | 'addtoken'
  | 'media'
  | 'tokenmedia_set_addr'
  | 'tokenmedia_media'
  | 'tokenmedia_clear_addr'
  | 'statusinterval';

export class CommandHandler {
  private bot: TelegramBot;
  private db: Database;
  private priceService: PriceService;
  private monitoringService: MonitoringService;
  private tokenMetadataService: TokenMetadataService;
  private pendingConfigInputs: Map<string, PendingConfigType> = new Map();
  private pendingTokenMediaAddress: Map<string, string> = new Map();

  constructor(bot: TelegramBot) {
    this.bot = bot;
    this.db = Database.getInstance();
    this.priceService = new PriceService();
    this.monitoringService = MonitoringService.getInstance(bot);
    this.tokenMetadataService = new TokenMetadataService();
  }

  async handleStart(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return;

    try {
      const welcomeMessage = `
🔔 **Welcome to Blockchain Transaction Monitor!**

I'll notify you whenever tokens you're watching are bought or sold on the blockchain.

**Commands:**
/watch <address> - Start monitoring a token
/unwatch <address> - Stop monitoring a token
/watchlist - View your monitored tokens
/info <address> - Full token details and 24h metrics
/price <address> - Quick price snapshot
/setwebsite <url> - Set alert Website button
/settelegram <url> - Set alert Telegram button
/setx <url> - Set alert X button
/buylinks - View current alert links
/clearlinks - Remove custom alert links
/statusnow - Send token status update now
/statusupdates <on|off> - Toggle automatic status updates
/statusinterval <hours> - Set automatic status interval
/settings - Open group settings panel
/help - Show all commands

  **Tip:** /price = quick snapshot, /info = full details + 24h stats.

Add me to a group to monitor tokens for everyone!
      `;

      await this.bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error handling /start command:', error);
      await this.sendNoticeMessage(chatId, '❌ An error occurred. Please try again.');
    }
  }

  async handleHelp(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    const helpMessage = `
📚 **Available Commands:**

/start - Initialize the bot
/help - Show this help message
/watch <token_address> - Start monitoring a token
/unwatch <token_address> - Stop monitoring a token
/watchlist - View all monitored tokens
/info <token_address> - Full token details and 24h metrics
/price <token_address> - Quick price snapshot
/setwebsite <url> - Set alert Website button
/settelegram <url> - Set alert Telegram button
/setx <url> - Set alert X button
/buylinks - View current alert links
/clearlinks - Remove custom alert links
/statusnow - Send token status update now
/statusupdates <on|off> - Toggle automatic status updates
/statusinterval <hours> - Set automatic status interval
/settings - Open settings panel

**How it works:**
1. Add a token to your watchlist with /watch
2. Get instant alerts when buys happen
3. View transaction details, amounts, and prices
4. Works in groups and private chats!

  **Tip:** /price = quick snapshot, /info = full details + 24h stats.

**Example:**
\`/watch 0x1234...abcd\`
    `;

    await this.bot.sendMessage(chatId, helpMessage, {
      parse_mode: 'Markdown',
      reply_markup: this.buildCloseReplyMarkup(),
    });
  }

  async handleGroupAdded(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    try {
      await this.bot.sendMessage(
        chatId,
        '⚙️ Buy Bot settings are ready for this group. Use the panel below to configure variables.'
      );
      await this.showSettingsMenu(chatId);
    } catch (error) {
      logger.error('Error handling group added event:', error);
    }
  }

  async handleSettings(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    try {
      await this.showSettingsMenu(chatId);
    } catch (error) {
      logger.error('Error handling /settings command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to open settings menu.');
    }
  }

  async handleCallbackQuery(query: TelegramBot.CallbackQuery): Promise<void> {
    const data = query.data;
    const message = query.message;

    if (!data || !message) {
      return;
    }

    if (data === 'msg:close') {
      await this.bot.answerCallbackQuery(query.id);
      try {
        await this.bot.deleteMessage(message.chat.id, message.message_id);
      } catch {
        // Ignore close failures when message is already deleted or not removable.
      }
      return;
    }

    if (!data.startsWith('cfg:')) {
      return;
    }

    const chatId = message.chat.id;
    const userId = query.from.id;

    try {
      const canManage = await this.canManageConfig(message.chat, userId);
      if (!canManage) {
        await this.bot.answerCallbackQuery(query.id, { text: 'Only group admins can change settings.' });
        return;
      }

      await this.bot.answerCallbackQuery(query.id);

      switch (data) {
        case 'cfg:minbuy':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'minbuy');
          await this.bot.sendMessage(chatId, 'Send min buy in USDC (example: 500). Use 0 to disable.');
          break;
        case 'cfg:icon':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'iconmult');
          await this.bot.sendMessage(chatId, 'Send icon multiplier (1 to 5).');
          break;
        case 'cfg:buyicons':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'buyicons');
          await this.bot.sendMessage(chatId, 'Send the buy icon pattern to use in alerts (example: 🟢⚔️ or 💚). Send "default" to reset.');
          break;
        case 'cfg:addtoken':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'addtoken');
          await this.bot.sendMessage(chatId, 'Send token contract address to add to watchlist.');
          break;
        case 'cfg:status_toggle': {
          const settings = await this.db.getChatSettings(chatId);
          const nextEnabled = !settings.status_updates_enabled;
          await this.db.setStatusUpdatesEnabled(chatId, nextEnabled);
          await this.sendConfirmationMessage(chatId, `✅ Automatic status updates ${nextEnabled ? 'enabled' : 'disabled'}.`);
          await this.showSettingsMenu(chatId, message.message_id);
          break;
        }
        case 'cfg:status_interval':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'statusinterval');
          await this.bot.sendMessage(chatId, 'Send status interval in hours (1-24).');
          break;
        case 'cfg:media':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'media');
          await this.bot.sendMessage(chatId, 'Send a photo or GIF animation to use in alerts.');
          break;
        case 'cfg:tokenmedia:set':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'tokenmedia_set_addr');
          await this.bot.sendMessage(chatId, 'Send the watched token contract address to set media for.');
          break;
        case 'cfg:tokenmedia:clear':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'tokenmedia_clear_addr');
          await this.bot.sendMessage(chatId, 'Send the watched token contract address to clear media for.');
          break;
        case 'cfg:clearmedia':
          await this.db.clearAlertMedia(chatId);
          await this.sendConfirmationMessage(chatId, '✅ Alert media cleared.');
          await this.showSettingsMenu(chatId, message.message_id);
          break;
        case 'cfg:web':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'website');
          await this.bot.sendMessage(chatId, 'Send Website URL (http/https).');
          break;
        case 'cfg:tg':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'telegram');
          await this.bot.sendMessage(chatId, 'Send Telegram URL (http/https).');
          break;
        case 'cfg:x':
          this.pendingConfigInputs.set(this.pendingKey(chatId, userId), 'x');
          await this.bot.sendMessage(chatId, 'Send X URL (http/https).');
          break;
        case 'cfg:clear':
          await this.db.clearAlertLinks(chatId);
          await this.sendConfirmationMessage(chatId, '✅ Custom alert links cleared.');
          await this.showSettingsMenu(chatId, message.message_id);
          break;
        case 'cfg:refresh':
          await this.showSettingsMenu(chatId, message.message_id);
          break;
        case 'cfg:close':
          try {
            await this.bot.deleteMessage(chatId, message.message_id);
          } catch {
            await this.sendConfirmationMessage(chatId, '✅ Settings menu closed.');
          }
          break;
      }
    } catch (error) {
      logger.error('Error handling settings callback:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to update settings.');
    }
  }

  async handlePendingInput(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) {
      return;
    }

    const key = this.pendingKey(chatId, userId);
    const pending = this.pendingConfigInputs.get(key);

    if (!pending) {
      return;
    }

    try {
      const canManage = await this.canManageConfig(msg.chat, userId);
      if (!canManage) {
        this.pendingConfigInputs.delete(key);
        await this.sendNoticeMessage(chatId, '❌ Only group admins can change settings.');
        return;
      }

      if (pending === 'media') {
        if (msg.photo && msg.photo.length > 0) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          await this.db.setAlertMedia(chatId, 'photo', fileId);
          this.pendingConfigInputs.delete(key);
          await this.sendConfirmationMessage(chatId, '✅ Alert image saved.');
          await this.showSettingsMenu(chatId);
          return;
        }

        if (msg.animation) {
          await this.db.setAlertMedia(chatId, 'animation', msg.animation.file_id);
          this.pendingConfigInputs.delete(key);
          await this.sendConfirmationMessage(chatId, '✅ Alert GIF saved.');
          await this.showSettingsMenu(chatId);
          return;
        }

        await this.sendNoticeMessage(chatId, '❌ Send a photo or GIF animation.');
        return;
      }

      if (pending === 'tokenmedia_media') {
        const tokenAddress = this.pendingTokenMediaAddress.get(key);
        if (!tokenAddress) {
          this.pendingConfigInputs.delete(key);
          await this.sendNoticeMessage(chatId, '❌ Token media setup expired. Please try again.');
          return;
        }

        if (msg.photo && msg.photo.length > 0) {
          const fileId = msg.photo[msg.photo.length - 1].file_id;
          await this.db.setWatchedTokenMedia(chatId, tokenAddress, 'photo', fileId);
          this.pendingConfigInputs.delete(key);
          this.pendingTokenMediaAddress.delete(key);
          await this.sendConfirmationMessage(chatId, `✅ Token media saved for ${tokenAddress}.`);
          await this.showSettingsMenu(chatId);
          return;
        }

        if (msg.animation) {
          await this.db.setWatchedTokenMedia(chatId, tokenAddress, 'animation', msg.animation.file_id);
          this.pendingConfigInputs.delete(key);
          this.pendingTokenMediaAddress.delete(key);
          await this.sendConfirmationMessage(chatId, `✅ Token media saved for ${tokenAddress}.`);
          await this.showSettingsMenu(chatId);
          return;
        }

        await this.sendNoticeMessage(chatId, '❌ Send a photo or GIF animation.');
        return;
      }

      const text = msg.text?.trim();
      if (!text || text.startsWith('/')) {
        return;
      }

      if (pending === 'tokenmedia_set_addr') {
        const tokenAddress = text.toLowerCase();

        if (!validateEthereumAddress(tokenAddress)) {
          await this.sendNoticeMessage(chatId, '❌ Invalid token address.');
          return;
        }

        const isWatching = await this.db.isWatchingToken(chatId, tokenAddress);
        if (!isWatching) {
          await this.sendNoticeMessage(chatId, '❌ This token is not in your watchlist.');
          return;
        }

        this.pendingTokenMediaAddress.set(key, tokenAddress);
        this.pendingConfigInputs.set(key, 'tokenmedia_media');
        await this.bot.sendMessage(chatId, 'Send a photo or GIF animation to attach to this token alerts.');
        return;
      }

      if (pending === 'tokenmedia_clear_addr') {
        const tokenAddress = text.toLowerCase();

        if (!validateEthereumAddress(tokenAddress)) {
          await this.sendNoticeMessage(chatId, '❌ Invalid token address.');
          return;
        }

        const isWatching = await this.db.isWatchingToken(chatId, tokenAddress);
        if (!isWatching) {
          await this.sendNoticeMessage(chatId, '❌ This token is not in your watchlist.');
          return;
        }

        await this.db.clearWatchedTokenMedia(chatId, tokenAddress);
        this.pendingConfigInputs.delete(key);
        await this.sendConfirmationMessage(chatId, `✅ Cleared token media for ${tokenAddress}.`);
        await this.showSettingsMenu(chatId);
        return;
      }

      if (pending === 'minbuy') {
        const minBuy = parseFloat(text);
        if (!Number.isFinite(minBuy) || minBuy < 0) {
          await this.sendNoticeMessage(chatId, '❌ Invalid value. Send a number >= 0.');
          return;
        }

        await this.db.setMinBuyUsdc(chatId, minBuy);
        this.pendingConfigInputs.delete(key);
        await this.sendConfirmationMessage(chatId, `✅ Min buy set to $${minBuy.toFixed(2)} USDC.`);
        await this.showSettingsMenu(chatId);
        return;
      }

      if (pending === 'iconmult') {
        const iconMult = parseInt(text, 10);
        if (!Number.isFinite(iconMult) || iconMult < 1 || iconMult > 5) {
          await this.sendNoticeMessage(chatId, '❌ Invalid value. Send an integer from 1 to 5.');
          return;
        }

        await this.db.setIconMultiplier(chatId, iconMult);
        this.pendingConfigInputs.delete(key);
        await this.sendConfirmationMessage(chatId, `✅ Icon multiplier set to x${iconMult}.`);
        await this.showSettingsMenu(chatId);
        return;
      }

      if (pending === 'buyicons') {
        const normalized = text.toLowerCase() === 'default' ? '🟢⚔️' : text;
        if (!normalized.trim()) {
          await this.sendNoticeMessage(chatId, '❌ Invalid value. Send at least one emoji or symbol.');
          return;
        }

        if (normalized.length > 24) {
          await this.sendNoticeMessage(chatId, '❌ Keep it short (max 24 characters).');
          return;
        }

        await this.db.setBuyIconPattern(chatId, normalized);
        this.pendingConfigInputs.delete(key);
        await this.sendConfirmationMessage(chatId, `✅ Buy icons set to: ${normalized}`);
        await this.showSettingsMenu(chatId);
        return;
      }

      if (pending === 'addtoken') {
        const tokenAddress = text;

        if (!validateEthereumAddress(tokenAddress)) {
          await this.sendNoticeMessage(chatId, '❌ Invalid token address.');
          return;
        }

        const isWatching = await this.db.isWatchingToken(chatId, tokenAddress);
        if (isWatching) {
          this.pendingConfigInputs.delete(key);
          await this.sendNoticeMessage(chatId, '⚠️ Already monitoring this token.');
          await this.showSettingsMenu(chatId);
          return;
        }

        const tokenInfo = await this.priceService.getTokenInfo(tokenAddress);
        if (!tokenInfo) {
          await this.sendNoticeMessage(chatId, '❌ Could not fetch token information. Invalid address?');
          return;
        }

        await this.db.addWatchedToken(chatId, tokenAddress, tokenInfo.symbol, tokenInfo.name);
        await this.monitoringService.startMonitoringToken(tokenAddress);
        this.pendingConfigInputs.delete(key);

        await this.trySetHLPMMTokenImage(chatId, tokenAddress);

        await this.sendConfirmationMessage(chatId, `✅ Added ${tokenInfo.symbol} to watchlist.`);
        await this.showSettingsMenu(chatId);
        return;
      }

      if (pending === 'statusinterval') {
        const intervalHours = parseInt(text, 10);
        if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 24) {
          await this.sendNoticeMessage(chatId, '❌ Invalid value. Send an integer from 1 to 24 hours.');
          return;
        }

        await this.db.setStatusIntervalMinutes(chatId, intervalHours * 60);
        this.pendingConfigInputs.delete(key);
        await this.sendConfirmationMessage(chatId, `✅ Status update interval set to ${intervalHours} hour(s).`);
        await this.showSettingsMenu(chatId);
        return;
      }

      if (!validateHttpUrl(text)) {
        await this.sendNoticeMessage(chatId, '❌ Invalid URL. Use http:// or https://');
        return;
      }

      await this.db.setAlertLink(chatId, pending as 'website' | 'telegram' | 'x', text);
      this.pendingConfigInputs.delete(key);
      this.pendingTokenMediaAddress.delete(key);
      await this.sendConfirmationMessage(chatId, `✅ ${pending.toUpperCase()} link saved.`);
      await this.showSettingsMenu(chatId);
    } catch (error) {
      logger.error('Error handling pending settings input:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to save setting.');
    }
  }

  async handleWatch(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !match) {
      await this.sendNoticeMessage(chatId, '❌ Usage: /watch <token_address>');
      return;
    }

    const tokenAddress = match[1].trim();

    if (!validateEthereumAddress(tokenAddress)) {
      await this.sendNoticeMessage(chatId, '❌ Invalid token address.');
      return;
    }

    try {
      const isWatching = await this.db.isWatchingToken(chatId, tokenAddress);
      if (isWatching) {
        await this.sendNoticeMessage(chatId, '⚠️ Already monitoring this token.');
        return;
      }

      await this.bot.sendMessage(chatId, '⏳ Adding token to watchlist...');

      const tokenInfo = await this.priceService.getTokenInfo(tokenAddress);
      if (!tokenInfo) {
        await this.sendNoticeMessage(chatId, '❌ Could not fetch token information. Invalid address?');
        return;
      }

      await this.db.addWatchedToken(chatId, tokenAddress, tokenInfo.symbol, tokenInfo.name);
      await this.monitoringService.startMonitoringToken(tokenAddress);

      await this.trySetHLPMMTokenImage(chatId, tokenAddress);

      const successMessage = `
✅ **Now monitoring ${tokenInfo.symbol}**

**Name:** ${tokenInfo.name}
**Symbol:** ${tokenInfo.symbol}
**Address:** \`${tokenAddress}\`

You'll receive alerts for all buy transactions!
      `;

      await this.bot.sendMessage(chatId, successMessage, { parse_mode: 'Markdown' });
    } catch (error) {
      logger.error('Error handling /watch command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to add token to watchlist.');
    }
  }

  async handleUnwatch(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId || !match) {
      await this.sendNoticeMessage(chatId, '❌ Usage: /unwatch <token_address>');
      return;
    }

    const tokenAddress = match[1].trim();

    if (!validateEthereumAddress(tokenAddress)) {
      await this.sendNoticeMessage(chatId, '❌ Invalid token address.');
      return;
    }

    try {
      const isWatching = await this.db.isWatchingToken(chatId, tokenAddress);

      if (!isWatching) {
        await this.sendNoticeMessage(chatId, '⚠️ Not monitoring this token.');
        return;
      }

      await this.db.removeWatchedToken(chatId, tokenAddress);

      const watchers = await this.db.getTokenWatchers(tokenAddress);
      if (watchers.length === 0) {
        await this.monitoringService.stopMonitoringToken(tokenAddress);
      }

      await this.sendConfirmationMessage(chatId, '✅ Token removed from watchlist.');
    } catch (error) {
      logger.error('Error handling /unwatch command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to remove token from watchlist.');
    }
  }

  async handleWatchlist(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    try {
      const tokens = await this.db.getWatchedTokens(chatId);
      const message = formatWatchlistMessage(tokens);
      await this.bot.sendMessage(chatId, message, {
        reply_markup: this.buildCloseReplyMarkup(),
      });
    } catch (error) {
      logger.error('Error handling /watchlist command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to fetch watchlist.');
    }
  }

  async handleInfo(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    let loadingMessageId: number | null = null;

    if (!match) {
      await this.sendNoticeMessage(chatId, '❌ Usage: /info <token_address>');
      return;
    }

    const tokenAddress = match[1].trim();

    if (!validateEthereumAddress(tokenAddress)) {
      await this.sendNoticeMessage(chatId, '❌ Invalid token address.');
      return;
    }

    try {
      const loadingMessage = await this.bot.sendMessage(chatId, '⏳ Fetching token information...');
      loadingMessageId = loadingMessage.message_id;

      const tokenInfo = await this.priceService.getTokenInfo(tokenAddress);
      const price = await this.priceService.getTokenPrice(tokenAddress);
      const metrics = await this.priceService.getTokenStatusMetrics(tokenAddress);
      const isWatching = await this.db.isWatchingToken(chatId, tokenAddress);

      if (!tokenInfo) {
        await this.sendNoticeMessage(chatId, '❌ Could not fetch token information.');
        return;
      }

      const marketCapUsd = parseFloat(tokenInfo.marketCapUsd || (
        (parseFloat(tokenInfo.totalSupply || '0') || 0) *
        (parseFloat(price?.priceInUsd || '0') || 0)
      ).toString());

      const tokenPricePax = parseFloat(price?.priceInEth || '0');
      const tokenPriceUsd = parseFloat(price?.priceInUsd || '0');
      const totalSupply = parseFloat(tokenInfo.totalSupply || '0');

      const formatUsdCompact = (value: number | null): string => {
        if (!Number.isFinite(value ?? NaN) || (value ?? 0) < 0) {
          return 'N/A';
        }

        return new Intl.NumberFormat('en-US', {
          style: 'currency',
          currency: 'USD',
          notation: 'compact',
          maximumFractionDigits: 2,
        }).format(value as number);
      };

      const formatNumberCompact = (value: number): string => {
        if (!Number.isFinite(value) || value < 0) {
          return 'N/A';
        }

        return new Intl.NumberFormat('en-US', {
          notation: 'compact',
          maximumFractionDigits: 2,
        }).format(value);
      };

      const ratioText = metrics.buyers24h !== null && metrics.sellers24h !== null
        ? (() => {
            const buyers = Math.max(0, metrics.buyers24h);
            const sellers = Math.max(0, metrics.sellers24h);
            const total = buyers + sellers;
            if (total <= 0) {
              return '0.0% buyers / 0.0% sellers';
            }
            const buyersPct = ((buyers / total) * 100).toFixed(1);
            const sellersPct = ((sellers / total) * 100).toFixed(1);
            return `${buyersPct}% buyers / ${sellersPct}% sellers`;
          })()
        : 'N/A';

      const message = `
🪙 **Token Info**

**${tokenInfo.name}** (${tokenInfo.symbol})
\`${tokenAddress}\`

**Watch Status:** ${isWatching ? '👁️ Watching' : '➕ Not watching'}

**Pricing**
• ${Number.isFinite(tokenPricePax) ? tokenPricePax.toFixed(8) : '0.00000000'} PAX
• ${Number.isFinite(tokenPriceUsd) ? `$${tokenPriceUsd.toFixed(6)}` : '$0.000000'} USDC
• Market Cap: ${formatUsdCompact(Number.isFinite(marketCapUsd) ? marketCapUsd : null)} USDC

**Token Stats**
• Total Supply: ${formatNumberCompact(totalSupply)}
• Holders: ${metrics.holders !== null ? Math.max(0, Math.floor(metrics.holders)).toLocaleString('en-US') : 'N/A'}
• 24h Volume: ${formatUsdCompact(metrics.volume24hUsd)} USDC
• Buys/Sells: ${ratioText}
• Biggest Buy (24h): ${formatUsdCompact(metrics.biggestBuy24hUsd)} USDC
      `.trim();

      await this.bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        reply_markup: this.buildCloseReplyMarkup(),
      });
    } catch (error) {
      logger.error('Error handling /info command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to fetch token information.');
    } finally {
      if (loadingMessageId !== null) {
        void this.bot.deleteMessage(chatId, loadingMessageId).catch(() => undefined);
      }
    }
  }

  async handlePrice(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    let loadingMessageId: number | null = null;

    if (!match) {
      await this.sendNoticeMessage(chatId, '❌ Usage: /price <token_address>');
      return;
    }

    const tokenAddress = match[1].trim();

    if (!validateEthereumAddress(tokenAddress)) {
      await this.sendNoticeMessage(chatId, '❌ Invalid token address.');
      return;
    }

    try {
      const loadingMessage = await this.bot.sendMessage(chatId, '⏳ Fetching price...');
      loadingMessageId = loadingMessage.message_id;

      const tokenInfo = await this.priceService.getTokenInfo(tokenAddress);
      const price = await this.priceService.getTokenPrice(tokenAddress);

      if (price && tokenInfo) {
        const pricePax = parseFloat(price.priceInEth);
        const priceUsd = parseFloat(price.priceInUsd);

        const marketCapUsd = tokenInfo.marketCapUsd
          ? parseFloat(tokenInfo.marketCapUsd)
          : (parseFloat(tokenInfo.totalSupply || '0') || 0) * priceUsd;
        const marketCapText = Number.isFinite(marketCapUsd)
          ? new Intl.NumberFormat('en-US', {
              style: 'currency',
              currency: 'USD',
              notation: 'compact',
              maximumFractionDigits: 2,
            }).format(marketCapUsd)
          : 'N/A';

        const priceMessage = `
💵 **Price Snapshot**

**${tokenInfo.name}** (${tokenInfo.symbol})
\`${tokenAddress}\`

**Current Price:**
• ${Number.isFinite(pricePax) ? pricePax.toFixed(8) : '0.00000000'} PAX
• ${Number.isFinite(priceUsd) ? `$${priceUsd.toFixed(6)}` : '$0.000000'} USDC

**Market Cap:** ${marketCapText} USDC

Updated: ${new Date().toLocaleString()}
        `;

        await this.bot.sendMessage(chatId, priceMessage, {
          parse_mode: 'Markdown',
          reply_markup: this.buildCloseReplyMarkup(),
        });
      } else {
        await this.sendNoticeMessage(chatId, '❌ Could not fetch price for this token.');
      }
    } catch (error) {
      logger.error('Error handling /price command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to fetch token price.');
    } finally {
      if (loadingMessageId !== null) {
        void this.bot.deleteMessage(chatId, loadingMessageId).catch(() => undefined);
      }
    }
  }

  async handleSetWebsite(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    await this.setLink(msg, match, 'website');
  }

  async handleSetTelegram(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    await this.setLink(msg, match, 'telegram');
  }

  async handleSetX(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    await this.setLink(msg, match, 'x');
  }

  async handleLinks(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    try {
      const links = await this.db.getAlertLinks(chatId);
      const website = links.website_url || 'Not set';
      const telegram = links.telegram_url || 'Not set';
      const x = links.x_url || 'Not set';

      await this.bot.sendMessage(
        chatId,
        `🔗 Alert Button Links\n\nWebsite: ${website}\nTelegram: ${telegram}\nX: ${x}`
      );
    } catch (error) {
      logger.error('Error handling /buylinks command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to fetch links.');
    }
  }

  async handleClearLinks(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) {
      await this.sendNoticeMessage(chatId, '❌ Could not identify user.');
      return;
    }

    try {
      const canManage = await this.canManageConfig(msg.chat, userId);
      if (!canManage) {
        await this.sendNoticeMessage(chatId, '❌ Only group admins can clear links.');
        return;
      }

      await this.db.clearAlertLinks(chatId);
      await this.sendConfirmationMessage(chatId, '✅ Custom alert links cleared.');
    } catch (error) {
      logger.error('Error handling /clearlinks command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to clear links.');
    }
  }

  async handleStatusNow(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;

    try {
      const sentCount = await this.monitoringService.triggerHourlyStatusUpdates(chatId);

      if (sentCount === 0) {
        await this.sendNoticeMessage(chatId, 'ℹ️ No watched tokens found for this chat yet. Use /watch <token_address> first.');
        return;
      }
    } catch (error) {
      logger.error('Error handling /statusnow command:', error);
      await this.sendNoticeMessage(chatId, '❌ Failed to send status update right now.');
    }
  }

  async handleStatusUpdates(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) {
      await this.sendNoticeMessage(chatId, '❌ Could not identify user.');
      return;
    }

    if (!match) {
      await this.sendNoticeMessage(chatId, '❌ Usage: /statusupdates <on|off>');
      return;
    }

    const canManage = await this.canManageConfig(msg.chat, userId);
    if (!canManage) {
      await this.sendNoticeMessage(chatId, '❌ Only group admins can change status update settings.');
      return;
    }

    const raw = match[1].trim().toLowerCase();
    if (raw !== 'on' && raw !== 'off') {
      await this.sendNoticeMessage(chatId, '❌ Usage: /statusupdates <on|off>');
      return;
    }

    const enabled = raw === 'on';
    await this.db.setStatusUpdatesEnabled(chatId, enabled);
    await this.sendConfirmationMessage(chatId, `✅ Automatic status updates ${enabled ? 'enabled' : 'disabled'}.`);
  }

  async handleStatusInterval(msg: TelegramBot.Message, match: RegExpExecArray | null): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) {
      await this.sendNoticeMessage(chatId, '❌ Could not identify user.');
      return;
    }

    if (!match) {
      await this.sendNoticeMessage(chatId, '❌ Usage: /statusinterval <hours>');
      return;
    }

    const canManage = await this.canManageConfig(msg.chat, userId);
    if (!canManage) {
      await this.sendNoticeMessage(chatId, '❌ Only group admins can change status update settings.');
      return;
    }

    const intervalHours = parseInt(match[1].trim(), 10);
    if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 24) {
      await this.sendNoticeMessage(chatId, '❌ Invalid value. Send an integer from 1 to 24 hours.');
      return;
    }

    await this.db.setStatusIntervalMinutes(chatId, intervalHours * 60);
    await this.sendConfirmationMessage(chatId, `✅ Status update interval set to ${intervalHours} hour(s).`);
  }

  private async setLink(
    msg: TelegramBot.Message,
    match: RegExpExecArray | null,
    platform: 'website' | 'telegram' | 'x'
  ): Promise<void> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) {
      await this.sendNoticeMessage(chatId, '❌ Could not identify user.');
      return;
    }

    if (!match) {
      await this.sendNoticeMessage(chatId, `❌ Usage: /set${platform} <url>`);
      return;
    }

    const url = match[1].trim();
    if (!validateHttpUrl(url)) {
      await this.sendNoticeMessage(chatId, '❌ Invalid URL. Use http:// or https://');
      return;
    }

    try {
      const canManage = await this.canManageConfig(msg.chat, userId);
      if (!canManage) {
        await this.sendNoticeMessage(chatId, `❌ Only group admins can set ${platform} links.`);
        return;
      }

      await this.db.setAlertLink(chatId, platform, url);
      await this.sendConfirmationMessage(chatId, `✅ ${platform.toUpperCase()} link saved.`);
    } catch (error) {
      logger.error(`Error handling /set${platform} command:`, error);
      await this.sendNoticeMessage(chatId, `❌ Failed to save ${platform} link.`);
    }
  }

  private pendingKey(chatId: number, userId: number): string {
    return `${chatId}:${userId}`;
  }

  private buildCloseReplyMarkup(): TelegramBot.InlineKeyboardMarkup {
    return {
      inline_keyboard: [[{ text: 'Close', callback_data: 'msg:close' }]],
    };
  }

  private getConfirmationAutoDeleteMs(): number {
    const configuredSeconds = parseInt(process.env.CONFIRMATION_AUTO_DELETE_SECONDS || '20', 10);
    if (!Number.isFinite(configuredSeconds) || configuredSeconds <= 0) {
      return 20_000;
    }

    return Math.min(300, configuredSeconds) * 1000;
  }

  private async sendConfirmationMessage(
    chatId: number,
    text: string,
    options?: TelegramBot.SendMessageOptions
  ): Promise<void> {
    const deleteAfterMs = this.getConfirmationAutoDeleteMs();
    await this.sendEphemeralMessage(chatId, text, deleteAfterMs, options);
  }

  private getNoticeAutoDeleteMs(): number {
    const configuredSeconds = parseInt(process.env.NOTICE_AUTO_DELETE_SECONDS || '', 10);
    if (Number.isFinite(configuredSeconds) && configuredSeconds > 0) {
      return Math.min(300, configuredSeconds) * 1000;
    }

    return this.getConfirmationAutoDeleteMs();
  }

  private async sendNoticeMessage(
    chatId: number,
    text: string,
    options?: TelegramBot.SendMessageOptions
  ): Promise<void> {
    const deleteAfterMs = this.getNoticeAutoDeleteMs();
    await this.sendEphemeralMessage(chatId, text, deleteAfterMs, options);
  }

  private async sendEphemeralMessage(
    chatId: number,
    text: string,
    deleteAfterMs: number,
    options?: TelegramBot.SendMessageOptions
  ): Promise<void> {
    const sentMessage = await this.bot.sendMessage(chatId, text, options);

    setTimeout(() => {
      void this.bot.deleteMessage(chatId, sentMessage.message_id).catch(() => undefined);
    }, deleteAfterMs);
  }

  private async canManageConfig(chat: TelegramBot.Chat, userId: number): Promise<boolean> {
    if (chat.type === 'private') {
      return true;
    }

    if (chat.type !== 'group' && chat.type !== 'supergroup') {
      return false;
    }

    try {
      const member = await this.bot.getChatMember(chat.id, userId);
      return member.status === 'administrator' || member.status === 'creator';
    } catch (error) {
      logger.error('Error checking admin permissions:', error);
      return false;
    }
  }

  private async trySetHLPMMTokenImage(chatId: number, tokenAddress: string): Promise<void> {
    if (!this.tokenMetadataService.isEnabled()) return;

    try {
      const isHlpmm = await this.tokenMetadataService.isHLPMMToken(tokenAddress);
      if (!isHlpmm) return;

      const imageUrl = await this.tokenMetadataService.fetchAndUploadTokenImage(tokenAddress);
      if (imageUrl) {
        await this.db.setWatchedTokenMedia(chatId, tokenAddress, 'photo', imageUrl);
        logger.info(`Auto-set HLPMM token image for ${tokenAddress} in chat ${chatId}`);
      }
    } catch (error) {
      logger.warn(`Failed to auto-set HLPMM token image for ${tokenAddress}:`, error);
    }
  }

  private async showSettingsMenu(chatId: number, messageId?: number): Promise<void> {
    const links = await this.db.getAlertLinks(chatId);
    const settings = await this.db.getChatSettings(chatId);
    const tokens = await this.db.getWatchedTokens(chatId);

    const mediaStatus = settings.alert_media_file_id
      ? settings.alert_media_type === 'animation' ? '✅ GIF' : '✅ Image'
      : '❌ None';
    const statusEnabledText = settings.status_updates_enabled ? '✅ On' : '❌ Off';
    const statusIntervalHours = Math.max(1, Math.min(24, Math.round((settings.status_interval_minutes ?? 60) / 60)));
    const statusIntervalText = `${statusIntervalHours} hr`;

    const text = [
      '⚙️ Group Buy Bot Settings',
      '',
      `Min Buy: $${settings.min_buy_usdc.toFixed(2)} USDC`,
      `Icon Scale: x${settings.icon_multiplier}`,
      `Buy Icons: ${settings.buy_icon_pattern}`,
      `Auto Status: ${statusEnabledText}`,
      `Status Interval: ${statusIntervalText}`,
      `Watched Tokens: ${tokens.length}`,
      `Alert Media: ${mediaStatus}`,
      `Website: ${links.website_url ? '✅' : '❌'}`,
      `Telegram: ${links.telegram_url ? '✅' : '❌'}`,
      `X: ${links.x_url ? '✅' : '❌'}`,
    ].join('\n');

    const replyMarkup: TelegramBot.InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: `Min Buy $${settings.min_buy_usdc.toFixed(0) || '0'}`, callback_data: 'cfg:minbuy' },
          { text: `Icon x${settings.icon_multiplier}`, callback_data: 'cfg:icon' },
        ],
        [
          { text: 'Buy Icons', callback_data: 'cfg:buyicons' },
        ],
        [
          { text: `Status ${settings.status_updates_enabled ? 'On' : 'Off'}`, callback_data: 'cfg:status_toggle' },
          { text: `Interval ${statusIntervalHours}h`, callback_data: 'cfg:status_interval' },
        ],
        [
          { text: 'Add Token', callback_data: 'cfg:addtoken' },
        ],
        [
          { text: 'Set Media', callback_data: 'cfg:media' },
          { text: 'Clear Media', callback_data: 'cfg:clearmedia' },
        ],
        [
          { text: 'Set Token Media', callback_data: 'cfg:tokenmedia:set' },
          { text: 'Clear Token Media', callback_data: 'cfg:tokenmedia:clear' },
        ],
        [
          { text: 'Set Website', callback_data: 'cfg:web' },
          { text: 'Set Telegram', callback_data: 'cfg:tg' },
        ],
        [
          { text: 'Set X', callback_data: 'cfg:x' },
          { text: 'Clear Links', callback_data: 'cfg:clear' },
        ],
        [
          { text: 'Refresh', callback_data: 'cfg:refresh' },
          { text: 'Close', callback_data: 'cfg:close' },
        ],
      ],
    };

    if (messageId) {
      try {
        await this.bot.editMessageText(text, {
          chat_id: chatId,
          message_id: messageId,
          reply_markup: replyMarkup,
        });
        return;
      } catch {
        // Fall back to sending a new message
      }
    }

    await this.bot.sendMessage(chatId, text, { reply_markup: replyMarkup });
  }
}
