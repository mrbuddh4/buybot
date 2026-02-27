import { ethers } from 'ethers';
import axios from 'axios';
import { logger } from '../utils/logger';

export interface TokenPrice {
  priceInEth: string;
  priceInUsd: string;
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
  private paxUsdErrorLoggedAt: number = 0;

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

  private parseNumericField(source: any, keys: string[]): number | null {
    for (const key of keys) {
      const raw = source?.[key];
      const value = typeof raw === 'string' || typeof raw === 'number' ? parseFloat(String(raw)) : NaN;
      if (Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return null;
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
      priceInUsd: resolvedUsd.toFixed(3),
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
        priceInUsd = (parseFloat(priceInEth) * paxUsdPrice).toFixed(3);
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
        priceInUsd: parseFloat(priceInUsd || '0').toFixed(3),
      };
    } catch (error) {
      logger.error('Error getting token price from AMM:', error);
      const fallbackPrice = await this.getHLPMMTokenPrice(tokenAddress);
      return fallbackPrice;
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
      const priceInUsd = parseFloat(priceInUsid || '0').toFixed(3);

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
  } | null> {
    try {
      const apiToken = await this.getTokenFromPortfolioApi(tokenAddress);
      if (apiToken) {
        const name = apiToken?.name;
        const symbol = apiToken?.symbol;
        const decimals = Number(apiToken?.decimals);
        const totalSupplyRaw = apiToken?.total_supply ?? apiToken?.totalSupply;

        if (name && symbol && Number.isFinite(decimals)) {
          return {
            name: String(name),
            symbol: String(symbol),
            decimals,
            totalSupply: totalSupplyRaw ? String(totalSupplyRaw) : '0',
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
