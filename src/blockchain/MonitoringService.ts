import { ethers } from 'ethers';
import TelegramBot from 'node-telegram-bot-api';
import { logger } from '../utils/logger';
import { Database } from '../database/Database';
import { PriceService } from './PriceService';
import { formatTransactionAlert } from '../utils/formatter';

interface SwapEvent {
  tokenAddress: string;
  type: 'buy' | 'sell';
  amountIn: bigint;
  amountOut: bigint;
  buyer: string;
  txHash: string;
  blockNumber: number;
  timestamp: number;
}

export class MonitoringService {
  private static instance: MonitoringService;
  private provider: ethers.JsonRpcProvider;
  private bot: TelegramBot;
  private db: Database;
  private priceService: PriceService;
  private routerAddress: string;
  private wethAddress: string;
  private isRunning: boolean = false;
  private monitoredTokens: Map<string, ethers.Contract> = new Map();
  private pollingInterval: NodeJS.Timeout | null = null;
  private lastBlockNumber: number = 0;

  private constructor(bot: TelegramBot) {
    const rpcEndpoint = process.env.RPC_ENDPOINT!;
    this.provider = new ethers.JsonRpcProvider(rpcEndpoint);
    this.bot = bot;
    this.db = Database.getInstance();
    this.priceService = new PriceService();
    this.routerAddress = process.env.DEX_ROUTER_ADDRESS!;
    this.wethAddress = process.env.WETH_ADDRESS!;
  }

  static getInstance(bot: TelegramBot): MonitoringService {
    if (!MonitoringService.instance) {
      MonitoringService.instance = new MonitoringService(bot);
    }
    return MonitoringService.instance;
  }

  async start(): Promise<void> {
    try {
      this.isRunning = true;
      
      // Load all watched tokens from database
      const watchedTokens = await this.db.getAllWatchedTokens();
      
      for (const token of watchedTokens) {
        await this.startMonitoringToken(token.token_address);
      }

      logger.info(`Monitoring service started - watching ${watchedTokens.length} tokens`);
    } catch (error) {
      logger.error('Error starting monitoring service:', error);
      throw error;
    }
  }

