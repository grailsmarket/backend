# Product Requirements Document (PRD)
## Listing & Offer Validation System

---

## Document Information

**Version:** 1.0
**Created:** 2025-01-09
**Status:** Draft
**Owner:** Engineering Team
**Stakeholders:** Product, Engineering, Operations

---

## 1. Executive Summary

### 1.1 Overview
Implement an automated validation system to ensure all marketplace listings and offers are backed by actual ownership and sufficient funds. This prevents users from attempting to complete transactions that will fail due to transferred assets or insufficient balances.

### 1.2 Problem Statement
Currently, users can:
- List ENS names they no longer own (after transferring to another wallet)
- Make offers without sufficient ETH/WETH/USDC balance
- See invalid listings/offers that will fail if attempted

This creates poor user experience, wasted gas fees, and loss of trust in the marketplace.

### 1.3 Success Metrics
- **Zero stale listings:** <1% of visible listings are invalid at any time
- **Fast detection:** Ownership/balance changes detected within 60 seconds
- **User satisfaction:** Reduce failed transaction attempts by >95%
- **System reliability:** 99.9% uptime for validation workers
- **Performance:** <100ms additional latency on API endpoints

### 1.4 Timeline
- **Phase 1 (Week 1):** Database schema, validation core logic
- **Phase 2 (Week 2):** Event-driven triggers, periodic validation
- **Phase 3 (Week 3):** Unfunded revalidation, notifications
- **Phase 4 (Week 4):** Bootstrap existing data, monitoring, launch

---

## 2. Background & Context

### 2.1 Current State
- **~2,000 distinct accounts** with active listings (~20,000 total listings)
- **~200 distinct accounts** with active offers
- No validation of ownership after listing creation
- No validation of buyer balance after offer creation
- Listings/offers remain visible even after becoming invalid

### 2.2 User Impact
**Sellers:**
- List name, transfer to different wallet, listing still shows as active
- Buyer attempts purchase, transaction fails, seller reputation damaged

**Buyers:**
- Make offer, transfer funds out, offer still shows
- Seller attempts to accept, transaction fails, time wasted

**Marketplace:**
- Users lose trust when transactions fail
- Support burden increases with failed transaction tickets

### 2.3 Technical Context
- Listings and offers stored in PostgreSQL
- ENS ownership tracked by Indexer service via blockchain events
- Wallet balances must be checked via RPC calls
- API service currently filters only by basic status field

---

## 3. Requirements

### 3.1 Functional Requirements

#### FR-1: Listing Ownership Validation
**Priority:** P0 (Critical)

The system MUST validate that every active listing's seller still owns the listed ENS name.

**Acceptance Criteria:**
- [ ] Validate ownership using database `ens_names.owner_address` as primary source
- [ ] Cross-validate with on-chain data for 10% of checks (sample validation)
- [ ] Mark listing as `unfunded` if ownership no longer matches
- [ ] Trigger validation immediately when ENS Transfer event detected
- [ ] Validate all active listings at least once per hour via periodic job
- [ ] Support validation via manual API trigger (admin endpoint)

**Edge Cases:**
- Name wrapped in Name Wrapper contract (use wrapped owner)
- Name expired (mark listing as expired, not unfunded)
- Database owner is stale (on-chain check reveals different owner)

---

#### FR-2: Offer Balance Validation
**Priority:** P0 (Critical)

The system MUST validate that every active offer's buyer has sufficient balance to complete the offer.

**Acceptance Criteria:**
- [ ] Support validation for ETH (native), WETH, and USDC offers
- [ ] Query wallet balance via RPC for native ETH
- [ ] Query token balance via ERC20.balanceOf() for WETH/USDC
- [ ] Mark offer as `unfunded` if balance < offer amount
- [ ] Validate all active offers at least once per 5 minutes
- [ ] Use multicall contract to batch balance checks (minimize RPC calls)

**Edge Cases:**
- Buyer has multiple offers, only enough balance for some (mark cheapest as funded first)
- Unknown/unsupported currency (mark as unfunded)
- RPC call fails (retry with exponential backoff, max 3 attempts)

---

#### FR-3: Unfunded Item Revalidation
**Priority:** P0 (Critical)

The system MUST periodically check if unfunded listings/offers have become valid again.

**Acceptance Criteria:**
- [ ] Check unfunded listings every 15 minutes
- [ ] Check unfunded offers every 15 minutes
- [ ] Restore status from `unfunded` to `active`/`pending` if now valid
- [ ] Only revalidate items unfunded within last 30 days (listings) / 14 days (offers)
- [ ] Send notification when item is restored to funded status

---

#### FR-4: Event-Driven Validation Triggers
**Priority:** P0 (Critical)

The system MUST respond to blockchain events to trigger immediate validation.

**Acceptance Criteria:**
- [ ] Listen to ENS Transfer events from Indexer service
- [ ] Queue validation for all listings of transferred name (high priority)
- [ ] Process validation queue with <10 second latency (p95)
- [ ] Handle queue backlog gracefully (prioritize high-priority jobs)

---

#### FR-5: User Notifications
**Priority:** P1 (High)

Users MUST be notified when their listings/offers become unfunded or refunded.

