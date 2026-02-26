# Telegram Blockchain Transaction Monitor

A powerful Telegram bot that monitors blockchain transactions in real-time and sends instant notifications when tokens are bought or sold. Perfect for tracking token trading activity on any EVM-compatible blockchain.

## Features

- 🔔 **Real-time Notifications** - Instant alerts for buy/sell transactions
- 👁️ **Token Watchlists** - Monitor multiple tokens simultaneously
- 📊 **Detailed Transaction Info** - View amounts, prices, wallet addresses, and more
- 💰 **Price Tracking** - Real-time token prices in ETH and USD
- 🏢 **Group Support** - Works in private chats and group channels
- ⚡ **Fast & Reliable** - WebSocket-based event monitoring
- 🔗 **Direct Links** - Quick access to transactions, tokens, and wallets on block explorers

## How It Works

1. Add tokens to your watchlist using `/watch <token_address>`
2. The bot monitors DEX transactions for those tokens
3. Get instant alerts with full transaction details when buys/sells occur
4. View price changes, trader wallets, and transaction links

Perfect for:
- Token holders monitoring their investments
- Traders tracking buy/sell pressure
- Communities watching their token activity
- Anyone interested in blockchain transparency

## Prerequisites

- Node.js 18+
- npm or yarn
- Telegram Bot Token (from [@BotFather](https://t.me/botfather))
- RPC endpoint with WebSocket support for your blockchain network

## Installation

1. Clone the repository:
```bash
git clone <your-repo-url>
cd buybot
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Configure your `.env` file with your credentials:
```env
TELEGRAM_BOT_TOKEN=your_bot_token_here
RPC_ENDPOINT=https://your-rpc-endpoint.com
ENCRYPTION_KEY=your_32_character_encryption_key_here
# ... other settings
```

## Configuration

### Required Environment Variables

- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token from BotFather
- `RPC_ENDPOINT` - HTTP RPC endpoint for blockchain connection
- `WS_RPC_ENDPOINT` - WebSocket RPC endpoint for real-time event monitoring
- `DEX_ROUTER_ADDRESS` - DEX router contract address (e.g., Uniswap V2)
- `WETH_ADDRESS` - Wrapped native token address
- `BLOCK_EXPLORER_URL` - Block explorer base URL (e.g., https://etherscan.io)

### Optional Variables

- `CHAIN_ID` - Network chain ID
- `ETHERSCAN_API_KEY` - For enhanced blockchain data
- `COINGECKO_API_KEY` - For better price feeds

## Usage

### Development Mode

```bash
npm run dev
```

### Production Mode

```bash
npm run build
npm start
```

## Bot Commands

- `/start` - Initialize the bot
- `/help` - Show all available commands
- `/watch <token_address>` - Start monitoring a token
- `/unwatch <token_address>` - Stop monitoring a token
- `/watchlist` - View all monitored tokens
- `/info <token_address>` - Get detailed token information
- `/price <token_address>` - Check current token price

## Example Usage

```
/watch 0x1234567890abcdef1234567890abcdef12345678
```

You'll receive notifications like:
```
🟢 BUY DETECTED 🟢

Token: MyToken (MTK)
Address: 0x1234...5678

Amount: 1000.0000 MTK
Value: 0.5000 ETH

Price:
• 0.00050000 ETH
• $1.000000 USD

Trader: 0xabcd...ef01
Block: 12345678

[View Transaction] [View Token] [View Wallet]
```

## Project Structure

```
buybot/
├── src/
│   ├── bot/
│   │   ├── TelegramBot.ts        # Main bot initialization
│   │   └── CommandHandler.ts     # Command handling logic
│   ├── blockchain/
│   │   ├── MonitoringService.ts  # Real-time event monitoring
│   │   ├── PriceService.ts       # Price fetching
│   │   └── WalletService.ts      # Wallet utilities
│   ├── database/
│   │   └── Database.ts           # PostgreSQL database operations
│   ├── utils/
│   │   ├── logger.ts             # Winston logger setup
│   │   ├── formatter.ts          # Message formatting
│   │   └── helpers.ts            # Utility functions
│   └── index.ts                  # Application entry point
├── .env.example                  # Environment variables template
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

## How Monitoring Works

The bot uses WebSocket connections to listen for blockchain events in real-time:

1. **Event Listening** - Monitors `Transfer` events on watched token contracts
2. **WebSocket Security** - Ensure your RPC endpoint is from a trusted provider
3. **Rate Limiting** - Some RPC providers have rate limits
4. **Database Backups** - Regularly backup your watchlist data
5. **Keep dependencies updated** - Run `npm audit` regularly

## Blockchain Support

This bot supports any EVM-compatible blockchain with DEX trading:

- Ethereum
- Binance Smart Chain
- Polygon
- Avalanche
- Arbitrum
- Optimism
- Base
- And more...

Just configure the appropriate RPC endpoints and contract addresses for your target network.

## Troubleshooting

### Bot not responding
- Check if the bot token is correct
- Verify the bot is running: `npm run dev`
- Check logs in `logs/` directory

### No transaction alerts
- Verify WebSocket RPC endpoint is working
- Check if token is added to watchlist: `/watchlist`
- Ensure DEX router address is correct for your network
- Verify token has actual trading activity

### WebSocket connection issues
- Some RPC providers don't support WebSocket - check with your provider
- Try using a different RPC endpoint
- Check firewall/network

Just configure the appropriate RPC endpoint and contract addresses.

## Troubleshooting

### Bot not responding
- Check if the bot token is correct
- Verify the bot is running: `npm run dev`
- Check logs in `logs/` directory

### Transaction failures
- Ensure sufficient native token balance for gas
- Check slippage settings
- Verify token address is correct
- Check if token has transfer restrictions

### Database errors
- Ensure `data/` directory exists
- Check file permissions
- Verify PostgreSQL is running and credentials are correct

## Development

### Build the project
```bash
npm run build
```

### Run linter
```bash
npm run lint
```

### Clean build directory
```bash
npm run clean
```

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## License
Important Information:**

This bot is for **informational and monitoring purposes only**. It displays blockchain transaction data that is already publicly available.

- This is not financial advice
- Always verify information independently
- Past trading activity doesn't predict future performance
- Be cautious of scam tokens and rug pulls

## Support

For issues and questions:
- Open an issue on GitHub
- Check existing issues for solutions
- Review the code and documentation

## Roadmap

- [ ] Add support for multiple DEX protocols (Uniswap V3, PancakeSwap, etc.)
- [ ] Implement whale wallet tracking
- [ ] Add price change notifications
- [ ] Support for volume tracking and charts
- [ ] Add liquidity pool monitoring
- [ ] Implement holder count tracking
- [ ] Add custom alert filters (min/max trade size)
- [ ] Support for NFT trading notifications

---

Made with ❤️ for blockchain transparenc
- [ ] Support for NFT trading

---

Made with ❤️ for the crypto community
