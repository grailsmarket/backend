# Add Last Sale Date to Search Endpoints

## Overview

Add `last_sale_date` field to search endpoints to show when an ENS name was last sold. This will be displayed alongside other name metadata in search results.

## Implementation Approach

We have two options for implementation:

### Option 1: Database Column (Recommended)
Add a `last_sale_date` column to the `ens_names` table that gets updated automatically via trigger when a sale is recorded.

**Pros:**
- Single source of truth in database
- Fast queries (no joins needed)
- Automatically synced to Elasticsearch
- Easy to filter and sort

**Cons:**
- Denormalized data (duplicates sale_date from sales table)
- Requires migration to add column

### Option 2: Query-Time JOIN
Calculate last_sale_date on-the-fly by joining with sales table.

**Pros:**
- No data duplication
- Always accurate

**Cons:**
- Slower queries (requires JOIN)
- More complex Elasticsearch sync
- Harder to index efficiently

**Decision: Use Option 1** - The performance and simplicity benefits outweigh the denormalization concern.

---

## Implementation Steps

### Step 1: Add Column to ens_names Table

**File**: `services/api/migrations/add_last_sale_date_to_ens_names.sql`

```sql
-- Add last_sale_date column to ens_names table
-- Migration: add_last_sale_date_to_ens_names
-- Created: 2025-10-21

-- Add the column
ALTER TABLE ens_names
ADD COLUMN last_sale_date TIMESTAMP DEFAULT NULL;

-- Create index for filtering and sorting
CREATE INDEX idx_ens_names_last_sale_date ON ens_names(last_sale_date DESC) WHERE last_sale_date IS NOT NULL;

-- Add comment
COMMENT ON COLUMN ens_names.last_sale_date IS 'Timestamp of the most recent sale of this ENS name';

-- Backfill existing data from sales table
UPDATE ens_names en
SET last_sale_date = (
    SELECT MAX(sale_date)
    FROM sales s
    WHERE s.ens_name_id = en.id
)
WHERE EXISTS (
    SELECT 1 FROM sales s WHERE s.ens_name_id = en.id
);

-- Create or replace the trigger function to update last_sale_date when a sale is recorded
CREATE OR REPLACE FUNCTION update_ens_name_last_sale_date()
RETURNS TRIGGER AS $$
BEGIN
    -- Update the ens_names table with the latest sale date
    UPDATE ens_names
    SET last_sale_date = NEW.sale_date,
        updated_at = NOW()
    WHERE id = NEW.ens_name_id
      -- Only update if this sale is newer than the current last_sale_date
      AND (last_sale_date IS NULL OR NEW.sale_date > last_sale_date);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger on sales table
DROP TRIGGER IF EXISTS update_last_sale_date_on_sale ON sales;
CREATE TRIGGER update_last_sale_date_on_sale
    AFTER INSERT ON sales
    FOR EACH ROW
    EXECUTE FUNCTION update_ens_name_last_sale_date();
```

**What this does:**
1. Adds `last_sale_date` column to `ens_names` table
2. Creates index for efficient filtering/sorting
3. Backfills existing sales data
4. Creates trigger that auto-updates when new sale is recorded
5. Only updates if new sale is more recent (handles out-of-order insertions)

### Step 2: Update Elasticsearch Sync

**File**: `services/wal-listener/src/services/elasticsearch.ts` (or wherever ES sync happens)

Add `last_sale_date` to the Elasticsearch mapping and sync:

```typescript
// Update the Elasticsearch index mapping
const ensNameMapping = {
  properties: {
    // ... existing fields ...
    last_sale_date: {
      type: 'date',
      format: 'strict_date_optional_time||epoch_millis'
    },
    // Denormalized field for easier filtering
    has_sales: {
      type: 'boolean'
    },
    days_since_last_sale: {
      type: 'integer'
    }
  }
};

// Update sync function to include last_sale_date
async function syncEnsNameToElasticsearch(ensName: any) {
  const now = new Date();

  // Calculate derived fields
  let hasSales = false;
  let daysSinceLastSale = null;

  if (ensName.last_sale_date) {
    hasSales = true;
    const lastSaleDate = new Date(ensName.last_sale_date);
    daysSinceLastSale = Math.floor((now.getTime() - lastSaleDate.getTime()) / (1000 * 60 * 60 * 24));
  }

  const document = {
    id: ensName.id,
    name: ensName.name,
    token_id: ensName.token_id,
    owner: ensName.owner_address,
    expiry_date: ensName.expiry_date,
    registration_date: ensName.registration_date,
    last_sale_date: ensName.last_sale_date,
    has_sales: hasSales,
    days_since_last_sale: daysSinceLastSale,
    // ... other fields ...
  };

  await esClient.index({
    index: 'ens_names',
    id: ensName.id.toString(),
    document
  });
}
```

