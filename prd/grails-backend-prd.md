# Product Requirements Document
# ENS Name Secondary Marketplace Backend System

## 1. Executive Summary

### 1.1 Project Overview
This document outlines the requirements for building a backend system for an ENS (Ethereum Name Service) secondary marketplace. The system will enable users to list, buy, bid on, and sell ENS names through a platform that bypasses traditional marketplace fees by directly interacting with the Seaport protocol.

### 1.2 Key Objectives
- Build a lightweight, cost-efficient backend infrastructure
- Minimize operational costs while maintaining high performance
- Enable direct Seaport order generation to avoid platform fees
- Provide real-time market data and transaction monitoring
- Support comprehensive search and discovery features via Elasticsearch

### 1.3 Success Criteria
- Zero platform fees on transactions (excluding gas)
- Sub-second API response times for queries
- 99.9% uptime for critical services
- Real-time indexing of on-chain events (< 5 second lag)
- Successful validation and execution of custom Seaport orders

## 2. System Architecture

### 2.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (3rd Party)                    │
└──────────────────────────────┬──────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│                          API Gateway                            │
│                    (REST API + WebSocket)                       │
└──────────────────────────────┬──────────────────────────────────┘
                               │
        ┌──────────────────────┼──────────────────────┐
        │                      │                      │
        ▼                      ▼                      ▼
┌──────────────┐    ┌──────────────────┐    ┌──────────────┐
│   PostgreSQL │    │   Elasticsearch  │    │     Redis    │
│   (Primary   │◄───│   (Search Index) │    │    (Cache)   │
│   Database)  │    └──────────────────┘    └──────────────┘
└──────────────┘              ▲
        ▲                     │
        │                     │
┌───────┴──────────┐  ┌───────┴──────────┐
│  WAL Listener    │  │  Indexer Service │
│  (CDC Service)   │  │  (Blockchain)    │
└──────────────────┘  └──────────────────┘
                              │
                              ▼
        ┌─────────────────────┴─────────────────────┐
        │                                           │
        ▼                                           ▼
┌──────────────────┐                    ┌──────────────────┐
│  ENS Contracts   │                    │  Seaport Contract│
│  (Events)        │                    │  (Orders)        │
└──────────────────┘                    └──────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  OpenSea Stream  │
                    │      API         │
                    └──────────────────┘
```

### 2.2 Technology Stack
- **Language**: TypeScript/Node.js (API, Services), Go (High-performance indexer)
- **Database**: PostgreSQL 15+ with partitioning
- **Search**: Elasticsearch 8.x
- **Cache**: Redis 7.x
- **Message Queue**: PostgreSQL WAL + Logical Replication
- **API Framework**: Fastify (for performance)
- **Blockchain Interaction**: Viem 2.37.x
- **Monitoring**: Prometheus + Grafana

## 3. Core Components

### 3.1 API Service

#### 3.1.1 Responsibilities
- RESTful API endpoints for marketplace operations
- WebSocket connections for real-time updates
- Order generation and validation
- Authentication and authorization
- Rate limiting and DDoS protection

#### 3.1.2 Key Endpoints
```
POST   /api/v1/orders/create         - Create a new Seaport order
POST   /api/v1/orders/validate       - Validate order parameters
POST   /api/v1/orders/sign           - Request order signature
GET    /api/v1/orders/:id            - Get order details
DELETE /api/v1/orders/:id            - Cancel order

GET    /api/v1/names                 - List ENS names (paginated)
GET    /api/v1/names/:name           - Get ENS name details
GET    /api/v1/names/:name/history   - Get transaction history
GET    /api/v1/names/search          - Search names (Elasticsearch)

POST   /api/v1/listings              - Create listing
PUT    /api/v1/listings/:id          - Update listing
DELETE /api/v1/listings/:id          - Remove listing

POST   /api/v1/offers                - Make offer
GET    /api/v1/offers/:name          - Get offers for name
PUT    /api/v1/offers/:id            - Update offer

