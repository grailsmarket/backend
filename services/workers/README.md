# Grails Workers Service

Asynchronous job processing service for the Grails ENS marketplace, built on pg-boss (PostgreSQL-based message queue).

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

1. **Expires Orders**: Automatically expires listings and offers at their expiration time
2. **Syncs ENS Metadata**: Fetches avatars, descriptions, and social links from blockchain
3. **Updates Ownership**: Processes ownership transfers and cancels invalid listings
4. **Sends Notifications**: Email alerts for watchlist events
5. **Resolves Names**: Converts placeholder names (token-*) to actual ENS names

## Workers

### Expiry Worker
- **Purpose**: Expire listings and offers at exact time
- **Queues**: `expire-orders` (individual), `batch-expire-orders` (cron every 5 min)
- **Triggers**: Scheduled when listing/offer created, plus batch safety net

### ENS Sync Worker
- **Purpose**: Refresh ENS metadata (avatar, description, social links)
- **Queues**: `sync-ens-data` (individual), `schedule-daily-ens-sync` (daily at 2 AM)
- **Triggers**: New listing created, daily refresh for all active listings
- **Data Sources**: ENS Resolver contracts, The Graph API, EFP API

### Ownership Worker
- **Purpose**: Process ownership transfers from blockchain
- **Queue**: `update-ownership`
- **Triggers**: Indexer detects Transfer event
- **Actions**: Updates owner_address, cancels invalid listings, notifies sellers

### Notification Worker
- **Purpose**: Send email notifications for watchlist events
- **Queue**: `send-notification`
- **Triggers**: Database changes detected by WAL Listener
- **Types**: new-listing, price-change, sale, new-offer, listing-cancelled

### Name Resolution Worker (Optional)
- **Purpose**: Resolve placeholder names to actual ENS names
- **Queue**: `resolve-name`
- **Source**: The Graph ENS subgraph

## Expiration Handling

### ENS Name Expiration
- **Source**: ENS Registrar contract `expiry_date`
- **Calculated Fields**:
  - `is_expired`: Current date > expiry_date
  - `is_grace_period`: 0-90 days past expiry (can still renew)
  - `is_premium_period`: 90-2555 days past expiry (Dutch auction)
  - `days_until_expiry`: Days remaining (negative if expired)
- **Updates**: Indexer reads from blockchain, stores in ens_names table
- **Search Filters**: API and WAL Listener calculate derived fields for Elasticsearch

### Listing/Offer Expiration
- **Source**: User-specified `expires_at` when creating listing/offer
- **Default**: 30 days from creation if not specified
- **Processing**:
  - Individual jobs scheduled for exact expiration time
  - Batch job runs every 5 minutes to catch missed expirations
- **Action**: Updates status to 'expired', removes from search index

## Required Environment Variables

```env
# Database (required)
DATABASE_URL=postgresql://user:password@localhost:5432/grails

# Blockchain (for ENS sync)
ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/your-key
ENS_REGISTRY_ADDRESS=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85

# Email (optional - dry-run mode without)
SENDGRID_API_KEY=your_sendgrid_api_key
FROM_EMAIL=noreply@grails.market
ENABLE_EMAIL=true

# URLs
FRONTEND_URL=http://localhost:3000  # For email links

# The Graph (for name resolution)
GRAPH_ENS_SUBGRAPH_URL=https://api.thegraph.com/subgraphs/name/ensdomains/ens

# Logging
LOG_LEVEL=info  # debug, info, warn, error
```

## Monitoring

### Queue Statistics
Logged every 60 seconds:
```json
{
  "created": 150,    // Pending jobs
  "retry": 5,        // Retrying after failure
  "active": 23,      // Currently processing
  "completed": 9500, // Successfully completed
  "failed": 12       // Failed after 3 retries
}
```

### Database Queries
```sql
-- View active jobs by queue
SELECT name, COUNT(*) as count, state
FROM pgboss.job
WHERE state IN ('created', 'retry', 'active')
GROUP BY name, state
ORDER BY count DESC;

-- View failed jobs
SELECT id, name, data, output, completed_on
FROM pgboss.archive
WHERE state = 'failed'
ORDER BY completed_on DESC
LIMIT 20;

-- View job processing times
SELECT
  name,
  AVG(EXTRACT(EPOCH FROM (completed_on - started_on))) as avg_duration_sec
FROM pgboss.archive
WHERE state = 'completed'
  AND completed_on > NOW() - INTERVAL '1 hour'
GROUP BY name;
```

## Job Publishers

### API Service
- Publishes `expire-orders` when listing/offer created
- Publishes `sync-ens-data` when listing created

### Indexer Service
- Publishes `update-ownership` when Transfer event detected

### WAL Listener
- Publishes `send-notification` when database changes occur

## Documentation

- **Complete Reference**: See `CLAUDE.md` in this directory
- **Queue Configuration**: See `src/queue.ts`
- **Email Templates**: See `src/services/email.ts`

## Architecture

```
Producers                    Queue                Workers               Actions
─────────────────────────────────────────────────────────────────────────────
API Service      ─┐
Indexer Service  ─┤──► pg-boss (PostgreSQL) ──► Worker Processes ──► Database
WAL Listener     ─┘                                                   Email
                                                                      Blockchain
```

**Benefits of pg-boss:**
- No separate message broker (Redis/RabbitMQ) needed
- ACID guarantees via PostgreSQL
- Automatic retries with exponential backoff
- Job archiving for audit trail
- Cron-like scheduling built-in

## Common Issues

### Jobs Not Processing
1. Check worker service is running
2. Verify database connection
3. Check for errors in logs
4. Verify pg-boss tables exist: `SELECT * FROM pgboss.job LIMIT 1`

### High Queue Depth
1. Check queue statistics for backlog
2. Scale workers (increase instances or concurrency)
3. Check for slow external APIs (RPC, SendGrid)
4. Verify database performance

### Emails Not Sending
1. Check `SENDGRID_API_KEY` is set
2. Verify `ENABLE_EMAIL=true`
3. Check SendGrid dashboard for bounces/errors
4. Test with dry-run mode (logs emails without sending)

### ENS Sync Failures
1. Check RPC provider rate limits
2. Verify `ETHEREUM_RPC_URL` is accessible
3. Check contract addresses are correct
4. Review blockchain service logs

## Testing

```bash
# Run tests
npm test

# Manual job publishing (for testing)
node -e "
const { getQueueClient } = require('./dist/queue');
const boss = await getQueueClient();
await boss.send('expire-orders', { type: 'listing', id: 123 });
console.log('Job published!');
await boss.stop();
"
```
