# Message Queue System - Product Requirements Document

## Document Information
**Version**: 1.0
**Date**: October 7, 2025
**Status**: Draft
**Author**: System Architecture Team

---

## Executive Summary

This PRD outlines the implementation of a message queue and async worker system to address four critical asynchronous processing challenges in the Grails ENS marketplace:

1. **Expiry Management**: Invalidating expired listings and offers
2. **ENS Data Sync**: Asynchronously updating ENS metadata and records
3. **Ownership Tracking**: Monitoring and updating ENS name ownership changes
4. **Notification System**: Sending email/webhook notifications for watchlist events

After analyzing various message queue solutions (Kafka, RabbitMQ, BullMQ, pg-boss), **we recommend pg-boss as the optimal solution** for this project due to its PostgreSQL-native architecture, minimal operational overhead, and perfect alignment with our existing infrastructure.

---

## Problem Statement

### Current Pain Points

1. **Expired Orders**: Listings and offers with `expires_at` timestamps remain in `active`/`pending` status indefinitely, causing stale data in search results and API responses
2. **ENS Data Freshness**: ENS metadata (resolver, text records, avatar) becomes stale and requires periodic refresh
3. **Ownership Drift**: Ownership changes happening off-platform aren't immediately reflected in our database
4. **Missing Notifications**: Users watching specific ENS names don't receive notifications when events occur (new listings, sales, offers)

### Business Impact

- **Poor UX**: Users see expired listings that can't be fulfilled
- **Data Integrity**: Stale ownership and metadata reduces trust
- **Missed Engagement**: Lack of notifications reduces user retention
- **Manual Overhead**: No automated cleanup requires manual intervention

---

## Goals & Success Metrics

### Primary Goals

1. Automatically expire listings/offers within 1 minute of their `expires_at` timestamp
2. Refresh ENS metadata for active listings every 24 hours
3. Detect ownership changes within 5 minutes of blockchain confirmation
4. Send watchlist notifications within 30 seconds of triggering events

### Success Metrics

- **Expiry Accuracy**: 99%+ of expired orders marked expired within 1 minute
- **Data Freshness**: ENS metadata no older than 24 hours for active listings
- **Ownership Sync**: Ownership changes detected within 5 minutes (99th percentile)
- **Notification Reliability**: 99.9%+ delivery rate for watchlist notifications
- **System Performance**: Message processing latency < 100ms (p95)
- **Queue Health**: Dead letter queue < 0.1% of total messages

---

## Solution Architecture

### Recommended Approach: **pg-boss**

**Rationale**:
- ✅ Uses existing PostgreSQL database (no additional infrastructure)
- ✅ Leverages PostgreSQL's SKIP LOCKED for reliable queue semantics
- ✅ Exactly-once delivery guarantees with atomic commits
- ✅ Simple operational model (just PostgreSQL to monitor)
- ✅ Built-in job scheduling, retries, and dead-letter queue
- ✅ TypeScript-friendly API
- ✅ Mature and battle-tested (6+ years production use)

**Why Not Kafka?**
- ❌ Overkill for our use case (Kafka excels at event streaming, not job queues)
- ❌ Requires separate Kafka cluster infrastructure
- ❌ Operational complexity (Zookeeper/KRaft, broker management)
- ❌ No native scheduled job support (would need external scheduler)
- ❌ Kafka doesn't support delayed/scheduled delivery natively

**Why Not RabbitMQ/BullMQ?**
- ❌ Requires Redis or RabbitMQ infrastructure (additional services to manage)
- ❌ Increases operational complexity (more systems to monitor)
- ❌ Data split across PostgreSQL + Redis/RabbitMQ (consistency challenges)

**Why Not pg_cron?**
- ❌ Limited to time-based scheduling (no event-driven jobs)
- ❌ No built-in retry logic or dead-letter queue
- ❌ Requires superuser privileges for setup
- ❌ Not suitable for high-frequency job processing

---

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         PostgreSQL                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐         │
│  │  ens_names   │  │   listings   │  │  watchlist   │         │
│  └──────────────┘  └──────────────┘  └──────────────┘         │
│  ┌──────────────────────────────────────────────────┐          │
│  │           pg-boss Job Queue Tables               │          │
│  │  (job, archive, schedule, subscription)          │          │
│  └──────────────────────────────────────────────────┘          │
└─────────────────────────────────────────────────────────────────┘
                              ▲
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐     ┌──────────────┐
│   Producer   │      │   Producer   │     │   Producer   │
│ (API Service)│      │  (Indexer)   │     │(WAL Listener)│
└──────────────┘      └──────────────┘     └──────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  Worker Service  │
                    │   (New Service)  │
                    └──────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐     ┌──────────────┐
