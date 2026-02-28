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
  walletTotalUsd?: string;
  positionLabel?: string;
  dexSource?: 'AMM' | 'HLPMM';
  purchaseCurrencySymbol?: string;
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
  if (value >= 10000) iconCount = 32;
  else if (value >= 5000) iconCount = 24;
  else if (value >= 2500) iconCount = 18;
  else if (value >= 1000) iconCount = 14;
  else if (value >= 500) iconCount = 11;
  else if (value >= 250) iconCount = 8;
  else if (value >= 100) iconCount = 5;
  else if (value >= 50) iconCount = 3;

  const multiplier = Number.isFinite(iconMultiplier) ? Math.max(1, iconMultiplier) : 1;
  return Math.min(32, Math.max(1, Math.round(iconCount * multiplier)));
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

function formatTokenUsdPrice(value: string): string {
  const numeric = parseFloat(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return '$0.00';
  }

  if (numeric >= 1) {
    return `$${numeric.toFixed(3)}`;
  }

  const cleaned = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    const trimmed = cleaned.replace(/0+$/, '').replace(/\.$/, '');
    if (trimmed && trimmed !== '0') {
      return `$${trimmed}`;
    }
  }

  const fallback = numeric.toLocaleString('en-US', {
    useGrouping: false,
    minimumSignificantDigits: 2,
    maximumSignificantDigits: 8,
  });
  return `$${fallback}`;
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
  const marketCapValue = parseFloat(data.marketCapUsd || '0');
  const marketCapText = formatUsdCompact(marketCapValue);
  const usdDisplay = `$${Math.max(0, Math.round(totalUsdValue)).toLocaleString()}`;
  const ethAmount = parseFloat(data.ethValue) || 0;
  const tokenAmount = parseFloat(data.amount) || 0;
  const tokenUnitUsdPriceText = formatTokenUsdPrice(data.priceInUsd);
  const purchaseCurrencySymbol = data.purchaseCurrencySymbol || (data.dexSource === 'HLPMM' ? 'USID' : 'PAX');
  
  const explorerUrl = process.env.BLOCK_EXPLORER_URL || 'https://etherscan.io';
  const escapedTokenName = escapeHtml(data.tokenName);
  const escapedTokenSymbol = escapeHtml(data.tokenSymbol);
  const tokenUrl = `${explorerUrl}/token/${data.tokenAddress}`;
  const walletUrl = `${explorerUrl}/address/${data.buyer}`;
  const txUrl = `${explorerUrl}/tx/${data.txHash}`;
  const holdingsTokenText = data.walletHoldingsToken || '0';
  const holdingsUsdText = data.walletHoldingsUsd || '$0';
  const walletTotalUsdText = data.walletTotalUsd || 'N/A';
  const positionText = data.positionLabel || 'NEW';
  
  return `
<b>🚨 BUY DETECTED ON PAXEER NETWORK${data.dexSource === 'HLPMM' ? ' (PaxFun)' : ''} 🚨</b>

<a href="${tokenUrl}">${escapedTokenName}</a> ${actionUpper}!
${statusDots}

➡️ ${escapeHtml(purchaseCurrencySymbol)}: ${ethAmount.toFixed(3)} (${usdDisplay})
⬅️ ${escapedTokenSymbol}: ${tokenAmount.toFixed(3)}
👤 <a href="${walletUrl}">Buyer</a> / <a href="${txUrl}">Txn</a>
🅿️ Position: ${positionText}
💵 Wallet Value: ${walletTotalUsdText}
💼 Holdings: ${holdingsUsdText} (${holdingsTokenText} ${escapedTokenSymbol})

💲 Token Price: ${tokenUnitUsdPriceText} USDC
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
• ${formatTokenUsdPrice(data.priceInUsd)} USDC

**Market Cap:** ${marketCapText} USDC

**Status:** ${watchingEmoji}

${data.watching ? 'Use /unwatch to stop monitoring' : 'Use /watch to start monitoring'}
  `.trim();
}