WS     /ws/events                    - Real-time event stream
WS     /ws/orders                    - Order status updates
```

### 3.2 Blockchain Indexer

#### 3.2.1 ENS Event Monitoring
Monitor and index the following ENS contract events:
- **Transfer**: Track ownership changes
- **NameRegistered**: New registrations
- **NameRenewed**: Renewal activities
- **NameMigrated**: Legacy migrations

Primary contracts to monitor:
- BaseRegistrar: `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85`
- ETHRegistrarController: (Verify current address)
- ENS Registry: `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`

#### 3.2.2 Seaport Event Monitoring
- **OrderFulfilled**: Completed trades
- **OrderCancelled**: Cancelled orders
- **OrderValidated**: Validation events

#### 3.2.3 Implementation Strategy
```typescript
interface IndexerConfig {
  startBlock: number;           // Starting block for historical sync
  batchSize: number;            // Blocks per batch (100-1000)
  confirmations: number;        // Required confirmations (12)
  retryAttempts: number;        // Retry failed blocks (3)
  reorganizationDepth: number;  // Handle chain reorgs (100)
}
```

### 3.3 Order Management System

#### 3.3.1 Seaport Order Generation
```typescript
interface SeaportOrder {
  offerer: string;
  zone: string;
  offer: OfferItem[];
  consideration: ConsiderationItem[];
  orderType: OrderType;
  startTime: number;
  endTime: number;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  totalOriginalConsiderationItems: number;
}

interface OfferItem {
  itemType: ItemType;  // ERC721 for ENS
  token: string;        // ENS contract address
  identifierOrCriteria: string;  // Token ID
  startAmount: string;
  endAmount: string;
}

