# Activity History Backfill Plan - On-Chain Events

## Objective
Backfill and fix activity_history records for on-chain events with:
- Correct blockchain timestamps (from block timestamp, not DB insert time)
- Complete transaction data (transaction_hash, block_number)
- Enriched metadata (registration cost, premium for mints)

## Scope
**In Scope** (On-chain events):
- ✅ `mint` events - NameRegistered events from ENS Registrar
- ✅ `sent`/`received` events - Transfer events from ENS Registry
- ✅ `burn` events - Transfer to 0x0 (if applicable)

**Out of Scope** (Off-chain/marketplace events):
- ❌ `listed` - Already accurate, recorded when they occurred
- ❌ `offer_made` - Already accurate, recorded when they occurred  
- ❌ `bought`/`sold` - Will be handled separately via CSV import

## Data Source
**The Graph ENS Subgraph**: `ensnode-api-production-500f.up.railway.app/subgraph`

### Available Event Data

#### NameRegistered Event
```graphql
{
  registrations(where: {labelName_not: null}) {
    id
    domain {
      name
      labelName
      labelhash
    }
    registrant {
      id
    }
    expiryDate
    registrationDate
    cost          # Total cost paid (base + premium)
    
    events {
      transactionID
      blockNumber
    }
  }
}
```

**Metadata to Store**:
- `token_id` (from labelhash)
- `cost` (total registration cost in wei)
- `from_address` = "0x0000000000000000000000000000000000000000"

#### Transfer Event
```graphql
{
  transfers(where: {domain_: {labelName_not: null}}) {
    id
    domain {
      name
      labelName
      labelhash
    }
    owner {
      id
    }
    blockNumber
    transactionID
  }
}
```

**Event Types**:
- If `from` = 0x0 → `mint` event
- If `to` = 0x0 → `burn` event  
- Otherwise → `sent` (from perspective) and `received` (to perspective)

## Implementation Strategy

### Phase 1: Backfill MINT Events
**Goal**: Fix ~100k existing mint events + add ~500k missing ones

#### Step 1.1: Update Existing Mint Events
```
For each mint event in activity_history:
  1. Get token_id from metadata
  2. Query The Graph for NameRegistered event by labelhash
  3. UPDATE activity_history SET:
     - created_at = registrationDate (block timestamp)
     - transaction_hash = transactionID
     - block_number = blockNumber
     - metadata = metadata || {cost: cost}
  WHERE id = current_id
```

#### Step 1.2: Insert Missing Mint Events
```
For each ens_name where no mint event exists:
  1. Query The Graph for NameRegistered event by token_id/labelhash
  2. If found, INSERT INTO activity_history:
     - event_type = 'mint'
     - actor_address = registrant.id
     - platform = 'blockchain'
     - chain_id = 1
     - created_at = registrationDate
     - transaction_hash = transactionID
     - block_number = blockNumber
     - metadata = {token_id, cost, from_address: 0x0}
```

**Script**: `backfill-mint-events.ts`

### Phase 2: Backfill TRANSFER Events (sent/received)
**Goal**: Add complete ownership transfer history

#### Step 2.1: Query All Transfers for Our Names
```
For each ens_name:
  1. Query The Graph for all Transfer events by labelhash
  2. Filter out mints (already handled in Phase 1)
  3. For each transfer:
     - If sent event doesn't exist, INSERT with event_type='sent'
       - actor_address = from
       - counterparty_address = to
     - If received event doesn't exist, INSERT with event_type='received'
       - actor_address = to
       - counterparty_address = from
```

**De-duplication Strategy**:
- Check if event exists: `WHERE ens_name_id = X AND event_type = 'sent' AND transaction_hash = Y`
- If exists: UPDATE with correct timestamp
- If not: INSERT

**Script**: `backfill-transfer-events.ts`

### Phase 3: Backfill BURN Events (Optional)
**Goal**: Track names that were burned (transferred to 0x0)

```
Query The Graph for Transfer events where to = 0x0
For each burn:
  INSERT activity_history:
    - event_type = 'burn'
    - actor_address = from
    - counterparty_address = 0x0
    - created_at = block timestamp
    - transaction_hash = transactionID
    - block_number = blockNumber
```

**Script**: `backfill-burn-events.ts`

## Database Schema

### Current activity_history Columns
- ✅ `id` - Primary key
- ✅ `ens_name_id` - Reference to ens_names
- ✅ `event_type` - Enum (mint, burn, sent, received, etc.)
- ✅ `actor_address` - Who performed the action
- ✅ `counterparty_address` - Other party (nullable)
- ✅ `platform` - 'blockchain' for on-chain events
- ✅ `chain_id` - Always 1 for mainnet
- ✅ `price_wei` - Nullable (not used for transfers)
- ✅ `currency_address` - Nullable
- ✅ `transaction_hash` - **Will populate/update**
- ✅ `block_number` - **Will populate/update**
- ✅ `metadata` - JSONB for additional data
- ✅ `created_at` - **Will update to block timestamp**

### Metadata Structure by Event Type

#### Mint Event
```json
{
  "token_id": "12345...",
  "from_address": "0x0000000000000000000000000000000000000000",
  "cost": "1234567890123456789",
  "labelhash": "0xabc..."
}
```

