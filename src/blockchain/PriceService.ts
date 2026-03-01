import { ethers } from 'ethers';
import axios from 'axios';
import { logger } from '../utils/logger';

export interface TokenPrice {
  priceInEth: string;
  priceInUsd: string;
}

export interface TokenStatusMetrics {
  marketCapUsd: number | null;
  volume24hUsd: number | null;
  buyers24h: number | null;
  sellers24h: number | null;
  holders: number | null;
  biggestBuy24hUsd: number | null;
}

export class PriceService {
  private provider: ethers.JsonRpcProvider;
  private routerAddress: string;
  private wethAddress: string;
  private usdcAddress: string;
  private hlpmmQuoterAddress: string | null;
  private hlpmmFactoryAddress: string | null;
  private hlpmmUsidAddress: string | null;
  private portfolioApiBaseUrl: string;
  private explorerApiBaseUrl: string;
  private explorerApiKey: string;
  private statusMetricsDebugEnabled: boolean;
  private statusMetricsDebugLoggedTokens: Set<string> = new Set();
  private paxUsdErrorLoggedAt: number = 0;
  private walletTotalUsdCache: Map<string, { value: number | null; expiresAt: number }> = new Map();

  constructor() {
    const rpcEndpoint = process.env.RPC_ENDPOINT!;
    this.provider = new ethers.JsonRpcProvider(rpcEndpoint);
    this.routerAddress = process.env.DEX_ROUTER_ADDRESS!;
    this.wethAddress = process.env.WETH_ADDRESS!;
    this.usdcAddress = process.env.USDC_ADDRESS || '0xf8850b62AE017c55be7f571BBad840b4f3DA7D49';
    this.hlpmmQuoterAddress = process.env.HLPMM_QUOTER_ADDRESS || null;
    this.hlpmmFactoryAddress = process.env.HLPMM_FACTORY_ADDRESS || null;
    this.hlpmmUsidAddress = process.env.HLPMM_USID_ADDRESS || null;
    this.portfolioApiBaseUrl = (process.env.PORTFOLIO_API_BASE_URL || 'https://us-east-1.user-stats.sidiora.exchange').replace(/\/+$/, '');
    this.explorerApiBaseUrl = (process.env.BLOCK_EXPLORER_API_URL || 'https://paxscan.io/api').replace(/\/+$/, '');
    this.explorerApiKey = process.env.BLOCK_EXPLORER_API_KEY || process.env.ETHERSCAN_API_KEY || '';
    this.statusMetricsDebugEnabled = (process.env.STATUS_METRICS_DEBUG || 'false').toLowerCase() === 'true';
  }