│Expiry Worker │      │ Sync Worker  │     │Notify Worker │
│ (invalidate) │      │ (ENS data)   │     │  (emails)    │
└──────────────┘      └──────────────┘     └──────────────┘
```

### Component Overview

#### 1. **pg-boss Job Queue** (PostgreSQL Extension)
- Central job queue using PostgreSQL tables
- Handles job scheduling, retries, and archiving
- Provides at-least-once delivery with exactly-once processing

#### 2. **Producer Services** (Existing Services)
- **API Service**: Publishes jobs when listings/offers created
- **Indexer Service**: Publishes jobs when blockchain events detected
- **WAL Listener**: Publishes jobs when database changes occur

#### 3. **Worker Service** (New Service: `/services/workers`)
- Dedicated Node.js service for processing async jobs
- Runs multiple worker handlers concurrently
- Stateless and horizontally scalable

#### 4. **Worker Handlers** (Job Processors)
- **Expiry Worker**: Marks expired listings/offers
- **ENS Sync Worker**: Refreshes ENS metadata from blockchain
- **Ownership Worker**: Updates owner addresses
- **Notification Worker**: Sends emails/webhooks for watchlist events

---

## Detailed Design

### 1. Expiry Management Worker

#### Job Definition
```typescript
{
  name: 'expire-orders',
  data: {
    type: 'listing' | 'offer',
    scheduledFor: Date  // When to run the expiry check
  }
}
```

#### Producer Logic
**Trigger**: When listing/offer created via API
```typescript
// In API service - after creating listing
if (listing.expires_at) {
  await boss.schedule(
    'expire-orders',
    { type: 'listing', listingId: listing.id },
    { startAfter: new Date(listing.expires_at) }
  );
}
```

#### Worker Logic
```typescript
// In worker service
boss.work('expire-orders', async (job) => {
  const { type, listingId } = job.data;

  if (type === 'listing') {
    await pool.query(`
      UPDATE listings
      SET status = 'expired', updated_at = NOW()
      WHERE id = $1
        AND status = 'active'
        AND expires_at <= NOW()
    `, [listingId]);
  }

  // Similar for offers
});
```

#### Implementation Details
- **Scheduling**: Use pg-boss `schedule()` to delay job until `expires_at`
- **Idempotency**: Check current status before updating (handle race conditions)
- **Batch Processing**: Optional batch job to catch any missed expirations daily
- **Monitoring**: Track percentage of on-time expirations

#### Alternative Approach: Scheduled Batch Job
```typescript
// Run every 5 minutes to expire overdue orders
boss.schedule('batch-expire-orders', null, {
  cron: '*/5 * * * *'  // Every 5 minutes
});

boss.work('batch-expire-orders', async () => {
  // Expire all overdue listings
  const result = await pool.query(`
    UPDATE listings
    SET status = 'expired', updated_at = NOW()
    WHERE status = 'active'
      AND expires_at <= NOW()
    RETURNING id
  `);

  // Expire all overdue offers
  await pool.query(`
    UPDATE offers
    SET status = 'expired'
    WHERE status = 'pending'
      AND expires_at <= NOW()
  `);

  console.log(`Expired ${result.rowCount} listings and offers`);
});
```

**Recommendation**: Use **both approaches**:
- Individual scheduled jobs for precision (expire within 1 minute)
- Batch job as safety net (catches any missed jobs every 5 minutes)

---

### 2. ENS Data Sync Worker

#### Job Definition
```typescript
{
  name: 'sync-ens-data',
  data: {
    ensNameId: number,
    nameHash: string,
    priority: 'high' | 'normal'  // High for active listings
  }
}
```

#### Producer Logic
**Trigger**: Multiple sources
1. When new listing created (immediate sync)
2. Scheduled daily refresh for all active listings
3. Manual refresh requested by user

```typescript
// Immediate sync when listing created
await boss.send('sync-ens-data', {
  ensNameId: ensName.id,
  nameHash: ensName.token_id,
  priority: 'high'
});

// Daily refresh job for all active listings
boss.schedule('schedule-daily-ens-sync', null, {
  cron: '0 2 * * *'  // 2 AM daily
});

