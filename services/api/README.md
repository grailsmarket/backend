# Grails API Service

REST API for the Grails ENS marketplace, providing endpoints for ENS names, listings, offers, user management, notifications, and sales history.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# Run database migrations (if needed)
npm run db:migrate

# Development mode
npm run dev

# Production
npm run build
npm start
```

Visit http://localhost:3000/health to verify the API is running.

## What This Service Does

- **Authentication**: SIWE (Sign-In With Ethereum) with JWT tokens
- **ENS Management**: Search, filter, and browse ENS names
- **Marketplace**: Create/cancel listings and offers
- **User Features**: Watchlists with notification preferences, voting
- **Sales History**: Track and analyze ENS name sales
- **Profiles**: View ENS records and owned names for any address
- **Real-time Sync**: OpenSea Stream API integration for marketplace events
- **Advanced Search**: Elasticsearch-powered search with comprehensive filters

## Core Endpoints

### Authentication
- `GET /auth/nonce` - Get signing nonce
- `POST /auth/verify` - Verify signature, get JWT

### Search
- `GET /names/search` - Search ENS names (Elasticsearch)
- `GET /listings/search` - Search active listings

### Marketplace
- `GET /listings` - Browse listings
- `POST /listings` - Create listing (auth required)
- `POST /offers` - Make offer (auth required)

### User Features (Auth Required)
- `GET /watchlist` - View watchlist
- `GET /watchlist/search` - Filter watchlist items
- `GET /notifications` - View notifications
- `GET /users/me` - Get profile

### Sales & Analytics
- `GET /sales` - Recent sales
- `GET /sales/name/:name` - Sales history for name
- `GET /sales/:nameOrId/analytics` - Sales analytics

### Profiles
- `GET /profiles/:addressOrName` - Get profile data

## Search Filters

All search endpoints support:
- **Price**: `filters[minPrice]`, `filters[maxPrice]`
- **Length**: `filters[minLength]`, `filters[maxLength]`
- **Characters**: `filters[hasNumbers]`, `filters[hasEmoji]`
- **Clubs**: `filters[clubs][]=10k Club`
- **Expiration**: `filters[isExpired]`, `filters[isGracePeriod]`, `filters[expiringWithinDays]`
- **Sales**: `filters[hasSales]`, `filters[minDaysSinceLastSale]`

## Required Environment Variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/grails
JWT_SECRET=your-secret-key
OPENSEA_API_KEY=your_opensea_api_key
ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/your-key
ELASTICSEARCH_URL=http://localhost:9200
```

## Technology Stack

- **Framework**: Fastify (high-performance Node.js web framework)
- **Database**: PostgreSQL (shared with other services)
- **Search**: Elasticsearch (synced via WAL Listener)
- **Authentication**: JWT + SIWE (Sign-In With Ethereum)
- **Validation**: Zod schemas
- **Real-time**: OpenSea Stream API (WebSocket)

## Architecture

```
Client → API → PostgreSQL (source of truth)
              ↓
         Elasticsearch (search index)
              ↓
         OpenSea Stream (marketplace events)
```

## Documentation

- **Full API Reference**: See `/prd/API_DOCUMENTATION.md`
- **Architecture Details**: See `CLAUDE.md` in this directory
- **OpenSea Integration**: See `src/services/opensea-stream.ts`

## Monitoring

```bash
# Check API health
curl http://localhost:3000/health

# Check OpenSea stream status
curl http://localhost:3000/api/v1/status
```

## Common Issues

### OpenSea Events Not Arriving
- Verify `OPENSEA_API_KEY` is valid
- Check WebSocket connection in logs
- Ensure ENS_REGISTRAR_ADDRESS is correct

### Search Not Working
- Verify Elasticsearch is running: `curl http://localhost:9200`
- Check WAL Listener is syncing data
- Ensure index exists: `curl http://localhost:9200/ens_names`

### Authentication Failures
- Verify `JWT_SECRET` is set
- Check nonce expiration (10 minutes)
- Ensure client is including `Authorization: Bearer <token>` header

## Testing

```bash
# Run tests
npm test

# Check linting
npm run lint

# Type check
npm run typecheck
```