**Acceptance Criteria:**
- [ ] Send notification when listing marked as unfunded
- [ ] Send notification when offer marked as unfunded
- [ ] Send notification when listing restored to active
- [ ] Send notification when offer restored to pending
- [ ] Include reason in notification (e.g., "ownership lost", "insufficient ETH")
- [ ] Notifications visible in user's notification feed
- [ ] Support future: Email/push notifications (out of scope for v1)

**Notification Types:**
- `listing_unfunded`: "Your listing for {name} is no longer funded"
- `offer_unfunded`: "Your offer on {name} is no longer funded"
- `listing_refunded`: "Your listing for {name} is now active again"
- `offer_refunded`: "Your offer on {name} is now active again"

---

#### FR-6: API Filtering
**Priority:** P0 (Critical)

All public API endpoints MUST exclude unfunded listings and offers from results.

**Acceptance Criteria:**
- [ ] `GET /listings` only returns listings with `status = 'active'`
- [ ] `GET /offers` only returns offers with `status = 'pending'`
- [ ] Search endpoints exclude unfunded items
- [ ] User's own listings/offers endpoint shows unfunded status (future: separate endpoint)
- [ ] Elasticsearch sync excludes unfunded items

---

#### FR-7: Initial Bootstrap Validation
**Priority:** P0 (Critical)

The system MUST validate all existing listings and offers during initial deployment.

**Acceptance Criteria:**
- [ ] Script validates all ~20,000 existing listings
- [ ] Script validates all ~200 existing offers
- [ ] Validation spread over 30 minutes to avoid RPC rate limits
- [ ] Progress tracking and resumability (if script crashes)
- [ ] Report showing validation results (counts by status)

---

### 3.2 Non-Functional Requirements

#### NFR-1: Performance
- Validation worker processes jobs within 5 seconds (p95)
- API endpoints add <100ms latency
- Batch offer validation completes in <2 seconds for 200 offers
- RPC calls <6,000 per hour under normal load

#### NFR-2: Reliability
- Validation system uptime: 99.9%
- Failed validations retry with exponential backoff (max 3 attempts)
- Graceful degradation if RPC provider is down (queue jobs for later)
- No data loss in validation queue (pg-boss persistence)

#### NFR-3: Scalability
- System handles 10,000 active listings with same performance
- System handles 1,000 active offers with same performance
- Validation frequency adjustable via configuration
- Support multiple validation workers for horizontal scaling

#### NFR-4: Observability
- Metrics for validation counts, success rates, latency
- Alerts for high failure rates (>10%)
- Alerts for validation lag (jobs queued >5 minutes)
- Dashboard showing current validation state

#### NFR-5: Maintainability
- Configuration via environment variables (intervals, batch sizes)
- Manual trigger endpoints for admin debugging
- Validation logic isolated in reusable modules
- Comprehensive logging for troubleshooting

---

## 4. Technical Design

### 4.1 Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Event Sources                             │
├─────────────────────────────────────────────────────────────┤
│ 1. Indexer Service (ENS Transfer events)                    │
│ 2. Periodic Scheduler (cron jobs)                           │
│ 3. Manual Triggers (admin API)                              │
└────────────────────────────┬────────────────────────────────┘
                             │
                ┌────────────▼─────────────┐
                │   Validation Queue        │
                │   (pg-boss)               │
                │   - listing_ownership     │
                │   - offer_balance         │
                │   - revalidate_unfunded   │
                └────────────┬──────────────┘
                             │
                ┌────────────▼──────────────┐
                │   Validation Workers       │
                │   - Check ownership/balance│
                │   - Update status in DB    │
                │   - Create notifications   │
                └────────────┬──────────────┘
                             │
                ┌────────────▼──────────────┐
                │   Status Update Handler    │
                │   - Update listings/offers │
                │   - Trigger notifications  │
                │   - Update metrics         │
                └────────────────────────────┘
```

### 4.2 Database Schema Changes

#### 4.2.1 Listings Table Updates

```sql
-- Listings already has 'status' column, add new status values:
-- Current values: 'active', 'cancelled', 'sold', 'expired'
-- New values: 'unfunded'

-- Add new columns for validation tracking
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_reason TEXT;

-- Add index for efficient querying
CREATE INDEX IF NOT EXISTS idx_listings_status_validated
  ON listings(status, last_validated_at)
  WHERE status IN ('active', 'unfunded');

COMMENT ON COLUMN listings.last_validated_at IS 'Last time ownership was validated';
COMMENT ON COLUMN listings.unfunded_at IS 'When listing became unfunded';
COMMENT ON COLUMN listings.unfunded_reason IS 'Why listing is unfunded: ownership_lost, ownership_lost_onchain';
```

#### 4.2.2 Offers Table Updates

```sql
-- Offers already has 'status' column, add new status values:
-- Current values: 'pending', 'accepted', 'cancelled', 'expired'
-- New values: 'unfunded'

-- Add new columns for validation tracking
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_reason TEXT;

-- Add index for efficient querying
CREATE INDEX IF NOT EXISTS idx_offers_status_validated
  ON offers(status, last_validated_at)
  WHERE status IN ('pending', 'unfunded');