boss.work('schedule-daily-ens-sync', async () => {
  const activeListings = await pool.query(`
    SELECT DISTINCT en.id, en.token_id
    FROM ens_names en
    JOIN listings l ON l.ens_name_id = en.id
    WHERE l.status = 'active'
  `);

  for (const ens of activeListings.rows) {
    await boss.send('sync-ens-data', {
      ensNameId: ens.id,
      nameHash: ens.token_id,
      priority: 'normal'
    });
  }
});
```

#### Worker Logic
```typescript
boss.work('sync-ens-data', async (job) => {
  const { ensNameId, nameHash } = job.data;

  // Fetch ENS data from blockchain via ethers.js
  const resolver = await ensRegistry.resolver(nameHash);
  const metadata = {
    avatar: await resolver.getText('avatar'),
    description: await resolver.getText('description'),
    url: await resolver.getText('url'),
    twitter: await resolver.getText('com.twitter'),
    github: await resolver.getText('com.github'),
  };

  // Update database
  await pool.query(`
    UPDATE ens_names
    SET metadata = $1, updated_at = NOW()
    WHERE id = $2
  `, [JSON.stringify(metadata), ensNameId]);
});
```

#### Implementation Details
- **Rate Limiting**: Respect RPC provider limits (batch in groups of 100)
- **Retry Logic**: pg-boss automatic retries with exponential backoff
- **Priority Queues**: Process high-priority (active listings) before normal
- **Caching**: Cache resolver addresses to reduce RPC calls

---

### 3. Ownership Update Worker

#### Job Definition
```typescript
{
  name: 'update-ownership',
  data: {
    ensNameId: number,
    newOwner: string,
    blockNumber: number,
    transactionHash: string
  }
}
```

#### Producer Logic
**Trigger**: Indexer detects Transfer event

```typescript
// In indexer service - when Transfer event detected
const transferHandler = async (event) => {
  await boss.send('update-ownership', {
    ensNameId: ensName.id,
    newOwner: event.args.to,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash
  });
};
```

#### Worker Logic
```typescript
boss.work('update-ownership', async (job) => {
  const { ensNameId, newOwner, transactionHash } = job.data;

  // Begin transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update ownership
    await client.query(`
      UPDATE ens_names
      SET owner_address = $1,
          last_transfer_date = NOW(),
          updated_at = NOW()
      WHERE id = $2
    `, [newOwner.toLowerCase(), ensNameId]);

    // Cancel any active listings (owner changed, listings invalid)
    const cancelledListings = await client.query(`
      UPDATE listings
      SET status = 'cancelled', updated_at = NOW()
      WHERE ens_name_id = $1
        AND status = 'active'
      RETURNING id, seller_address
    `, [ensNameId]);

    // Publish notification jobs for cancelled listings
    for (const listing of cancelledListings.rows) {
      await boss.send('send-notification', {
        type: 'listing-cancelled-ownership-change',
        recipientAddress: listing.seller_address,
        ensNameId,
        transactionHash
      });
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
});
```

#### Implementation Details
- **Transaction Safety**: Use database transactions for atomic updates
- **Cascade Effects**: Cancel listings, notify sellers
- **Deduplication**: Check if ownership already matches (idempotent)
- **Reorg Handling**: Compare block numbers to handle chain reorganizations

#### Integration with Existing Indexer

**Option A: Keep Indexer Sync, Add Worker Processing**
```typescript
// Indexer still updates database directly for ownership
// Worker handles side effects (notifications, listing cancellations)
```

**Option B: Move All Processing to Workers**
```typescript
// Indexer only publishes events to queue
// Worker handles all database updates
// Better separation of concerns, easier to scale
```

**Recommendation**: **Option A** for initial implementation (less risky), migrate to Option B in v2.

---

### 4. Notification Worker

#### Job Definition
```typescript
{
  name: 'send-notification',
  data: {
    type: 'new-listing' | 'price-change' | 'sale' | 'new-offer',
    ensNameId: number,
    triggeredBy: string,  // Address that triggered event
    metadata: Record<string, any>
  }
}
```

#### Producer Logic
**Trigger**: WAL Listener detects relevant changes

```typescript
// In WAL listener - when new listing detected
walListener.on('insert', async (change) => {
  if (change.table === 'listings') {
    const listing = change.new;

    // Find all users watching this ENS name
    const watchers = await pool.query(`
      SELECT w.user_id, u.email, w.notify_on_listing
      FROM watchlist w
      JOIN users u ON u.id = w.user_id
      WHERE w.ens_name_id = $1
        AND w.notify_on_listing = true
    `, [listing.ens_name_id]);

    // Publish notification job for each watcher
    for (const watcher of watchers.rows) {
      await boss.send('send-notification', {
        type: 'new-listing',
        userId: watcher.user_id,
        email: watcher.email,
        ensNameId: listing.ens_name_id,
        metadata: {
          priceWei: listing.price_wei,
          sellerAddress: listing.seller_address
        }
      });
    }
  }
});
```

#### Worker Logic
```typescript
boss.work('send-notification', async (job) => {
  const { type, userId, email, ensNameId, metadata } = job.data;

  // Fetch ENS name details
  const ensName = await pool.query(
    'SELECT name FROM ens_names WHERE id = $1',
    [ensNameId]
  );

  // Build email based on notification type
  const emailContent = buildEmailTemplate(type, {
    ensName: ensName.rows[0].name,
    ...metadata
  });

  // Send email via SMTP/SendGrid/SES
  await emailService.send({
    to: email,
    subject: `${ensName.rows[0].name} - ${getSubject(type)}`,
    html: emailContent
  });

  // Log notification in database
  await pool.query(`
    INSERT INTO notifications (user_id, type, ens_name_id, sent_at)
    VALUES ($1, $2, $3, NOW())
  `, [userId, type, ensNameId]);
});
```

#### Implementation Details
- **Email Service**: Use SendGrid, AWS SES, or Resend.com
- **Rate Limiting**: Batch emails, respect provider limits (max 10/sec)
- **Unsubscribe**: Include unsubscribe link in all emails
- **Retry Logic**: Retry failed sends with exponential backoff
- **Deduplication**: Track sent notifications to prevent duplicates
- **User Preferences**: Respect notification preferences (email vs webhook)

#### Notification Types & Triggers

| Event | Trigger | Watchlist Setting | Template |
|-------|---------|-------------------|----------|
| New Listing | INSERT into listings | `notify_on_listing` | "🏷️ {name} is now listed for {price} ETH" |
| Price Change | UPDATE listings.price_wei | `notify_on_price_change` | "💰 {name} price changed to {newPrice} ETH" |
| Sale | UPDATE listings.status = sold | `notify_on_sale` | "✅ {name} was sold for {price} ETH" |
| New Offer | INSERT into offers | `notify_on_offer` | "💬 New offer on {name}: {amount} ETH" |

---

## Database Schema Changes

### New Tables

#### 1. notifications table
```sql
CREATE TABLE IF NOT EXISTS notifications (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    type VARCHAR(50) NOT NULL,
    ens_name_id INTEGER REFERENCES ens_names(id) ON DELETE CASCADE,
    metadata JSONB DEFAULT '{}',
    sent_at TIMESTAMP DEFAULT NOW(),
    read_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, sent_at DESC);
CREATE INDEX idx_notifications_read ON notifications(user_id, read_at) WHERE read_at IS NULL;
```

#### 2. pg-boss tables (auto-created)
pg-boss automatically creates these tables on initialization:
- `pgboss.job` - Active jobs
- `pgboss.archive` - Completed/failed jobs
- `pgboss.schedule` - Scheduled jobs
- `pgboss.subscription` - Worker subscriptions

### Schema Modifications

#### Add expires_at index
```sql
-- Optimize expiry queries
CREATE INDEX IF NOT EXISTS idx_listings_expires_at
ON listings(expires_at)
WHERE status = 'active' AND expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_offers_expires_at
ON offers(expires_at)
WHERE status = 'pending' AND expires_at IS NOT NULL;
```

#### Add watchlist table (if not exists)
```sql
CREATE TABLE IF NOT EXISTS watchlist (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    ens_name_id INTEGER REFERENCES ens_names(id) ON DELETE CASCADE,
    notify_on_sale BOOLEAN DEFAULT true,
    notify_on_listing BOOLEAN DEFAULT true,
    notify_on_offer BOOLEAN DEFAULT true,
    notify_on_price_change BOOLEAN DEFAULT false,
    added_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(user_id, ens_name_id)
);

CREATE INDEX idx_watchlist_user ON watchlist(user_id);
CREATE INDEX idx_watchlist_ens_name ON watchlist(ens_name_id);
```

---

## Service Implementation

### New Service: `/services/workers`

#### Directory Structure
```
services/workers/
├── src/
│   ├── index.ts              # Main entry point
│   ├── queue.ts              # pg-boss client setup
│   ├── workers/
│   │   ├── expiry.ts         # Expiry worker
│   │   ├── ens-sync.ts       # ENS data sync worker
│   │   ├── ownership.ts      # Ownership update worker
│   │   └── notifications.ts  # Notification worker
│   ├── services/
│   │   ├── email.ts          # Email service abstraction
│   │   └── blockchain.ts     # Blockchain RPC helpers
│   └── utils/
│       ├── logger.ts
│       └── metrics.ts
├── package.json
├── tsconfig.json
└── CLAUDE.md
```

#### package.json
```json
{
  "name": "@grails/workers",
  "version": "1.0.0",
  "dependencies": {
    "pg-boss": "^10.0.0",
    "ethers": "^6.9.0",
    "@sendgrid/mail": "^8.0.0",
    "pino": "^8.17.2"
  }
}
```

#### Main Entry Point (src/index.ts)
```typescript
import PgBoss from 'pg-boss';
import { config } from '../../shared/src';
import { registerExpiryWorker } from './workers/expiry';
import { registerEnsSyncWorker } from './workers/ens-sync';
import { registerOwnershipWorker } from './workers/ownership';
import { registerNotificationWorker } from './workers/notifications';
import { logger } from './utils/logger';

async function start() {
  const boss = new PgBoss({
    connectionString: config.database.url,
    schema: 'pgboss',
    max: 10,
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    expireInHours: 24,
    archiveCompletedAfterSeconds: 60 * 60 * 24 * 7, // 7 days
  });

  boss.on('error', (error) => logger.error('pg-boss error:', error));
  boss.on('monitor-states', (states) => {
    logger.info('Queue metrics:', {
      created: states.created,
      retry: states.retry,
      active: states.active,
      completed: states.completed,
      failed: states.failed,
    });
  });

  await boss.start();
  logger.info('pg-boss started successfully');

  // Register all workers
  await registerExpiryWorker(boss);
  await registerEnsSyncWorker(boss);
  await registerOwnershipWorker(boss);
  await registerNotificationWorker(boss);

  logger.info('All workers registered');

  // Graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down workers...');
    await boss.stop({ graceful: true, timeout: 30000 });
    process.exit(0);
  });
}