  async startMonitoringToken(tokenAddress: string): Promise<void> {
    if (this.monitoredTokens.has(tokenAddress)) {
      logger.info(`Already monitoring token: ${tokenAddress}`);
      return;
    }

    try {
      // Create token contract instance
      const tokenContract = new ethers.Contract(
        tokenAddress,
        [
          'event Transfer(address indexed from, address indexed to, uint256 value)',
          'function name() view returns (string)',
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)',
        ],
        this.provider
      );

      this.monitoredTokens.set(tokenAddress, tokenContract);
      logger.info(`Started monitoring token: ${tokenAddress}`);
      
      // Start polling if not already running
      if (!this.pollingInterval) {
        this.startPolling();
      }
    } catch (error) {
      logger.error(`Error monitoring token ${tokenAddress}:`, error);
    }
  }

  async stopMonitoringToken(tokenAddress: string): Promise<void> {
    this.monitoredTokens.delete(tokenAddress);
    logger.info(`Stopped monitoring token: ${tokenAddress}`);
    
    // Stop polling if no tokens are being monitored
    if (this.monitoredTokens.size === 0 && this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
      logger.info('Stopped polling - no tokens being monitored');
    }
  }

  private startPolling(): void {
    logger.info('Starting block polling (WebSocket not available)');
    
    // Poll for new blocks every 3 seconds
    this.pollingInterval = setInterval(async () => {
      try {
        const currentBlock = await this.provider.getBlockNumber();
        
        if (currentBlock > this.lastBlockNumber) {
          // Check blocks we may have missed
          const fromBlock = this.lastBlockNumber === 0 ? currentBlock : this.lastBlockNumber + 1;
          
          for (const [tokenAddress, contract] of this.monitoredTokens) {
            const filter = contract.filters.Transfer();
            const events = await contract.queryFilter(filter, fromBlock, currentBlock);
            
            for (const event of events) {
              if ('args' in event) {
                await this.handleTransferEvent(
                  tokenAddress,
                  event.args[0],
                  event.args[1],
                  event.args[2],
                  event
                );
              }
            }
          }
          
          this.lastBlockNumber = currentBlock;
        }
      } catch (error) {
        logger.error('Error in polling loop:', error);
      }
    }, 3000);
  }

  private classifyTransfer(
    from: string,
    to: string,
    tx: ethers.TransactionResponse
  ): { type: 'buy'; trader: string } | null {
    const normalizedFrom = from.toLowerCase();
    const normalizedTo = to.toLowerCase();
    const normalizedRouter = this.routerAddress.toLowerCase();
    const normalizedTxFrom = tx.from.toLowerCase();
    const normalizedTxTo = tx.to?.toLowerCase() || '';

    if (normalizedFrom === normalizedRouter) {
      return { type: 'buy', trader: to };
    }

    if (normalizedTxTo === normalizedRouter) {
      if (normalizedTo === normalizedTxFrom) {
        return { type: 'buy', trader: to };
      }
    }

    return null;
  }

  private async hasPriorTokenInteraction(
    tokenAddress: string,
    walletAddress: string,
    currentTxHash: string,
    upToBlock: number
  ): Promise<boolean> {
    try {
      const interactionContract = new ethers.Contract(
        tokenAddress,
        ['event Transfer(address indexed from, address indexed to, uint256 value)'],
        this.provider
      );

      const normalizedWallet = walletAddress.toLowerCase();
      const fromFilter = interactionContract.filters.Transfer(normalizedWallet, null);
      const toFilter = interactionContract.filters.Transfer(null, normalizedWallet);

      const [fromEvents, toEvents] = await Promise.all([
        interactionContract.queryFilter(fromFilter, 0, upToBlock),
        interactionContract.queryFilter(toFilter, 0, upToBlock),
      ]);

      const currentTx = currentTxHash.toLowerCase();
      const hasPrior = [...fromEvents, ...toEvents].some((evt: any) => {
        const evtTxHash = (evt?.transactionHash || evt?.log?.transactionHash || '').toLowerCase();
        return evtTxHash && evtTxHash !== currentTx;
      });

      return hasPrior;
    } catch (error) {
      logger.warn(`Failed to check prior token interactions for ${walletAddress} on ${tokenAddress}; assuming prior interaction.`, error);
      return true;
    }
  }

  private formatPositionPercent(current: number, previous: number): string {
    if (!Number.isFinite(previous) || previous <= 0) {
      return 'N/A';
    }

    const pct = ((current - previous) / previous) * 100;
    const sign = pct >= 0 ? '+' : '';
    return `${sign}${pct.toFixed(2)}%`;
  }

  private async handleTransferEvent(
    tokenAddress: string,
    from: string,
    to: string,
    value: bigint,
    event: any
  ): Promise<void> {
    try {
      const txHash = event?.log?.transactionHash || event?.transactionHash;
      const blockNumber = event?.log?.blockNumber || event?.blockNumber;

      if (!txHash || !blockNumber) {
        return;
      }

      const tx = await this.provider.getTransaction(txHash);

      if (!tx) {
        return;
      }

      const classification = this.classifyTransfer(from, to, tx);
      if (!classification) {
        return;
      }

      const { type, trader } = classification;

      const swapEvent: SwapEvent = {
        tokenAddress,
        type,
        amountIn: value,
        amountOut: value,
        buyer: trader,
        txHash,
        blockNumber,
        timestamp: Date.now(),
      };

      // Get additional transaction details
      const receipt = await this.provider.getTransactionReceipt(swapEvent.txHash);

      if (!tx || !receipt) return;

      // Calculate ETH value from transaction
      const ethValue = tx.value;

      // Get token info and price
      const tokenInfo = await this.priceService.getTokenInfo(tokenAddress);
      const price = await this.priceService.getTokenPrice(tokenAddress);

      const tokenDecimals = tokenInfo?.decimals ?? 18;
      const tokenAmount = ethers.formatUnits(value, tokenDecimals);
      const priceInEthNumeric = parseFloat(price?.priceInEth || '0');
      const priceInUsdNumeric = parseFloat(price?.priceInUsd || '0');
      const tokenAmountNumeric = parseFloat(tokenAmount || '0');
      const estimatedEthValue = (tokenAmountNumeric * priceInEthNumeric).toString();
      const totalUsdValue = tokenAmountNumeric * priceInUsdNumeric;
      const marketCapUsd = ((parseFloat(tokenInfo?.totalSupply || '0') || 0) * priceInUsdNumeric).toString();

      const balanceContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        this.provider
      );
      const currentHoldingsRaw: bigint = await balanceContract.balanceOf(trader);
      const currentHoldingsToken = ethers.formatUnits(currentHoldingsRaw, tokenDecimals);
      const currentHoldingsNumeric = parseFloat(currentHoldingsToken || '0') || 0;
      const currentHoldingsUsdNumeric = currentHoldingsNumeric * priceInUsdNumeric;

      const previousSnapshot = await this.db.getTraderPosition(tokenAddress, trader);
      const previousHoldingsNumeric = parseFloat(previousSnapshot?.holdings_token || '0') || 0;
      let positionLabel = 'NEW';

      if (previousSnapshot && previousHoldingsNumeric > 0) {
        positionLabel = this.formatPositionPercent(currentHoldingsNumeric, previousHoldingsNumeric);
      } else {
        const hasPriorInteraction = await this.hasPriorTokenInteraction(
          tokenAddress,
          trader,
          swapEvent.txHash,
          swapEvent.blockNumber
        );

        if (hasPriorInteraction) {
          const inferredPrevious = type === 'buy'
            ? Math.max(0, currentHoldingsNumeric - tokenAmountNumeric)
            : currentHoldingsNumeric + tokenAmountNumeric;
          positionLabel = this.formatPositionPercent(currentHoldingsNumeric, inferredPrevious);
        }
      }

      const holdingsTokenDisplay = currentHoldingsNumeric >= 1_000_000
        ? `${(currentHoldingsNumeric / 1_000_000).toFixed(2)}M`
        : currentHoldingsNumeric >= 1_000
          ? `${(currentHoldingsNumeric / 1_000).toFixed(2)}K`
          : currentHoldingsNumeric.toFixed(2);
      const holdingsUsdDisplay = `$${Math.max(0, Math.round(currentHoldingsUsdNumeric)).toLocaleString()}`;

      const alreadyDetected = await this.db.hasDetectedTransaction(swapEvent.txHash);
      if (alreadyDetected) {
        return;
      }

      // Get all chat IDs watching this token
      const watchers = await this.db.getTokenWatchers(tokenAddress);

      if (watchers.length === 0) {
        logger.info(`No watchers for token ${tokenInfo?.symbol || tokenAddress}; skipping alert for tx ${swapEvent.txHash}`);
        return;
      }

      // Send notification to all watchers
      let deliveredCount = 0;
      for (const watcher of watchers) {
        const settings = await this.db.getChatSettings(watcher.chat_id);
        const effectiveMediaType = watcher.alert_media_type || settings.alert_media_type;
        const effectiveMediaFileId = watcher.alert_media_file_id || settings.alert_media_file_id;

        if (totalUsdValue < settings.min_buy_usdc) {
          logger.info(
            `Skipped alert for chat ${watcher.chat_id}: swap $${totalUsdValue.toFixed(2)} below min buy $${settings.min_buy_usdc.toFixed(2)} (tx ${swapEvent.txHash})`
          );
          continue;
        }

        const message = formatTransactionAlert({
          type: swapEvent.type,
          tokenAddress,
          tokenSymbol: tokenInfo?.symbol || 'UNKNOWN',
          tokenName: tokenInfo?.name || 'Unknown Token',
          amount: tokenAmount,
          ethValue: estimatedEthValue,
          priceInEth: price?.priceInEth || '0',
          priceInUsd: price?.priceInUsd || '0',
          marketCapUsd,
          iconMultiplier: settings.icon_multiplier,
          buyIconPattern: settings.buy_icon_pattern,
          walletHoldingsToken: holdingsTokenDisplay,
          walletHoldingsUsd: holdingsUsdDisplay,
          positionLabel,
          buyer: trader,
          txHash: swapEvent.txHash,
          blockNumber: swapEvent.blockNumber,
        });

        const links = await this.db.getAlertLinks(watcher.chat_id);
        const websiteUrl = links.website_url || process.env.ALERT_WEBSITE_URL;
        const telegramUrl = links.telegram_url || process.env.ALERT_TELEGRAM_URL;
        const xUrl = links.x_url || process.env.ALERT_X_URL;
        const getFundedUrl = 'https://hyperpaxeer.com/';

        const buttonRow: Array<{ text: string; url: string }> = [];
        if (websiteUrl) buttonRow.push({ text: 'Website', url: websiteUrl });
        if (telegramUrl) buttonRow.push({ text: 'Telegram', url: telegramUrl });
        if (xUrl) buttonRow.push({ text: 'X', url: xUrl });
        const getFundedRow: Array<{ text: string; url: string }> = [
          { text: 'Get Funded', url: getFundedUrl },
        ];

        const sendOptions: TelegramBot.SendMessageOptions = {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: {
            inline_keyboard: buttonRow.length > 0
              ? [buttonRow, getFundedRow]
              : [getFundedRow],
          },
        };

        try {
          let sent = false;

          if (effectiveMediaFileId && effectiveMediaType === 'photo') {
            try {
              await this.bot.sendPhoto(watcher.chat_id, effectiveMediaFileId, {
                caption: message,
                parse_mode: 'HTML',
                reply_markup: sendOptions.reply_markup,
              });
              sent = true;
              deliveredCount += 1;
            } catch (mediaError) {
              logger.warn(`Photo alert failed for chat ${watcher.chat_id}, falling back to text alert.`, mediaError);
            }
          } else if (effectiveMediaFileId && effectiveMediaType === 'animation') {
            try {
              await this.bot.sendAnimation(watcher.chat_id, effectiveMediaFileId, {
                caption: message,
                parse_mode: 'HTML',
                reply_markup: sendOptions.reply_markup,
              });
              sent = true;
              deliveredCount += 1;
            } catch (mediaError) {
              logger.warn(`GIF alert failed for chat ${watcher.chat_id}, falling back to text alert.`, mediaError);
            }
          }

          if (!sent) {
            await this.bot.sendMessage(watcher.chat_id, message, sendOptions);
            deliveredCount += 1;
          }
        } catch (error) {
          logger.error(`Failed to send notification to chat ${watcher.chat_id}:`, error);
        }
      }

      if (deliveredCount > 0) {
        await this.db.saveDetectedTransaction(
          tokenAddress,
          swapEvent.txHash,
          type,
          trader,
          value.toString(),
          estimatedEthValue
        );
        await this.db.setTraderPosition(tokenAddress, trader, currentHoldingsToken);
        logger.info(`Delivered alert for tx ${swapEvent.txHash} to ${deliveredCount} watcher(s)`);
      } else {
        logger.warn(`No alert delivery succeeded for tx ${swapEvent.txHash}; transaction not marked as detected.`);
      }

      logger.info(`Detected ${type.toUpperCase()}: ${tokenInfo?.symbol || tokenAddress} - ${swapEvent.txHash}`);
    } catch (error) {
      logger.error('Error handling transfer event:', error);
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    
    // Remove all listeners
    for (const [tokenAddress, contract] of this.monitoredTokens) {
      contract.removeAllListeners();
    }
    
    this.monitoredTokens.clear();
    await this.provider.destroy();
    
    logger.info('Monitoring service stopped');
  }

  isTokenMonitored(tokenAddress: string): boolean {
    return this.monitoredTokens.has(tokenAddress);
  }
}