COMMENT ON COLUMN offers.last_validated_at IS 'Last time balance was validated';
COMMENT ON COLUMN offers.unfunded_at IS 'When offer became unfunded';
COMMENT ON COLUMN offers.unfunded_reason IS 'Why offer is unfunded: insufficient_eth, insufficient_weth, insufficient_usdc, unsupported_currency';
```

#### 4.2.3 Notifications Table Updates

```sql
-- Notifications already has 'type' column with values: 'new-listing', 'new-offer'
-- Add new notification types for validation events
-- No schema change needed, just add new type values:
--   - 'listing_unfunded'
--   - 'offer_unfunded'
--   - 'listing_refunded'
--   - 'offer_refunded'

-- Ensure index exists for efficient querying
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_address, read)
  WHERE read = false;
```

#### 4.2.4 New Validation State Table

```sql
-- Track validation schedule and history
CREATE TABLE IF NOT EXISTS validation_state (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL, -- 'listing' or 'offer'
  entity_id INTEGER NOT NULL,
  last_check_at TIMESTAMP NOT NULL DEFAULT NOW(),
  next_check_at TIMESTAMP NOT NULL, -- When to check next
  check_count INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(entity_type, entity_id)
);

CREATE INDEX idx_validation_state_next_check
  ON validation_state(next_check_at)
  WHERE next_check_at <= NOW();

CREATE INDEX idx_validation_state_entity
  ON validation_state(entity_type, entity_id);

COMMENT ON TABLE validation_state IS 'Tracks validation schedule and history for listings and offers';
COMMENT ON COLUMN validation_state.next_check_at IS 'When this entity should be validated next';
COMMENT ON COLUMN validation_state.consecutive_failures IS 'Count of consecutive validation failures';
```

#### 4.2.5 Migration Script

```sql
-- Migration: 001_add_validation_tracking.sql

BEGIN;

-- Listings table updates
ALTER TABLE listings
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_listings_status_validated
  ON listings(status, last_validated_at)
  WHERE status IN ('active', 'unfunded');

-- Offers table updates
ALTER TABLE offers
  ADD COLUMN IF NOT EXISTS last_validated_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_at TIMESTAMP,
  ADD COLUMN IF NOT EXISTS unfunded_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_offers_status_validated
  ON offers(status, last_validated_at)
  WHERE status IN ('pending', 'unfunded');

-- Validation state table
CREATE TABLE IF NOT EXISTS validation_state (
  id SERIAL PRIMARY KEY,
  entity_type VARCHAR(20) NOT NULL,
  entity_id INTEGER NOT NULL,
  last_check_at TIMESTAMP NOT NULL DEFAULT NOW(),
  next_check_at TIMESTAMP NOT NULL,
  check_count INTEGER DEFAULT 0,
  consecutive_failures INTEGER DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(entity_type, entity_id)
);

CREATE INDEX idx_validation_state_next_check
  ON validation_state(next_check_at)
  WHERE next_check_at <= NOW();

CREATE INDEX idx_validation_state_entity
  ON validation_state(entity_type, entity_id);

-- Ensure notifications index exists
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread
  ON notifications(user_address, read)
  WHERE read = false;

COMMIT;
```

### 4.3 Core Components

#### 4.3.1 Validation Queue (pg-boss)

**Job Types:**
- `validate-listing-ownership`: Validate single listing
- `validate-offer-balance`: Validate single offer
- `batch-validate-offers`: Validate multiple offers at once
- `revalidate-unfunded-listings`: Check unfunded listings for restoration
- `revalidate-unfunded-offers`: Check unfunded offers for restoration

**Job Priority Levels:**
- `high`: Event-driven validations (process immediately)
- `normal`: Periodic validations (process within 1 minute)
- `low`: Unfunded revalidations (process within 5 minutes)

**Configuration:**
```typescript
const boss = new PgBoss({
  connectionString: process.env.DATABASE_URL,
  schema: 'pgboss',
  retryLimit: 3,
  retryDelay: 60, // 1 minute
  retryBackoff: true,
  expireInHours: 24
});
```

#### 4.3.2 Validation Workers

**Worker Files:**
- `services/wal-listener/src/workers/validate-listing-ownership.ts`
- `services/wal-listener/src/workers/validate-offer-balance.ts`
- `services/wal-listener/src/workers/batch-validate-offers.ts`
- `services/wal-listener/src/workers/revalidate-unfunded.ts`

**Concurrency:**
- Listing validation: 5 concurrent workers
- Offer validation: 3 concurrent workers
- Batch validation: 1 worker (handles batching internally)

#### 4.3.3 Periodic Schedulers

**Cron Jobs:**
- `periodic-listing-validator`: Every 1 minute (validates 50 listings/run)
- `periodic-offer-validator`: Every 5 minutes (validates all offers in batch)
- `unfunded-revalidator`: Every 15 minutes (checks unfunded items)

**Configuration (Environment Variables):**
```env
# Listing validation
LISTING_VALIDATION_BATCH_SIZE=50
LISTING_VALIDATION_INTERVAL_MS=60000  # 1 minute
LISTING_VALIDATION_MAX_AGE_HOURS=1    # Validate all within 1 hour

# Offer validation
OFFER_VALIDATION_INTERVAL_MS=300000   # 5 minutes
OFFER_VALIDATION_USE_MULTICALL=true

# Unfunded revalidation
UNFUNDED_REVALIDATION_INTERVAL_MS=900000  # 15 minutes
UNFUNDED_LISTING_MAX_AGE_DAYS=30
UNFUNDED_OFFER_MAX_AGE_DAYS=14