start().catch((error) => {
  logger.error('Fatal error:', error);
  process.exit(1);
});
```

---

## Integration with Existing Services

### API Service Integration

**Install pg-boss**:
```bash
cd services/api
npm install pg-boss
```

**Create queue client** (`services/api/src/queue.ts`):
```typescript
import PgBoss from 'pg-boss';
import { config } from '../../shared/src';

let boss: PgBoss | null = null;

export async function getQueueClient(): Promise<PgBoss> {
  if (!boss) {
    boss = new PgBoss({
      connectionString: config.database.url,
      schema: 'pgboss',
    });
    await boss.start();
  }
  return boss;
}
```

**Publish jobs** when listing created:
```typescript
// In services/api/src/routes/listings.ts
import { getQueueClient } from '../queue';

fastify.post('/', async (request, reply) => {
  // ... create listing ...

  const boss = await getQueueClient();

  // Schedule expiry job
  if (listing.expires_at) {
    await boss.schedule('expire-orders',
      { type: 'listing', listingId: listing.id },
      { startAfter: new Date(listing.expires_at) }
    );
  }

  // Trigger immediate ENS sync
  await boss.send('sync-ens-data', {
    ensNameId: listing.ens_name_id,
    priority: 'high'
  });

  // Return response
});
```

### Indexer Service Integration

**Publish ownership jobs**:
```typescript
// In services/indexer/src/indexers/ens-indexer.ts
import { getQueueClient } from '../queue';

async handleTransferEvent(event: TransferEvent) {
  // Update database
  await pool.query(/* ... */);

  // Publish ownership update job
  const boss = await getQueueClient();
  await boss.send('update-ownership', {
    ensNameId: ensName.id,
    newOwner: event.args.to,
    blockNumber: event.blockNumber,
    transactionHash: event.transactionHash
  });
}
```

### WAL Listener Integration

**Publish notification jobs**:
```typescript
// In services/wal-listener/src/services/wal-listener.ts
import { getQueueClient } from '../queue';

