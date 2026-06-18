# Worker Service - CLAUDE.md

## Service Overview
The Worker service is an asynchronous job processing service built on pg-boss (PostgreSQL-based message queue). It handles background tasks for the Grails ENS marketplace, including order expiration, ENS metadata synchronization, ownership updates, and notification delivery.

## Technology Stack
- **Runtime**: Node.js with TypeScript
- **Queue**: pg-boss (PostgreSQL-based job queue)
- **Database**: PostgreSQL (shared with other services)
- **Email**: Nodemailer with SMTP (configurable provider)
- **Blockchain**: viem (for ENS data fetching and validation)
- **External APIs**: CoinGecko (price feeds), The Graph (ENS subgraph)
- **Logging**: Pino with pino-pretty for development

## Key Components

### Workers (`src/workers/`)

#### 1. **Expiry Worker** (`expiry.ts`)
Handles automatic expiration of listings and offers when they reach their `expires_at` timestamp.

**Two modes**:
- **Individual Jobs**: Scheduled to run at exact `expires_at` time (scheduled by API when listing/offer created)
- **Batch Job**: Runs every 5 minutes as a safety net to catch any missed expirations

**Queue**: `expire-orders`
**Batch Queue**: `batch-expire-orders` (cron: `*/5 * * * *`)

#### 2. **ENS Sync Worker** (`ens-sync.ts`)
Refreshes ENS metadata (avatar, description, social links) from the blockchain.

**Triggers**:
- Immediate sync when new listing created (published by API)
- Daily refresh for all active listings at 2 AM (scheduled job)

**Queues**:
- `sync-ens-data` - Individual sync jobs
- `schedule-daily-ens-sync` - Scheduler (cron: `0 2 * * *`)

#### 3. **Ownership Worker** (`ownership.ts`)
Processes ownership changes detected by the indexer, updating the database and cancelling invalid listings.

**Triggered by**: Indexer service when Transfer event detected

**Queue**: `update-ownership`