# RPC settings
ETHEREUM_RPC_URL=https://eth-mainnet.alchemyapi.io/v2/xxx
RPC_RATE_LIMIT_PER_SECOND=10
MULTICALL3_ADDRESS=0xcA11bde05977b3631167028862bE2a173976CA11
```

#### 4.3.4 Event Listeners

**Indexer Integration:**
```typescript
// services/indexer/src/processors/ens-transfer-processor.ts

export async function handleENSTransfer(event: TransferEvent) {
  const { from, to, tokenId } = event;

  // Update database owner
  await updateENSOwner(tokenId, to);

  // Trigger validation for affected listings
  await triggerListingValidation(tokenId, 'high');
}
```

#### 4.3.5 Status Update Handler

**Responsibilities:**
- Update listing/offer status in database
- Create user notifications
- Update validation_state tracking
- Emit metrics

**Key Functions:**
- `updateListingStatus(listingId, validationResult, action?)`
- `updateOfferStatus(offerId, validationResult, action?)`
- `createNotification(userId, type, data)`

### 4.4 Validation Logic

#### 4.4.1 Listing Ownership Validation Algorithm

```typescript
async function validateListingOwnership(listingId: number): Promise<ValidationResult> {
  // 1. Fetch listing and current owner from database
  const listing = await fetchListingWithOwner(listingId);

  // 2. Check if seller still owns the name (database check)
  const dbOwnerMatches = listing.current_owner?.toLowerCase() === listing.seller_address.toLowerCase();

  if (!dbOwnerMatches) {
    return {
      isValid: false,
      reason: 'ownership_lost',
      details: {
        expectedOwner: listing.seller_address,
        currentOwner: listing.current_owner
      }
    };
  }

  // 3. Random sample: 10% on-chain verification
  if (Math.random() < 0.1) {
    const onChainOwner = await getENSOwnerFromRPC(listing.token_id);

    if (onChainOwner?.toLowerCase() !== listing.seller_address.toLowerCase()) {
      return {
        isValid: false,
        reason: 'ownership_lost_onchain',
        details: {
          expectedOwner: listing.seller_address,
          currentOwner: onChainOwner
        }
      };
    }
  }

  return { isValid: true };
}
```

#### 4.4.2 Offer Balance Validation Algorithm

```typescript
async function validateOfferBalance(offerId: number): Promise<ValidationResult> {
  // 1. Fetch offer details
  const offer = await fetchOffer(offerId);

  // 2. Determine currency type
  const currency = determineCurrency(offer.currency_address);

  // 3. Check balance based on currency
  let balance: bigint;

  if (currency === 'ETH') {
    balance = await provider.getBalance(offer.buyer_address);
  } else if (currency === 'WETH' || currency === 'USDC') {
    const token = new ethers.Contract(offer.currency_address, ERC20_ABI, provider);
    balance = await token.balanceOf(offer.buyer_address);
  } else {
    return { isValid: false, reason: 'unsupported_currency' };
  }

  // 4. Compare balance to required amount
  const required = BigInt(offer.price_wei);

  if (balance < required) {
    return {
      isValid: false,
      reason: `insufficient_${currency.toLowerCase()}`,
      details: {
        currentBalance: balance.toString(),
        requiredBalance: required.toString(),
        currency
      }
    };
  }

  return { isValid: true };
}
```

#### 4.4.3 Batch Offer Validation (Multicall)

```typescript
async function batchValidateOffers(offers: Offer[]): Promise<Map<number, ValidationResult>> {
  // Group by currency
  const ethOffers = offers.filter(o => isNativeETH(o.currency_address));
  const wethOffers = offers.filter(o => isWETH(o.currency_address));
  const usdcOffers = offers.filter(o => isUSDC(o.currency_address));

  const results = new Map<number, ValidationResult>();

  // Batch ETH balance checks
  if (ethOffers.length > 0) {
    const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

    const calls = ethOffers.map(offer => ({
      target: offer.buyer_address,
      allowFailure: true,
      callData: '0x'
    }));

    const responses = await multicall.aggregate3.staticCall(calls);

    ethOffers.forEach((offer, index) => {
      const balance = responses[index].success
        ? BigInt(responses[index].returnData)
        : 0n;

      results.set(offer.id, validateBalanceResult(balance, offer.price_wei, 'ETH'));
    });
  }

  // Batch WETH balance checks (similar pattern)
  // Batch USDC balance checks (similar pattern)

  return results;
}
```

### 4.5 Notification System

#### 4.5.1 Notification Creation

```typescript
async function createNotification(params: {
  user_address: string;
  type: NotificationType;
  title: string;
  message: string;
  data: any;
}) {
  await pool.query(`
    INSERT INTO notifications (user_address, type, title, message, data, read, created_at)
    VALUES ($1, $2, $3, $4, $5, false, NOW())
  `, [
    params.user_address.toLowerCase(),
    params.type,
    params.title,
    params.message,
    JSON.stringify(params.data)
  ]);
}
```

#### 4.5.2 Notification Types

**Listing Unfunded:**
```json
{
  "type": "listing_unfunded",
  "title": "Listing Unfunded",
  "message": "Your listing for vitalik.eth has been marked as unfunded because ownership_lost",
  "data": {
    "listing_id": 123,
    "name": "vitalik.eth",
    "reason": "ownership_lost",
    "details": {
      "expectedOwner": "0xabc...",
      "currentOwner": "0xdef..."
    }
  }
}
```

**Offer Unfunded:**
```json
{
  "type": "offer_unfunded",
  "title": "Offer Unfunded",
  "message": "Your offer on vitalik.eth is no longer funded (insufficient ETH balance)",
  "data": {
    "offer_id": 456,
    "name": "vitalik.eth",
    "reason": "insufficient_eth",
    "details": {
      "currentBalance": "100000000000000000",
      "requiredBalance": "500000000000000000",
      "currency": "ETH"
    }
  }
}
```

**Listing Refunded:**
```json
{
  "type": "listing_refunded",
  "title": "Listing Restored",
  "message": "Your listing for vitalik.eth is now active again",
  "data": {
    "listing_id": 123,
    "name": "vitalik.eth"
  }
}
```

**Offer Refunded:**
```json
{
  "type": "offer_refunded",
  "title": "Offer Restored",
  "message": "Your offer on vitalik.eth is now active again",
  "data": {
    "offer_id": 456,
    "name": "vitalik.eth"
  }
}
```

### 4.6 API Changes

#### 4.6.1 Listings Endpoints

**Update all listing queries to filter by status:**

```typescript
// Before
const query = `SELECT * FROM listings WHERE deleted_at IS NULL`;

