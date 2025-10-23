# Sales Table Implementation Plan

## Overview

This document outlines the implementation plan for adding a dedicated `sales` table to track completed ENS name sales across all marketplaces.

## Current State Analysis

### Existing Tables

1. **`transactions` table** (blockchain-focused)
   - Tracks all blockchain-level transactions from the indexer
   - Fields: `transaction_hash`, `block_number`, `from_address`, `to_address`, `price_wei`, `transaction_type`
   - **Issue**: Generic for all transaction types (sale, transfer, registration, renewal)

2. **`activity_history` table** (marketplace event log)
   - Tracks marketplace activity events for the activity feed
   - Fields: `event_type`, `actor_address`, `counterparty_address`, `price_wei`, `platform`, `metadata`
   - **Issue**: Event log format, not optimized for sales queries/analytics

3. **`listings` table** - Tracks active/past listings
4. **`offers` table** - Tracks offers made on ENS names

### The Gap

Neither table provides:
- Dedicated sales records similar to `listings` and `offers`
- Links between sales and the original listing/offer
- Complete order data for marketplace sales
- Efficient querying for sales analytics and history
- Fee tracking (platform fees, creator fees)

---

## Proposed Solution: Sales Table

### Schema

```sql
CREATE TABLE sales (
    id SERIAL PRIMARY KEY,
    ens_name_id INTEGER NOT NULL REFERENCES ens_names(id),

    -- Parties
    seller_address VARCHAR(42) NOT NULL,
    buyer_address VARCHAR(42) NOT NULL,

    -- Price
    sale_price_wei VARCHAR(78) NOT NULL,
    currency_address VARCHAR(42) DEFAULT '0x0000000000000000000000000000000000000000',

    -- Links to original listing/offer
    listing_id INTEGER REFERENCES listings(id),
    offer_id INTEGER REFERENCES offers(id),

    -- Blockchain
    transaction_hash VARCHAR(66) NOT NULL,
    block_number BIGINT NOT NULL,

    -- Order data
    order_hash VARCHAR(66),
    order_data JSONB,

    -- Marketplace
    source VARCHAR(20) NOT NULL,
    platform_fee_wei VARCHAR(78),
    creator_fee_wei VARCHAR(78),
    metadata JSONB,

    -- Timestamps
    sale_date TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
```

### Key Features

1. **Automatic Status Updates** - Triggers automatically mark listings as 'sold' and offers as 'accepted'
2. **Activity Feed Integration** - Triggers create activity_history entries for both buyer and seller
3. **Comprehensive Indexing** - Optimized for common query patterns (by name, date, buyer, seller, source)
4. **Relationship Tracking** - Links sales to original listings/offers when applicable

---

## Implementation Steps

### Step 1: Database Migration ✅

**File**: `services/api/migrations/create_sales_table.sql`

Run the migration:
```bash
cd services/api
psql $DATABASE_URL -f migrations/create_sales_table.sql
```

**What it creates:**
- `sales` table with all necessary fields and constraints
- 9 indexes for query optimization
- 2 trigger functions for automatic updates
- Comments for documentation

### Step 2: Update Shared Types

**File**: `services/shared/src/types/index.ts` (or similar)

Add TypeScript interface:
```typescript
export interface Sale {
  id: number;
  ens_name_id: number;
  seller_address: string;
  buyer_address: string;
  sale_price_wei: string;
  currency_address: string;
  listing_id?: number;
  offer_id?: number;
  transaction_hash: string;
  block_number: number;
  order_hash?: string;
  order_data?: any;
  source: 'opensea' | 'grails' | 'blur' | 'looksrare' | 'x2y2' | 'other';
  platform_fee_wei?: string;
  creator_fee_wei?: string;
  metadata?: any;
  sale_date: string;
  created_at: string;
}
```

### Step 3: Create Sales Service

**File**: `services/api/src/services/sales.ts` (new file)

