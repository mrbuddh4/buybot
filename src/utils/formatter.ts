import { truncateAddress } from './helpers';

interface TransactionAlertData {
  type: 'buy' | 'sell';
  tokenAddress: string;
  tokenSymbol: string;
  tokenName: string;
  amount: string;
  ethValue: string;
  priceInEth: string;
  priceInUsd: string;
  buyer: string;
  txHash: string;
  blockNumber: number;
  marketCapUsd?: string;
  iconMultiplier?: number;
  buyIconPattern?: string;
  walletHoldingsToken?: string;
  walletHoldingsUsd?: string;
  positionLabel?: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getSwapIconCount(usdValue: number, iconMultiplier: number = 1): number {
  const value = Number.isFinite(usdValue) ? Math.max(0, usdValue) : 0;

  let iconCount = 1;
  if (value >= 10000) iconCount = 16;
  else if (value >= 5000) iconCount = 14;
  else if (value >= 2500) iconCount = 12;
  else if (value >= 1000) iconCount = 10;
  else if (value >= 500) iconCount = 8;
  else if (value >= 250) iconCount = 6;
  else if (value >= 100) iconCount = 4;
  else if (value >= 50) iconCount = 2;

  const multiplier = Number.isFinite(iconMultiplier) ? Math.max(1, iconMultiplier) : 1;
  return Math.max(1, Math.round(iconCount * multiplier));
}

function getSwapIcons(type: 'buy' | 'sell', usdValue: number, iconMultiplier: number = 1, buyIconPattern: string = '🟢⚔️'): string {
  const iconCount = getSwapIconCount(usdValue, iconMultiplier);
  const pair = type === 'buy' ? buyIconPattern : '🔴⚔️';
  return pair.repeat(Math.max(1, Math.ceil(iconCount / 2)));
}

function formatUsdCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '$0.00';
  }

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    notation: 'compact',
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return '0';
  }

  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(2)}K`;
  return value.toFixed(2);
}

export function formatTransactionAlert(data: TransactionAlertData): string {
  const action = data.type === 'buy' ? 'Buy' : 'Sell';
  const actionUpper = action.toUpperCase();
  const totalUsdValue = parseFloat(data.amount) * parseFloat(data.priceInUsd);
  const statusDots = getSwapIcons(
    data.type,
    totalUsdValue,
    data.iconMultiplier || 1,
    (data.buyIconPattern || '🟢⚔️').trim() || '🟢⚔️'
  );
  const iconCount = getSwapIconCount(totalUsdValue, data.iconMultiplier || 1);
  const arrowSymbol = data.type === 'buy' ? '⬆️' : '⬇️';
  const arrowCount = Math.max(4, Math.ceil(iconCount / 2));
  const arrowLine = arrowSymbol.repeat(arrowCount);
  const marketCapValue = parseFloat(data.marketCapUsd || '0');
  const marketCapText = formatUsdCompact(marketCapValue);
  const usdDisplay = `$${Math.max(0, Math.round(totalUsdValue)).toLocaleString()}`;
  const ethAmount = parseFloat(data.ethValue) || 0;
  const tokenAmount = parseFloat(data.amount) || 0;
  
  const explorerUrl = process.env.BLOCK_EXPLORER_URL || 'https://etherscan.io';
  const escapedTokenName = escapeHtml(data.tokenName);
  const escapedTokenSymbol = escapeHtml(data.tokenSymbol);
  const tokenUrl = `${explorerUrl}/token/${data.tokenAddress}`;
  const walletUrl = `${explorerUrl}/address/${data.buyer}`;
  const txUrl = `${explorerUrl}/tx/${data.txHash}`;
  const holdingsTokenText = data.walletHoldingsToken || '0';
  const holdingsUsdText = data.walletHoldingsUsd || '$0';
  const positionText = data.positionLabel || 'NEW';
  
  return `
<b>BUY DETECTED ON PAXEER NETWORK</b>

${arrowLine}
${usdDisplay} <a href="${tokenUrl}">${escapedTokenName}</a> ${actionUpper}!
${statusDots}

➡️ PAX: ${ethAmount.toFixed(4)} (${usdDisplay})
⬅️ ${escapedTokenSymbol}: ${formatTokenAmount(tokenAmount)}
👤 <a href="${walletUrl}">Buyer</a> / <a href="${txUrl}">Txn</a>
🅿️ Position: ${positionText}
💼 Holdings: ${holdingsTokenText} ${escapedTokenSymbol} (${holdingsUsdText})

📈 Market Cap: ${marketCapText} USDC
  `.trim();
}

export function formatWatchlistMessage(tokens: Array<{ symbol: string; address: string; name: string }>): string {
  if (tokens.length === 0) {
    return '📋 **Your Watchlist is empty**\n\nUse /watch <token_address> to add tokens.';
  }

  let message = '📋 **Your Watchlist**\n\n';
  
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    message += `${i + 1}. **${token.symbol}** - ${token.name}\n`;
    message += `   \`${token.address}\`\n\n`;
  }
  
  message += '\nUse /unwatch <token_address> to remove a token.';
  
  return message;
}

export function formatTokenInfo(data: {
  name: string;
  symbol: string;
  address: string;
  priceInEth: string;
  priceInUsd: string;
  marketCapUsd?: string;
  watching: boolean;
}): string {
  const watchingEmoji = data.watching ? '👁️ Watching' : '➕ Not Watching';
  const marketCapValue = parseFloat(data.marketCapUsd || '0');
  const marketCapText = formatUsdCompact(marketCapValue);
  
  return `
🪙 **Token Information**

**Name:** ${data.name}
**Symbol:** ${data.symbol}
**Address:** \`${data.address}\`

**Current Price:**
• ${parseFloat(data.priceInEth).toFixed(8)} PAX
• $${parseFloat(data.priceInUsd).toFixed(6)} USDC

**Market Cap:** ${marketCapText} USDC

**Status:** ${watchingEmoji}

${data.watching ? 'Use /unwatch to stop monitoring' : 'Use /watch to start monitoring'}
  `.trim();
}