interface ConsiderationItem extends OfferItem {
  recipient: string;    // Payment recipient
}
```

#### 3.3.2 Fee Structure
To avoid OpenSea's 2.5% platform fee:
- Generate orders directly without OpenSea API
- Set consideration items to exclude OpenSea's fee recipient
- Include only:
  - Seller payment (97.5-100% depending on creator fees)
  - Creator royalties (if applicable)
  - Optional protocol fee (our marketplace fee, if any)

### 3.4 Database Schema

#### 3.4.1 PostgreSQL Tables

```sql
-- ENS Names table
CREATE TABLE ens_names (
    id SERIAL PRIMARY KEY,
    name VARCHAR(255) UNIQUE NOT NULL,
    token_id VARCHAR(78) UNIQUE NOT NULL,
    owner_address VARCHAR(42) NOT NULL,
    registrant VARCHAR(42),
    expiry_date TIMESTAMP,
    registration_date TIMESTAMP,
    last_transfer_date TIMESTAMP,
    metadata JSONB,
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Listings table
CREATE TABLE listings (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER REFERENCES ens_names(id),
    seller_address VARCHAR(42) NOT NULL,
    price_wei VARCHAR(78) NOT NULL,
    currency_address VARCHAR(42),
    order_hash VARCHAR(66) UNIQUE,
    order_data JSONB NOT NULL,
    status VARCHAR(20) NOT NULL, -- active, sold, cancelled, expired
    created_at TIMESTAMP DEFAULT NOW(),
    updated_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);

-- Offers table
CREATE TABLE offers (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER REFERENCES ens_names(id),
    buyer_address VARCHAR(42) NOT NULL,
    offer_amount_wei VARCHAR(78) NOT NULL,
    currency_address VARCHAR(42),
    order_hash VARCHAR(66) UNIQUE,
    order_data JSONB NOT NULL,
    status VARCHAR(20) NOT NULL, -- pending, accepted, rejected, expired
    created_at TIMESTAMP DEFAULT NOW(),
    expires_at TIMESTAMP
);

-- Transactions table
CREATE TABLE transactions (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER REFERENCES ens_names(id),
    transaction_hash VARCHAR(66) UNIQUE NOT NULL,
    block_number BIGINT NOT NULL,
    from_address VARCHAR(42) NOT NULL,
    to_address VARCHAR(42) NOT NULL,
    price_wei VARCHAR(78),
    transaction_type VARCHAR(20), -- sale, transfer, registration, renewal
    timestamp TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Events log table (for reorg handling)
CREATE TABLE blockchain_events (
    id SERIAL PRIMARY KEY,
    block_number BIGINT NOT NULL,
    transaction_hash VARCHAR(66) NOT NULL,
    log_index INTEGER NOT NULL,
    contract_address VARCHAR(42) NOT NULL,
    event_name VARCHAR(50) NOT NULL,
    event_data JSONB NOT NULL,
    processed BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(transaction_hash, log_index)
);

-- Create indexes
CREATE INDEX idx_ens_names_owner ON ens_names(owner_address);
CREATE INDEX idx_ens_names_expiry ON ens_names(expiry_date);
CREATE INDEX idx_listings_status ON listings(status);
CREATE INDEX idx_listings_seller ON listings(seller_address);
CREATE INDEX idx_offers_buyer ON offers(buyer_address);
CREATE INDEX idx_transactions_block ON transactions(block_number);
CREATE INDEX idx_events_block ON blockchain_events(block_number);
CREATE INDEX idx_events_processed ON blockchain_events(processed);
```

### 3.5 Elasticsearch Integration

#### 3.5.1 Index Structure
```json
{
  "mappings": {
    "properties": {
      "name": {
        "type": "text",
        "fields": {
          "keyword": { "type": "keyword" },
          "ngram": {
            "type": "text",
            "analyzer": "ngram_analyzer"
          }
        }
      },
      "token_id": { "type": "keyword" },
      "owner": { "type": "keyword" },
      "price": { "type": "scaled_float", "scaling_factor": 1000000000000000000 },
      "expiry_date": { "type": "date" },
      "registration_date": { "type": "date" },
      "character_count": { "type": "integer" },
      "has_numbers": { "type": "boolean" },
      "has_emoji": { "type": "boolean" },
      "status": { "type": "keyword" },
      "tags": { "type": "keyword" },
      "last_sale_price": { "type": "scaled_float", "scaling_factor": 1000000000000000000 },
      "listing_created_at": { "type": "date" }
    }
  },
  "settings": {
    "analysis": {
      "analyzer": {
        "ngram_analyzer": {
          "type": "custom",
          "tokenizer": "ngram_tokenizer",
          "filter": ["lowercase"]
        }
      },
      "tokenizer": {
        "ngram_tokenizer": {
          "type": "ngram",
          "min_gram": 2,
          "max_gram": 10
        }
      }
    }
  }
}
```

### 3.6 WAL Listener Service

#### 3.6.1 Change Data Capture (CDC)
```typescript
interface CDCService {
  // Listen to PostgreSQL logical replication
  subscribeToChanges(tables: string[]): void;

  // Process change events
  handleInsert(table: string, data: any): Promise<void>;
  handleUpdate(table: string, oldData: any, newData: any): Promise<void>;
  handleDelete(table: string, data: any): Promise<void>;

  // Sync to Elasticsearch
  syncToElasticsearch(operation: string, data: any): Promise<void>;
}
```

#### 3.6.2 PostgreSQL Configuration
```sql
-- Enable logical replication
ALTER SYSTEM SET wal_level = logical;
ALTER SYSTEM SET max_replication_slots = 10;
ALTER SYSTEM SET max_wal_senders = 10;

-- Create replication slot
SELECT pg_create_logical_replication_slot('elasticsearch_sync', 'pgoutput');

-- Create publication
CREATE PUBLICATION elasticsearch_pub FOR TABLE ens_names, listings, offers;
```

## 4. Integration Requirements

### 4.1 OpenSea Stream API Integration

#### 4.1.1 Connection Management
```typescript
interface StreamConfig {
  apiKey: string;
  endpoint: 'wss://stream.openseabeta.com/socket';
  reconnectInterval: number;  // 5000ms
  maxReconnectAttempts: number;  // 10
  heartbeatInterval: number;  // 30000ms
}
```

#### 4.1.2 Event Subscriptions
Monitor ENS collection events:
- item_listed
- item_sold
- item_transferred
- item_metadata_updated
- item_cancelled
- item_received_bid

### 4.2 Seaport Direct Integration

#### 4.2.1 Order Validation
Before submission, validate orders against:
- Correct item types and token addresses
- Valid time windows
- Proper signature format
- Sufficient balances and approvals

#### 4.2.2 Gas Optimization
- Batch operations where possible
- Use multicall for multiple reads
- Implement gas price oracle integration
- Provide gas estimation endpoints

## 5. Security Considerations

### 5.1 Order Security
- **Signature Validation**: Verify all order signatures server-side
- **Replay Protection**: Track order nonces and salts
- **Time Window Validation**: Enforce order expiration
- **Price Manipulation**: Monitor for suspicious pricing patterns

### 5.2 API Security
- **Rate Limiting**: Implement per-IP and per-user limits
- **DDoS Protection**: Use Cloudflare or similar CDN
- **Authentication**: JWT tokens with refresh mechanism
- **Input Validation**: Strict validation on all inputs
- **SQL Injection Prevention**: Use parameterized queries

### 5.3 Blockchain Security
- **Reorg Handling**: Wait for sufficient confirmations (12 blocks)
- **Event Verification**: Cross-verify events with multiple nodes
- **Contract Verification**: Whitelist known contract addresses
- **Gas Price Protection**: Set maximum gas price limits

## 6. Performance Requirements

### 6.1 Response Time SLAs
- API Queries: < 100ms (p95)
- Search Queries: < 200ms (p95)
- Order Generation: < 500ms (p95)
- Blockchain Indexing Lag: < 5 seconds

### 6.2 Scalability Targets
- Concurrent Users: 10,000+
- Requests per Second: 1,000+
- Total ENS Names Indexed: 3,000,000+
- Active Listings: 100,000+

### 6.3 Optimization Strategies
- **Database**:
  - Implement table partitioning for time-series data
  - Use materialized views for complex queries
  - Enable query result caching

- **Caching**:
  - Redis for hot data (active listings, popular names)
  - CDN for static assets
  - Application-level caching for computed values

- **Elasticsearch**:
  - Use appropriate shard sizing (50GB per shard)
  - Implement index lifecycle management
  - Optimize mapping for search patterns

## 7. Cost Optimization Strategies

### 7.1 Infrastructure Optimization
- **Database**: Use read replicas for query distribution
- **Compute**: Implement auto-scaling with conservative thresholds
- **Storage**: Archive old data to cheaper storage tiers
- **Bandwidth**: Compress API responses (gzip/brotli)

### 7.2 Blockchain Interaction
- **RPC Optimization**:
  - Use batch requests
  - Implement local caching of blockchain data
  - Consider running own node for high-volume operations
- **Gas Optimization**:
  - Monitor gas prices and delay non-critical operations
  - Implement gas price prediction

### 7.3 Monitoring & Alerts
- Cost tracking per component
- Alert on unusual spending patterns
- Regular cost optimization reviews

## 8. Development Phases

### Phase 1: Foundation (Weeks 1-3)
- [ ] Setup PostgreSQL database with schema
- [ ] Implement basic API framework
- [ ] Create ENS indexer for basic events
- [ ] Setup development and testing environment

### Phase 2: Core Marketplace (Weeks 4-6)
- [ ] Implement Seaport order generation
- [ ] Build listing and offer management
- [ ] Create order validation system
- [ ] Implement basic search functionality

### Phase 3: Real-time Features (Weeks 7-8)
- [ ] Integrate OpenSea Stream API
- [ ] Implement WebSocket connections
- [ ] Setup WAL listener for CDC
- [ ] Elasticsearch integration

### Phase 4: Advanced Features (Weeks 9-10)
- [ ] Advanced search and filtering
- [ ] Analytics and reporting
- [ ] Bulk operations support
- [ ] Performance optimization

### Phase 5: Production Readiness (Weeks 11-12)
- [ ] Security audit
- [ ] Load testing
- [ ] Monitoring and alerting setup
- [ ] Documentation and deployment

## 9. Success Metrics

### 9.1 Technical Metrics
- **Uptime**: > 99.9%
- **API Latency**: < 100ms p95
- **Indexing Lag**: < 5 seconds
- **Failed Transactions**: < 0.1%

### 9.2 Business Metrics
- **Platform Fee Savings**: 2.5% per transaction
- **Monthly Active Users**: Track growth
- **Transaction Volume**: Total and trends
- **Operating Costs**: < $X per transaction

### 9.3 Quality Metrics
- **Code Coverage**: > 80%
- **Security Vulnerabilities**: 0 critical, < 5 medium
- **Technical Debt Ratio**: < 5%
- **Documentation Coverage**: 100% for public APIs

## 10. Risk Analysis

### 10.1 Technical Risks
| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Blockchain reorg | High | Low | 12 block confirmations, event replay system |
| RPC node failure | High | Medium | Multiple node providers, fallback mechanisms |
| Database failure | High | Low | Automated backups, read replicas |
| DDoS attack | Medium | Medium | CDN, rate limiting, traffic filtering |

### 10.2 Business Risks
| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| Seaport protocol changes | High | Low | Abstract order generation, version detection |
| OpenSea API changes | Medium | Medium | Abstract integration layer, fallback data sources |
| Regulatory changes | High | Low | Compliance monitoring, flexible architecture |
| Competition | Medium | High | Focus on UX, lower fees, unique features |

## 11. Future Enhancements

### 11.1 Potential Features
- Multi-chain support (Polygon, Arbitrum)
- Advanced analytics dashboard
- Automated market making (AMM) for ENS names
- Fractional ownership support
- Integration with DeFi protocols
- Mobile app backend support

### 11.2 Technical Improvements
- GraphQL API layer
- Machine learning for price prediction
- IPFS integration for decentralized metadata
- Layer 2 scaling solutions
- Advanced caching strategies

## 12. Dependencies and External Services

### 12.1 Required Services
- **Ethereum RPC Provider**: Alchemy, Infura, or QuickNode
- **OpenSea API Key**: For Stream API access
- **Cloud Infrastructure**: AWS, GCP, or Azure
- **CDN**: Cloudflare or Fastly
- **Monitoring**: DataDog, New Relic, or Prometheus

### 12.2 Optional Services
- **Analytics**: Mixpanel or Amplitude
- **Error Tracking**: Sentry
- **Log Management**: ELK Stack or Splunk
- **Backup Solution**: AWS S3 or equivalent

## Appendix A: API Response Formats

### Standard Success Response
```json
{
  "success": true,
  "data": {},
  "meta": {
    "timestamp": "2024-01-01T00:00:00Z",
    "version": "1.0.0"
  }
}
```

### Standard Error Response
```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human readable message",
    "details": {}
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00Z",
    "request_id": "uuid"
  }
}
```

## Appendix B: Environment Configuration

### Required Environment Variables
```bash
# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/marketplace
REDIS_URL=redis://localhost:6379

# Blockchain
RPC_URL=https://mainnet.infura.io/v3/YOUR_KEY
CHAIN_ID=1
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
SEAPORT_ADDRESS=0x0000000000000068F116a894984e2DB1123eB395

# OpenSea
OPENSEA_API_KEY=your_api_key
OPENSEA_STREAM_URL=wss://stream.openseabeta.com/socket

# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_INDEX=ens_names

# API
API_PORT=3000
JWT_SECRET=your_secret_key
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW=60000

# Monitoring
SENTRY_DSN=your_sentry_dsn
LOG_LEVEL=info
```

---

*Document Version: 1.0.0*
*Last Updated: September 2025*
*Status: Draft - Pending Review*