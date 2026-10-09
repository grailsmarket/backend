# Grails Market Backend - Project Memory

## Overview
This file contains curated long-term context about the grailsmarket/backend project for use by Gard agents.

## Architecture

### Service Architecture
The system consists of 5 interconnected services:

1. **API Service** (ports 3000/3002) - REST API backend with ENS metadata fetching
2. **Indexer Service** - Blockchain monitoring and state synchronization
3. **WAL Listener Service** - Real-time database change detection and Elasticsearch sync
4. **Workers Service** - Background job processing with pg-boss
5. **Frontend Service** - Next.js 15 user interface

### Data Sources

#### The Graph ENS Subgraph
- Primary source for ENS metadata (text records, address records, contenthash)
- URL: `https://gateway.thegraph.com/api/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH`
- Optional API key authentication via `Authorization: Bearer <token>` header
- GraphQL API with domain queries

#### Blockchain RPC
- Direct Ethereum mainnet access for contract queries
- Monitors ENS Registry (0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e)
- Monitors ENS Registrar (0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85)
- Monitors Name Wrapper (0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401)

#### PostgreSQL Database
- Central data store for ENS names, listings, offers, transactions
- Metadata caching with TTL (72 hours)
- Real-time change notifications via LISTEN/NOTIFY

#### Elasticsearch
- Search index for ENS names
- Synced from PostgreSQL via WAL Listener
- Supports advanced filtering and full-text search

### ENS Metadata System

#### Metadata Types
The system handles three types of ENS metadata:

1. **Text Records** - Arbitrary key-value pairs (e.g., avatar, description, url, email, twitter, github)
2. **Address Records** - Multi-chain cryptocurrency addresses (coinType-based via ENSIP-11)
3. **Contenthash** - IPFS, IPNS, Swarm, Arweave, Skynet, Onion content hashes

#### Metadata Fetching Flow
1. API receives request for ENS name
2. Checks database for existing metadata and `metadata_updated_at` timestamp
3. If stale (>72 hours), fetches fresh data from The Graph
4. Updates database with new metadata
5. Returns enriched response to client

#### Key Services

**ENS Metadata Service** (`services/api/src/services/ens-metadata.ts`):
- `fetchFreshMetadata(ensNameId, name)` - Always fetches from Graph, syncs to DB async
- `ensureMetadataFresh(ensNameId, name, lastUpdated)` - Checks staleness, refreshes if needed
- 72-hour TTL for cached metadata

**Address Decoder** (`services/shared/src/utils/address-decoder.ts`):
- Decodes multi-chain addresses from raw bytes
- Supports SLIP-44 coin types and ENSIP-11 EVM chains
- Returns `{ coinType, chainId?, chainName, address }`

**Contenthash Decoder** (`services/shared/src/utils/contenthash-decoder.ts`):
- Decodes IPFS CIDs, IPNS hashes, Swarm hashes, etc.
- Uses `@ensdomains/content-hash` library
- Returns `{ protocol, value, raw? }`

## API Endpoints

### ENS Names Endpoints

#### `GET /api/v1/names`
List ENS names with pagination and filtering
- Query params: `page`, `limit`, `owner`, `status`, `sort`, `order`
- Excludes names past grace period by default
- Returns names with listings and metadata

#### `GET /api/v1/names/:name`
Get detailed information for a specific ENS name
- Supports optional authentication for user-specific data (votes, watchlist status)
- Auto-imports from The Graph if not in database
- Refreshes metadata if stale (>72 hours)
- Tracks view count asynchronously
- Response includes: name, token_id, owner, expiry, metadata, listings, votes, watchers

#### `GET /api/v1/names/:name/metadata`
Get fresh metadata for an ENS name (always fetches from The Graph)
- Bypasses cache for guaranteed fresh data
- Database sync happens asynchronously
- Response includes: `{ name, metadata, source: 'graph' }`
- Metadata includes text records, address chains, and contenthash

#### `GET /api/v1/names/:name/legacy`
Legacy endpoint with OpenSea listing/offer data
- Includes recent transactions history
- Queries OpenSea API for best listing/offer
- Auto-resolves wrapped names to actual owner

#### `GET /api/v1/names/:name/history`
Get transaction history for an ENS name
- Paginated results (`page`, `limit`)
- Returns transfers, sales, registrations

### Search Endpoints

#### `GET /api/v1/search`
Global ENS name search with advanced filtering
- Elasticsearch-first, PostgreSQL fallback
- Supports: text search, price/length filters, character filters, club filters, status filters
- Optional CSV export for authenticated users (`export=true`, `filename=<name>`)
- Query params include: `q`, `page`, `limit`, `sortBy`, `sortOrder`, `filters[...]`

#### `POST /api/v1/search/bulk`
Bulk exact name search (up to 10,000 names)
- Returns results in same order as input terms
- Placeholder objects for not-found names
- Request body: `{ terms: string[], page?, limit? }`

#### `POST /api/v1/search/bulk-filters`
Bulk search with filtering and sorting
- Returns only names matching both terms AND filters
- Paginates filtered results (not input terms)
- Request body: `{ terms, page?, limit?, sortBy?, sortOrder?, filters? }`

### Other Endpoints

#### `GET /api/v1/listings`
List active marketplace listings
- Filter by price, marketplace source (grails/opensea)
- Includes ENS name details

#### `GET /api/v1/offers`
List active offers
- Filter by buyer, price range
- Includes ENS name details

#### `GET /api/v1/profiles/:address`
Get user profile and owned names
- Resolves ENS name to address or uses raw address
- Includes portfolio stats