### Step 3: Update Search Service

**File**: `services/api/src/services/search.ts`

Add filtering and sorting capabilities:

```typescript
export interface SearchFilters {
  // ... existing filters ...

  // Sale date filters
  hasSales?: boolean;
  lastSoldAfter?: string; // ISO date string
  lastSoldBefore?: string; // ISO date string
  minDaysSinceLastSale?: number;
  maxDaysSinceLastSale?: number;
}

export async function searchNames(query: SearchQuery) {
  const { q, page = 1, limit = 20, filters = {} } = query;

  const esQuery: any = {
    bool: {
      must: [],
      filter: []
    }
  };

  // ... existing query building ...

  // Add sale date filters
  if (filters.hasSales !== undefined) {
    filter.push({ term: { has_sales: filters.hasSales } });
  }

  if (filters.lastSoldAfter) {
    filter.push({
      range: {
        last_sale_date: {
          gte: filters.lastSoldAfter
        }
      }
    });
  }

  if (filters.lastSoldBefore) {
    filter.push({
      range: {
        last_sale_date: {
          lte: filters.lastSoldBefore
        }
      }
    });
  }

  if (filters.minDaysSinceLastSale !== undefined) {
    filter.push({
      range: {
        days_since_last_sale: {
          gte: filters.minDaysSinceLastSale
        }
      }
    });
  }

  if (filters.maxDaysSinceLastSale !== undefined) {
    filter.push({
      range: {
        days_since_last_sale: {
          lte: filters.maxDaysSinceLastSale
        }
      }
    });
  }

  // Add sort options
  let sort: any[] = [];

  if (filters.sortBy === 'last_sale_date') {
    sort.push({
      last_sale_date: {
        order: filters.sortOrder || 'desc',
        // Put items without sales at the end
        missing: '_last',
        unmapped_type: 'date'
      }
    });
  }

  // ... rest of search implementation ...

  return {
    results: hits.map(hit => hit._source),
    pagination: {
      page,
      limit,
      total: total.value,
      totalPages: Math.ceil(total.value / limit),
      hasNext: page * limit < total.value,
      hasPrev: page > 1
    }
  };
}
```

### Step 4: Update Listings Search Route

**File**: `services/api/src/routes/listings.ts`

Update the `/listings/search` endpoint to accept and pass through the new filters:

```typescript
fastify.get('/search', async (request, reply) => {
  const { q = '', page = '1', limit = '20', filters = {} } = request.query as any;

  // Extract sale date filters
  const {
    hasSales,
    lastSoldAfter,
    lastSoldBefore,
    minDaysSinceLastSale,
    maxDaysSinceLastSale,
    sortBy,
    sortOrder,
    // ... other filters ...
  } = filters;

  try {
    const searchFilters: any = {
      // ... existing filters ...
    };

    // Add sale date filters
    if (hasSales !== undefined) {
      searchFilters.hasSales = hasSales === 'true' || hasSales === true;
    }

    if (lastSoldAfter) {
      searchFilters.lastSoldAfter = lastSoldAfter;
    }

    if (lastSoldBefore) {
      searchFilters.lastSoldBefore = lastSoldBefore;
    }

    if (minDaysSinceLastSale !== undefined) {
      searchFilters.minDaysSinceLastSale = parseInt(minDaysSinceLastSale);
    }

    if (maxDaysSinceLastSale !== undefined) {
      searchFilters.maxDaysSinceLastSale = parseInt(maxDaysSinceLastSale);
    }

    if (sortBy) {
      searchFilters.sortBy = sortBy;
      searchFilters.sortOrder = sortOrder || 'desc';
    }

    const results = await searchNames({
      q,
      page: parseInt(page),
      limit: parseInt(limit),
      filters: searchFilters
    });

    return reply.send({
      success: true,
      data: results,
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0'
      }
    });
  } catch (error) {
    fastify.log.error(error);
    return reply.status(500).send({
      success: false,
      error: 'Search failed'
    });
  }
});
```

### Step 5: Update Frontend Types

**File**: `services/frontend/services/api/listings.ts`