async handleInsert(change: WALChange) {
  if (change.table === 'listings') {
    const boss = await getQueueClient();

    // Find watchers
    const watchers = await pool.query(/* ... */);

    // Publish notification jobs
    for (const watcher of watchers.rows) {
      await boss.send('send-notification', {
        type: 'new-listing',
        userId: watcher.user_id,
        // ...
      });
    }
  }
}
```

---

## Deployment & Operations

### Deployment Strategy

#### Phase 1: Worker Service Deployment (Week 1)
1. Deploy new `workers` service to staging
2. Run alongside existing services (no producers yet)
3. Validate pg-boss tables created correctly
4. Test worker handlers with manual job insertion

#### Phase 2: Expiry Worker (Week 2)
1. Deploy API changes to publish expiry jobs
2. Monitor job processing in staging
3. Run batch expiry job in parallel for safety
4. Deploy to production with feature flag

#### Phase 3: ENS Sync Worker (Week 3)
1. Deploy ENS sync worker
2. Backfill sync jobs for existing active listings
3. Monitor RPC usage and rate limits
4. Deploy scheduled daily sync

#### Phase 4: Ownership & Notifications (Week 4)
1. Deploy indexer integration
2. Deploy WAL listener integration
3. Test end-to-end notification flow
4. Enable for beta users first

### Infrastructure Requirements

#### PostgreSQL
- **Disk Space**: +5GB for pg-boss tables (assuming 1M jobs/month)
- **Connections**: +10 connections for worker service
- **Extensions**: None (pg-boss uses pure SQL)

#### Worker Service
- **CPU**: 2 vCPUs
- **Memory**: 2GB RAM
- **Instances**: Start with 1, scale to 3 for high availability
- **Autoscaling**: Based on queue depth (>1000 jobs = scale up)

#### External Services
- **Email**: SendGrid/AWS SES account (50k emails/month free tier)
- **Monitoring**: Existing logging infrastructure

### Monitoring & Alerting

#### Key Metrics

**Queue Health**:
- Queue depth by job type
- Job processing rate (jobs/minute)
- Average processing time per job type
- Retry rate (< 5% target)
- Dead letter queue size (alert if > 10)

**Worker Performance**:
- CPU/memory usage per worker
- Worker uptime
- Job success/failure rate
- Processing latency (p50, p95, p99)

**Business Metrics**:
- Orders expired on-time (target: 99%)
- ENS metadata freshness (target: < 24h)
- Notification delivery rate (target: 99.9%)
- Average notification delay (target: < 30s)

#### Alerts

| Alert | Condition | Severity | Action |
|-------|-----------|----------|--------|
| High Queue Depth | >5000 pending jobs | Warning | Scale workers |
| Dead Letter Queue | >50 failed jobs | Critical | Investigate failures |
| Worker Crash Loop | >3 restarts in 5min | Critical | Check logs, rollback |
| High Retry Rate | >10% retries | Warning | Check external deps |
| Email Failures | >5% email failures | Warning | Check email service |

#### Dashboards

**pg-boss Admin Dashboard**:
```typescript
// Mount admin UI at /admin/jobs
import pgBossUI from 'pg-boss-ui';
app.use('/admin/jobs', pgBossUI(boss));
```

**Custom Metrics Dashboard** (Grafana/CloudWatch):
- Job queue depth over time (by type)
- Job processing latency histogram
- Worker health status
- Expiry accuracy gauge (% on-time)

### Maintenance

#### Database Maintenance
pg-boss includes automatic archive management:
```typescript
{
  archiveCompletedAfterSeconds: 60 * 60 * 24 * 7,  // Archive after 7 days
  deleteAfterDays: 30  // Delete archives after 30 days
}
```

**Manual cleanup** (if needed):
```sql
-- View archive size
SELECT
  pg_size_pretty(pg_total_relation_size('pgboss.archive')) as archive_size;

-- Delete old archives (older than 90 days)
DELETE FROM pgboss.archive
WHERE completed_on < NOW() - INTERVAL '90 days';
```

#### Queue Management

**Pause queue** during maintenance:
```typescript
await boss.pause({ queue: 'send-notification' });
// Perform maintenance
await boss.resume({ queue: 'send-notification' });
```

**Clear failed jobs**:
```typescript
// Retry all failed jobs
const failedJobs = await boss.fetch('send-notification', 100, {
  includeMetadata: true
});
for (const job of failedJobs) {
  await boss.retry(job.id);
}
```

**View queue stats**:
```typescript
const queues = await boss.getQueues();
console.log(queues);
// { created: 150, retry: 5, active: 23, completed: 9500, failed: 12 }
```

---

## Error Handling & Resilience

### Retry Strategy

**pg-boss Built-in Retries**:
```typescript
{
  retryLimit: 3,            // Retry up to 3 times
  retryDelay: 60,           // Wait 60 seconds before retry
  retryBackoff: true,       // Exponential backoff (60s, 120s, 240s)
}
```

**Custom Retry Logic**:
```typescript
boss.work('send-notification',
  {
    teamSize: 5,           // 5 concurrent workers
    teamConcurrency: 2     // Each processes 2 jobs at once
  },
  async (job) => {
    try {
      await sendEmail(job.data);
    } catch (error) {
      if (isRetryable(error)) {
        throw error;  // pg-boss will retry
      } else {
        logger.error('Non-retryable error:', error);
        // Don't throw - job will be marked complete
      }
    }
  }
);
```

### Dead Letter Queue

**Automatic DLQ**:
Jobs that fail after `retryLimit` attempts move to dead letter queue automatically.

**DLQ Monitoring**:
```typescript
// Check DLQ size daily
boss.schedule('check-dlq', null, { cron: '0 9 * * *' });

