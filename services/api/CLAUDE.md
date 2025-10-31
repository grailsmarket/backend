# API Service - CLAUDE.md

## Service Overview
This is the REST API service for the Grails ENS marketplace system. It provides comprehensive endpoints for ENS names, listings, offers, user management, notifications, sales history, and integrates with OpenSea's Stream API for real-time marketplace event processing.

## Technology Stack
- **Runtime**: Node.js with TypeScript
- **Framework**: Fastify (high-performance web framework)
- **Database**: PostgreSQL (shared with other services)
- **Search**: Elasticsearch (via WAL Listener sync)
- **Validation**: Zod schemas
- **Authentication**: SIWE (Sign-In With Ethereum) with JWT
- **Real-time**: OpenSea Stream API WebSocket client (Phoenix protocol)

## Key Components

### Database Schema (`prisma/schema.prisma`)
- **ens_names**: Stores ENS domain information (token_id, name, expiry, owner)
- **listings**: Active marketplace listings with Seaport order data
- **offers**: Incoming offers on ENS names
- **opensea_events**: Raw event storage from OpenSea

### API Endpoints

#### Authentication (SIWE)
- `GET /auth/nonce` - Get nonce for signing
- `POST /auth/verify` - Verify signature and get JWT token
- `POST /auth/logout` - Invalidate current token
- `GET /auth/me` - Get current user info

#### ENS Names
- `GET /names` - List ENS names with filters
- `GET /names/search` - Search ENS names with Elasticsearch (advanced filters)
- `GET /names/:name` - Get specific ENS name details

#### Listings
- `GET /listings` - Get paginated listings
- `GET /listings/search` - Search listings with Elasticsearch
- `GET /listings/:name` - Get listing by ENS name
- `POST /listings` - Create new listing (requires auth)
- `PATCH /listings/:id` - Update listing (requires auth)
- `DELETE /listings/:id` - Cancel listing (requires auth)

#### Offers
- `GET /offers` - Get offers with filters
- `GET /offers/:name` - Get offers for specific ENS name
- `POST /offers` - Submit new offer (requires auth)
- `DELETE /offers/:id` - Cancel offer (requires auth)

#### Watchlist (Auth Required)
- `GET /watchlist` - Get user's watchlist with pagination
- `GET /watchlist/search` - Search/filter watchlist with Elasticsearch
- `POST /watchlist` - Add ENS name to watchlist
- `PATCH /watchlist/:id` - Update notification preferences
- `DELETE /watchlist/:id` - Remove from watchlist

#### Notifications (Auth Required)
- `GET /notifications` - Get user notifications (with unreadOnly filter)
- `GET /notifications/unread/count` - Get unread count
- `PATCH /notifications/:id/read` - Mark notification as read
- `PATCH /notifications/read-all` - Mark all as read

#### Sales
- `GET /sales` - Get recent sales with pagination
- `GET /sales/name/:name` - Get sales history for ENS name
- `GET /sales/address/:address` - Get sales by address (buyer/seller)
- `GET /sales/:nameOrId/analytics` - Get sales analytics for name

#### Profiles
- `GET /profiles/:addressOrName` - Get profile by address or ENS name
  - Fetches from The Graph if not in database
  - Queries Name Wrapper contract for wrapped names
  - Gets ENS records from EFP API

#### Activity
- `GET /activity/:name` - Get activity history for ENS name

#### Clubs
- `GET /clubs` - List all clubs with member counts
- `GET /clubs/:clubName` - Get club details with members

#### Votes
- `POST /votes` - Cast vote on ENS name (requires auth)
- `GET /votes/:ensName` - Get votes for ENS name

#### Users (Auth Required)
- `GET /users/me` - Get current user profile
- `PATCH /users/me` - Update user profile

#### Orders
- `POST /orders/seaport` - Create Seaport order
- `GET /orders/:hash` - Get order by hash

###Search & Filtering

The API provides advanced search capabilities through Elasticsearch integration:

