# Grails Backend - ENS Name Secondary Marketplace

A lightweight, cost-efficient backend system for an ENS (Ethereum Name Service) secondary marketplace that enables users to list, buy, bid on, and sell ENS names while avoiding platform fees through direct Seaport protocol integration.

## Architecture

The system is built with a microservices architecture consisting of:

- **API Service** - RESTful API and WebSocket server built with Fastify
- **Blockchain Indexer** - Indexes ENS and Seaport contract events
- **WAL Listener** - PostgreSQL WAL-based CDC for Elasticsearch synchronization
- **Shared Libraries** - Common types, configurations, and database clients

## Tech Stack

- **Runtime**: Node.js 20+ with TypeScript
- **API Framework**: Fastify
- **Blockchain**: Viem 2.x
- **Database**: PostgreSQL 15+
- **Cache**: Redis 7+
- **Search**: Elasticsearch 8.x
- **Real-time**: WebSockets + OpenSea Stream API

## Prerequisites

- Node.js 20+ and npm 10+
- PostgreSQL 15+ (with logical replication enabled)
- Redis 7+
- Elasticsearch 8.x
- Ethereum RPC endpoint (Infura, Alchemy, etc.)

## Quick Start

### 1. Clone and Install

```bash
git clone <repository>
cd grails-backend
npm install
```

### 2. Environment Setup

```bash
cp .env.example .env
# Edit .env with your configuration
```

### 3. Start Infrastructure

Using Docker Compose (recommended):

```bash
docker-compose up -d
```

Or manually start PostgreSQL, Redis, and Elasticsearch.

### 4. Database Setup

```bash
npm run migrate
```

### 5. Build Services

```bash
npm run build
```

### 6. Start Services

In separate terminals:

```bash
# API Service
cd services/api && npm run dev

# Blockchain Indexer
cd services/indexer && npm run dev

# WAL Listener (CDC)
cd services/wal-listener && npm run dev
```

## Project Structure

```
grails-backend/
├── services/
│   ├── api/              # REST API and WebSocket server
│   ├── indexer/          # Blockchain event indexer
│   ├── wal-listener/     # PostgreSQL CDC to Elasticsearch
│   └── shared/           # Shared libraries and types
├── migrations/           # Database migrations
├── scripts/             # Utility scripts
├── config/              # Configuration files
└── docker-compose.yml   # Local development infrastructure
```

## API Endpoints

### Names
- `GET /api/v1/names` - List ENS names (paginated)
- `GET /api/v1/names/:name` - Get ENS name details
- `GET /api/v1/names/:name/history` - Get transaction history
- `GET /api/v1/names/search` - Search names (Elasticsearch)

### Orders
- `POST /api/v1/orders/create` - Create a new Seaport order
- `POST /api/v1/orders/validate` - Validate order parameters
- `GET /api/v1/orders/:id` - Get order details
- `DELETE /api/v1/orders/:id` - Cancel order

### Listings
- `POST /api/v1/listings` - Create listing
- `PUT /api/v1/listings/:id` - Update listing
- `DELETE /api/v1/listings/:id` - Remove listing

### Offers
- `POST /api/v1/offers` - Make offer
- `GET /api/v1/offers/:name` - Get offers for name
- `PUT /api/v1/offers/:id` - Update offer

### WebSocket
- `WS /ws/events` - Real-time event stream
- `WS /ws/orders` - Order status updates

### Health
- `GET /health` - Basic health check
- `GET /health/ready` - Readiness check (all dependencies)

## Configuration

Key environment variables:

```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/grails

# Blockchain
RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
SEAPORT_ADDRESS=0x0000000000000068F116a894984e2DB1123eB395

# Optional: OpenSea Stream API
OPENSEA_API_KEY=your_api_key
```

See `.env.example` for all configuration options.

## Development

### Running Tests
```bash
npm test
```

### Linting
```bash
npm run lint
```

### Type Checking
```bash
npm run typecheck
```

## PostgreSQL WAL Configuration

For the WAL listener to work, PostgreSQL needs logical replication enabled:

```sql
ALTER SYSTEM SET wal_level = logical;
ALTER SYSTEM SET max_replication_slots = 10;
ALTER SYSTEM SET max_wal_senders = 10;
```

Then restart PostgreSQL.

## Cost Optimization Features

- Direct Seaport integration (0% platform fees)
- PostgreSQL WAL for CDC (no message queue costs)
- Efficient batch processing for blockchain indexing
- Strategic caching to minimize RPC calls
- Connection pooling for all services

## Security Considerations

- All orders validated server-side
- Rate limiting on all API endpoints
- Input sanitization and validation with Zod
- Prepared statements for SQL queries
- 12-block confirmation for blockchain events

## Monitoring

The system includes health checks and logging:

- Health endpoints for each service
- Structured logging with Pino
- Optional Sentry integration for error tracking
- Prometheus-compatible metrics (coming soon)

## License

[Your License]

## Support

For issues and questions, please open a GitHub issue.