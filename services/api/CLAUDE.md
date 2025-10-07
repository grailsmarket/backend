# API Service - CLAUDE.md

## Service Overview
This is the REST API service for the ENS marketplace system. It provides endpoints for managing ENS listings, offers, and integrates with OpenSea's Stream API for real-time event processing.

## Technology Stack
- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js
- **Database**: PostgreSQL with Prisma ORM
- **Validation**: Zod schemas
- **Documentation**: OpenAPI/Swagger
- **Real-time**: OpenSea Stream API WebSocket client

## Key Components

### Database Schema (`prisma/schema.prisma`)
- **ens_names**: Stores ENS domain information (token_id, name, expiry, owner)
- **listings**: Active marketplace listings with Seaport order data
- **offers**: Incoming offers on ENS names
- **opensea_events**: Raw event storage from OpenSea

### API Endpoints

#### Listings
- `GET /api/v1/listings` - Get paginated listings with filters
- `GET /api/v1/listings/:name` - Get listing by ENS name
- `POST /api/v1/listings` - Create new listing
- `PUT /api/v1/listings/:id` - Update listing status
- `DELETE /api/v1/listings/:id` - Cancel listing

#### Offers
- `GET /api/v1/offers` - Get offers with filters
- `GET /api/v1/offers/:name` - Get offers for specific ENS name
- `POST /api/v1/offers` - Submit new offer

#### ENS Names
- `GET /api/v1/ens/:name` - Get ENS name details
- `GET /api/v1/ens/:name/history` - Get ownership history

### OpenSea Integration (`src/services/opensea/`)
- **WebSocket Stream**: Connects to OpenSea's stream for real-time events
- **Event Processing**: Handles item_listed, item_sold, order_cancelled events
- **Order Parsing**: Extracts and stores Seaport protocol data
- **Automatic Sync**: Updates listings/offers based on OpenSea events

### Important Files
- `src/index.ts` - Main server entry point
- `src/routes/` - Express route definitions
- `src/services/opensea/stream.ts` - OpenSea WebSocket handler
- `src/services/opensea/processor.ts` - Event processing logic
- `src/utils/validation.ts` - Request validation middleware

## Environment Variables
```env
DATABASE_URL=postgresql://user:password@localhost:5432/grails
PORT=3002
OPENSEA_API_KEY=your_opensea_api_key
CHAIN=ethereum
ENS_CONTRACT_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
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