  private async getPaxscanTokenStats(tokenAddress: string): Promise<Partial<TokenStatusMetrics>> {
    const normalized = tokenAddress.toLowerCase();
    const nowSec = Math.floor(Date.now() / 1000);
    const dayAgoSec = nowSec - 24 * 60 * 60;
    const routerAddress = this.routerAddress.toLowerCase();

    const buildParams = (extra: Record<string, string>) => ({
      module: 'account',
      apikey: this.explorerApiKey,
      ...extra,
    });

    const fetchResult = async (params: Record<string, string>): Promise<any[] | null> => {
      try {
        const response = await axios.get(this.explorerApiBaseUrl, {
          params,
          timeout: 8000,
        });
        const payload = response.data;
        const result = payload?.result;
        if (Array.isArray(result)) {
          return result;
        }
        return null;
      } catch {
        return null;
      }
    };

    const fetchHolderCount = async (): Promise<number | null> => {
      try {
        const response = await axios.get(this.explorerApiBaseUrl, {
          params: {
            module: 'token',
            action: 'tokenholdercount',
            contractaddress: normalized,
            apikey: this.explorerApiKey,
          },
          timeout: 8000,
        });

        const raw = response.data?.result;
        const holderCount = typeof raw === 'string' || typeof raw === 'number'
          ? parseFloat(String(raw).replace(/[,_\s]/g, ''))
          : NaN;
        if (!Number.isFinite(holderCount) || holderCount < 0) {
          return null;
        }
        return Math.floor(holderCount);
      } catch {
        return null;
      }
    };

    const transfers = await fetchResult(
      buildParams({
        action: 'tokentx',
        contractaddress: normalized,
        page: '1',
        offset: '200',
        sort: 'desc',
      })
    );

    const holders = await fetchHolderCount();

    if (!transfers || transfers.length === 0) {
      return { holders };
    }

    const price = await this.getTokenPrice(normalized);
    const priceInUsd = parseFloat(price?.priceInUsd || '0');
    const hasUsdPrice = Number.isFinite(priceInUsd) && priceInUsd > 0;

    const buyerSet = new Set<string>();
    const sellerSet = new Set<string>();
    const genericRecipientSet = new Set<string>();
    const genericSenderSet = new Set<string>();
    let biggestBuyUsd = 0;
    let volume24hUsd = 0;
    let routerClassifiedTransferCount = 0;
    let genericTransferCount = 0;
    let genericBiggestTransferUsd = 0;

    const zeroAddress = '0x0000000000000000000000000000000000000000';

    for (const transfer of transfers) {
      const timeStamp = parseInt(String(transfer?.timeStamp || '0'), 10);
      if (!Number.isFinite(timeStamp) || timeStamp < dayAgoSec || timeStamp > nowSec + 300) {
        continue;
      }

      const from = String(transfer?.from || '').toLowerCase();
      const to = String(transfer?.to || '').toLowerCase();
      const valueRaw = String(transfer?.value || '0');
      const tokenDecimalRaw = String(transfer?.tokenDecimal || transfer?.tokenDecimals || '18');
      const tokenDecimals = parseInt(tokenDecimalRaw, 10);

      if (!/^\d+$/.test(valueRaw) || !Number.isFinite(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 30) {
        continue;
      }

      let tokenAmount = 0;
      try {
        tokenAmount = parseFloat(ethers.formatUnits(BigInt(valueRaw), tokenDecimals));
      } catch {
        continue;
      }

      if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
        continue;
      }

      const transferUsd = hasUsdPrice ? tokenAmount * priceInUsd : 0;

      if (from && from !== zeroAddress && from !== routerAddress) {
        genericSenderSet.add(from);
      }
      if (to && to !== zeroAddress && to !== routerAddress) {
        genericRecipientSet.add(to);
      }
      if (transferUsd > 0) {
        genericTransferCount += 1;
        if (transferUsd > genericBiggestTransferUsd) {
          genericBiggestTransferUsd = transferUsd;
        }
      }

      if (from === routerAddress) {
        routerClassifiedTransferCount += 1;
        if (to) {
          buyerSet.add(to);
        }
        if (transferUsd > biggestBuyUsd) {
          biggestBuyUsd = transferUsd;
        }
        volume24hUsd += transferUsd;
        continue;
      }

      if (to === routerAddress) {
        routerClassifiedTransferCount += 1;
        if (from) {
          sellerSet.add(from);
        }
        volume24hUsd += transferUsd;
      }
    }

    let buyers24h = buyerSet.size > 0 ? buyerSet.size : null;
    let sellers24h = sellerSet.size > 0 ? sellerSet.size : null;

    if (routerClassifiedTransferCount === 0) {
      buyers24h = genericRecipientSet.size > 0 ? genericRecipientSet.size : buyers24h;
      sellers24h = genericSenderSet.size > 0 ? genericSenderSet.size : sellers24h;

      if (volume24hUsd <= 0 && genericTransferCount > 0) {
        volume24hUsd = volume24hUsd + (hasUsdPrice ? genericTransferCount > 0 ? transfers
          .filter((transfer) => {
            const timeStamp = parseInt(String(transfer?.timeStamp || '0'), 10);
            return Number.isFinite(timeStamp) && timeStamp >= dayAgoSec && timeStamp <= nowSec + 300;
          })
          .reduce((sum, transfer) => {
            const valueRaw = String(transfer?.value || '0');
            const tokenDecimalRaw = String(transfer?.tokenDecimal || transfer?.tokenDecimals || '18');
            const tokenDecimals = parseInt(tokenDecimalRaw, 10);
            if (!/^\d+$/.test(valueRaw) || !Number.isFinite(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 30) {
              return sum;
            }
            try {
              const tokenAmount = parseFloat(ethers.formatUnits(BigInt(valueRaw), tokenDecimals));
              if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) {
                return sum;
              }
              return sum + tokenAmount * priceInUsd;
            } catch {
              return sum;
            }
          }, 0)
          : 0 : 0);
      }

      if (biggestBuyUsd <= 0 && genericBiggestTransferUsd > 0) {
        biggestBuyUsd = genericBiggestTransferUsd;
      }
    }

    return {
      holders,
      buyers24h,
      sellers24h,
      volume24hUsd: volume24hUsd > 0 ? volume24hUsd : null,
      biggestBuy24hUsd: biggestBuyUsd > 0 ? biggestBuyUsd : null,
    };
  }