boss.work('check-dlq', async () => {
  const failed = await boss.fetch('__state__completed__', 100, {
    state: 'failed'
  });

  if (failed.length > 50) {
    await sendAlert('High DLQ count: ' + failed.length);
  }
});
```

**Manual DLQ Processing**:
```sql
-- View failed jobs
SELECT id, name, data, output, state, retry_count, completed_on
FROM pgboss.archive
WHERE state = 'failed'
ORDER BY completed_on DESC
LIMIT 20;
```

### Idempotency

**Ensure Idempotent Workers**:
```typescript
// Expiry worker - idempotent via WHERE clause
UPDATE listings SET status = 'expired'
WHERE id = $1 AND status = 'active';  // Only update if still active

// Notification worker - check if already sent
const existing = await pool.query(
  'SELECT id FROM notifications WHERE user_id = $1 AND type = $2 AND ens_name_id = $3',
  [userId, type, ensNameId]
);
if (existing.rows.length > 0) {
  return;  // Already sent, skip
}
```

### Circuit Breaker

**External Service Circuit Breaker**:
```typescript
import { CircuitBreaker } from 'opossum';

const emailBreaker = new CircuitBreaker(sendEmail, {
  timeout: 5000,
  errorThresholdPercentage: 50,
  resetTimeout: 30000
});

boss.work('send-notification', async (job) => {
  try {
    await emailBreaker.fire(job.data);
  } catch (error) {
    if (emailBreaker.opened) {
      logger.warn('Email circuit breaker open, retrying later');
      throw error;  // Will be retried by pg-boss
    }
  }
});
```

---

## Migration Plan

### Pre-Migration Checklist

- [ ] Deploy worker service to staging
- [ ] Verify pg-boss tables created
- [ ] Test each worker with manual jobs
- [ ] Load test with 10k jobs
- [ ] Configure monitoring/alerts
- [ ] Document rollback procedure
- [ ] Train ops team on pg-boss admin

### Migration Steps

#### Week 1: Infrastructure Setup
1. **Day 1-2**: Deploy worker service to staging
2. **Day 3-4**: Integration testing with API/indexer
3. **Day 5**: Production deployment (workers only, no producers)

#### Week 2: Expiry Worker
1. **Day 1-2**: Deploy API changes to publish expiry jobs (staging)
2. **Day 3**: Run parallel comparison (old vs new expiry logic)
3. **Day 4**: Deploy to production with feature flag
4. **Day 5**: Enable for 10% of new listings, monitor

#### Week 3: ENS Sync Worker
1. **Day 1-2**: Deploy ENS sync worker
2. **Day 3**: Backfill jobs for existing listings
3. **Day 4-5**: Monitor sync accuracy and RPC usage

#### Week 4: Ownership & Notifications
1. **Day 1-2**: Deploy indexer/WAL listener integrations
2. **Day 3**: Enable notifications for beta users
3. **Day 4**: Full rollout
4. **Day 5**: Monitoring and optimization

### Rollback Plan

**If critical issues occur**:

1. **Pause Job Publishing**:
```typescript
// In API service - disable job publishing
const WORKER_ENABLED = false;
if (WORKER_ENABLED) {
  await boss.send(/* ... */);
}
```

2. **Stop Worker Service**:
```bash
kubectl scale deployment workers --replicas=0
```

3. **Fallback to Old Logic**:
- Expiry: Run manual batch SQL cleanup
- Sync: Keep using existing indexer sync
- Notifications: Disable temporarily

4. **Clear Queue** (if needed):
```typescript
await boss.deleteQueue('problematic-queue-name');
```

---

## Testing Strategy

### Unit Tests

**Test Worker Logic**:
```typescript
// workers/expiry.test.ts
describe('ExpiryWorker', () => {
  it('should expire listings past expires_at', async () => {
    const expiredListing = await createListing({
      expires_at: new Date(Date.now() - 1000)
    });

    await expiryWorker.process({
      data: { type: 'listing', listingId: expiredListing.id }
    });

    const listing = await getListing(expiredListing.id);
    expect(listing.status).toBe('expired');
  });

  it('should not expire listings before expires_at', async () => {
    const activeListing = await createListing({
      expires_at: new Date(Date.now() + 86400000)
    });

    await expiryWorker.process({
      data: { type: 'listing', listingId: activeListing.id }
    });

    const listing = await getListing(activeListing.id);
    expect(listing.status).toBe('active');
  });
});
```

### Integration Tests

**Test End-to-End Flow**:
```typescript
describe('Notification Flow', () => {
  it('should send email when listing created for watched name', async () => {
    // Setup watchlist
    await createWatchlist(userId, ensNameId, { notify_on_listing: true });

    // Create listing (triggers WAL → queue → worker → email)
    await createListing({ ens_name_id: ensNameId });

    // Wait for async processing
    await wait(2000);

    // Verify email sent
    const notifications = await getNotifications(userId);
    expect(notifications).toHaveLength(1);
    expect(notifications[0].type).toBe('new-listing');
  });
});
```

### Load Testing

**Simulate High Job Volume**:
```typescript
// scripts/load-test.ts
const boss = new PgBoss(/* ... */);
await boss.start();

// Publish 10k jobs
for (let i = 0; i < 10000; i++) {
  await boss.send('sync-ens-data', {
    ensNameId: Math.floor(Math.random() * 1000),
    priority: 'normal'
  });
}