**Actions**:
- Updates `owner_address` in `ens_names` table
- Cancels active listings (ownership changed = seller can't fulfill)
- Publishes notification jobs to sellers about cancelled listings

#### 4. **Notification Worker** (`notifications.ts`)
Sends email notifications to users based on watchlist events.

**Triggered by**: WAL listener when database changes occur

**Queue**: `send-notification`

**Notification Types**:
- `new-listing` - New listing created for watched name
- `price-change` - Listing price updated
- `sale` - Listing sold
- `new-offer` - New offer on watched name
- `listing-cancelled-ownership-change` - Listing cancelled due to ownership transfer

#### 5. **Price Sync Worker** (`price-sync.ts`)
Fetches current ETH/USD price from CoinGecko and updates the database for USD price calculations.

**Queue**: `sync-eth-price`
**Cron**: `*/5 * * * *` (every 5 minutes)

**Actions**:
- Fetches ETH price from CoinGecko API
- Updates `eth_price` in price cache table
- Used for USD price display in frontend

#### 6. **Club Stats Worker** (`club-stats.ts`)
Calculates and updates statistics for ENS clubs (999, 10k, 100k, etc.).

**Queue**: `update-club-stats`
**Cron**: `0 * * * *` (hourly)

**Metrics Calculated**:
- Floor price (lowest active listing)
- Total listings count
- 24h sales volume
- Average sale price

#### 7. **Highest Offer Worker** (`highest-offer.ts`)
Updates the highest offer for each ENS name when offers change.

**Triggered by**: WAL listener when offers table changes

**Queue**: `update-highest-offer`

**Actions**:
- Queries max offer for ENS name
- Updates `highest_offer` in ens_names table
- Used for quick display without join queries

#### 8. **Refresh Analytics Worker** (`refresh-analytics.ts`)
Refreshes materialized views for trending and analytics data.

**Queue**: `refresh-analytics`
**Cron**: `*/15 * * * *` (every 15 minutes)

**Views Refreshed**:
- `trending_names` - Composite trending score
- `top_sales` - Recent high-value sales
- `hot_names` - Names with recent activity

#### 9. **AI Cache Cleanup Worker** (`ai-cache-cleanup.ts`)
Deletes expired rows from `ai_recommendations` to keep the cache table compact over time.

**Queue**: `cleanup-ai-recommendations`
**Cron**: `0 3 * * 0` (weekly, Sunday 3 AM UTC)

**Actions**:
- Deletes rows where `expires_at < NOW()`
- Logs count of deleted rows for observability

#### **Global Chat Retention Worker** (`global-chat-retention.ts`)
Hard-deletes **global-chat** messages older than the configured cap, to keep the room lean.

**Queue**: `cleanup-global-chat-messages`
**Cron**: `0 4 * * *` (daily, 4 AM UTC)

**Actions**:
- Reads `global_chat_config.message_retention_days` (default 30, admin-tunable)
- Deletes attached images from the bucket first (ON DELETE CASCADE would otherwise drop the rows holding the storage keys), then hard-deletes the messages in batches of 500
- Global room only; DMs/groups are untouched

#### **Chat Image Expiry Worker** (`expire-chat-images.ts`)
Expires chat images (**all** chats) past the configured age — deletes the bucket object and stamps `expired_at`, leaving the message intact.

**Queue**: `expire-chat-images`
**Cron**: `0 5 * * *` (daily, 5 AM UTC)

**Actions**:
- Reads `global_chat_config.image_retention_days` (default 180, admin-tunable)
- Keyset-cursor scan over `message_attachments WHERE expired_at IS NULL AND created_at < cutoff`; per row: `deleteFile()` then `UPDATE … SET expired_at = NOW()`
- Idempotent; failed deletes keep `expired_at` NULL and retry next run. Skips entirely if storage is not configured

### Validation Workers (`src/workers/validation/`)

These workers validate on-chain state to ensure listings and offers are still fulfillable.

#### 9. **Listing Ownership Validator** (`listing-ownership.ts`)
Validates that listing sellers still own their ENS names.

**Queue**: `validate-listing-ownership`

**Contract Calls**:
- `ENS Base Registrar.ownerOf(tokenId)` - For unwrapped names
- `ENS Name Wrapper.ownerOf(tokenId)` - For wrapped names

**Actions**:
- Cancels listings where seller no longer owns name
- Uses Multicall3 for batch validation

#### 10. **Offer Balance Validator** (`offer-balance.ts`)
Validates that offer makers have sufficient WETH balance and approval.

**Queue**: `validate-offer-balance`

**Contract Calls**:
- `WETH.balanceOf(maker)` - Check balance
- `WETH.allowance(maker, conduit)` - Check Seaport approval

**Actions**:
- Marks offers as unfunded if balance insufficient
- Reactivates offers when balance restored

#### 11. **Batch Validation Worker** (`batch-validation.ts`)
Runs periodic batch validation of all active listings and offers.

**Queue**: `batch-validate-orders`
**Cron**: `0 */6 * * *` (every 6 hours)

**Process**:
1. Fetches all active listings in batches of 100
2. Uses Multicall3 for efficient RPC calls
3. Validates ownership and expiry
4. Updates invalid listings to cancelled status

**Contract Addresses Used**:
- **Multicall3**: `0xcA11bde05977b3631167028862bE2a173976CA11`
- **ENS Name Wrapper**: `0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401`
- **ENS Base Registrar**: `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85`
- **WETH**: `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`

### Services (`src/services/`)

#### **Email Service** (`email.ts`)
Abstracts email sending via Nodemailer with SMTP, featuring pre-built templates for each notification type.

**Features**:
- Dry-run mode when `ENABLE_EMAIL=false`
- HTML email templates with unsubscribe links
- Text fallbacks for all emails
- Configurable SMTP provider (any SMTP server)

#### **Blockchain Service** (`blockchain.ts`)
Utilities for fetching ENS data from the blockchain.

**Functions**:
- `fetchENSMetadata(nameHash)` - Get resolver and text records
- `fetchENSOwner(tokenId)` - Get current owner from ENS Registrar

### Queue Client (`src/queue.ts`)
Shared pg-boss client configuration and job type definitions.

**Configuration**:
- Schema: `pgboss`
- Retry limit: 3
- Retry delay: 60 seconds with exponential backoff
- Expiry: 24 hours
- Archive: 7 days

## Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/grails

# Blockchain
RPC_URL=https://eth-mainnet.alchemyapi.io/v2/your-key
ENS_REGISTRY_ADDRESS=0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e
ENS_REGISTRAR_ADDRESS=0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85

# Email (SMTP via Nodemailer)
SMTP_SERVER=smtp.example.com
SMTP_PORT=587
SMTP_LOGIN=your_smtp_login
SMTP_PASSWORD=your_smtp_password
FROM_EMAIL=noreply@grails.market
ENABLE_EMAIL=true  # Set to false for dry-run mode

# External APIs
COINGECKO_API_KEY=your_coingecko_key  # Optional, uses free tier if not set

# Frontend URL (for email links)
FRONTEND_URL=http://localhost:3001

# Logging
LOG_LEVEL=info  # debug, info, warn, error
```

## Common Commands

```bash
# Development
npm run dev          # Start with hot reload
npm run build        # Compile TypeScript
npm start           # Production mode

# Testing
npm test            # Run tests
npm run lint        # Check code style
```

## Architecture Patterns

### Job Flow

```
1. Producer (API/Indexer/WAL) publishes job
       ↓
2. pg-boss stores in PostgreSQL (pgboss.job table)
       ↓
3. Worker polls and claims job (SKIP LOCKED)
       ↓
4. Worker processes job (with retries on failure)
       ↓
5. Job marked complete and archived (pgboss.archive)
```

### Worker Registration
All workers register on startup in `src/index.ts`:
```typescript
const boss = await getQueueClient();

// Core workers
await registerExpiryWorker(boss);
await registerBatchExpiryWorker(boss);
await registerEnsSyncWorker(boss);
await registerDailyEnsSyncScheduler(boss);
await registerOwnershipWorker(boss);
await registerNotificationWorker(boss);

// Analytics and stats workers
await registerPriceSyncWorker(boss);
await registerClubStatsWorker(boss);
await registerHighestOfferWorker(boss);
await registerRefreshAnalyticsWorker(boss);
await registerAiCacheCleanupWorker(boss);

// Validation workers
await registerListingOwnershipValidator(boss);
await registerOfferBalanceValidator(boss);
await registerBatchValidationWorker(boss);
```

### Error Handling
- **Automatic Retries**: pg-boss retries failed jobs 3 times with exponential backoff (60s, 120s, 240s)
- **Dead Letter Queue**: Jobs failing after 3 attempts move to failed state
- **Idempotency**: All workers check state before updating (e.g., don't expire if already expired)

## Integration Points

### Publishers
- **API Service**: Publishes expiry and ENS sync jobs when listings/offers created
- **Indexer Service**: Publishes ownership update jobs when Transfer events detected
- **WAL Listener**: Publishes notification jobs when database changes occur

### Database Tables
- **ens_names**: Source of truth for ENS names and ownership
- **listings**: Listings to be expired
- **offers**: Offers to be expired
- **notifications**: Log of sent notifications
- **watchlist**: User notification preferences
- **pgboss.job**: Active jobs queue (managed by pg-boss)
- **pgboss.archive**: Completed/failed jobs (managed by pg-boss)

## Monitoring

### Queue Statistics
The service logs queue statistics every 60 seconds:
```json
{
  "created": 150,
  "retry": 5,
  "active": 23,
  "completed": 9500,
  "failed": 12
}
```

### Important Metrics
- **Queue Depth**: Number of pending jobs (monitor `created` + `retry`)
- **Processing Rate**: `completed` count per minute
- **Failure Rate**: `failed` / `completed` ratio (target: < 1%)
- **Retry Rate**: `retry` / `created` ratio (target: < 5%)

### Log Levels
- `debug`: Job processing details, metadata fetched
- `info`: Jobs started/completed, workers registered
- `warn`: Non-critical errors (e.g., ENS name not found)
- `error`: Critical errors triggering retries

## Troubleshooting

### Jobs Not Processing
1. Check worker service is running: `pm2 status workers` or `docker ps`
2. Check database connection: Verify `DATABASE_URL`
3. Check pg-boss tables exist: `SELECT * FROM pgboss.job LIMIT 1`
4. Check for errors in logs: `pm2 logs workers`

### High Queue Depth
1. Check queue statistics: Monitor `created` count
2. Scale workers: Add more instances or increase `teamSize`/`teamConcurrency`
3. Check for slow jobs: Look for jobs with long processing times
4. Check external dependencies: RPC provider, email service

### Emails Not Sending
1. Check SMTP credentials are set (`SMTP_SERVER`, `SMTP_LOGIN`, `SMTP_PASSWORD`)
2. Check `ENABLE_EMAIL=true`
3. Check SMTP server logs for delivery errors
4. Test with dry-run mode (`ENABLE_EMAIL=false`) to see logs

### ENS Sync Failures
1. Check RPC provider rate limits
2. Verify `RPC_URL` is working: `curl $RPC_URL`
3. Check `ENS_REGISTRY_ADDRESS` and `ENS_REGISTRAR_ADDRESS` are correct
4. Review blockchain service logs for specific errors

## Database Queries

### View Active Jobs
```sql
SELECT name, COUNT(*) as count, state
FROM pgboss.job
WHERE state IN ('created', 'retry', 'active')
GROUP BY name, state
ORDER BY count DESC;
```

### View Failed Jobs
```sql
SELECT id, name, data, output, completed_on
FROM pgboss.archive
WHERE state = 'failed'
ORDER BY completed_on DESC
LIMIT 20;
```

### View Job Processing Times
```sql
SELECT
  name,
  AVG(EXTRACT(EPOCH FROM (completed_on - started_on))) as avg_duration_sec,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_on - started_on))) as p95_duration_sec