**Search Filters Available:**
- **Price**: `minPrice`, `maxPrice` (in wei)
- **Length**: `minLength`, `maxLength` (character count)
- **Character Types**: `hasNumbers`, `hasEmoji` (boolean)
- **Clubs**: `clubs[]` (array of club names)
- **Expiration**: `isExpired`, `isGracePeriod`, `isPremiumPeriod`, `expiringWithinDays`
- **Sales History**: `hasSales`, `lastSoldAfter`, `lastSoldBefore`, `minDaysSinceLastSale`, `maxDaysSinceLastSale`

**Filter Notation:**
- Bracket notation: `filters[minPrice]=1000000000000000000`
- Array values: `filters[clubs][]=10k Club&filters[clubs][]=999 Club`

**Response Builder Pattern:**
Elasticsearch returns name strings → `buildSearchResults()` enriches with PostgreSQL data (listings, offers, watchlist status) → Returns full objects to client

### OpenSea Integration (`src/services/opensea-stream.ts`)
- **WebSocket Stream**: Phoenix protocol WebSocket to OpenSea Stream API
- **Event Processing**: Handles item_listed, item_sold, order_cancelled, item_received_bid, collection_offer
- **Order Parsing**: Extracts Seaport protocol_data and stores in listings.order_data (JSON)
- **Automatic Sync**: Creates/updates listings and offers based on OpenSea events
- **Name Resolution**: Resolves placeholder names (token-*) to actual ENS names via The Graph API

### Important Files
- `src/index.ts` - Main Fastify server entry point
- `src/routes/` - Route definitions (auth, names, listings, offers, watchlist, notifications, sales, profiles, etc.)
- `src/services/opensea-stream.ts` - OpenSea WebSocket handler (Phoenix protocol)
- `src/services/search.ts` - Elasticsearch query builder
- `src/middleware/auth.ts` - JWT authentication middleware (`requireAuth`, `optionalAuth`)
- `src/utils/response-builder.ts` - Enriches ES results with PostgreSQL data
- `src/utils/siwe.ts` - Sign-In With Ethereum utilities

## Environment Variables
```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/grails

# Server
PORT=3000
NODE_ENV=development

# Authentication (SIWE)
JWT_SECRET=your-secret-key
JWT_EXPIRATION=7d

# OpenSea
OPENSEA_API_KEY=your_opensea_api_key
OPENSEA_STREAM_URL=wss://stream.openseabeta.com/socket

# Blockchain
CHAIN=ethereum
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/your-key

# Search
ELASTICSEARCH_URL=http://localhost:9200

# The Graph
GRAPH_ENS_SUBGRAPH_URL=https://api.thegraph.com/subgraphs/name/ensdomains/ens
GRAPH_API_KEY=your-graph-api-key  # Optional

# External APIs
EFP_API_URL=https://api.ethfollow.xyz  # For ENS records
```

## Common Commands
```bash
# Development
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm start           # Production mode

# Database
npm run db:migrate   # Run migrations
npm run db:generate  # Generate Prisma client
npm run db:seed      # Seed test data

# Testing
npm test            # Run tests
npm run lint        # Check code style
```

## Architecture Patterns
1. **Repository Pattern**: Database operations isolated in repository classes
2. **Service Layer**: Business logic separated from routes
3. **Event-Driven**: OpenSea events trigger database updates
4. **Error Handling**: Centralized error middleware with proper status codes

## Key Features
- Real-time OpenSea event streaming and processing
- Seaport order data storage and validation
- Pagination and filtering for all list endpoints
- Comprehensive error handling and logging
- TypeScript for type safety
- OpenAPI documentation at `/api-docs`

## Integration Points
- **Indexer Service**: Shares database, provides blockchain data
- **WAL Listener**: Processes database changes via PostgreSQL WAL
- **Frontend**: Consumes REST API endpoints

## Troubleshooting
- Check OpenSea API key is valid and has proper permissions
- Ensure PostgreSQL is running and migrations are applied
- Verify ENS contract address matches the network
- Monitor WebSocket connection status in logs

## Testing Endpoints
```bash
# Get active listings
curl http://localhost:3002/api/v1/listings

# Get specific listing
curl http://localhost:3002/api/v1/listings/vitalik.eth

# Check OpenSea stream status
curl http://localhost:3002/api/v1/status
```