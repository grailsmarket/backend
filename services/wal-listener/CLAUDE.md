# WAL Listener Service - CLAUDE.md

## Service Overview
The WAL (Write-Ahead Log) Listener service monitors PostgreSQL's logical replication stream to detect database changes in real-time. It processes these changes and can trigger actions, send notifications, or sync data to other systems.

## Technology Stack
- **Runtime**: Node.js with TypeScript
- **Database**: PostgreSQL with logical replication
- **WAL Decoding**: pg-logical-replication
- **Message Queue**: Optional (Redis/RabbitMQ for event distribution)
- **WebSocket**: For real-time client notifications

## Key Components

### WAL Monitoring (`src/services/`)
- **Replication Slot**: Creates and manages PostgreSQL replication slot
- **Change Stream**: Processes INSERT, UPDATE, DELETE operations
- **Event Parser**: Decodes WAL entries into structured events
- **Action Dispatcher**: Routes changes to appropriate handlers

### Change Handlers
- **Listing Changes**: Updates cache, notifies clients
- **Offer Changes**: Triggers notifications to sellers
- **ENS Updates**: Syncs ownership changes
- **Event Logging**: Archives all changes for audit

### Important Files
- `src/index.ts` - Main service entry point
- `src/services/wal-processor.ts` - Core WAL processing logic
- `src/services/change-handlers.ts` - Database change handlers
- `src/utils/replication.ts` - PostgreSQL replication utilities
- `src/config/tables.ts` - Monitored table configurations

## Environment Variables
```env
DATABASE_URL=postgresql://user:password@localhost:5432/grails
REPLICATION_SLOT=grails_wal_slot
PUBLICATION_NAME=grails_publication
WAL_SENDER_TIMEOUT=60000
HEARTBEAT_INTERVAL=30000
REDIS_URL=redis://localhost:6379  # Optional
WEBSOCKET_PORT=3003               # Optional
```

## Common Commands
```bash
# Development
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm start           # Production mode

# WAL Management
npm run wal:setup    # Create replication slot and publication
npm run wal:status   # Check replication status
npm run wal:reset    # Reset WAL position
npm run wal:drop     # Remove replication slot
```

## PostgreSQL Setup

### 1. Enable Logical Replication
```sql
-- In postgresql.conf
wal_level = logical
max_replication_slots = 4
max_wal_senders = 4
```

### 2. Create Publication
```sql
CREATE PUBLICATION grails_publication FOR TABLE
  listings, offers, ens_names, opensea_events;
```

### 3. Create Replication Slot
```sql
SELECT pg_create_logical_replication_slot('grails_wal_slot', 'pgoutput');
```

## Change Event Structure
```typescript
interface WalChangeEvent {
  operation: 'INSERT' | 'UPDATE' | 'DELETE';
  schema: string;
  table: string;
  timestamp: Date;
  old: Record<string, any> | null;
  new: Record<string, any> | null;
  changed_columns?: string[];
}
```

## Event Processing Flow
1. PostgreSQL writes change to WAL
2. WAL Listener receives change via replication protocol
3. Change is decoded and parsed
4. Relevant handler is invoked based on table/operation
5. Actions are executed (notifications, cache updates, etc.)
6. Change is acknowledged to PostgreSQL

## Monitored Tables & Actions

### listings
- **INSERT**: Notify subscribers of new listing
- **UPDATE**: Update cache, notify if price changed
- **DELETE**: Remove from cache, notify watchers

### offers
- **INSERT**: Notify seller of new offer
- **UPDATE**: Update offer status in cache
- **DELETE**: Clean up expired offers

### ens_names
- **UPDATE**: Sync ownership changes, update listings

### opensea_events
- **INSERT**: Process OpenSea event, update related records

## Performance Considerations
- Batch processing of changes when possible
- Async/parallel execution of handlers
- Connection pooling for database operations
- Rate limiting for external notifications
- Dead letter queue for failed events

## Integration Points
- **Database**: Direct PostgreSQL replication connection
- **API Service**: Cache invalidation endpoints
- **Frontend**: WebSocket notifications
- **External Services**: Webhooks for events

## Error Handling
- Automatic reconnection on connection loss
- Exponential backoff for retries
- Dead letter queue for persistent failures
- Comprehensive error logging
- Health check endpoints

## Monitoring & Metrics
```bash
# Check replication lag
npm run metrics:lag

# View processing stats
npm run metrics:stats

# Monitor error rate
npm run metrics:errors

# Check handler performance
npm run metrics:handlers
```

## Troubleshooting

### Common Issues
1. **Replication Lag**: Increase wal_sender_timeout
2. **Slot Growth**: Ensure regular acknowledgments
3. **Connection Drops**: Check network and PostgreSQL logs
4. **High Memory**: Tune batch size and processing rate

### Recovery Procedures
```bash
# Reset stuck replication slot
npm run wal:reset --force

# Replay from specific LSN
npm run wal:replay --lsn=0/17D5A48

# Skip problematic transaction
npm run wal:skip --xid=12345
```

## Security Considerations
- Use SSL for replication connection
- Implement row-level security if needed
- Sanitize data before external transmission
- Rate limit client connections
- Validate all change events

## Testing
```bash
# Run unit tests
npm test

# Integration tests with test database
npm run test:integration

# Load testing
npm run test:load

# Simulate WAL events
npm run test:simulate
```