#### Sent/Received Event
```json
{
  "token_id": "12345...",
  "labelhash": "0xabc..."
}
```

#### Burn Event
```json
{
  "token_id": "12345...",
  "to_address": "0x0000000000000000000000000000000000000000"
}
```

## The Graph Query Examples

### Query 1: Get NameRegistered Event by Labelhash
```graphql
query GetRegistration($labelhash: String!) {
  registrations(where: { domain_: { labelhash: $labelhash } }) {
    id
    domain {
      name
      labelName
      labelhash
    }
    registrant {
      id
    }
    registrationDate
    expiryDate
    cost
    events {
      id
      transactionID
      blockNumber
    }
  }
}
```

### Query 2: Get All Transfers for a Domain
```graphql
query GetTransfers($labelhash: String!) {
  transfers(
    where: { domain_: { labelhash: $labelhash } }
    orderBy: blockNumber
    orderDirection: asc
  ) {
    id
    domain {
      name
      labelhash
    }
    owner {
      id
    }
    blockNumber
    transactionID
  }
}
```

### Query 3: Batch Query Multiple Domains
```graphql
query GetMultipleRegistrations($labelhashes: [String!]) {
  registrations(where: { domain_: { labelhash_in: $labelhashes } }) {
    id
    domain {
      name
      labelName  
      labelhash
    }
    registrant {
      id
    }
    registrationDate
    cost
    events {
      transactionID
      blockNumber
    }
  }
}
```

## Implementation Details

### Script Structure
```typescript
// Common utilities
interface GraphQLResponse {
  registrations?: Registration[];
  transfers?: Transfer[];
}

async function queryTheGraph(query: string, variables: any): Promise<GraphQLResponse> {
  const response = await fetch(GRAPH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  return response.json();
}

async function updateActivityEvent(id: number, data: UpdateData) {
  await pool.query(`
    UPDATE activity_history 
    SET 
      created_at = $1,
      transaction_hash = $2,
      block_number = $3,
      metadata = metadata || $4::jsonb
    WHERE id = $5
  `, [data.timestamp, data.txHash, data.blockNumber, data.metadata, id]);
}

async function insertActivityEvent(event: ActivityEvent) {
  await pool.query(`
    INSERT INTO activity_history (
      ens_name_id, event_type, actor_address, counterparty_address,
      platform, chain_id, transaction_hash, block_number, metadata, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    ON CONFLICT (ens_name_id, event_type, transaction_hash) DO UPDATE
    SET created_at = EXCLUDED.created_at,
        block_number = EXCLUDED.block_number,
        metadata = EXCLUDED.metadata
  `, [...values]);
}
```

### Batching Strategy
- Process 50 names at a time
- Add 200ms delay between batches to avoid rate limiting
- Use transactions for data integrity
- Log progress every 100 records

### Resume Capability
```typescript
// Track progress in a state file
interface Progress {
  lastProcessedId: number;
  totalProcessed: number;
  errors: Array<{id: number, error: string}>;
}

// Save progress every 100 records
await fs.writeFile('backfill-progress.json', JSON.stringify(progress));
```

## Execution Plan

### Pre-flight Checks
1. ✅ Verify The Graph endpoint is accessible
2. ✅ Test query with single name
3. ✅ Backup activity_history table
4. ✅ Create progress tracking mechanism

### Execution Order
1. **Phase 1** (Mint Events) - Priority 1
   - Update existing: ~100k records
   - Insert missing: ~500k records
   - Estimated time: 3-4 hours

2. **Phase 2** (Transfer Events) - Priority 2
   - Insert all transfers: Unknown count
   - Estimated time: 6-8 hours

3. **Phase 3** (Burn Events) - Priority 3
   - Insert burns: Minimal count
   - Estimated time: 30 minutes

### Rollback Plan
If something goes wrong:
```sql
-- Restore from backup
BEGIN;
DELETE FROM activity_history WHERE created_at > '2025-01-XX'; -- Use backup timestamp
COPY activity_history FROM '/backup/activity_history.csv';
COMMIT;
```

## Success Metrics
- ✅ All mint events have `transaction_hash` and `block_number`
- ✅ All mint events have `cost` in metadata
- ✅ `created_at` matches blockchain timestamp (not DB insert time)
- ✅ ~600k mint events total (one per registered name)
- ✅ Transfer history is complete for ownership changes

## Monitoring
```sql
-- Check progress
SELECT 
  event_type,
  COUNT(*) as total,
  COUNT(transaction_hash) as with_tx,
  COUNT(block_number) as with_block,
  COUNT(CASE WHEN metadata ? 'cost' THEN 1 END) as with_cost
FROM activity_history
WHERE event_type IN ('mint', 'sent', 'received', 'burn')
GROUP BY event_type;

-- Check timestamp accuracy (should be old dates, not recent)
SELECT 
  event_type,
  MIN(created_at) as earliest,
  MAX(created_at) as latest
FROM activity_history
GROUP BY event_type;
```

## Next Steps
1. Review and approve this plan
2. Create backup of activity_history table
3. Implement `backfill-mint-events.ts` script
4. Test on small sample (100 records)
5. Run full backfill for mint events
6. Verify results
7. Proceed to transfer events if needed
