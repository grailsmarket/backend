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

### Event Monitoring (`src/services/`)
- **ENS Registry Events**: NameRegistered, Transfer, NameRenewed, NameChanged
- **Block Scanning**: Processes historical and new blocks
- **Event Parsing**: Decodes and stores blockchain events
- **State Sync**: Updates ENS name ownership and metadata

### Database Operations
- Updates `ens_names` table with latest blockchain state
- Records ownership transfers and history
- Tracks registration and expiry dates
- Stores resolver and controller information

### Important Files
- `src/index.ts` - Main indexer entry point
- `src/services/ens-indexer.ts` - Core indexing logic
- `src/services/event-processor.ts` - Event handling
- `src/contracts/` - ENS contract ABIs and interfaces
- `src/utils/block-tracker.ts` - Block processing state

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
- Creates new ENS name record
- Sets initial owner and expiry
- Records registration timestamp

### Transfer
- Updates current owner
- Maintains ownership history
- Triggers listing status updates

### NameRenewed
- Updates expiry date
- Records renewal transaction

### NameChanged
- Updates ENS name resolution
- Tracks reverse records

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