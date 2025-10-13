# Grails Workers Service

Asynchronous job processing service for the Grails ENS marketplace, built on pg-boss (PostgreSQL-based message queue).

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# Development mode
npm run dev

# Production
npm run build
npm start
```

## What This Service Does

1. **Expires listings and offers** automatically when they reach their expiration time
2. **Syncs ENS metadata** from the blockchain (avatars, social links, etc.)
3. **Updates ownership** when ENS names are transferred
4. **Sends email notifications** to users watching ENS names

## Workers

- **Expiry Worker**: Expires listings/offers at exact time + batch safety net every 5 min
- **ENS Sync Worker**: Refreshes metadata when listing created + daily at 2 AM
- **Ownership Worker**: Processes ownership changes and cancels invalid listings
- **Notification Worker**: Sends emails for watchlist events

## Required Environment Variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/grails
RPC_URL=https://eth-mainnet.alchemyapi.io/v2/your-key
SENDGRID_API_KEY=your_sendgrid_api_key  # Optional for email
FROM_EMAIL=noreply@grails.market
FRONTEND_URL=http://localhost:3001
```

## Monitoring

Queue statistics are logged every 60 seconds. Check:
- Active jobs: `SELECT COUNT(*) FROM pgboss.job WHERE state='active'`
- Failed jobs: `SELECT COUNT(*) FROM pgboss.archive WHERE state='failed'`

## Documentation

See [CLAUDE.md](./CLAUDE.md) for complete documentation.

## Architecture

```
API/Indexer/WAL → pg-boss Queue (PostgreSQL) → Workers → Email/Blockchain
```

Uses PostgreSQL for the queue (no Redis/Kafka needed).
