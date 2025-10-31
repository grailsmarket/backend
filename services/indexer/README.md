# Grails Indexer Service

Monitors the Ethereum blockchain for ENS-related events and synchronizes blockchain state with the database. Also integrates with OpenSea Stream API for real-time marketplace events.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# Development mode
npm run dev

# Production
npm run build
npm start
```

## What This Service Does

- **Blockchain Monitoring**: Tracks ENS Registry and Registrar contract events
- **ENS Events**: NameRegistered, Transfer, NameRenewed, NameChanged
- **OpenSea Integration**: Real-time marketplace events via WebSocket
- **Data Sync**: Updates database with latest blockchain state
- **Name Resolution**: Resolves placeholder names (token-*) to actual ENS names

## Events Tracked

### ENS Registrar Contract
**Contract**: `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85`

| Event | What Gets Recorded | Database Updates |
|-------|-------------------|------------------|
| NameRegistered | token_id, name, owner, expiry_date | Creates new ens_names record |
| Transfer | from_address, to_address, token_id | Updates owner_address in ens_names |
| NameRenewed | token_id, new_expiry_date | Updates expiry_date in ens_names |

### OpenSea Stream Events
**Protocol**: Phoenix WebSocket

| Event | What Gets Recorded | Database Updates |
|-------|-------------------|------------------|
| item_listed | price, seller, order_hash, protocol_data | Creates/updates listings table |
| item_sold | price, buyer, seller, transaction_hash | Creates sales record, updates ownership |
| order_cancelled | order_hash, reason | Updates listing status to 'cancelled' |
| item_received_bid | price, buyer, expiration | Creates offers record |

## Required Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/grails

# Blockchain
ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/your-key
ENS_REGISTRY_ADDRESS=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85

# OpenSea
OPENSEA_API_KEY=your_opensea_api_key
OPENSEA_STREAM_URL=wss://stream.openseabeta.com/socket

# The Graph (for ENS name resolution)
GRAPH_ENS_SUBGRAPH_URL=https://api.thegraph.com/subgraphs/name/ensdomains/ens

# Indexing Config
START_BLOCK=19000000  # Optional: starting block for historical sync
BLOCK_BATCH_SIZE=1000  # Blocks to process per batch
```

## Architecture

```
Ethereum Blockchain → RPC Provider → Indexer → PostgreSQL
                                                    ↓
OpenSea Stream API → WebSocket → Indexer → (listings, offers, sales)
                                                    ↓
The Graph API → Name Resolution → Indexer → (resolved names)
```

## How It Works

### Blockchain Event Processing
1. Connect to Ethereum RPC endpoint
2. Query current block number
3. Scan blocks for ENS events (batch mode)
4. Parse and decode event data
5. Upsert to database (handles conflicts)
6. Mark blocks as processed
7. Continue monitoring new blocks

### OpenSea Event Processing
1. Connect to OpenSea Stream API via WebSocket
2. Subscribe to ENS collection events
3. Receive real-time marketplace events
4. Extract Seaport order data from protocol_data
5. Resolve ENS names via The Graph (if placeholder)
6. Store listing/offer/sale data in database
7. Maintain WebSocket connection with heartbeat

### Name Resolution Strategy
- Names come in as `token-{tokenId}` placeholders
- Indexer resolves to actual names via The Graph
- Uses `CASE WHEN` logic to only update placeholders
- Preserves actual names once resolved

## Data Flow Examples

### New ENS Registration
```
1. NameRegistered event emitted on-chain
2. Indexer detects event via RPC
3. Creates ens_names record:
   - token_id: 123456789
   - name: newname.eth
   - owner_address: 0x...
   - expiry_date: 2025-01-01
   - registration_date: 2024-01-01
4. WAL Listener syncs to Elasticsearch
5. Name becomes searchable in frontend
```

### OpenSea Listing
```
1. User lists on OpenSea
2. item_listed event sent via WebSocket
3. Indexer receives event:
   - order_hash: 0xabc...
   - price: 1.5 ETH
   - protocol_data: {Seaport order}
4. Stores in listings table
5. WAL Listener syncs to Elasticsearch
6. Listing appears in frontend search
```

## Monitoring

### Check Indexing Status
```bash
# Check latest indexed block
psql $DATABASE_URL -c "SELECT MAX(block_number) FROM indexed_blocks;"

# Check recent ENS events
psql $DATABASE_URL -c "SELECT COUNT(*) FROM ens_names WHERE created_at > NOW() - INTERVAL '1 hour';"

# Check OpenSea events
psql $DATABASE_URL -c "SELECT event_type, COUNT(*) FROM opensea_events WHERE created_at > NOW() - INTERVAL '1 hour' GROUP BY event_type;"
```

### Common Issues

#### RPC Connection Failures
- Check `ETHEREUM_RPC_URL` is accessible
- Verify API key hasn't hit rate limits
- Use premium RPC provider for production

#### OpenSea WebSocket Disconnections
- Service auto-reconnects with exponential backoff
- Check `OPENSEA_API_KEY` is valid
- Monitor reconnection attempts in logs

#### Missing Events
- Check block range hasn't skipped
- Verify contracts addresses are correct
- Run backfill for specific block range

## Utilities

### Backfill Historical Data
```bash
# Backfill specific block range
npm run backfill -- --from 19000000 --to 19100000

# Backfill last N blocks
npm run backfill -- --last 10000
```

### Verify ENS Name Data
```bash
# Check if name exists and data is correct
npm run verify -- vitalik.eth
```

### Resync Placeholder Names
```bash
# Resolve all token-* placeholders
cd src/scripts
node --loader tsx backfill-ens-names.ts --limit 1000
```

## Documentation

- **Architecture Details**: See `CLAUDE.md` in this directory
- **Event Schemas**: See `src/contracts/` for ABIs
- **Database Schema**: See `/services/api/prisma/schema.prisma`