```typescript
export interface SearchParams {
  q?: string;
  page?: number;
  limit?: number;
  minPrice?: string;
  maxPrice?: string;
  minLength?: number;
  maxLength?: number;
  hasEmoji?: boolean;
  hasNumbers?: boolean;
  showAll?: boolean;
  clubs?: string[];
  isExpired?: boolean;
  isGracePeriod?: boolean;
  isPremiumPeriod?: boolean;
  expiringWithinDays?: number;

  // New sale date filters
  hasSales?: boolean;
  lastSoldAfter?: string;
  lastSoldBefore?: string;
  minDaysSinceLastSale?: number;
  maxDaysSinceLastSale?: number;
  sortBy?: 'price' | 'created' | 'last_sale_date' | 'name';
  sortOrder?: 'asc' | 'desc';
}

async searchListings(params: SearchParams) {
  // ... existing implementation ...

  // Add new filters to query params
  if (params.hasSales !== undefined) {
    queryParams['filters[hasSales]'] = params.hasSales;
  }

  if (params.lastSoldAfter) {
    queryParams['filters[lastSoldAfter]'] = params.lastSoldAfter;
  }

  if (params.lastSoldBefore) {
    queryParams['filters[lastSoldBefore]'] = params.lastSoldBefore;
  }

  if (params.minDaysSinceLastSale !== undefined) {
    queryParams['filters[minDaysSinceLastSale]'] = params.minDaysSinceLastSale;
  }

  if (params.maxDaysSinceLastSale !== undefined) {
    queryParams['filters[maxDaysSinceLastSale]'] = params.maxDaysSinceLastSale;
  }

  if (params.sortBy) {
    queryParams['filters[sortBy]'] = params.sortBy;
  }

  if (params.sortOrder) {
    queryParams['filters[sortOrder]'] = params.sortOrder;
  }

  // ... rest of implementation ...
}
```

---

## Use Cases & Examples

### Use Case 1: Find Recently Sold Names
```bash
# Names sold in the last 7 days
GET /api/v1/listings/search?filters[maxDaysSinceLastSale]=7

# Names sold after a specific date
GET /api/v1/listings/search?filters[lastSoldAfter]=2025-10-01T00:00:00Z
```

### Use Case 2: Sort by Recent Sales
```bash
# Show most recently sold names first
GET /api/v1/listings/search?filters[sortBy]=last_sale_date&filters[sortOrder]=desc

# Show least recently sold names (potentially stale listings)
GET /api/v1/listings/search?filters[sortBy]=last_sale_date&filters[sortOrder]=asc
```

### Use Case 3: Find Names with No Sales History
```bash
# Names that have never been sold
GET /api/v1/listings/search?filters[hasSales]=false
```

### Use Case 4: Find "Hot" Names
```bash
# Names sold within last 30 days AND currently listed (likely flipping)
GET /api/v1/listings/search?filters[showAll]=false&filters[maxDaysSinceLastSale]=30
```

### Use Case 5: Find "Cold" Names
```bash
# Names that haven't sold in over a year
GET /api/v1/listings/search?filters[minDaysSinceLastSale]=365
```

---

## Frontend UI Components

### SearchPanel Component Update

Add new filter options to the search panel:

```typescript
// In SearchPanel.tsx
const [hasSales, setHasSales] = useState<boolean | undefined>(undefined);
const [maxDaysSinceLastSale, setMaxDaysSinceLastSale] = useState<number | ''>('');
const [sortBy, setSortBy] = useState<'price' | 'created' | 'last_sale_date' | 'name'>('created');

// In the JSX
<div>
  <label className="block text-sm font-medium text-gray-300 mb-2">
    Sale History
  </label>
  <select
    value={hasSales === undefined ? 'any' : hasSales ? 'true' : 'false'}
    onChange={(e) => setHasSales(e.target.value === 'any' ? undefined : e.target.value === 'true')}
    className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
  >
    <option value="any">Any Sale History</option>
    <option value="true">Has Been Sold</option>
    <option value="false">Never Sold</option>
  </select>
</div>

<div>
  <label className="block text-sm font-medium text-gray-300 mb-2">
    Last Sold Within (Days)
  </label>
  <input
    type="number"
    value={maxDaysSinceLastSale}
    onChange={(e) => setMaxDaysSinceLastSale(e.target.value ? parseInt(e.target.value) : '')}
    placeholder="e.g., 30 for names sold in last 30 days"
    min="0"
    className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
  />
  <p className="text-xs text-gray-400 mt-1">Find recently traded names</p>
</div>

<div>
  <label className="block text-sm font-medium text-gray-300 mb-2">
    Sort By
  </label>
  <select
    value={sortBy}
    onChange={(e) => setSortBy(e.target.value as any)}
    className="w-full bg-gray-900 text-white px-3 py-2 rounded-lg border border-gray-700 focus:border-purple-500 focus:outline-none"
  >
    <option value="created">Recently Listed</option>
    <option value="price">Price</option>
    <option value="name">Name</option>
    <option value="last_sale_date">Last Sale Date</option>
  </select>
</div>
```

### ListingCard Component Update

Display the last sale date on listing cards:

