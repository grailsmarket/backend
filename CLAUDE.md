# ENS Marketplace System - CLAUDE.md

## System Overview
A comprehensive ENS (Ethereum Name Service) marketplace system that aggregates listings from OpenSea, provides a custom frontend for browsing and purchasing ENS names, and maintains synchronized blockchain state. The system consists of four interconnected services working together to provide a complete marketplace experience.

## Architecture

```
┌─────────────────┐     ┌──────────────┐     ┌───────────────┐
│                 │────▶│              │────▶│               │
│    Frontend     │     │   API        │     │   Database    │
│   (Next.js)     │◀────│   Service    │◀────│  (PostgreSQL) │
│                 │     │              │     │               │
└─────────────────┘     └──────────────┘     └───────────────┘
                               ▲                      ▲
                               │                      │
                        ┌──────┴──────┐       ┌───────┴────────┐
                        │             │       │                │
                        │  OpenSea    │       │   Indexer      │
                        │  Stream API │       │   Service      │
                        │             │       │                │
                        └─────────────┘       └────────────────┘
                                                      ▲
                                                      │
                                              ┌───────┴────────┐
                                              │                │
                                              │   Ethereum     │
                                              │   Blockchain   │
                                              │                │
                                              └────────────────┘
```

## Services

### 1. API Service (`/services/api`)
**Purpose**: REST API backend serving frontend and managing marketplace data
**Port**: 3000 (API v1) / 3002 (API v2)
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
**Purpose**: Real-time database change detection and processing
**Key Features**:
- PostgreSQL logical replication monitoring
- Change event processing and routing
- Cache invalidation triggers
- External notification dispatch

### 4. Frontend Service (`/services/frontend`)
**Purpose**: User interface for marketplace interaction
**Port**: 3000/3001
**Key Features**:
- ENS listing browsing and search
- Wallet connection via RainbowKit
- Seaport 1.6 order execution
- Responsive design with dark theme

## Database Schema

### Core Tables
```sql
-- ENS name registry
ens_names (
  id, token_id, name, label_name, expiry_date,
  registration_date, owner_address, resolver_address
)

-- Active marketplace listings
listings (
  id, ens_name_id, seller_address, price_wei,
  order_hash, order_data, status, created_at
)

-- Offers on ENS names
offers (
  id, ens_name_id, buyer_address, price_wei,
  order_data, status, created_at
)

-- Raw OpenSea events
opensea_events (
  id, event_type, order_hash, chain,
  event_data, processed, created_at
)
```

## Quick Start

### Prerequisites
- Node.js 18+
- PostgreSQL 14+
- Ethereum RPC endpoint (Alchemy/Infura)
- OpenSea API key

### Installation
```bash
# Clone repository
git clone <repository-url>
cd grails-testing

# Install dependencies for all services
cd services/api && npm install
cd ../indexer && npm install
cd ../wal-listener && npm install
cd ../frontend && npm install

# Setup database
createdb grails
cd services/api
npm run db:migrate
```

### Configuration
Create `.env` files in each service directory:

**API Service**:
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/grails
OPENSEA_API_KEY=your_key
PORT=3002
```

**Indexer Service**:
```env
DATABASE_URL=postgresql://user:pass@localhost:5432/grails
ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/key
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
```

**Frontend Service**:
```env
NEXT_PUBLIC_API_URL=http://localhost:3002
NEXT_PUBLIC_SEAPORT_ADDRESS=0x0000000000000068F116a894984e2DB1123eB395
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=your_project_id
```

### Running the System

```bash
# Terminal 1 - API Service
cd services/api
npm run dev

# Terminal 2 - Indexer Service
cd services/indexer
npm run dev

# Terminal 3 - WAL Listener (optional)
cd services/wal-listener
npm run dev

# Terminal 4 - Frontend
cd services/frontend
npm run dev
```

## Key Integrations

### OpenSea Integration
- **Stream API**: Real-time WebSocket for marketplace events
- **Event Types**: item_listed, item_sold, order_cancelled
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
4. Frontend displays new listing
5. Indexer updates ownership if transferred

### 2. Purchase Flow
1. User connects wallet on frontend
2. Selects ENS name to purchase
3. Frontend builds BasicOrderParameters
4. User signs transaction
5. Calls Seaport 1.6 contract
6. API updates listing status
7. Indexer detects transfer event

### 3. Data Sync Flow
1. Indexer monitors blockchain events
2. Updates ENS ownership in database
3. WAL listener detects changes
4. Triggers API cache invalidation
5. Frontend receives updated data

## Monitoring & Maintenance

### Health Checks
```bash
# API health
curl http://localhost:3002/health

# Check OpenSea stream
curl http://localhost:3002/api/v1/status

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

4. **Frontend API errors**
   - Ensure API service is running
   - Check CORS configuration
   - Verify environment variables

## Development Tools

### Database Management
```bash
# Connect to database
psql -d grails

# View recent listings
SELECT ens_name, price_wei, status FROM listings
ORDER BY created_at DESC LIMIT 10;

# Check OpenSea events
SELECT event_type, COUNT(*) FROM opensea_events
GROUP BY event_type;
```

### Testing
```bash
# Run all tests
npm test

# API integration tests
cd services/api && npm run test:integration

# Frontend E2E tests
cd services/frontend && npm run test:e2e
```

### Deployment
```bash
# Build all services
npm run build:all

# Docker deployment
docker-compose up -d

# Kubernetes deployment
kubectl apply -f k8s/
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
- CDN for frontend assets
- Connection pooling for database
- Batch processing for blockchain events
- Lazy loading for frontend components

## Roadmap & Future Enhancements
- [ ] Multi-chain support (Polygon, Arbitrum)
- [ ] Advanced search and filtering
- [ ] Price history charts
- [ ] Automated market making
- [ ] Mobile app
- [ ] IPFS integration for metadata
- [ ] Analytics dashboard
- [ ] Notification system

## Support & Documentation
- Individual service CLAUDE.md files in each service directory
- API documentation at http://localhost:3002/api-docs
- Database schema in services/api/prisma/schema.prisma
- Frontend component storybook (if configured)