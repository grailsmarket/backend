# Indexer Service - CLAUDE.md

## Service Overview
The Indexer service monitors the Ethereum blockchain for ENS-related events and synchronizes blockchain state with the database. It tracks ENS registrations, transfers, name changes, and expiry updates.

## Technology Stack
- **Runtime**: Node.js with TypeScript
- **Blockchain**: Ethers.js v6 for Ethereum interaction
- **Database**: PostgreSQL with Prisma ORM
- **RPC**: Alchemy/Infura for reliable blockchain access
- **Monitoring**: Event listeners and block scanning

## Key Components

### Event Monitoring

#### ENS Blockchain Events (`src/indexers/ens-indexer.ts`)
- **NameRegistered**: Creates new ens_names records with token_id, name, owner, expiry
- **Transfer**: Updates owner_address, publishes ownership job to workers
- **NameRenewed**: Updates expiry_date for ENS names
- **Block Scanning**: Processes historical and new blocks in batches
- **Event Parsing**: Decodes events using contract ABIs
- **State Sync**: Updates ENS name ownership and metadata

#### OpenSea Stream Events (`src/services/opensea-stream.ts`)
- **item_listed**: Creates/updates listings with Seaport order data
- **item_sold**: Records sales, updates ownership if needed
- **order_cancelled**: Marks listings as cancelled
- **item_received_bid**: Creates offers records
- **collection_offer**: Handles collection-wide offers
- **WebSocket Management**: Phoenix protocol with heartbeat, auto-reconnect

### Database Operations
- Updates `ens_names` table with latest blockchain state
- Records ownership transfers and history
- Tracks registration and expiry dates
- Stores resolver and controller information

### Important Files
- `src/index.ts` - Main indexer entry point, starts all services
- `src/indexers/ens-indexer.ts` - ENS blockchain event indexing
- `src/services/opensea-stream.ts` - OpenSea WebSocket stream handler
- `src/services/name-resolver.ts` - Resolves placeholder names via The Graph
- `src/contracts/` - ENS contract ABIs and interfaces
- `src/scripts/backfill-ens-names.ts` - Backfill script for placeholder resolution
- `src/scripts/backfill-simple.ts` - Lightweight backfill with minimal deps

## Environment Variables
```env
DATABASE_URL=postgresql://user:password@localhost:5432/grails
ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/your-key
ENS_REGISTRY_ADDRESS=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85
START_BLOCK=19000000  # Optional: starting block for historical sync
BLOCK_BATCH_SIZE=1000  # Number of blocks to process per batch
```

## Common Commands
```bash
# Development
npm run dev          # Start indexer with hot reload
npm run build        # Compile TypeScript
npm start           # Production mode

# Utilities
npm run sync        # Force re-sync from specific block
npm run backfill    # Backfill historical data
npm run check       # Verify data integrity
```

## Indexing Strategy
1. **Initial Sync**: Scans historical blocks for past events
2. **Real-time Monitoring**: Subscribes to new blocks and events
3. **Gap Filling**: Detects and fills any missing block ranges
4. **Reorganization Handling**: Manages blockchain reorgs
5. **Checkpoint System**: Saves progress to resume after restarts

## Event Types Processed

### NameRegistered
- Creates new ENS name record in ens_names table
- Records: token_id, name, owner_address, expiry_date, registration_date
- Triggers ENS sync job in workers for metadata fetch

### Transfer
- Updates owner_address in ens_names table
- Publishes update-ownership job to workers queue
- Workers cancel invalid listings (old owner can't fulfill)
- Maintains ownership history via activity_history table

### NameRenewed
- Updates expiry_date in ens_names table
- Records renewal transaction hash and timestamp
- Updates derived expiration fields (is_expired, is_grace_period, etc.)

### NameChanged
- Updates ENS name resolution data
- Tracks reverse records
- Updates resolver_address if changed

### item_listed (OpenSea)
- Creates/updates listing in listings table
- Stores Seaport order data in order_data (JSON column)
- Resolves placeholder name via The Graph if needed
- Upserts ens_names record with resolved name
- Only updates name if current value is placeholder (token-*)

### item_sold (OpenSea)
- Creates sale record in sales table
- Updates last_sale_price and last_sale_date in ens_names
- Updates ownership if Transfer event detected
- Marks listing as sold

### order_cancelled (OpenSea)
- Updates listing status to 'cancelled'
- Records cancellation timestamp
- Removes from active listings

## Performance Optimizations
- Batch processing of events
- Database transaction batching
- Block range caching
- Concurrent event processing
- Connection pooling

## Data Flow
1. Connect to Ethereum RPC endpoint
2. Query current block number
3. Scan blocks for ENS events
4. Parse and decode event data
5. Update database with new state
6. Mark blocks as processed
7. Continue monitoring new blocks

## Integration Points
- **API Service**: Provides ENS data for listings
- **Database**: Shared PostgreSQL instance
- **Blockchain**: Ethereum mainnet/testnet

## Monitoring & Alerts
- Track indexing lag (current vs latest block)
- Monitor RPC connection health
- Alert on processing errors
- Track event processing rate

## Troubleshooting
```bash
# Check indexing status
npm run status

# View recent events
npm run logs:events

# Reset indexer state
npm run reset --from-block=19000000

# Verify ENS name data
npm run verify:ens <name>
```

## Recovery Procedures
1. **Missed Events**: Run backfill for specific block range
2. **Corrupt Data**: Reset and re-index from checkpoint
3. **RPC Issues**: Automatic retry with exponential backoff
4. **Database Errors**: Transaction rollback and retry

## Performance Metrics
- Events per second processed
- Block processing latency
- Database write throughput
- RPC request rate
- Memory usage patterns