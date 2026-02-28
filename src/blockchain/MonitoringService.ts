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
  dexSource?: 'AMM' | 'HLPMM';
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
  private pollingInProgress: boolean = false;
  private lastBlockNumber: number = 0;
  private hlpmmEventEmitter: ethers.Contract | null = null;
  private hlpmmFactory: ethers.Contract | null = null;
  private hlpmmUsidAddress: string | null = null;
  private hlpmmPoolTokenCache: Map<string, string> = new Map();
  private hlpmmEnabled: boolean = false;
  private disabledChats: Set<number> = new Set();
  private readonly ammRouterInterface = new ethers.Interface([
    'function swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
    'function swapExactETHForTokensSupportingFeeOnTransferTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)',
    'function swapETHForExactTokens(uint256 amountOut, address[] path, address to, uint256 deadline)',
    'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
    'function swapTokensForExactTokens(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
    'function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
    'function swapTokensForExactETH(uint256 amountOut, uint256 amountInMax, address[] path, address to, uint256 deadline)',
    'function swapExactTokensForTokensSupportingFeeOnTransferTokens(uint256 amountIn, uint256 amountOutMin, address[] path, address to, uint256 deadline)',
  ]);

  private constructor(bot: TelegramBot) {
    const rpcEndpoint = process.env.RPC_ENDPOINT!;
    this.provider = new ethers.JsonRpcProvider(rpcEndpoint);
    this.bot = bot;
    this.db = Database.getInstance();
    this.priceService = new PriceService();
    this.routerAddress = process.env.DEX_ROUTER_ADDRESS!;
    this.wethAddress = process.env.WETH_ADDRESS!;
    this.initHLPMM();
  }

  private initHLPMM(): void {
    const emitterAddr = process.env.HLPMM_EVENT_EMITTER_ADDRESS;
    const factoryAddr = process.env.HLPMM_FACTORY_ADDRESS;
    const usidAddr = process.env.HLPMM_USID_ADDRESS;

    if (!emitterAddr || !factoryAddr || !usidAddr) {
      logger.info('HLPMM monitoring disabled (missing HLPMM_EVENT_EMITTER_ADDRESS, HLPMM_FACTORY_ADDRESS, or HLPMM_USID_ADDRESS)');
      return;
    }

    this.hlpmmEventEmitter = new ethers.Contract(
      emitterAddr,
      [
        'event Swap(address indexed pool, address indexed sender, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut, uint256 newReserveUSID, uint256 newReserveToken, uint256 feeAmount, uint256 timestamp)',
      ],
      this.provider
    );

    this.hlpmmFactory = new ethers.Contract(
      factoryAddr,
      [
        'function poolToToken(address pool) view returns (address)',
        'function tokenToPool(address token) view returns (address)',
      ],
      this.provider
    );

    this.hlpmmUsidAddress = usidAddr.toLowerCase();
    this.hlpmmEnabled = true;
    logger.info('HLPMM monitoring enabled', { emitterAddr, factoryAddr, usidAddr });
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
      if (this.pollingInProgress) {
        return;
      }

      this.pollingInProgress = true;
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

          if (this.hlpmmEnabled && this.hlpmmEventEmitter) {
            try {
              const swapFilter = this.hlpmmEventEmitter.filters.Swap();
              const swapEvents = await this.hlpmmEventEmitter.queryFilter(swapFilter, fromBlock, currentBlock);

              for (const event of swapEvents) {
                if ('args' in event) {
                  await this.handleHLPMMSwapEvent(event);
                }
              }
            } catch (hlpmmError) {
              logger.error('Error polling HLPMM EventEmitter:', hlpmmError);
            }
          }

          this.lastBlockNumber = currentBlock;
        }
      } catch (error) {
        logger.error('Error in polling loop:', error);
      } finally {
        this.pollingInProgress = false;
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
    upToBlock: number,
    currentTxIndex: number
  ): Promise<boolean> {
    const hasPriorInEvents = (events: any[], txHash: string, blockNumber: number, txIndex: number): boolean => {
      const currentTx = txHash.toLowerCase();

      return events.some((evt: any) => {
        const evtTxHash = (evt?.transactionHash || evt?.log?.transactionHash || '').toLowerCase();
        if (!evtTxHash || evtTxHash === currentTx) {
          return false;
        }

        const evtBlock = Number(evt?.blockNumber ?? evt?.log?.blockNumber ?? -1);
        const evtTxIndex = Number(evt?.transactionIndex ?? evt?.log?.transactionIndex ?? Number.MAX_SAFE_INTEGER);

        if (evtBlock < blockNumber) {
          return true;
        }

        if (evtBlock > blockNumber) {
          return false;
        }

        return evtTxIndex < txIndex;
      });
    };

    const isRangeLimitError = (error: unknown): boolean => {
      const message = String(error || '').toLowerCase();
      return message.includes('maximum [from, to] blocks distance') || message.includes('maximum from, to blocks distance');
    };

    try {
      const interactionContract = new ethers.Contract(
        tokenAddress,
        ['event Transfer(address indexed from, address indexed to, uint256 value)'],
        this.provider
      );

      const normalizedWallet = walletAddress.toLowerCase();
      const fromFilter = interactionContract.filters.Transfer(normalizedWallet, null);
      const toFilter = interactionContract.filters.Transfer(null, normalizedWallet);

      try {
        const [fromEvents, toEvents] = await Promise.all([
          interactionContract.queryFilter(fromFilter, 0, upToBlock),
          interactionContract.queryFilter(toFilter, 0, upToBlock),
        ]);

        return hasPriorInEvents([...fromEvents, ...toEvents], currentTxHash, upToBlock, currentTxIndex);
      } catch (rangeError) {
        if (!isRangeLimitError(rangeError)) {
          throw rangeError;
        }

        const windowSize = 1000;

        for (let end = upToBlock; end >= 0; end -= windowSize) {
          const start = Math.max(0, end - windowSize + 1);
          const [fromEvents, toEvents] = await Promise.all([
            interactionContract.queryFilter(fromFilter, start, end),
            interactionContract.queryFilter(toFilter, start, end),
          ]);

          if (hasPriorInEvents([...fromEvents, ...toEvents], currentTxHash, upToBlock, currentTxIndex)) {
            return true;
          }
        }

        return false;
      }
    } catch (error) {
      logger.warn(`Failed to check prior token interactions for ${walletAddress} on ${tokenAddress}; assuming no prior interaction.`, error);
      return false;
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

  private isKickedChatError(error: unknown): boolean {
    const message = String(error || '').toLowerCase();
    return message.includes('bot was kicked') || message.includes('forbidden: bot was kicked');
  }

  private async resolveAmmPurchaseDetails(
    tx: ethers.TransactionResponse,
    boughtTokenAddress: string,
    estimatedAmountFallback: string
  ): Promise<{ symbol: string; amount: string }> {
    const nativeSymbol = process.env.NATIVE_CURRENCY_SYMBOL || 'PAX';
    const tokenAddressLower = boughtTokenAddress.toLowerCase();

    try {
      const parsed = this.ammRouterInterface.parseTransaction({ data: tx.data, value: tx.value });
      if (!parsed) {
        if (tx.value > 0n) {
          return { symbol: nativeSymbol, amount: ethers.formatEther(tx.value) };
        }
        return { symbol: nativeSymbol, amount: estimatedAmountFallback };
      }

      const name = parsed.name;
      const pathArg = name.includes('ETHFor') ? parsed.args[1] : parsed.args[2];
      const path = Array.isArray(pathArg) ? (pathArg as string[]) : [];

      if (path.length < 2 || path[path.length - 1].toLowerCase() !== tokenAddressLower) {
        return { symbol: nativeSymbol, amount: estimatedAmountFallback };
      }

      const inputToken = path[0].toLowerCase();
      let rawAmount: bigint | null = null;

      if (name === 'swapExactETHForTokens' || name === 'swapExactETHForTokensSupportingFeeOnTransferTokens' || name === 'swapETHForExactTokens') {
        rawAmount = tx.value;
      } else if (name === 'swapExactTokensForTokens' || name === 'swapExactTokensForETH' || name === 'swapExactTokensForTokensSupportingFeeOnTransferTokens') {
        rawAmount = parsed.args[0] as bigint;
      } else if (name === 'swapTokensForExactTokens' || name === 'swapTokensForExactETH') {
        rawAmount = parsed.args[1] as bigint;
      }

      if (!rawAmount || rawAmount <= 0n) {
        return { symbol: nativeSymbol, amount: estimatedAmountFallback };
      }

      if (inputToken === this.wethAddress.toLowerCase()) {
        return {
          symbol: nativeSymbol,
          amount: ethers.formatEther(rawAmount),
        };
      }

      const inputTokenContract = new ethers.Contract(
        inputToken,
        [
          'function symbol() view returns (string)',
          'function decimals() view returns (uint8)',
        ],
        this.provider
      );

      const [inputSymbol, inputDecimals] = await Promise.all([
        inputTokenContract.symbol(),
        inputTokenContract.decimals(),
      ]);

      return {
        symbol: inputSymbol,
        amount: ethers.formatUnits(rawAmount, Number(inputDecimals)),
      };
    } catch {
      return { symbol: nativeSymbol, amount: estimatedAmountFallback };
    }
  }

  private async computePositionLabel(
    tokenAddress: string,
    walletAddress: string,
    txHash: string,
    blockNumber: number,
    txIndex: number,
    currentHoldingsNumeric: number,
    deltaAmountNumeric: number
  ): Promise<string> {
    const previousSnapshot = await this.db.getTraderPosition(tokenAddress, walletAddress);
    const previousHoldingsNumeric = parseFloat(previousSnapshot?.holdings_token || '0') || 0;
    const inferredPrevious = Math.max(0, currentHoldingsNumeric - deltaAmountNumeric);

    if (previousSnapshot && previousHoldingsNumeric > 0) {
      if (currentHoldingsNumeric >= previousHoldingsNumeric) {
        return this.formatPositionPercent(currentHoldingsNumeric, previousHoldingsNumeric);
      }

      if (inferredPrevious > 0) {
        logger.info(
          `Position baseline fallback applied: token=${tokenAddress} trader=${walletAddress} tx=${txHash} snapshot=${previousHoldingsNumeric.toFixed(6)} inferred=${inferredPrevious.toFixed(6)} current=${currentHoldingsNumeric.toFixed(6)}`
        );
        return this.formatPositionPercent(currentHoldingsNumeric, inferredPrevious);
      }

      logger.info(
        `Position baseline reset to NEW: token=${tokenAddress} trader=${walletAddress} tx=${txHash} snapshot=${previousHoldingsNumeric.toFixed(6)} inferred=${inferredPrevious.toFixed(6)} current=${currentHoldingsNumeric.toFixed(6)}`
      );
      return 'NEW';
    }

    const hasPriorInteraction = await this.hasPriorTokenInteraction(
      tokenAddress,
      walletAddress,
      txHash,
      blockNumber,
      txIndex
    );

    if (!hasPriorInteraction) {
      return 'NEW';
    }

    if (inferredPrevious <= 0) {
      return 'NEW';
    }

    return this.formatPositionPercent(currentHoldingsNumeric, inferredPrevious);
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
        dexSource: 'AMM',
      };

      // Get additional transaction details
      const receipt = await this.provider.getTransactionReceipt(swapEvent.txHash);

      if (!tx || !receipt) return;
      const txIndex = Number((receipt as any).index ?? Number.MAX_SAFE_INTEGER);

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
      const purchaseDetails = await this.resolveAmmPurchaseDetails(tx, tokenAddress, estimatedEthValue);
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

      const positionLabel = await this.computePositionLabel(
        tokenAddress,
        trader,
        swapEvent.txHash,
        swapEvent.blockNumber,
        txIndex,
        currentHoldingsNumeric,
        tokenAmountNumeric
      );

      logger.info(
        `Computed position (AMM): token=${tokenInfo?.symbol || tokenAddress} trader=${trader} position=${positionLabel} tx=${swapEvent.txHash}`
      );

      const holdingsTokenDisplay = currentHoldingsNumeric >= 1_000_000
        ? `${(currentHoldingsNumeric / 1_000_000).toFixed(3)}M`
        : currentHoldingsNumeric >= 1_000
          ? `${(currentHoldingsNumeric / 1_000).toFixed(3)}K`
          : currentHoldingsNumeric.toFixed(3);
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
          ethValue: purchaseDetails.amount,
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
          purchaseCurrencySymbol: purchaseDetails.symbol,
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
          if (this.isKickedChatError(error) && !this.disabledChats.has(watcher.chat_id)) {
            this.disabledChats.add(watcher.chat_id);
            try {
              await this.db.disableChatWatchers(watcher.chat_id);
            } catch (disableError) {
              logger.error(`Failed to auto-disable kicked chat ${watcher.chat_id}:`, disableError);
            }
          }
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

      logger.info(`Detected ${type.toUpperCase()} (AMM): ${tokenInfo?.symbol || tokenAddress} - ${swapEvent.txHash}`);
    } catch (error) {
      logger.error('Error handling transfer event:', error);
    }
  }

  private async resolveHLPMMPoolToken(poolAddress: string): Promise<string | null> {
    const normalized = poolAddress.toLowerCase();
    const cached = this.hlpmmPoolTokenCache.get(normalized);
    if (cached) return cached;

    if (!this.hlpmmFactory) return null;

    try {
      const tokenAddr: string = await this.hlpmmFactory.poolToToken(poolAddress);
      if (!tokenAddr || tokenAddr === ethers.ZeroAddress) return null;
      const lower = tokenAddr.toLowerCase();
      this.hlpmmPoolTokenCache.set(normalized, lower);
      return lower;
    } catch (error) {
      logger.error(`Failed to resolve HLPMM pool ${poolAddress} to token:`, error);
      return null;
    }
  }

  private async handleHLPMMSwapEvent(event: any): Promise<void> {
    try {
      const pool: string = event.args[0];
      const sender: string = event.args[1];
      const tokenIn: string = event.args[2];
      const tokenOut: string = event.args[3];
      const amountIn: bigint = event.args[4];
      const amountOut: bigint = event.args[5];
      const feeAmount: bigint = event.args[8];

      const txHash = event?.log?.transactionHash || event?.transactionHash;
      const blockNumber = event?.log?.blockNumber || event?.blockNumber;
      const txIndex = Number(event?.log?.transactionIndex ?? event?.transactionIndex ?? Number.MAX_SAFE_INTEGER);

      if (!txHash || !blockNumber) return;

      const isBuy = tokenIn.toLowerCase() === this.hlpmmUsidAddress;
      if (!isBuy) return;

      const tokenAddress = tokenOut.toLowerCase();

      if (!this.monitoredTokens.has(tokenAddress)) {
        const resolved = await this.resolveHLPMMPoolToken(pool);
        if (!resolved || !this.monitoredTokens.has(resolved)) return;
      }

      const alreadyDetected = await this.db.hasDetectedTransaction(txHash);
      if (alreadyDetected) return;

      const tx = await this.provider.getTransaction(txHash);
      if (!tx) return;

      const buyer = tx.from;

      const tokenInfo = await this.priceService.getTokenInfo(tokenAddress);
      const tokenDecimals = tokenInfo?.decimals ?? 18;
      const tokenAmount = ethers.formatUnits(amountOut, tokenDecimals);
      const usidAmount = ethers.formatEther(amountIn);

      const tokenAmountNumeric = parseFloat(tokenAmount || '0');
      const usidAmountNumeric = parseFloat(usidAmount || '0');

      const priceInUsdNumeric = tokenAmountNumeric > 0
        ? usidAmountNumeric / tokenAmountNumeric
        : 0;

      const price = await this.priceService.getTokenPrice(tokenAddress);
      const effectivePriceInUsd = priceInUsdNumeric > 0
        ? priceInUsdNumeric.toFixed(6)
        : (price?.priceInUsd || '0');
      const effectivePriceInEth = price?.priceInEth || '0';

      const totalUsdValue = usidAmountNumeric;

      const hlpmmMarketCap = await this.priceService.getHLPMMMarketCap(tokenAddress);
      const marketCapUsd = hlpmmMarketCap
        || ((parseFloat(tokenInfo?.totalSupply || '0') || 0) * parseFloat(effectivePriceInUsd)).toString();

      const balanceContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        this.provider
      );
      const currentHoldingsRaw: bigint = await balanceContract.balanceOf(buyer);
      const currentHoldingsToken = ethers.formatUnits(currentHoldingsRaw, tokenDecimals);
      const currentHoldingsNumeric = parseFloat(currentHoldingsToken || '0') || 0;
      const currentHoldingsUsdNumeric = currentHoldingsNumeric * parseFloat(effectivePriceInUsd);

      const positionLabel = await this.computePositionLabel(
        tokenAddress,
        buyer,
        txHash,
        blockNumber,
        txIndex,
        currentHoldingsNumeric,
        tokenAmountNumeric
      );

      logger.info(
        `Computed position (HLPMM): token=${tokenInfo?.symbol || tokenAddress} trader=${buyer} position=${positionLabel} tx=${txHash}`
      );

      const holdingsTokenDisplay = currentHoldingsNumeric >= 1_000_000
        ? `${(currentHoldingsNumeric / 1_000_000).toFixed(3)}M`
        : currentHoldingsNumeric >= 1_000
          ? `${(currentHoldingsNumeric / 1_000).toFixed(3)}K`
          : currentHoldingsNumeric.toFixed(3);
      const holdingsUsdDisplay = `$${Math.max(0, Math.round(currentHoldingsUsdNumeric)).toLocaleString()}`;

      const watchers = await this.db.getTokenWatchers(tokenAddress);
      if (watchers.length === 0) {
        logger.info(`No watchers for HLPMM token ${tokenInfo?.symbol || tokenAddress}; skipping alert for tx ${txHash}`);
        return;
      }

      let deliveredCount = 0;
      for (const watcher of watchers) {
        const settings = await this.db.getChatSettings(watcher.chat_id);
        const effectiveMediaType = watcher.alert_media_type || settings.alert_media_type;
        const effectiveMediaFileId = watcher.alert_media_file_id || settings.alert_media_file_id;

        if (totalUsdValue < settings.min_buy_usdc) {
          logger.info(
            `Skipped HLPMM alert for chat ${watcher.chat_id}: swap $${totalUsdValue.toFixed(2)} below min buy $${settings.min_buy_usdc.toFixed(2)} (tx ${txHash})`
          );
          continue;
        }

        const message = formatTransactionAlert({
          type: 'buy',
          tokenAddress,
          tokenSymbol: tokenInfo?.symbol || 'UNKNOWN',
          tokenName: tokenInfo?.name || 'Unknown Token',
          amount: tokenAmount,
          ethValue: usidAmount,
          priceInEth: effectivePriceInEth,
          priceInUsd: effectivePriceInUsd,
          marketCapUsd,
          iconMultiplier: settings.icon_multiplier,
          buyIconPattern: settings.buy_icon_pattern,
          walletHoldingsToken: holdingsTokenDisplay,
          walletHoldingsUsd: holdingsUsdDisplay,
          positionLabel,
          buyer,
          txHash,
          blockNumber,
          dexSource: 'HLPMM',
          purchaseCurrencySymbol: 'USID',
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
              logger.warn(`HLPMM photo alert failed for chat ${watcher.chat_id}, falling back to text alert.`, mediaError);
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
              logger.warn(`HLPMM GIF alert failed for chat ${watcher.chat_id}, falling back to text alert.`, mediaError);
            }
          }

          if (!sent) {
            await this.bot.sendMessage(watcher.chat_id, message, sendOptions);
            deliveredCount += 1;
          }
        } catch (error) {
          logger.error(`Failed to send HLPMM notification to chat ${watcher.chat_id}:`, error);
          if (this.isKickedChatError(error) && !this.disabledChats.has(watcher.chat_id)) {
            this.disabledChats.add(watcher.chat_id);
            try {
              await this.db.disableChatWatchers(watcher.chat_id);
            } catch (disableError) {
              logger.error(`Failed to auto-disable kicked chat ${watcher.chat_id}:`, disableError);
            }
          }
        }
      }

      if (deliveredCount > 0) {
        await this.db.saveDetectedTransaction(
          tokenAddress,
          txHash,
          'buy',
          buyer,
          amountOut.toString(),
          usidAmount
        );
        await this.db.setTraderPosition(tokenAddress, buyer, currentHoldingsToken);
        logger.info(`Delivered HLPMM alert for tx ${txHash} to ${deliveredCount} watcher(s)`);
      } else {
        logger.warn(`No HLPMM alert delivery succeeded for tx ${txHash}; transaction not marked as detected.`);
      }

      logger.info(`Detected BUY (HLPMM): ${tokenInfo?.symbol || tokenAddress} - ${txHash}`);
    } catch (error) {
      logger.error('Error handling HLPMM swap event:', error);
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