```typescript
import { getPostgresPool } from '../../../shared/src';

const pool = getPostgresPool();

export interface CreateSaleParams {
  ensNameId: number;
  sellerAddress: string;
  buyerAddress: string;
  salePriceWei: string;
  currencyAddress?: string;
  listingId?: number;
  offerId?: number;
  transactionHash: string;
  blockNumber: number;
  orderHash?: string;
  orderData?: any;
  source: string;
  platformFeeWei?: string;
  creatorFeeWei?: string;
  metadata?: any;
  saleDate: Date;
}

export async function createSale(params: CreateSaleParams) {
  const {
    ensNameId,
    sellerAddress,
    buyerAddress,
    salePriceWei,
    currencyAddress = '0x0000000000000000000000000000000000000000',
    listingId,
    offerId,
    transactionHash,
    blockNumber,
    orderHash,
    orderData,
    source,
    platformFeeWei,
    creatorFeeWei,
    metadata,
    saleDate
  } = params;

  const query = `
    INSERT INTO sales (
      ens_name_id,
      seller_address,
      buyer_address,
      sale_price_wei,
      currency_address,
      listing_id,
      offer_id,
      transaction_hash,
      block_number,
      order_hash,
      order_data,
      source,
      platform_fee_wei,
      creator_fee_wei,
      metadata,
      sale_date
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
    ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING
    RETURNING *
  `;

  const values = [
    ensNameId,
    sellerAddress.toLowerCase(),
    buyerAddress.toLowerCase(),
    salePriceWei,
    currencyAddress,
    listingId,
    offerId,
    transactionHash,
    blockNumber,
    orderHash,
    orderData ? JSON.stringify(orderData) : null,
    source,
    platformFeeWei,
    creatorFeeWei,
    metadata ? JSON.stringify(metadata) : null,
    saleDate
  ];

  const result = await pool.query(query, values);
  return result.rows[0];
}

export async function getSalesByName(ensName: string, limit = 20, offset = 0) {
  const query = `
    SELECT s.*, en.name, en.token_id
    FROM sales s
    JOIN ens_names en ON s.ens_name_id = en.id
    WHERE en.name = $1
    ORDER BY s.sale_date DESC
    LIMIT $2 OFFSET $3
  `;

  const result = await pool.query(query, [ensName, limit, offset]);
  return result.rows;
}

export async function getSalesByAddress(
  address: string,
  type: 'buyer' | 'seller' | 'both' = 'both',
  limit = 20,
  offset = 0
) {
  let whereClause = '';
  if (type === 'buyer') {
    whereClause = 's.buyer_address = $1';
  } else if (type === 'seller') {
    whereClause = 's.seller_address = $1';
  } else {
    whereClause = '(s.buyer_address = $1 OR s.seller_address = $1)';
  }

  const query = `
    SELECT s.*, en.name, en.token_id
    FROM sales s
    JOIN ens_names en ON s.ens_name_id = en.id
    WHERE ${whereClause}
    ORDER BY s.sale_date DESC
    LIMIT $2 OFFSET $3
  `;

  const result = await pool.query(query, [address.toLowerCase(), limit, offset]);
  return result.rows;
}

export async function getRecentSales(limit = 20, offset = 0) {
  const query = `
    SELECT s.*, en.name, en.token_id
    FROM sales s
    JOIN ens_names en ON s.ens_name_id = en.id
    ORDER BY s.sale_date DESC
    LIMIT $1 OFFSET $2
  `;

  const result = await pool.query(query, [limit, offset]);
  return result.rows;
}

export async function getSalesAnalytics(ensNameId: number) {
  const query = `
    SELECT
      COUNT(*) as total_sales,
      AVG(CAST(sale_price_wei AS NUMERIC)) as avg_price_wei,
      MIN(CAST(sale_price_wei AS NUMERIC)) as min_price_wei,
      MAX(CAST(sale_price_wei AS NUMERIC)) as max_price_wei,
      MIN(sale_date) as first_sale_date,
      MAX(sale_date) as last_sale_date
    FROM sales
    WHERE ens_name_id = $1
  `;

  const result = await pool.query(query, [ensNameId]);
  return result.rows[0];
}
```

### Step 4: Create Sales API Routes

**File**: `services/api/src/routes/sales.ts` (new file)

```typescript
import { FastifyInstance } from 'fastify';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import {
  getSalesByName,
  getSalesByAddress,
  getRecentSales,
  getSalesAnalytics
} from '../services/sales';

export async function salesRoutes(fastify: FastifyInstance) {
  // GET /api/v1/sales - Get recent sales
  fastify.get('/', async (request, reply) => {
    const { page = '1', limit = '20' } = request.query as any;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
      const sales = await getRecentSales(parseInt(limit), offset);

      const response: APIResponse = {
        success: true,
        data: { sales },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch sales',
      });
    }
  });

  // GET /api/v1/sales/name/:name - Get sales for specific ENS name
  fastify.get('/name/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const { page = '1', limit = '20' } = request.query as any;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
      const sales = await getSalesByName(name, parseInt(limit), offset);

      const response: APIResponse = {
        success: true,
        data: { sales },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch sales',
      });
    }
  });

  // GET /api/v1/sales/address/:address - Get sales by address
  fastify.get('/address/:address', async (request, reply) => {
    const { address } = request.params as { address: string };
    const { page = '1', limit = '20', type = 'both' } = request.query as any;
    const offset = (parseInt(page) - 1) * parseInt(limit);

    try {
      const sales = await getSalesByAddress(
        address,
        type,
        parseInt(limit),
        offset
      );

      const response: APIResponse = {
        success: true,
        data: { sales },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch sales',
      });
    }
  });

  // GET /api/v1/sales/:nameOrId/analytics - Get sales analytics
  fastify.get('/:nameOrId/analytics', async (request, reply) => {
    const { nameOrId } = request.params as { nameOrId: string };

    try {
      // Try to get ens_name_id
      const pool = getPostgresPool();
      let ensNameId: number;

      if (isNaN(parseInt(nameOrId))) {
        // It's a name
        const result = await pool.query(
          'SELECT id FROM ens_names WHERE name = $1',
          [nameOrId]
        );
        if (result.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: 'ENS name not found',
          });
        }
        ensNameId = result.rows[0].id;
      } else {
        ensNameId = parseInt(nameOrId);
      }

      const analytics = await getSalesAnalytics(ensNameId);

      const response: APIResponse = {
        success: true,
        data: analytics,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({
        success: false,
        error: 'Failed to fetch analytics',
      });
    }
  });
}
```

### Step 5: Register Sales Routes

**File**: `services/api/src/routes/index.ts`

Add the import and registration:
```typescript
import { salesRoutes } from './sales';

export function registerRoutes(fastify: FastifyInstance) {
  // ... existing routes ...
  fastify.register(salesRoutes, { prefix: '/api/v1/sales' });
}
```

### Step 6: Integrate Sales Recording

You'll need to record sales in two places:

#### A. OpenSea Event Processor

When an `item_sold` event is received from OpenSea:

```typescript
// In your OpenSea event handler
import { createSale } from '../services/sales';

async function handleItemSold(event: OpenseaEvent) {
  const { item, sale } = event.payload;

  // Get ENS name ID
  const ensNameId = await getEnsNameIdFromTokenId(item.nft_id);

  // Find the listing if it exists
  const listing = await findListingByOrderHash(sale.order_hash);

  await createSale({
    ensNameId,
    sellerAddress: sale.seller.address,
    buyerAddress: sale.buyer.address,
    salePriceWei: sale.price.value,
    currencyAddress: sale.payment_token.address,
    listingId: listing?.id,
    transactionHash: sale.transaction,
    blockNumber: sale.block_number,
    orderHash: sale.order_hash,
    orderData: sale,
    source: 'opensea',
    platformFeeWei: sale.platform_fee?.value,
    creatorFeeWei: sale.creator_fee?.value,
    saleDate: new Date(sale.event_timestamp)
  });
}
```

#### B. Blockchain Indexer

When a Transfer event with a price is detected:

```typescript
// In your blockchain indexer
import { createSale } from '../services/sales';

async function handleTransferWithPayment(transfer: TransferEvent) {
  // Detect if this is a sale (has payment in same transaction)
  const payment = await detectPaymentInTransaction(transfer.transactionHash);

  if (payment) {
    await createSale({
      ensNameId: transfer.ensNameId,
      sellerAddress: transfer.from,
      buyerAddress: transfer.to,
      salePriceWei: payment.value,
      transactionHash: transfer.transactionHash,
      blockNumber: transfer.blockNumber,
      source: 'other', // or detect marketplace
      saleDate: new Date(transfer.timestamp)
    });
  }
}
```

---

## Testing Checklist

- [ ] Run migration successfully
- [ ] Insert test sale record
- [ ] Verify listing auto-updated to 'sold' status
- [ ] Verify activity_history entries created for buyer and seller
- [ ] Test all API endpoints:
  - [ ] GET /api/v1/sales
  - [ ] GET /api/v1/sales/name/:name
  - [ ] GET /api/v1/sales/address/:address
  - [ ] GET /api/v1/sales/:name/analytics
- [ ] Verify indexes are being used (EXPLAIN ANALYZE)
- [ ] Test duplicate sale prevention (same transaction)
- [ ] Backfill historical sales if needed

---

## Benefits

1. **Clean Data Model** - Sales are first-class citizens like listings and offers
2. **Better Analytics** - Easy to query sales volume, average prices, trends
3. **Relationship Tracking** - Know which listing or offer led to each sale
4. **Auto-Updates** - Triggers keep listings/offers/activity in sync
5. **Marketplace Tracking** - Track sales across different platforms
6. **Fee Transparency** - Record platform and creator fees

---

## Next Steps

1. ✅ Create migration file
2. ✅ Document implementation plan
3. ⬜ Run migration on database
4. ⬜ Create sales service file
5. ⬜ Create sales routes file
6. ⬜ Register routes in index.ts
7. ⬜ Add TypeScript types
8. ⬜ Integrate with OpenSea event processor
9. ⬜ Integrate with blockchain indexer
10. ⬜ Add to API documentation
11. ⬜ Test all endpoints
12. ⬜ Deploy

---

## Questions to Consider

1. **Historical Data**: Do you want to backfill sales from existing `transactions` or `activity_history` tables?
2. **Duplicate Handling**: The migration uses `ON CONFLICT DO NOTHING` - is this the right behavior?
3. **Royalties**: Do you need more detailed royalty/fee tracking?
4. **Cancellations**: Should we track cancelled sales separately?
5. **Refunds**: Do we need to handle sale reversals?