// Monitor processing time
const start = Date.now();
await boss.waitForJobComplete('job-id');
const duration = Date.now() - start;
console.log(`Processed 10k jobs in ${duration}ms`);
```

---

## Alternative Approaches Considered

### 1. Kafka + KafkaJS

**Pros**:
- Industry standard for event streaming
- High throughput (millions of messages/sec)
- Built-in partitioning and replication
- Strong ordering guarantees

**Cons**:
- ❌ Operational complexity (Kafka cluster, Zookeeper/KRaft)
- ❌ Overkill for job queue use case (Kafka is for event streaming)
- ❌ No native scheduled/delayed job support
- ❌ Requires separate infrastructure (increased costs)
- ❌ Steeper learning curve

**Verdict**: Not recommended for this use case. Kafka excels at event streaming (logs, analytics), but pg-boss is better for job queues.

### 2. BullMQ + Redis

**Pros**:
- Feature-rich (priorities, rate limiting, repeatable jobs)
- High performance
- Active community and ecosystem

**Cons**:
- ❌ Requires Redis infrastructure
- ❌ Data split across PostgreSQL + Redis
- ❌ Consistency challenges (dual writes)
- ❌ Additional service to monitor/maintain

**Verdict**: Good alternative if Redis already in use, but pg-boss is simpler for PostgreSQL-centric stacks.

### 3. pg_cron Extension

**Pros**:
- Built into PostgreSQL
- Simple for scheduled tasks

**Cons**:
- ❌ Limited to cron-based scheduling (no event-driven jobs)
- ❌ No retry logic or DLQ
- ❌ Requires superuser privileges
- ❌ Not suitable for high-frequency jobs
- ❌ No job prioritization

**Verdict**: Useful for simple scheduled tasks, but insufficient for our requirements.

### 4. AWS SQS + Lambda

**Pros**:
- Fully managed (no infrastructure)
- Auto-scaling
- Pay-per-use pricing

**Cons**:
- ❌ Vendor lock-in (AWS)
- ❌ Latency for cross-region
- ❌ Additional costs
- ❌ Requires AWS account/setup

**Verdict**: Good for AWS-native deployments, but pg-boss is simpler for self-hosted.

### 5. Custom Cron Jobs

**Pros**:
- Simple to implement
- No dependencies

**Cons**:
- ❌ No at-least-once delivery guarantees
- ❌ No built-in retries
- ❌ Hard to scale horizontally
- ❌ Manual error handling
- ❌ No job prioritization

**Verdict**: Too simplistic, lacks reliability features.

---

## Cost Analysis

### Infrastructure Costs (Monthly)

**pg-boss Approach** (Recommended):
- PostgreSQL storage: +5GB = **$0.50** (assuming $0.10/GB)
- Worker service (1x 2vCPU, 2GB RAM): **$30** (typical VPS pricing)
- Email service (SendGrid 50k/mo): **$0** (free tier)
- **Total: ~$30.50/month**

**Kafka Alternative**:
- Kafka cluster (3 nodes, minimal): **$150-300/month**
- Worker service: **$30/month**
- Email service: **$0**
- **Total: ~$180-330/month**

**BullMQ + Redis Alternative**:
- Redis (managed, 2GB): **$30-50/month**
- Worker service: **$30/month**
- Email service: **$0**
- **Total: ~$60-80/month**

**Cost Savings**: pg-boss saves **$30-300/month** vs alternatives.

### Development Costs

**pg-boss**:
- Initial implementation: ~40 hours (1 week)
- Integration: ~16 hours (2 days)
- Testing: ~16 hours (2 days)
- **Total: ~72 hours (~$10k at $140/hr)**

**Kafka**:
- Initial implementation: ~80 hours (2 weeks)
- Integration: ~24 hours (3 days)
- Testing: ~24 hours (3 days)
- **Total: ~128 hours (~$18k)**

**Development Savings**: pg-boss saves ~56 hours (~$8k) vs Kafka.

---

## Success Criteria

### Launch Criteria (Must Pass)

- [ ] All 4 workers processing jobs successfully
- [ ] Expiry accuracy > 95% within 5 minutes
- [ ] ENS sync completing without errors
- [ ] Ownership updates within 10 minutes of event
- [ ] Notification delivery rate > 98%
- [ ] Dead letter queue < 1% of total jobs
- [ ] Zero data loss during worker restarts
- [ ] Monitoring dashboards operational
- [ ] Alerts configured and tested
- [ ] Rollback procedure documented and tested

### Post-Launch Goals (30 Days)

- [ ] Expiry accuracy > 99% within 1 minute
- [ ] ENS metadata freshness < 24 hours (99th percentile)
- [ ] Ownership sync < 5 minutes (99th percentile)
- [ ] Notification latency < 30 seconds (p95)
- [ ] Worker uptime > 99.9%
- [ ] Queue processing rate > 100 jobs/sec
- [ ] Zero critical incidents related to workers
- [ ] Positive user feedback on notifications

### Performance Benchmarks

| Metric | Target | Measurement |
|--------|--------|-------------|
| Expiry Job Scheduling | < 100ms | Time to publish job after listing creation |
| Expiry Accuracy | 99% within 1 min | % of orders expired within 1 min of expires_at |
| ENS Sync Duration | < 5 sec/name | Time to fetch + update metadata |
| Ownership Update Latency | < 2 min | Time from Transfer event to DB update |
| Notification Delivery | < 30 sec (p95) | Time from trigger to email sent |
| Queue Throughput | > 100 jobs/sec | Jobs processed per second |
| Worker CPU Usage | < 60% | Average CPU utilization |
| Database Impact | < 5% increase | Additional load on PostgreSQL |

---

## Appendix

### A. pg-boss Quick Reference

**Install**:
```bash
npm install pg-boss
```

**Initialize**:
```typescript
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schema: 'pgboss'
});
await boss.start();
```

**Publish Job**:
```typescript
// Simple job
await boss.send('job-name', { data: 'value' });

