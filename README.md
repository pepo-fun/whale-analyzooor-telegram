# Whale Analyzooor Telegram Bot

A Telegram bot that monitors whale transactions and sends personalized alerts.

## Setup

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in your values
3. Run: `npm start`

## Required Environment Variables

- `TELEGRAM_BOT_TOKEN` - Your Telegram bot token
- `DATABASE_URL` - Railway PostgreSQL connection string
- `WHALE_API_URL` - API endpoint for whale data
- `POLLING_INTERVAL` - Check interval in seconds (default: 10)
