# ENS Marketplace System - CLAUDE.md

## System Overview
A comprehensive ENS (Ethereum Name Service) marketplace system that aggregates listings from OpenSea, provides an API for browsing and purchasing ENS names, and maintains synchronized blockchain state. The system consists of four backend services plus shared libraries working together to provide a complete marketplace experience.

## Architecture

```
                        ┌──────────────┐     ┌───────────────┐     ┌───────────────┐
                        │              │────▶│               │────▶│               │
                        │   API        │     │   Database    │     │ Elasticsearch │
                        │   Service    │◀────│  (PostgreSQL) │◀────│   (Search)    │
                        │              │     │               │     │               │
                        └──────────────┘     └───────────────┘     └───────────────┘
                               ▲                      ▲                     ▲
                               │                      │                     │
                        ┌──────┴──────┐       ┌───────┴────────┐    ┌───────┴────────┐
                        │             │       │                │    │                │
                        │  OpenSea    │       │   Indexer      │    │  WAL Listener  │
                        │  Stream API │       │   Service      │    │   Service      │
                        │             │       │                │    │                │
                        └─────────────┘       └────────────────┘    └────────────────┘
                                                      ▲                     │
                                                      │                     ▼
                                              ┌───────┴────────┐    ┌───────────────┐
                                              │                │    │               │
                                              │   Ethereum     │    │   Workers     │
                                              │   Blockchain   │    │   (pg-boss)   │
                                              │                │    │               │
                                              └────────────────┘    └───────────────┘
```

## Services

### 1. API Service (`/services/api`)
**Purpose**: REST API backend serving the marketplace
**Port**: 3000 (default, configurable via `API_PORT`)
**Key Features**:
- RESTful endpoints for listings, offers, and ENS data
- OpenSea Stream API integration for real-time events
- Seaport order data storage and validation
- WebSocket support for live updates

### 2. Indexer Service (`/services/indexer`)
**Purpose**: Blockchain monitoring and state synchronization
**Key Features**:
- Monitors ENS Registry and Registrar contracts
- Tracks ownership, transfers, and expiry dates
- Maintains historical event data
- Avoids reorgs by trailing the chain head by `CONFIRMATIONS` blocks (12 in the root `.env`; 0 if unset). There is no reorg rollback.
- ENSv2: an event whose handler keeps failing for a non-transient reason is retried 3 times, then logged as `ENSv2 event SKIPPED` (with the replay command) and skipped. Skipped events are not stored anywhere; see `services/indexer/CLAUDE.md`.

### 3. WAL Listener Service (`/services/wal-listener`)
**Purpose**: Real-time database change detection and Elasticsearch synchronization
**Key Features**:
- PostgreSQL LISTEN/NOTIFY with database triggers (not logical replication)
- Elasticsearch document synchronization for search
- Activity history tracking for user feeds
- pg-boss job publishing for notifications

### 4. Workers Service (`/services/workers`)
**Purpose**: Background job processing for async operations
**Key Features**:
- pg-boss PostgreSQL-based job queue (21+ worker types)
- Order expiration and ENS metadata sync
- Listing/offer validation against blockchain state
- Club stats, price feeds, and analytics refresh