#### `GET /api/v1/clubs`
List ENS clubs (999, 10k, 100k, etc.)
- Club membership based on name patterns
- Includes member counts and stats

#### `GET /api/v1/analytics`
Marketplace analytics and trends
- Volume, sales, trending names
- Time-series data

## Database Schema

### Key Tables

#### `ens_names`
Primary ENS name registry table
```sql
id                    SERIAL PRIMARY KEY
token_id              VARCHAR(255) UNIQUE NOT NULL
name                  VARCHAR(255) UNIQUE NOT NULL
label_name            VARCHAR(255)
owner_address         VARCHAR(42)
resolver_address      VARCHAR(42)
expiry_date           TIMESTAMP
registration_date     TIMESTAMP
metadata              JSONB
metadata_updated_at   TIMESTAMP
clubs                 TEXT[]
has_numbers           BOOLEAN
has_emoji             BOOLEAN
view_count            INTEGER
highest_offer_wei     VARCHAR(78)
highest_offer_currency VARCHAR(42)
last_sale_date        TIMESTAMP
last_sale_price_wei   VARCHAR(78)
last_sale_currency    VARCHAR(42)
last_sale_price_usd   NUMERIC
created_at            TIMESTAMP
updated_at            TIMESTAMP
```

#### `listings`
Active marketplace listings
```sql
id                SERIAL PRIMARY KEY
ens_name_id       INTEGER REFERENCES ens_names(id)
seller_address    VARCHAR(42) NOT NULL
price_wei         VARCHAR(78) NOT NULL
currency_address  VARCHAR(42)
order_hash        VARCHAR(66)
order_data        JSONB
status            VARCHAR(20) -- 'active', 'filled', 'cancelled', 'expired'
source            VARCHAR(20) -- 'grails', 'opensea'
expires_at        TIMESTAMP
created_at        TIMESTAMP
updated_at        TIMESTAMP
```

#### `offers`
Offers on ENS names
```sql
id               SERIAL PRIMARY KEY
ens_name_id      INTEGER REFERENCES ens_names(id)
buyer_address    VARCHAR(42) NOT NULL
price_wei        VARCHAR(78) NOT NULL
currency_address VARCHAR(42)
order_data       JSONB
status           VARCHAR(20) -- 'pending', 'accepted', 'rejected', 'expired'
created_at       TIMESTAMP
updated_at       TIMESTAMP
```

#### `transactions`
Historical transaction records
```sql
id                SERIAL PRIMARY KEY
ens_name_id       INTEGER REFERENCES ens_names(id)
transaction_hash  VARCHAR(66) NOT NULL
block_number      BIGINT
from_address      VARCHAR(42)
to_address        VARCHAR(42)
price_wei         VARCHAR(78)
transaction_type  VARCHAR(20) -- 'transfer', 'sale', 'registration', 'renewal'
timestamp         TIMESTAMP
```

## Conventions

### API Response Format
All API responses follow this structure:
```typescript
{
  success: boolean,
  data?: any,
  error?: {
    code: string,
    message: string,
    details?: any
  },
  meta: {
    timestamp: string,
    version: string
  }
}
```

### Metadata Storage
- Stored as JSONB in PostgreSQL (`ens_names.metadata`)
- 72-hour TTL enforced by `metadata_updated_at` timestamp
- Text records stored as flat key-value pairs
- Address records stored under `chains` key as array
- Contenthash stored under `contenthash` key as object

### Address Handling
- All addresses stored lowercase in database
- Ethereum addresses validated as 0x + 40 hex chars
- ENS names resolved to addresses via database lookup

### Pagination
Standard pagination response:
```typescript
{
  page: number,
  limit: number,
  total: number,
  totalPages: number,
  hasNext: boolean,
  hasPrev: boolean
}
```

### Filtering Patterns
- Use bracket notation for array filters: `filters[clubs][]=999&filters[clubs][]=10k`
- Boolean filters accept string or boolean: `filters[listed]=true`
- Tri-state filters: `filters[digits]=include|exclude|only`

## Known Issues

### Wrapped Names
- Names wrapped in Name Wrapper contract show contract as owner
- System auto-resolves to actual owner via The Graph `wrappedOwner` field
- Fallback to Name Wrapper contract `ownerOf()` if Graph data unavailable

### Metadata Staleness
- 72-hour TTL means metadata can be up to 3 days old
- Use `/api/v1/names/:name/metadata` endpoint for guaranteed fresh data
- Async DB sync can cause brief inconsistency after metadata updates

### Elasticsearch Sync
- WAL Listener provides near real-time sync
- Brief lag possible during high transaction volume
- PostgreSQL fallback activated automatically if Elasticsearch returns stale data

### Grace Period Handling
- ENS names have 90-day grace period after expiry
- System excludes names past grace period from default searches
- Use `includeExpired=true` or `status=premium|available` filters to show expired names

## Development Notes

### Configuration
All services use shared config from `services/shared/src/config/index.ts`
- Loads from `.env` files at multiple locations
- Environment variables override defaults
- Validation via Zod schemas

### Logging
- Pino logger used throughout
- Structured logging with context objects
- Log level configurable via `LOG_LEVEL` env var

### Error Handling
- Services fail gracefully with fallbacks (ES → PostgreSQL, Graph → cached data)
- Rate limiting on API endpoints (150 requests/minute default)
- Retry logic for blockchain RPC calls

### Testing
- Integration tests in `services/api/src/__tests__`
- Mock The Graph responses for metadata tests
- Database transaction rollback for test isolation
