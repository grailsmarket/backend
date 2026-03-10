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
- Handles blockchain reorganizations

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
Common configuration, database client, schema, and migrations used by all backend services.

### 6. Docs (`/services/docs`)
Astro-based documentation site.

### 7. SDK (`/services/sdk`)
Client SDK for API consumers.

## Database Schema

### Core Tables
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

-- Blockchain events log (for reorg handling)
blockchain_events (
  id, block_number, transaction_hash, log_index,
  contract_address, event_name, event_data,
  processed, created_at
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

# Setup database
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

# Check blockchain events
SELECT event_name, COUNT(*) FROM blockchain_events
GROUP BY event_name;
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
- Database schema in services/shared/src/db/schema.sql