FROM pgboss.archive
WHERE state = 'completed'
  AND completed_on > NOW() - INTERVAL '1 hour'
GROUP BY name;
```

### Check Notification History
```sql
SELECT type, COUNT(*) as sent, DATE_TRUNC('day', sent_at) as date
FROM notifications
WHERE sent_at > NOW() - INTERVAL '7 days'
GROUP BY type, date
ORDER BY date DESC, sent DESC;
```

## Performance Tuning

### Worker Concurrency
Adjust in worker registration:
```typescript
await boss.work('queue-name', {
  teamSize: 5,        // Number of concurrent workers
  teamConcurrency: 2  // Jobs per worker (total = 5 * 2 = 10)
}, handler);
```

### Batch Size
For batch operations (daily ENS sync):
```typescript
// Process in batches of 100
const jobs = result.rows.map(row => ({ name: 'sync-ens-data', data: {...} }));
await boss.insert(jobs); // pg-boss batches internally
```

### RPC Rate Limiting
```typescript
// In blockchain service, add delay between calls
await Promise.all(
  names.map((name, i) =>
    new Promise(resolve =>
      setTimeout(() => resolve(fetchENSMetadata(name)), i * 100)
    )
  )
);
```

## Security Considerations
- **Database Credentials**: Never commit `.env` files
- **SMTP Credentials**: Use app-specific passwords, rotate regularly
- **Rate Limiting**: Respect external API limits (RPC, CoinGecko)
- **Input Validation**: All job data is validated before processing
- **SQL Injection**: Use parameterized queries exclusively

## Deployment

### Docker
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY dist ./dist
CMD ["node", "dist/index.js"]
```