  private async getTokenFromPortfolioApi(tokenAddress: string): Promise<any | null> {
    try {
      const normalized = tokenAddress.toLowerCase();
      const url = `${this.portfolioApiBaseUrl}/api/v1/tokens/${normalized}`;
      const response = await axios.get(url, { timeout: 8000 });
      return response.data || null;
    } catch {
      return null;
    }
  }

  private extractWalletTotalUsd(payload: any): number | null {
    const candidates = [
      payload,
      payload?.data,
      payload?.result,
      payload?.portfolio,
      payload?.wallet,
      payload?.portfolio?.summary,
      payload?.data?.summary,
    ];

    for (const candidate of candidates) {
      const value = this.parseNumericField(candidate, [
        'total_value_usd',
        'totalValueUsd',
        'portfolio_value_usd',
        'portfolioValueUsd',
        'wallet_value_usd',
        'walletValueUsd',
        'net_worth_usd',
        'netWorthUsd',
        'total_balance_usd',
        'totalBalanceUsd',
      ]);

      if (value !== null) {
        return value;
      }
    }

    return null;
  }

  async getWalletTotalUsd(walletAddress: string): Promise<number | null> {
    const normalizedWallet = walletAddress.toLowerCase();
    const now = Date.now();
    const cached = this.walletTotalUsdCache.get(normalizedWallet);
    if (cached && cached.expiresAt > now) {
      return cached.value;
    }

    const endpoints = [
      `${this.portfolioApiBaseUrl}/api/v1/wallets/${normalizedWallet}`,
      `${this.portfolioApiBaseUrl}/api/v1/wallet/${normalizedWallet}`,
      `${this.portfolioApiBaseUrl}/api/v1/portfolio/${normalizedWallet}`,
      `${this.portfolioApiBaseUrl}/api/v1/users/${normalizedWallet}/portfolio`,
    ];

    for (const url of endpoints) {
      try {
        const response = await axios.get(url, { timeout: 6000 });
        const totalUsd = this.extractWalletTotalUsd(response.data);
        if (totalUsd !== null) {
          this.walletTotalUsdCache.set(normalizedWallet, {
            value: totalUsd,
            expiresAt: now + 30_000,
          });
          return totalUsd;
        }
      } catch {
        continue;
      }
    }

    this.walletTotalUsdCache.set(normalizedWallet, {
      value: null,
      expiresAt: now + 30_000,
    });
    return null;
  }

  private parseNumericField(source: any, keys: string[]): number | null {
    for (const key of keys) {
      const raw = source?.[key];
      const normalizedRaw = typeof raw === 'string' ? raw.replace(/[,_\s]/g, '') : raw;
      const value = typeof normalizedRaw === 'string' || typeof normalizedRaw === 'number'
        ? parseFloat(String(normalizedRaw))
        : NaN;
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return null;
  }

  private parseNumericFieldAllowZero(source: any, keys: string[]): number | null {
    for (const key of keys) {
      const raw = source?.[key];
      const normalizedRaw = typeof raw === 'string' ? raw.replace(/[,_\s]/g, '') : raw;
      const value = typeof normalizedRaw === 'string' || typeof normalizedRaw === 'number'
        ? parseFloat(String(normalizedRaw))
        : NaN;
      if (Number.isFinite(value) && value >= 0) {
        return value;
      }
    }
    return null;
  }

  private parseIntegerFieldAllowZero(source: any, keys: string[]): number | null {
    const numeric = this.parseNumericFieldAllowZero(source, keys);
    if (numeric === null) {
      return null;
    }
    return Math.floor(numeric);
  }

  private extractMetricFromCandidates(
    candidates: any[],
    keys: string[],
    integer: boolean = false
  ): number | null {
    for (const candidate of candidates) {
      const value = integer
        ? this.parseIntegerFieldAllowZero(candidate, keys)
        : this.parseNumericFieldAllowZero(candidate, keys);

      if (value !== null) {
        return value;
      }
    }

    return null;
  }

  private findNumericByKeysDeep(source: any, keys: string[], allowZero: boolean = true): number | null {
    if (!source) {
      return null;
    }

    const normalizedTargetKeys = new Set(
      keys.map((key) => key.toLowerCase().replace(/[^a-z0-9]/g, ''))
    );
    const queue: any[] = [source];
    const seen = new Set<any>();

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || typeof current !== 'object') {
        continue;
      }

      if (seen.has(current)) {
        continue;
      }
      seen.add(current);

      for (const [rawKey, rawValue] of Object.entries(current)) {
        const normalizedKey = rawKey.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (normalizedTargetKeys.has(normalizedKey)) {
          const normalizedValue = typeof rawValue === 'string'
            ? rawValue.replace(/[,_\s]/g, '')
            : rawValue;
          const numeric = typeof normalizedValue === 'string' || typeof normalizedValue === 'number'
            ? parseFloat(String(normalizedValue))
            : NaN;

          if (Number.isFinite(numeric) && (allowZero ? numeric >= 0 : numeric > 0)) {
            return numeric;
          }
        }

        if (rawValue && typeof rawValue === 'object') {
          queue.push(rawValue);
        }
      }
    }