```typescript
// In ListingCard.tsx
interface ListingCardProps {
  listing: Listing & {
    last_sale_date?: string;
  };
}

export function ListingCard({ listing }: ListingCardProps) {
  const formatLastSale = (lastSaleDate?: string) => {
    if (!lastSaleDate) return null;

    const date = new Date(lastSaleDate);
    const now = new Date();
    const daysSince = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));

    if (daysSince === 0) return 'Today';
    if (daysSince === 1) return 'Yesterday';
    if (daysSince < 7) return `${daysSince} days ago`;
    if (daysSince < 30) return `${Math.floor(daysSince / 7)} weeks ago`;
    if (daysSince < 365) return `${Math.floor(daysSince / 30)} months ago`;
    return `${Math.floor(daysSince / 365)} years ago`;
  };

  return (
    <div className="bg-gray-800 rounded-lg p-6 hover:bg-gray-750 transition-all">
      {/* ... existing card content ... */}

      {listing.last_sale_date && (
        <div className="mt-3 pt-3 border-t border-gray-700">
          <div className="flex items-center gap-2 text-xs text-gray-400">
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Last sold: {formatLastSale(listing.last_sale_date)}</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## Testing Checklist

- [ ] Run migration to add `last_sale_date` column
- [ ] Verify backfill populated existing data correctly
- [ ] Insert test sale and verify trigger updates `last_sale_date`
- [ ] Verify Elasticsearch sync includes `last_sale_date`
- [ ] Test search filters:
  - [ ] `hasSales=true` returns only names with sales
  - [ ] `hasSales=false` returns only names without sales
  - [ ] `lastSoldAfter` filter works correctly
  - [ ] `lastSoldBefore` filter works correctly
  - [ ] `maxDaysSinceLastSale` filter works correctly
  - [ ] `minDaysSinceLastSale` filter works correctly
- [ ] Test sorting:
  - [ ] `sortBy=last_sale_date&sortOrder=desc` shows most recent first
  - [ ] `sortBy=last_sale_date&sortOrder=asc` shows oldest first
  - [ ] Names without sales appear at the end when sorting
- [ ] Test frontend:
  - [ ] Sale history filters appear in SearchPanel
  - [ ] Last sale date displays on listing cards
  - [ ] Filters update URL parameters correctly
- [ ] Performance test:
  - [ ] Query with sale date filter is fast (< 100ms)
  - [ ] Sorting by last_sale_date is fast (< 100ms)
  - [ ] Index is being used (check EXPLAIN ANALYZE)

---

## Performance Considerations

### Database
- Index on `last_sale_date` ensures fast filtering and sorting
- Partial index (`WHERE last_sale_date IS NOT NULL`) reduces index size
- Trigger only updates if new sale is more recent (prevents unnecessary writes)

### Elasticsearch
- Denormalized `days_since_last_sale` field avoids runtime calculations
- `has_sales` boolean field enables fast filtering
- Proper date mapping enables efficient range queries

### Frontend
- Cache formatted dates to avoid recalculation
- Use relative time formatting for better UX
- Lazy load sale history data if needed

---

## Benefits

1. **Better Discovery** - Users can find recently traded names
2. **Market Insights** - See which names are actively trading
3. **Price Context** - Last sale date helps determine if current price is fair
4. **Trend Analysis** - Track trading frequency over time
5. **Filtering Power** - Combine with other filters for precise searches

---

## Migration Order

Since this feature depends on the sales table:

1. ✅ Create `sales` table (already done)
2. ⬜ Run sales table migration
3. ⬜ Add `last_sale_date` column to `ens_names`
4. ⬜ Update Elasticsearch mapping
5. ⬜ Resync Elasticsearch index
6. ⬜ Update search service
7. ⬜ Update API routes
8. ⬜ Update frontend components
9. ⬜ Test end-to-end
10. ⬜ Deploy

---

## API Documentation Addition

Add to `API_DOCUMENTATION.md`:

### Search Filters - Sale History

```markdown
#### Sale Date Filters

| Parameter | Type | Description |
|-----------|------|-------------|
| filters[hasSales] | boolean | Filter by whether name has sales history |
| filters[lastSoldAfter] | string | ISO date - names sold after this date |
| filters[lastSoldBefore] | string | ISO date - names sold before this date |
| filters[minDaysSinceLastSale] | number | Minimum days since last sale |
| filters[maxDaysSinceLastSale] | number | Maximum days since last sale |
| filters[sortBy] | string | Sort field (price, created, last_sale_date, name) |
| filters[sortOrder] | string | Sort order (asc, desc) |

**Examples:**

```bash
# Find names sold in the last 30 days
GET /api/v1/listings/search?filters[maxDaysSinceLastSale]=30

# Find names that have never been sold
GET /api/v1/listings/search?filters[hasSales]=false

# Find names sold between two dates
GET /api/v1/listings/search?filters[lastSoldAfter]=2025-09-01&filters[lastSoldBefore]=2025-10-01

# Sort by most recently sold
GET /api/v1/listings/search?filters[sortBy]=last_sale_date&filters[sortOrder]=desc
```
```