### PM2
```bash
pm2 start dist/index.js --name workers --instances 1
pm2 save
pm2 startup
```

### Kubernetes
```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: grails-workers
spec:
  replicas: 2
  template:
    spec:
      containers:
      - name: workers
        image: grails/workers:latest
        env:
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: grails-secrets
              key: database-url
```

## Testing

### Unit Tests
```bash
npm test
```

### Integration Tests
Test with real PostgreSQL:
```bash
npm run test:integration
```

### Manual Testing
Publish test jobs:
```typescript
import { getQueueClient } from './queue';

const boss = await getQueueClient();

// Test expiry worker
await boss.send('expire-orders', {
  type: 'listing',
  id: 123
});

// Test notification worker
await boss.send('send-notification', {
  type: 'new-listing',
  userId: 1,
  ensNameId: 456,
  metadata: { priceWei: '1000000000000000000' }
});
```

## Future Enhancements
- [ ] Webhook notifications (in addition to email)
- [ ] SMS notifications via Twilio
- [ ] Batch email sending (reduce SendGrid API calls)
- [ ] Queue priority (high-priority listings get faster processing)
- [ ] Job scheduling UI (view/manage scheduled jobs)
- [ ] Worker autoscaling based on queue depth
- [ ] Metrics export to Prometheus/Grafana
- [ ] Custom retry strategies per job type
