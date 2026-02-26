import { ethers } from 'ethers';
import sharp from 'sharp';
import { logger } from '../utils/logger';
import { S3Service } from '../utils/S3Service';
import { PriceService } from './PriceService';

export class TokenMetadataService {
  private provider: ethers.JsonRpcProvider;
  private hlpmmFactoryAddress: string | null;
  private hlpmmQuoterAddress: string | null;
  private s3Service: S3Service | null = null;
  private priceService: PriceService;
  private enabled: boolean = false;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(process.env.RPC_ENDPOINT!);
    this.hlpmmFactoryAddress = process.env.HLPMM_FACTORY_ADDRESS || null;
    this.hlpmmQuoterAddress = process.env.HLPMM_QUOTER_ADDRESS || null;
    this.priceService = new PriceService();

    try {
      if (
        process.env.S3_ENDPOINT_URL &&
        process.env.S3_ACCESS_KEY_ID &&
        process.env.S3_SECRET_ACCESS_KEY &&
        process.env.S3_BUCKET_NAME
      ) {
        this.s3Service = new S3Service();
        this.enabled = true;
        logger.info('TokenMetadataService enabled (S3 + HLPMM)');
      } else {
        logger.info('TokenMetadataService disabled (missing S3 credentials)');
      }
    } catch (error) {
      logger.warn('TokenMetadataService: failed to initialize S3 client', error);
    }
  }

  isEnabled(): boolean {
    return this.enabled && !!this.hlpmmFactoryAddress;
  }

  async isHLPMMToken(tokenAddress: string): Promise<boolean> {
    if (!this.hlpmmFactoryAddress) return false;

    try {
      const factory = new ethers.Contract(
        this.hlpmmFactoryAddress,
        ['function tokenToPool(address) view returns (address)'],
        this.provider
      );
      const pool = await factory.tokenToPool(tokenAddress);
      return pool !== ethers.ZeroAddress;
    } catch {
      return false;
    }
  }

  async fetchAndUploadTokenImage(tokenAddress: string): Promise<string | null> {
    if (!this.s3Service || !this.hlpmmFactoryAddress) {
      return null;
    }

    try {
      const factory = new ethers.Contract(
        this.hlpmmFactoryAddress,
        ['function tokenToPool(address) view returns (address)'],
        this.provider
      );
      const poolAddress: string = await factory.tokenToPool(tokenAddress);
      if (!poolAddress || poolAddress === ethers.ZeroAddress) return null;

      const tokenInfo = await this.priceService.getTokenInfo(tokenAddress);
      if (!tokenInfo) return null;

      let spotPrice = '0';
      let marketCap = '0';

      if (this.hlpmmQuoterAddress) {
        const quoter = new ethers.Contract(
          this.hlpmmQuoterAddress,
          [
            'function getSpotPrice(address) view returns (uint256)',
            'function getMarketCap(address) view returns (uint256)',
          ],
          this.provider
        );

        try {
          const sp = await quoter.getSpotPrice(poolAddress);
          spotPrice = parseFloat(ethers.formatEther(sp)).toFixed(6);
        } catch (e) {
          logger.warn('TokenMetadata: failed to get spot price', e);
        }

        try {
          const mc = await quoter.getMarketCap(poolAddress);
          marketCap = this.formatCompact(parseFloat(ethers.formatEther(mc)));
        } catch (e) {
          logger.warn('TokenMetadata: failed to get market cap', e);
        }
      }

      const pngBuffer = await this.generateTokenCard({
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        tokenAddress,
        poolAddress,
        spotPrice,
        marketCap,
      });

      const key = `hlpmm-tokens/${tokenAddress.toLowerCase()}.png`;
      const url = await this.s3Service.uploadBuffer(key, pngBuffer, 'image/png');

      logger.info(`Uploaded HLPMM token card for ${tokenInfo.symbol}: ${url}`);
      return url;
    } catch (error) {
      logger.error('Error generating/uploading HLPMM token image:', error);
      return null;
    }
  }

  private async generateTokenCard(data: {
    name: string;
    symbol: string;
    tokenAddress: string;
    poolAddress: string;
    spotPrice: string;
    marketCap: string;
  }): Promise<Buffer> {
    const eName = this.escapeXml(data.name);
    const eSymbol = this.escapeXml(data.symbol);
    const eAddr = this.escapeXml(this.truncate(data.tokenAddress, 20));
    const ePool = this.escapeXml(this.truncate(data.poolAddress, 20));
    const ePrice = this.escapeXml(data.spotPrice);
    const eMcap = this.escapeXml(data.marketCap);

    const symbolInitial = data.symbol.charAt(0).toUpperCase() || '?';

    const svg = `<svg width="800" height="418" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#0f0c29"/>
      <stop offset="50%" stop-color="#302b63"/>
      <stop offset="100%" stop-color="#24243e"/>
    </linearGradient>
    <linearGradient id="accent" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#00d4ff"/>
      <stop offset="100%" stop-color="#9b59b6"/>
    </linearGradient>
  </defs>

  <rect width="800" height="418" fill="url(#bg)" rx="20"/>
  <rect x="0" y="0" width="800" height="5" fill="url(#accent)"/>

  <circle cx="85" cy="85" r="42" fill="#1a1a3e" stroke="#00d4ff" stroke-width="2"/>
  <text x="85" y="95" text-anchor="middle" fill="#00d4ff" font-size="30" font-weight="bold" font-family="Arial, Helvetica, sans-serif">${this.escapeXml(symbolInitial)}</text>

  <text x="148" y="72" fill="#ffffff" font-size="28" font-weight="bold" font-family="Arial, Helvetica, sans-serif">${eName}</text>
  <text x="148" y="100" fill="#666666" font-size="14" font-family="monospace">${eAddr}</text>

  <rect x="640" y="48" width="120" height="30" rx="15" fill="#9b59b6"/>
  <text x="700" y="68" text-anchor="middle" fill="#ffffff" font-size="13" font-weight="bold" font-family="Arial, Helvetica, sans-serif">HLPMM</text>

  <line x1="40" y1="150" x2="760" y2="150" stroke="#2a2a4e" stroke-width="1"/>

  <text x="60" y="195" fill="#888888" font-size="14" font-family="Arial, Helvetica, sans-serif">Spot Price</text>
  <text x="60" y="230" fill="#00d4ff" font-size="26" font-weight="bold" font-family="Arial, Helvetica, sans-serif">${ePrice} USID</text>

  <text x="440" y="195" fill="#888888" font-size="14" font-family="Arial, Helvetica, sans-serif">Market Cap</text>
  <text x="440" y="230" fill="#00d4ff" font-size="26" font-weight="bold" font-family="Arial, Helvetica, sans-serif">${eMcap}</text>

  <text x="60" y="290" fill="#888888" font-size="14" font-family="Arial, Helvetica, sans-serif">Pool Address</text>
  <text x="60" y="315" fill="#aaaaaa" font-size="14" font-family="monospace">${ePool}</text>

  <text x="60" y="365" fill="#888888" font-size="14" font-family="Arial, Helvetica, sans-serif">Symbol</text>
  <text x="60" y="390" fill="#ffffff" font-size="20" font-weight="bold" font-family="Arial, Helvetica, sans-serif">$${eSymbol}</text>

  <text x="740" y="400" text-anchor="end" fill="#444444" font-size="11" font-family="Arial, Helvetica, sans-serif">HLPMM Protocol · Paxeer Network</text>
</svg>`;

    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  private escapeXml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }

  private truncate(str: string, tailLen: number): string {
    if (str.length <= tailLen + 6) return str;
    return `${str.slice(0, 6)}...${str.slice(-tailLen)}`;
  }

  private formatCompact(value: number): string {
    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
    if (value >= 1_000) return `$${(value / 1_000).toFixed(2)}K`;
    return `$${value.toFixed(2)}`;
  }
}