// Scheduled job
await boss.schedule('job-name', { data: 'value' }, {
  startAfter: new Date('2025-01-01')
});

// Recurring job
await boss.schedule('job-name', { data: 'value' }, {
  cron: '0 * * * *'  // Every hour
});
```

**Process Job**:
```typescript
await boss.work('job-name', async (job) => {
  console.log('Processing:', job.data);
  // Do work
});
```

**Common Options**:
```typescript
{
  teamSize: 5,              // Number of concurrent workers
  teamConcurrency: 2,       // Jobs per worker
  includeMetadata: true,    // Include job metadata
  priority: 10,             // Higher = more priority
  retryLimit: 3,            // Max retries
  retryDelay: 60,           // Seconds between retries
  expireInHours: 24,        // Expire job if not started
}
```

### B. Email Templates

**New Listing Template**:
```html
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; }
    .container { max-width: 600px; margin: 0 auto; }
    .header { background: #4F46E5; color: white; padding: 20px; }
    .content { padding: 20px; }
    .cta { background: #4F46E5; color: white; padding: 12px 24px;
           text-decoration: none; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>🏷️ New Listing: {{ensName}}</h1>
    </div>
    <div class="content">
      <p>Great news! An ENS name on your watchlist has been listed.</p>
      <p><strong>{{ensName}}</strong></p>
      <p>Price: <strong>{{priceEth}} ETH</strong></p>
      <p>Seller: {{sellerAddress}}</p>
      <p><a href="{{listingUrl}}" class="cta">View Listing</a></p>
      <hr>
      <p style="font-size: 12px; color: #666;">
        <a href="{{unsubscribeUrl}}">Unsubscribe</a> from notifications
      </p>
    </div>
  </div>
</body>
</html>
```

### C. Monitoring Queries

**Queue Health**:
```sql
-- Active jobs by queue
SELECT name, COUNT(*) as count, state
FROM pgboss.job
WHERE state IN ('created', 'retry', 'active')
GROUP BY name, state
ORDER BY count DESC;

-- Failed jobs (last 24h)
SELECT name, COUNT(*) as failures
FROM pgboss.archive
WHERE state = 'failed'
  AND completed_on > NOW() - INTERVAL '24 hours'
GROUP BY name
ORDER BY failures DESC;

-- Average processing time
SELECT
  name,
  AVG(EXTRACT(EPOCH FROM (completed_on - started_on))) as avg_duration_sec,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (completed_on - started_on))) as p95_duration_sec
FROM pgboss.archive
WHERE state = 'completed'
  AND completed_on > NOW() - INTERVAL '1 hour'
GROUP BY name;
```

**Worker Performance**:
```sql
-- Jobs processed per minute (last hour)
SELECT
  DATE_TRUNC('minute', completed_on) as minute,
  COUNT(*) as jobs_completed
FROM pgboss.archive
WHERE completed_on > NOW() - INTERVAL '1 hour'
GROUP BY minute
ORDER BY minute DESC;

-- Retry rate
SELECT
  name,
  COUNT(*) FILTER (WHERE retry_count > 0) as retried,
  COUNT(*) as total,
  ROUND(100.0 * COUNT(*) FILTER (WHERE retry_count > 0) / COUNT(*), 2) as retry_pct
FROM pgboss.archive
WHERE completed_on > NOW() - INTERVAL '24 hours'
GROUP BY name
HAVING COUNT(*) > 10
ORDER BY retry_pct DESC;
```

### D. Useful Resources

**pg-boss Documentation**:
- GitHub: https://github.com/timgit/pg-boss
- Docs: https://github.com/timgit/pg-boss/blob/master/docs/readme.md
- Examples: https://github.com/timgit/pg-boss/tree/master/docs/examples

**Comparison Articles**:
- pg-boss vs Bull: https://github.com/timgit/pg-boss/issues/94
- Node.js Job Queue Comparison: https://npm-compare.com/agenda,bull,kue,pg-boss

**Email Services**:
- SendGrid: https://sendgrid.com
- AWS SES: https://aws.amazon.com/ses/
- Resend: https://resend.com

---

## Conclusion

Implementing a message queue system with **pg-boss** is the optimal solution for addressing the four async processing challenges:

1. ✅ **Expiry Management**: Scheduled jobs + batch safety net ensures 99%+ on-time expiration
2. ✅ **ENS Data Sync**: Daily refresh + event-driven sync keeps metadata fresh
3. ✅ **Ownership Tracking**: Event-driven updates maintain accurate ownership state
4. ✅ **Notifications**: Reliable, scalable notification delivery to watchlist users

**Key Advantages**:
- Minimal infrastructure (just PostgreSQL)
- Low operational overhead
- Cost-effective (~$30/month vs $180-330 for alternatives)
- TypeScript-native with excellent DX
- Production-ready with built-in retries, DLQ, and monitoring

**Next Steps**:
1. Review and approve this PRD
2. Create implementation tickets
3. Deploy worker service to staging (Week 1)
4. Phased rollout over 4 weeks
5. Monitor metrics and iterate

**Questions or Concerns?**
Please add comments or schedule a design review meeting.

---

**Approval**:

- [ ] Product Manager: _________________ Date: _______
- [ ] Tech Lead: _________________ Date: _______
- [ ] DevOps Lead: _________________ Date: _______