    return null;
  }

  private normalizeUsdPrice(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
      return '0';
    }

    if (value >= 1) {
      return value.toFixed(3);
    }

    const precise = value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
    return precise === '' || precise === '0' ? '0' : precise;
  }

  private normalizeApiTotalSupply(totalSupplyRaw: unknown, decimals: number): string {
    if (totalSupplyRaw === null || totalSupplyRaw === undefined) {
      return '0';
    }

    const rawString = String(totalSupplyRaw).trim();
    if (!rawString) {
      return '0';
    }

    if (!/^\d+$/.test(rawString)) {
      return rawString;
    }

    if (!Number.isFinite(decimals) || decimals <= 0) {
      return rawString;
    }

    if (rawString.length > decimals + 6) {
      try {
        return ethers.formatUnits(BigInt(rawString), decimals);
      } catch {
        return rawString;
      }
    }

    return rawString;
  }

  private async getTokenPriceFromPortfolioApi(tokenAddress: string): Promise<TokenPrice | null> {
    const data = await this.getTokenFromPortfolioApi(tokenAddress);
    if (!data) {
      return null;
    }

    const usd = this.parseNumericField(data, [
      'price_usd',
      'priceUsd',
      'current_price_usd',
      'currentPriceUsd',
      'usd_price',
      'usdPrice',
    ]);

    const eth = this.parseNumericField(data, [
      'price_in_eth',
      'priceInEth',
      'eth_price',
      'ethPrice',
    ]);

    if (!usd && !eth) {
      return null;
    }

    const paxUsdPrice = await this.getPaxUsdPrice(6);
    const resolvedUsd = usd ?? ((eth || 0) * paxUsdPrice);
    const resolvedEth = eth ?? (resolvedUsd > 0 && paxUsdPrice > 0 ? resolvedUsd / paxUsdPrice : 0);

    if (!(resolvedUsd > 0) && !(resolvedEth > 0)) {
      return null;
    }

    return {
      priceInEth: resolvedEth.toFixed(8),
      priceInUsd: this.normalizeUsdPrice(resolvedUsd),
    };
  }

  async getTokenPrice(tokenAddress: string): Promise<TokenPrice | null> {
    try {
      const apiPrice = await this.getTokenPriceFromPortfolioApi(tokenAddress);
      if (apiPrice) {
        return apiPrice;
      }

      const routerABI = [
        'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
      ];

      const tokenABI = [
        'function decimals() view returns (uint8)',
      ];

      const router = new ethers.Contract(this.routerAddress, routerABI, this.provider);
      const tokenContract = new ethers.Contract(tokenAddress, tokenABI, this.provider);
      const usdcContract = new ethers.Contract(this.usdcAddress, tokenABI, this.provider);

      const [tokenDecimals, usdcDecimals] = await Promise.all([
        tokenContract.decimals(),
        usdcContract.decimals(),
      ]);

      const amountIn = ethers.parseUnits('1', Number(tokenDecimals));
      const paxUsdPrice = await this.getPaxUsdPrice(Number(usdcDecimals));

      let priceInEth = '0';
      let priceInUsd = '0';

      try {
        const wethPath = [tokenAddress, this.wethAddress];
        const wethAmounts = await router.getAmountsOut(amountIn, wethPath);
        priceInEth = ethers.formatEther(wethAmounts[1]);
      } catch {
        // Ignore; we'll try USDC path fallback
      }

      try {
        const usdcPath = [tokenAddress, this.usdcAddress];
        const usdcAmounts = await router.getAmountsOut(amountIn, usdcPath);
        priceInUsd = ethers.formatUnits(usdcAmounts[1], Number(usdcDecimals));
      } catch {
        // Ignore; we'll rely on ETH path if available
      }

      if (priceInUsd === '0' && priceInEth !== '0') {
        priceInUsd = this.normalizeUsdPrice(parseFloat(priceInEth) * paxUsdPrice);
      }

      if (priceInEth === '0' && priceInUsd !== '0') {
        priceInEth = (parseFloat(priceInUsd) / paxUsdPrice).toFixed(8);
      }

      if (priceInEth === '0' && priceInUsd === '0') {
        const hlpmmPrice = await this.getHLPMMTokenPrice(tokenAddress);
        return hlpmmPrice;
      }

      return {
        priceInEth,
        priceInUsd: this.normalizeUsdPrice(parseFloat(priceInUsd || '0')),
      };
    } catch (error) {
      logger.error('Error getting token price from AMM:', error);
      const fallbackPrice = await this.getHLPMMTokenPrice(tokenAddress);
      return fallbackPrice;
    }
  }

  async getTokenStatusMetrics(tokenAddress: string): Promise<TokenStatusMetrics> {
    try {
      const normalized = tokenAddress.toLowerCase();
      let data = await this.getTokenFromPortfolioApi(tokenAddress);
      if (!data) {
        const fallbackEndpoints = [
          `${this.portfolioApiBaseUrl}/api/v1/tokens/${normalized}/stats`,
          `${this.portfolioApiBaseUrl}/api/v1/token/${normalized}/stats`,
          `${this.portfolioApiBaseUrl}/api/v1/markets/${normalized}`,
        ];

        for (const url of fallbackEndpoints) {
          try {
            const response = await axios.get(url, { timeout: 8000 });
            if (response.data) {
              data = response.data;
              break;
            }
          } catch {
            continue;
          }
        }
      }

      const candidates = [
        data,
        data?.data,
        data?.result,
        data?.stats,
        data?.metrics,
        data?.data?.stats,
        data?.data?.metrics,
      ];

      const fromPortfolio = {
        marketCap: false,
        volume24h: false,
        buyers24h: false,
        sellers24h: false,
        holders: false,
        biggestBuy24h: false,
      };

      const fromExplorer = {
        volume24h: false,
        buyers24h: false,
        sellers24h: false,
        holders: false,
        biggestBuy24h: false,
      };

      let marketCapUsd = this.extractMetricFromCandidates(candidates, [
        'market_cap_usd',
        'marketCapUsd',
        'marketcap_usd',
        'market_cap',
        'marketCap',
        'fdv_usd',
        'fdvUsd',
      ]);
      if (marketCapUsd !== null) {
        fromPortfolio.marketCap = true;
      }
      if (marketCapUsd === null && data) {
        marketCapUsd = this.findNumericByKeysDeep(data, [
          'market_cap_usd',
          'marketCapUsd',
          'marketcap_usd',
          'market_cap',
          'marketCap',
          'fdv_usd',
          'fdvUsd',
        ]);
        if (marketCapUsd !== null) {
          fromPortfolio.marketCap = true;
        }
      }

      let volume24hUsd = this.extractMetricFromCandidates(candidates, [
        'volume_24h_usd',
        'volume24hUsd',
        'trading_volume_24h_usd',
        'tradingVolume24hUsd',
        'volume_24h',
        'volume24h',
      ]);
      if (volume24hUsd !== null) {
        fromPortfolio.volume24h = true;
      }
      if (volume24hUsd === null && data) {
        volume24hUsd = this.findNumericByKeysDeep(data, [
          'volume_24h_usd',
          'volume24hUsd',
          'trading_volume_24h_usd',
          'tradingVolume24hUsd',
          'volume_24h',
          'volume24h',
        ]);
        if (volume24hUsd !== null) {
          fromPortfolio.volume24h = true;
        }
      }

      let buyers24h = this.extractMetricFromCandidates(
        candidates,
        [
          'buyers_24h',
          'buyers24h',
          'unique_buyers_24h',
          'uniqueBuyers24h',
          'buy_count_24h',
          'buyCount24h',
          'buys_24h',
          'buys24h',
        ],
        true
      );
      if (buyers24h !== null) {
        fromPortfolio.buyers24h = true;
      }
      if (buyers24h === null && data) {
        const deepBuyers = this.findNumericByKeysDeep(data, [
          'buyers_24h',
          'buyers24h',
          'unique_buyers_24h',
          'uniqueBuyers24h',
          'buy_count_24h',
          'buyCount24h',
          'buys_24h',
          'buys24h',
        ]);
        buyers24h = deepBuyers !== null ? Math.floor(deepBuyers) : null;
        if (buyers24h !== null) {
          fromPortfolio.buyers24h = true;
        }
      }

      let sellers24h = this.extractMetricFromCandidates(
        candidates,
        [
          'sellers_24h',
          'sellers24h',
          'unique_sellers_24h',
          'uniqueSellers24h',
          'sell_count_24h',
          'sellCount24h',
          'sells_24h',
          'sells24h',
        ],
        true
      );
      if (sellers24h !== null) {
        fromPortfolio.sellers24h = true;
      }
      if (sellers24h === null && data) {
        const deepSellers = this.findNumericByKeysDeep(data, [
          'sellers_24h',
          'sellers24h',
          'unique_sellers_24h',
          'uniqueSellers24h',
          'sell_count_24h',
          'sellCount24h',
          'sells_24h',
          'sells24h',
        ]);
        sellers24h = deepSellers !== null ? Math.floor(deepSellers) : null;
        if (sellers24h !== null) {
          fromPortfolio.sellers24h = true;
        }
      }

      let holders = this.extractMetricFromCandidates(
        candidates,
        [
          'holders',
          'holders_count',
          'holdersCount',
          'holder_count',
          'holderCount',
          'total_holders',
          'totalHolders',
        ],
        true
      );
      if (holders !== null) {
        fromPortfolio.holders = true;
      }
      if (holders === null && data) {
        const deepHolders = this.findNumericByKeysDeep(data, [
          'holders',
          'holders_count',
          'holdersCount',
          'holder_count',
          'holderCount',
          'total_holders',
          'totalHolders',
        ]);
        holders = deepHolders !== null ? Math.floor(deepHolders) : null;
        if (holders !== null) {
          fromPortfolio.holders = true;
        }
      }

      let biggestBuy24hUsd = this.extractMetricFromCandidates(candidates, [
        'biggest_buy_usd_24h',
        'biggestBuyUsd24h',
        'max_buy_usd_24h',
        'maxBuyUsd24h',
        'recent_biggest_buy_usd',
        'recentBiggestBuyUsd',
      ]);
      if (biggestBuy24hUsd !== null) {
        fromPortfolio.biggestBuy24h = true;
      }
      if (biggestBuy24hUsd === null && data) {
        biggestBuy24hUsd = this.findNumericByKeysDeep(data, [
          'biggest_buy_usd_24h',
          'biggestBuyUsd24h',
          'max_buy_usd_24h',
          'maxBuyUsd24h',
          'recent_biggest_buy_usd',
          'recentBiggestBuyUsd',
        ]);
        if (biggestBuy24hUsd !== null) {
          fromPortfolio.biggestBuy24h = true;
        }
      }

      if (marketCapUsd === null) {
        const tokenInfo = await this.getTokenInfo(tokenAddress);
        if (tokenInfo?.marketCapUsd) {
          const parsedMarketCap = parseFloat(tokenInfo.marketCapUsd);
          if (Number.isFinite(parsedMarketCap) && parsedMarketCap > 0) {
            marketCapUsd = parsedMarketCap;
          }
        }

        if (marketCapUsd === null && tokenInfo) {
          const price = await this.getTokenPrice(tokenAddress);
          const priceInUsd = parseFloat(price?.priceInUsd || '0');
          const supply = parseFloat(tokenInfo.totalSupply || '0');
          if (Number.isFinite(priceInUsd) && priceInUsd > 0 && Number.isFinite(supply) && supply > 0) {
            marketCapUsd = priceInUsd * supply;
          }
        }
      }

      const needExplorerFallback =
        volume24hUsd === null ||
        buyers24h === null ||
        sellers24h === null ||
        holders === null ||
        biggestBuy24hUsd === null;

      if (needExplorerFallback) {
        const explorerStats = await this.getPaxscanTokenStats(tokenAddress);

        if (volume24hUsd === null && explorerStats.volume24hUsd !== undefined) {
          volume24hUsd = explorerStats.volume24hUsd ?? null;
          if (volume24hUsd !== null) {
            fromExplorer.volume24h = true;
          }
        }
        if (buyers24h === null && explorerStats.buyers24h !== undefined) {
          buyers24h = explorerStats.buyers24h ?? null;
          if (buyers24h !== null) {
            fromExplorer.buyers24h = true;
          }
        }
        if (sellers24h === null && explorerStats.sellers24h !== undefined) {
          sellers24h = explorerStats.sellers24h ?? null;
          if (sellers24h !== null) {
            fromExplorer.sellers24h = true;
          }
        }
        if (holders === null && explorerStats.holders !== undefined) {
          holders = explorerStats.holders ?? null;
          if (holders !== null) {
            fromExplorer.holders = true;
          }
        }
        if (biggestBuy24hUsd === null && explorerStats.biggestBuy24hUsd !== undefined) {
          biggestBuy24hUsd = explorerStats.biggestBuy24hUsd ?? null;
          if (biggestBuy24hUsd !== null) {
            fromExplorer.biggestBuy24h = true;
          }
        }
      }

      if (this.statusMetricsDebugEnabled && !this.statusMetricsDebugLoggedTokens.has(normalized)) {
        this.statusMetricsDebugLoggedTokens.add(normalized);
        logger.info('Status metrics source debug', {
          token: normalized,
          sources: {
            marketCap: fromPortfolio.marketCap ? 'portfolio' : marketCapUsd !== null ? 'computed' : 'missing',
            volume24h: fromPortfolio.volume24h ? 'portfolio' : fromExplorer.volume24h ? 'explorer' : 'missing',
            buyers24h: fromPortfolio.buyers24h ? 'portfolio' : fromExplorer.buyers24h ? 'explorer' : 'missing',
            sellers24h: fromPortfolio.sellers24h ? 'portfolio' : fromExplorer.sellers24h ? 'explorer' : 'missing',
            holders: fromPortfolio.holders ? 'portfolio' : fromExplorer.holders ? 'explorer' : 'missing',
            biggestBuy24h: fromPortfolio.biggestBuy24h ? 'portfolio' : fromExplorer.biggestBuy24h ? 'explorer' : 'missing',
          },
          values: {
            marketCapUsd,
            volume24hUsd,
            buyers24h,
            sellers24h,
            holders,
            biggestBuy24hUsd,
          },
        });
      }

      return {
        marketCapUsd,
        volume24hUsd,
        buyers24h,
        sellers24h,
        holders,
        biggestBuy24hUsd,
      };
    } catch (error) {
      logger.error('Error getting token status metrics:', error);
      return {
        marketCapUsd: null,
        volume24hUsd: null,
        buyers24h: null,
        sellers24h: null,
        holders: null,
        biggestBuy24hUsd: null,
      };
    }
  }

  async getHLPMMTokenPrice(tokenAddress: string): Promise<TokenPrice | null> {
    if (!this.hlpmmQuoterAddress || !this.hlpmmFactoryAddress || !this.hlpmmUsidAddress) {
      return null;
    }

    try {
      const factoryContract = new ethers.Contract(
        this.hlpmmFactoryAddress,
        ['function tokenToPool(address token) view returns (address)'],
        this.provider
      );

      const poolAddress = await factoryContract.tokenToPool(tokenAddress);
      if (!poolAddress || poolAddress === ethers.ZeroAddress) {
        return null;
      }

      const quoterContract = new ethers.Contract(
        this.hlpmmQuoterAddress,
        [
          'function getSpotPrice(address pool) view returns (uint256)',
          'function getMarketCap(address pool) view returns (uint256)',
        ],
        this.provider
      );

      const spotPrice = await quoterContract.getSpotPrice(poolAddress);
      const priceInUsid = ethers.formatEther(spotPrice);
      const priceInUsd = this.normalizeUsdPrice(parseFloat(priceInUsid || '0'));

      const paxUsdPrice = await this.getPaxUsdPrice(6);
      const priceInEth = paxUsdPrice > 0
        ? (parseFloat(priceInUsd) / paxUsdPrice).toFixed(8)
        : '0';

      if (priceInEth === '0' && priceInUsd === '0') {
        return null;
      }

      return { priceInEth, priceInUsd };
    } catch (error) {
      logger.error('Error getting HLPMM token price:', error);
      return null;
    }
  }

  async getHLPMMMarketCap(tokenAddress: string): Promise<string | null> {
    if (!this.hlpmmQuoterAddress || !this.hlpmmFactoryAddress) {
      return null;
    }

    try {
      const factoryContract = new ethers.Contract(
        this.hlpmmFactoryAddress,
        ['function tokenToPool(address token) view returns (address)'],
        this.provider
      );

      const poolAddress = await factoryContract.tokenToPool(tokenAddress);
      if (!poolAddress || poolAddress === ethers.ZeroAddress) {
        return null;
      }

      const quoterContract = new ethers.Contract(
        this.hlpmmQuoterAddress,
        ['function getMarketCap(address pool) view returns (uint256)'],
        this.provider
      );

      const marketCap = await quoterContract.getMarketCap(poolAddress);
      return ethers.formatEther(marketCap);
    } catch (error) {
      logger.error('Error getting HLPMM market cap:', error);
      return null;
    }
  }

  private async getPaxUsdPrice(usdcDecimals: number): Promise<number> {
    try {
      const routerABI = [
        'function getAmountsOut(uint amountIn, address[] memory path) public view returns (uint[] memory amounts)',
      ];

      const router = new ethers.Contract(this.routerAddress, routerABI, this.provider);
      const onePax = ethers.parseEther('1');
      const path = [this.wethAddress, this.usdcAddress];
      const amounts = await router.getAmountsOut(onePax, path);

      return parseFloat(ethers.formatUnits(amounts[1], usdcDecimals));
    } catch (error) {
      const now = Date.now();
      if (now - this.paxUsdErrorLoggedAt >= 5 * 60 * 1000) {
        this.paxUsdErrorLoggedAt = now;
        logger.warn('PAX/USD quote unavailable from router; using fallback PAX_USD_PRICE.');
      }
      const fallbackPrice = parseFloat(process.env.PAX_USD_PRICE || '11.51');
      return Number.isFinite(fallbackPrice) && fallbackPrice > 0 ? fallbackPrice : 11.51;
    }
  }

  async getTokenInfo(tokenAddress: string): Promise<{
    name: string;
    symbol: string;
    decimals: number;
    totalSupply: string;
    marketCapUsd?: string;
  } | null> {
    try {
      const apiToken = await this.getTokenFromPortfolioApi(tokenAddress);
      if (apiToken) {
        const name = apiToken?.name;
        const symbol = apiToken?.symbol;
        const decimals = Number(apiToken?.decimals);
        const totalSupplyRaw = apiToken?.total_supply ?? apiToken?.totalSupply;
        const marketCapUsd = this.parseNumericField(apiToken, [
          'market_cap_usd',
          'marketCapUsd',
          'marketcap_usd',
          'marketCap',
          'fdv_usd',
          'fdvUsd',
        ]);

        if (name && symbol && Number.isFinite(decimals)) {
          return {
            name: String(name),
            symbol: String(symbol),
            decimals,
            totalSupply: this.normalizeApiTotalSupply(totalSupplyRaw, decimals),
            marketCapUsd: marketCapUsd ? String(marketCapUsd) : undefined,
          };
        }
      }

      const tokenABI = [
        'function name() view returns (string)',
        'function symbol() view returns (string)',
        'function decimals() view returns (uint8)',
        'function totalSupply() view returns (uint256)',
      ];

      const tokenContract = new ethers.Contract(tokenAddress, tokenABI, this.provider);

      const [name, symbol, decimals, totalSupplyRaw] = await Promise.all([
        tokenContract.name(),
        tokenContract.symbol(),
        tokenContract.decimals(),
        tokenContract.totalSupply(),
      ]);

      return {
        name,
        symbol,
        decimals: Number(decimals),
        totalSupply: ethers.formatUnits(totalSupplyRaw, Number(decimals)),
      };
    } catch (error) {
      logger.error('Error getting token info:', error);
      return null;
    }
  }
}