// After
const query = `
  SELECT * FROM listings
  WHERE deleted_at IS NULL
    AND status = 'active'
`;
```

**Affected Endpoints:**
- `GET /api/v1/listings`
- `GET /api/v1/listings/search`
- `GET /api/v1/listings/:name`
- `GET /api/v1/search` (when showListings=true)

#### 4.6.2 Offers Endpoints

**Update all offer queries to filter by status:**

```typescript
// Before
const query = `SELECT * FROM offers WHERE 1=1`;

// After
const query = `
  SELECT * FROM offers
  WHERE status = 'pending'
`;
```

**Affected Endpoints:**
- `GET /api/v1/offers`
- `GET /api/v1/offers/:name`
- `GET /api/v1/search` (when filtering offers)

#### 4.6.3 New Admin Endpoints

```typescript
// Manual validation trigger
POST /api/v1/admin/validation/listings/:id/validate
POST /api/v1/admin/validation/offers/:id/validate

// Validation metrics
GET /api/v1/admin/validation/metrics

// Validation status
GET /api/v1/admin/validation/status
```

#### 4.6.4 Elasticsearch Sync Updates

**Update WAL listener to exclude unfunded listings from Elasticsearch:**

(i'm not sure if this is entirely correct, we don't want to remove the name itself, just the unfunded listing)

```typescript
// services/wal-listener/src/services/elasticsearch-sync.ts