### 5. Shared (`/services/shared`)
Common configuration, database client, and a partial schema mirror (`src/db/schema.sql`; see [Schema source of truth](#schema-source-of-truth)) used by all backend services. Migrations live in `services/api/migrations/seq/`.

### 6. Docs (`/services/docs`)
Astro-based documentation site.

### 7. SDK (`/services/sdk`)
Client SDK for API consumers.

## Database Schema

### Schema source of truth
The production database is the only authoritative schema. Before writing code or SQL that depends on a table or column, confirm it exists in the target database (`information_schema.columns`, or `\d <table>` in psql). A table listed in this file or in `schema.sql` is not proof that it exists.

- `services/shared/src/db/schema.sql` is a partial mirror: on 2026-11-19 it covered 28 of prod's 62 tables. Everything in it should exist in prod; a table missing from it may still exist.
- Migrations live in `services/api/migrations/seq/` and are applied to prod by hand. Prod has no `migrations_log` table.
- Neither migrate command is how prod is migrated. The root `npm run migrate` executes `schema.sql` as-is, and `npm run migrate` in `services/api` replays every migration in `seq/`. Never run either against prod or Sepolia; a local shell loads the prod `.env` by default.
- A database built from `schema.sql` is incomplete. New environments are bootstrapped from a schema-only dump of prod (`pg_dump --schema-only --exclude-schema=pgboss`, with a v17 `pg_dump`), plus data for seed tables such as `clubs` and `global_chat_config`.
- When a migration adds or changes a table that `schema.sql` mirrors, update `schema.sql` in the same change. Never document a table here, or add it to `schema.sql`, unless an applied migration creates it.
- Why this matters: `blockchain_events` was documented here and in `schema.sql` from the initial design but never existed in prod. Code that wrote to it was written against the docs, and when it first ran (2026-11-18) it froze the ENSv2 indexer for 17 hours.

### Core Tables
Columns below were checked against prod on 2026-11-19. Most tables have more columns than listed.
```sql
-- ENS name registry
ens_names (
  id, name, token_id, owner_address, registrant,
  expiry_date, registration_date, last_transfer_date,
  metadata, created_at, updated_at
)

-- Active marketplace listings
listings (
  id, ens_name_id, seller_address, price_wei,
  currency_address, order_hash, order_data, status,
  created_at, updated_at, expires_at
)

-- Offers on ENS names
offers (
  id, ens_name_id, buyer_address, offer_amount_wei,
  currency_address, order_hash, order_data, status,
  created_at, expires_at
)

-- Transaction history
transactions (
  id, ens_name_id, transaction_hash, block_number,
  from_address, to_address, price_wei, transaction_type,
  timestamp, created_at
)

-- Indexer state tracking
indexer_state (
  id, contract_address, last_processed_block,
  last_processed_timestamp, created_at, updated_at
)

-- AI recommendation cache (backend-generated similar names)
ai_recommendations (
  id, name, recommendations, model,
  expires_at, created_at, updated_at
)
```

## Quick Start

### Prerequisites
- Node.js 20+
- PostgreSQL 14+ with LISTEN/NOTIFY support
- Elasticsearch 8.x
- Ethereum RPC endpoint (Alchemy/Infura)
- OpenSea API key

### Installation
```bash
# Clone repository
git clone <repository-url>
cd grails-backend

# Install dependencies (npm workspaces)
npm install

# Setup database (local development only). `npm run migrate` runs schema.sql, which is
# incomplete; read "Schema source of truth" first, and never point it at prod or Sepolia.
createdb grails
npm run migrate
```

### Configuration
Create `.env` files in each service directory:

**API Service**:
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/grails
OPENSEA_API_KEY=your_key
API_PORT=3000
```

**Indexer Service**:
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/grails
RPC_URL=https://eth-mainnet.alchemyapi.io/v2/key
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
```

### Running the System

```bash
# Terminal 1 - API Service
cd services/api
npm run dev

# Terminal 2 - Indexer Service
cd services/indexer
npm run dev

# Terminal 3 - WAL Listener
cd services/wal-listener
npm run dev

# Terminal 4 - Workers
cd services/workers
npm run dev
```

## Shared Configuration (`/services/shared`)
All backend services share a common configuration module that loads from `.env` files:
- `config.database` - PostgreSQL connection settings
- `config.elasticsearch` - Elasticsearch URL and index name
- `config.blockchain` - RPC URL, chain ID, contract addresses
- `config.opensea` - API key and stream URL
- `config.jwt` - Authentication settings
- `config.email` - SMTP configuration
- `config.redis` - Caching settings
- `config.theGraph` - The Graph API settings
- `config.api` - API service settings
- `config.monitoring` - Monitoring/alerting settings
- `config.poap` - POAP integration settings
- `config.broker` - Message broker settings
- `config.openai` - OpenAI API settings
- `config.etherscan` - Etherscan API settings
- `config.storage` - File storage settings

## Key Integrations

### OpenSea Integration
- **Stream API**: Real-time WebSocket for marketplace events
- **Event Types**: item_listed, item_sold, item_received_bid
- **Order Format**: Seaport protocol with protocol_data

### Seaport 1.6 Protocol
- **Contract**: 0x0000000000000068F116a894984e2DB1123eB395
- **Function**: fulfillBasicOrder_efficient_6GL6yc
- **Order Types**: BasicOrderParameters for efficient gas usage

### Blockchain Monitoring
- **ENS Registry**: 0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
- **ENS Registrar**: 0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
- **Events**: NameRegistered, Transfer, NameRenewed

## Common Workflows

### 1. New Listing Flow
1. User lists ENS on OpenSea
2. OpenSea Stream API sends event to API service
3. API service stores listing with Seaport order data
4. Indexer updates ownership if transferred

### 2. Purchase Flow
1. Client connects wallet
2. Selects ENS name to purchase
3. Client builds BasicOrderParameters
4. User signs transaction
5. Calls Seaport 1.6 contract
6. API updates listing status
7. Indexer detects transfer event

### 3. Data Sync Flow
1. Indexer monitors blockchain events
2. Updates ENS ownership in database
3. WAL listener detects changes via LISTEN/NOTIFY
4. Syncs changes to Elasticsearch for search
5. Publishes jobs to pg-boss for notifications
6. Workers process async tasks (validation, stats)
7. Clients receive updated data via API/WebSocket

## Monitoring & Maintenance

### Health Checks
```bash
# API health
curl http://localhost:3000/health

# Check OpenSea stream
curl http://localhost:3000/api/v1/status

# Indexer status
curl http://localhost:3003/status

# Database connections
psql -d grails -c "SELECT count(*) FROM pg_stat_activity;"
```

### Common Issues & Solutions

1. **OpenSea events not arriving**
   - Check API key validity
   - Verify WebSocket connection
   - Review event filters

2. **Transaction failures**
   - Verify Seaport contract address
   - Check wallet has sufficient ETH
   - Validate order parameters

3. **Indexer lag**
   - Check RPC endpoint rate limits
   - Increase batch size
   - Verify database performance

## Development Tools

### Database Management
```bash
# Connect to database
psql -d grails

# View recent listings
SELECT en.name, l.price_wei, l.status FROM listings l
JOIN ens_names en ON l.ens_name_id = en.id
ORDER BY l.created_at DESC LIMIT 10;

# Check indexer cursors (compare last_processed_block with the chain head)
SELECT contract_address, last_processed_block, updated_at FROM indexer_state;
```

### Testing
```bash
# Run all tests
npm test

# API tests
cd services/api && npm run test
```

### Deployment
```bash
# Build all services
npm run build:local

# Docker deployment
docker-compose up -d
```

## Security Considerations
- Never expose private keys or mnemonics
- Use environment variables for secrets
- Implement rate limiting on API endpoints
- Validate all blockchain data
- Use checksummed addresses
- Enable CORS appropriately
- Implement request signing for sensitive operations

## Performance Optimization
- Database indexing on frequently queried columns
- Redis caching for hot data
- Connection pooling for database
- Batch processing for blockchain events

## Current Features
- [x] Advanced search and filtering (Elasticsearch)
- [x] Analytics dashboard (trending, volume, price trends)
- [x] Notification system (email, watchlist alerts)
- [x] Clubs (999, 10k, 100k ENS categories)
- [x] Voting and leaderboards
- [x] Real-time activity feeds (WebSocket)

## Roadmap & Future Enhancements
- [ ] Multi-chain support (Polygon, Arbitrum)
- [ ] Price history charts
- [ ] Automated market making
- [ ] Mobile app
- [ ] IPFS integration for metadata

## Support & Documentation
- Individual service CLAUDE.md files in each service directory
- Partial schema mirror in services/shared/src/db/schema.sql (prod is authoritative; see Database Schema → Schema source of truth)