async function syncListingToES(listingId: number) {
  const listing = await fetchListing(listingId);

  // Only sync active listings
  if (listing.status !== 'active') {
    // Remove from ES if exists
    await esClient.delete({
      index: 'ens_names',
      id: listing.ens_name_id,
      ignore: [404]
    });
    return;
  }

  // Sync to ES
  await esClient.update({
    index: 'ens_names',
    id: listing.ens_name_id,
    body: {
      doc: {
        status: 'active',
        price: listing.price_wei,
        // ... other fields
      }
    }
  });
}
```

### 4.7 Monitoring & Metrics

#### 4.7.1 Metrics to Track

**Validation Metrics:**
- `validation.listings.checked.total` (counter)
- `validation.listings.unfunded.total` (counter)
- `validation.listings.refunded.total` (counter)
- `validation.offers.checked.total` (counter)
- `validation.offers.unfunded.total` (counter)
- `validation.offers.refunded.total` (counter)
- `validation.duration.seconds` (histogram)
- `validation.queue.depth` (gauge)
- `validation.errors.total` (counter by type)

**System Health:**
- `validation.worker.heartbeat` (timestamp of last successful job)
- `validation.rpc.calls.total` (counter)
- `validation.rpc.errors.total` (counter)
- `validation.lag.seconds` (gauge: time since oldest unvalidated item)

#### 4.7.2 Alerts

**Critical Alerts:**
- Validation worker not processing jobs for >5 minutes
- RPC error rate >10%
- Validation queue depth >1000 jobs
- Validation lag >15 minutes

**Warning Alerts:**
- Unfunded rate >5% (potential systemic issue)
- RPC rate limit approaching (>80% of limit)
- Validation duration p95 >10 seconds

#### 4.7.3 Dashboard

**Grafana Dashboard Sections:**
1. **Overview:** Total listings, total offers, active vs unfunded counts
2. **Validation Activity:** Checks per minute, unfunded rate, refunded rate
3. **Queue Health:** Queue depth over time, processing rate
4. **RPC Usage:** Calls per minute, error rate, latency
5. **Worker Health:** Heartbeats, job success rate

### 4.8 Error Handling

#### 4.8.1 Validation Failures

**RPC Errors:**
- Retry with exponential backoff (1s, 2s, 4s)
- Max 3 retries
- After 3 failures, mark validation_state.consecutive_failures
- Alert if consecutive_failures >10 for any entity

**Database Errors:**
- Retry immediately once
- If still fails, log error and move to next job
- Alert if error rate >1%

**Unknown Errors:**
- Log full error details
- Mark job as failed
- Alert if unknown error count >10/hour

#### 4.8.2 Graceful Degradation

**RPC Provider Down:**
- Queue validation jobs for later (don't fail)
- Continue showing last known status
- Alert immediately

**Database Down:**
- Worker stops processing
- Queue accumulates (pg-boss persists to disk)
- Alert immediately

**High Load:**
- Reduce validation frequency automatically
- Prioritize event-driven validations
- Alert if queue depth grows rapidly

---

## 5. Implementation Plan

### 5.1 Phase 1: Foundation (Week 1)

**Goals:**
- Database schema in place
- Core validation logic implemented
- Manual validation working

**Tasks:**
1. **Day 1-2: Database Schema**
   - [ ] Write migration script (`001_add_validation_tracking.sql`)
   - [ ] Test migration on staging database
   - [ ] Run migration on production
   - [ ] Verify indexes created

2. **Day 3-4: Validation Workers**
   - [ ] Implement `validate-listing-ownership.ts`
   - [ ] Implement `validate-offer-balance.ts`
   - [ ] Implement `batch-validate-offers.ts`
   - [ ] Add unit tests for validation logic
   - [ ] Test with sample listings/offers

3. **Day 5: Status Update Handler**
   - [ ] Implement `updateListingStatus()`
   - [ ] Implement `updateOfferStatus()`
   - [ ] Add notification creation
   - [ ] Test status transitions

**Deliverables:**
- Migration applied to production
- Validation workers deployable
- Manual validation endpoint working

---

### 5.2 Phase 2: Automation (Week 2)

**Goals:**
- Event-driven validation live
- Periodic validation running
- Queue processing reliably

**Tasks:**
1. **Day 1-2: Event Integration**
   - [ ] Update indexer to emit validation events
   - [ ] Connect events to validation queue
   - [ ] Test with real Transfer events
   - [ ] Verify high-priority jobs processed quickly

2. **Day 3-4: Periodic Schedulers**
   - [ ] Implement `periodic-listing-validator`
   - [ ] Implement `periodic-offer-validator`
   - [ ] Configure cron schedules
   - [ ] Test rotation logic (all items validated within target time)

3. **Day 5: Queue Optimization**
   - [ ] Tune worker concurrency
   - [ ] Implement multicall batching
   - [ ] Add RPC rate limiting
   - [ ] Load test with production data

**Deliverables:**
- Event-driven validation working in production
- Periodic validation running every 1/5 minutes
- Queue processing <10s latency (p95)

---

### 5.3 Phase 3: Revalidation & Notifications (Week 3)

**Goals:**
- Unfunded items monitored for restoration
- Users notified of status changes
- API filters active

**Tasks:**
1. **Day 1-2: Unfunded Revalidation**
   - [ ] Implement `revalidate-unfunded-listings`
   - [ ] Implement `revalidate-unfunded-offers`
   - [ ] Configure 15-minute schedule
   - [ ] Test restoration flow (unfunded → active)

2. **Day 3: Notification System**
   - [ ] Add notification creation to status updates
   - [ ] Test all 4 notification types
   - [ ] Verify notifications visible in API
   - [ ] Add notification preference handling

3. **Day 4-5: API Updates**
   - [ ] Update all listing queries to filter status
   - [ ] Update all offer queries to filter status
   - [ ] Update Elasticsearch sync logic
   - [ ] Test API returns no unfunded items
   - [ ] Update API documentation

**Deliverables:**
- Unfunded items automatically restored when valid
- Users receive notifications for all status changes
- API excludes unfunded listings/offers

---

### 5.4 Phase 4: Bootstrap & Launch (Week 4)

**Goals:**
- All existing data validated
- Monitoring in place
- System launched to production

**Tasks:**
1. **Day 1-2: Initial Bootstrap**
   - [ ] Write `bootstrap-validation.ts` script
   - [ ] Run script on production (validate 20k listings)
   - [ ] Monitor progress and error rate
   - [ ] Generate validation report

2. **Day 3: Monitoring Setup**
   - [ ] Add metrics collection
   - [ ] Create Grafana dashboard
   - [ ] Configure alerts
   - [ ] Test alert delivery

3. **Day 4: Documentation**
   - [ ] Update API documentation
   - [ ] Write runbook for operations team
   - [ ] Document troubleshooting procedures
   - [ ] Create user-facing help articles

4. **Day 5: Launch**
   - [ ] Final QA testing
   - [ ] Deploy to production
   - [ ] Monitor for 24 hours
   - [ ] Retrospective meeting

**Deliverables:**
- All existing listings/offers validated
- Monitoring dashboard live
- System running in production
- Documentation complete

---

## 6. Testing Strategy

### 6.1 Unit Tests

**Validation Logic:**
- [ ] Listing ownership validation (happy path)
- [ ] Listing ownership validation (ownership lost)
- [ ] Offer balance validation (sufficient balance)
- [ ] Offer balance validation (insufficient ETH)
- [ ] Offer balance validation (insufficient WETH)
- [ ] Offer balance validation (insufficient USDC)
- [ ] Batch validation (multiple offers)

**Status Updates:**
- [ ] Listing marked unfunded correctly
- [ ] Offer marked unfunded correctly
- [ ] Listing restored to active
- [ ] Offer restored to pending
- [ ] Notifications created for each transition

### 6.2 Integration Tests

**End-to-End Flows:**
- [ ] Transfer event → validation → status update → notification
- [ ] Periodic validation runs and updates status
- [ ] Unfunded revalidation detects restoration
- [ ] API excludes unfunded items
- [ ] Manual validation trigger works

**RPC Integration:**
- [ ] ENS Registrar ownerOf() call
- [ ] Native ETH balance check
- [ ] WETH balanceOf() call
- [ ] USDC balanceOf() call
- [ ] Multicall batch validation

### 6.3 Load Testing

**Scenarios:**
- [ ] 100 Transfer events per minute
- [ ] 1000 listing validations queued
- [ ] 500 concurrent offer balance checks
- [ ] RPC provider rate limit (verify backoff)
- [ ] Database connection pool exhaustion

**Targets:**
- Queue processing: <10s latency (p95)
- Validation duration: <5s (p95)
- API latency: <100ms added overhead
- System stays stable under 2x expected load

### 6.4 Manual Testing

**User Scenarios:**
- [ ] User lists name, transfers it, listing marked unfunded, notification received
- [ ] User makes offer, transfers funds out, offer marked unfunded, notification received
- [ ] User's listing becomes unfunded, user transfers name back, listing restored
- [ ] User's offer becomes unfunded, user adds funds, offer restored
- [ ] User views listings, unfunded items not visible
- [ ] User views offers, unfunded items not visible

---

## 7. Rollout Plan

### 7.1 Staging Deployment

**Week 1-3:**
- Deploy to staging after each phase
- Test with staging database (copy of production)
- Verify validation logic with real data
- Smoke test all endpoints

### 7.2 Production Deployment

**Week 4, Day 5:**

**Pre-Deployment:**
- [ ] Code review completed
- [ ] All tests passing
- [ ] Staging fully tested
- [ ] Runbook prepared
- [ ] Rollback plan ready

**Deployment Steps:**
1. **Deploy database migration** (during low-traffic window)
2. **Deploy wal-listener service** (with workers disabled)
3. **Run bootstrap validation script** (validate existing data)
4. **Enable validation workers** (start processing queue)
5. **Deploy API service** (with updated filtering)
6. **Enable periodic schedulers** (start cron jobs)
7. **Monitor for 1 hour** (verify no errors)

**Post-Deployment:**
- [ ] Verify validation workers processing jobs
- [ ] Check validation metrics in dashboard
- [ ] Confirm API excludes unfunded items
- [ ] Test notification delivery
- [ ] Monitor error rates for 24 hours

### 7.3 Rollback Plan

**If critical issues detected:**

1. **Disable validation workers** (stop marking items unfunded)
2. **Revert API filtering** (show all listings/offers again)
3. **Investigate issue** in staging environment
4. **Fix and re-deploy** when ready

**Rollback does NOT require:**
- Database migration revert (new columns are additive, safe to keep)
- Data cleanup (statuses can be reset manually if needed)

---

## 8. Success Criteria

### 8.1 Launch Criteria (Must Meet Before Launch)

- [ ] All Phase 1-4 tasks completed
- [ ] All unit tests passing (>90% coverage)
- [ ] All integration tests passing
- [ ] Load tests show <10s queue latency under 2x load
- [ ] Bootstrap validation completes successfully
- [ ] Staging fully tested with real data
- [ ] Monitoring dashboard live with all metrics
- [ ] Alerts configured and tested
- [ ] Documentation complete
- [ ] Rollback plan tested

### 8.2 Success Metrics (Measure After 1 Week)

**Performance:**
- [ ] <1% of visible listings are invalid (validation working)
- [ ] Ownership changes detected within 60 seconds (event-driven working)
- [ ] API latency <100ms added overhead
- [ ] Validation queue depth <100 jobs (keeping up with load)

**Reliability:**
- [ ] System uptime >99.9%
- [ ] Validation success rate >99%
- [ ] RPC error rate <1%
- [ ] No critical alerts fired

**User Impact:**
- [ ] Failed transaction attempts reduced by >90%
- [ ] No user complaints about stale listings
- [ ] Notification delivery rate >95%
- [ ] Support tickets about invalid listings reduced by >80%

---

## 9. Risks & Mitigations

### 9.1 Technical Risks

**Risk: RPC Provider Rate Limiting**
- **Impact:** Validations fail, items not updated
- **Likelihood:** Medium
- **Mitigation:**
  - Use multicall to reduce call volume
  - Implement exponential backoff
  - Monitor RPC usage proactively
  - Have backup RPC provider configured

**Risk: Validation Queue Overload**
- **Impact:** Validation lag increases, stale data visible
- **Likelihood:** Low
- **Mitigation:**
  - Load test to find breaking point
  - Auto-scaling workers (horizontal scaling)
  - Alert on queue depth >500 jobs
  - Prioritize event-driven validations

**Risk: Indexer Falls Behind**
- **Impact:** Database owner is stale, validations incorrect
- **Likelihood:** Low
- **Mitigation:**
  - 10% on-chain sample validation catches stale data
  - Indexer has separate monitoring/alerts
  - On-chain checks increase if indexer lag detected

**Risk: Database Performance Degradation**
- **Impact:** Validation queries slow, queue backs up
- **Likelihood:** Low
- **Mitigation:**
  - All queries use indexed columns
  - Load test database queries
  - Separate read replica for validation queries (future)

### 9.2 Product Risks

**Risk: Too Many False Positives**
- **Impact:** Valid listings marked unfunded, user complaints
- **Likelihood:** Low
- **Mitigation:**
  - Thorough testing before launch
  - Monitor unfunded rate (alert if >5%)
  - Manual review process for disputed items
  - Easy restore mechanism for false positives

**Risk: Notification Fatigue**
- **Impact:** Users ignore notifications, miss important updates
- **Likelihood:** Medium
- **Mitigation:**
  - Only notify on status changes (not every validation)
  - Clear, actionable notification messages
  - Group notifications (future: daily digest)
  - User notification preferences

**Risk: User Confusion About "Unfunded"**
- **Impact:** Users don't understand why listing/offer hidden
- **Likelihood:** Medium
- **Mitigation:**
  - Clear notification messages with reasons
  - Help articles explaining validation
  - Show unfunded items in user's own dashboard (future)
  - Support team trained on validation system

### 9.3 Business Risks

**Risk: Increased Infrastructure Costs**
- **Impact:** RPC calls cost money, higher AWS bill
- **Likelihood:** Medium
- **Mitigation:**
  - Optimize with multicall and batching
  - Use free tier RPC provider when possible
  - Monitor costs closely
  - Only validate when necessary (not everything every minute)

**Risk: Launch Delays**
- **Impact:** Problem persists longer, user experience suffers
- **Likelihood:** Low
- **Mitigation:**
  - Aggressive testing schedule
  - Daily standups during implementation
  - Buffer time in Week 4 for issues
  - Phased rollout (can pause at any phase)

---

## 10. Open Questions

### 10.1 Product Questions

1. **Q:** Should users be able to see their own unfunded listings/offers?
   - **A:** Out of scope for v1, add separate endpoint later

2. **Q:** Should we show "This listing is no longer available" message?
   - **A:** No, just hide it completely (return 404)

3. **Q:** Should we auto-cancel unfunded items after X days?
   - **A:** Out of scope for v1, discuss in future iteration

4. **Q:** Should we email users about unfunded status?
   - **A:** Out of scope for v1, in-app notifications only

### 10.2 Technical Questions

1. **Q:** Should we validate expired listings differently?
   - **A:** Expired listings already filtered by expiry_date, no validation needed

2. **Q:** What if user has 10 offers but only balance for 5?
   - **A:** Mark most expensive offers as unfunded, keep cheaper ones active

3. **Q:** Should we cache RPC results?
   - **A:** No caching for v1, keep it simple (re-validate each time)

4. **Q:** What about offers in multiple currencies?
   - **A:** Validate each currency independently, mark unfunded if any insufficient

---

## 11. Future Enhancements

### 11.1 Short-Term (Next Quarter)

- **User Dashboard:** Show user their own unfunded items
- **Smart Revalidation:** Increase frequency for high-value items
- **Email Notifications:** Send email for unfunded status
- **Offer Prioritization:** If user has multiple offers, prioritize which stay funded
- **Admin Tools:** Better debugging/investigation tools

### 11.2 Long-Term (6+ Months)

- **Predictive Validation:** ML model predicts which listings likely to become unfunded
- **WebSocket Notifications:** Real-time push notifications
- **Allowance Checking:** Verify ERC20 allowance for Seaport contract
- **Gas Balance:** Warn if user has no gas to complete transaction
- **Multi-Chain:** Support validation on L2s (Polygon, Arbitrum)

---

## 12. Appendices

### 12.1 Glossary

**Active Listing:** Listing with status='active', seller owns name, visible to buyers
**Unfunded Listing:** Listing with status='unfunded', seller lost ownership, hidden
**Pending Offer:** Offer with status='pending', buyer has sufficient balance, visible
**Unfunded Offer:** Offer with status='unfunded', buyer lacks balance, hidden
**Validation:** Process of checking ownership/balance and updating status
**Revalidation:** Re-checking unfunded items to see if they're valid again
**pg-boss:** PostgreSQL-based job queue library
**Multicall:** Smart contract that batches multiple RPC calls into one

### 12.2 References

- [pg-boss Documentation](https://github.com/timgit/pg-boss)
- [Multicall3 Contract](https://www.multicall3.com/)
- [ENS Registrar Contract](https://etherscan.io/address/0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85)
- [Seaport Protocol Docs](https://docs.opensea.io/reference/seaport-overview)

### 12.3 Database ER Diagram

```
┌─────────────────┐         ┌─────────────────┐
│   ens_names     │         │    listings     │
├─────────────────┤         ├─────────────────┤
│ id (PK)         │◄───────┤│ ens_name_id (FK)│
│ token_id        │         │ seller_address  │
│ name            │         │ status          │
│ owner_address   │         │ price_wei       │
│ expiry_date     │         │ last_validated  │
└─────────────────┘         │ unfunded_at     │
                            │ unfunded_reason │
                            └─────────────────┘
                                     │
                                     │
                            ┌────────▼──────────┐
                            │ validation_state  │
                            ├───────────────────┤
                            │ entity_type       │
                            │ entity_id         │
                            │ last_check_at     │
                            │ next_check_at     │
                            └───────────────────┘
```

---

## Document Approval

**Prepared By:** Engineering Team
**Reviewed By:** [Product Manager]
**Approved By:** [Engineering Lead]
**Date:** 2025-01-09

---

**END OF PRD**
