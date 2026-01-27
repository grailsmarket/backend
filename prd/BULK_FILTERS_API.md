# Bulk Search with Filters API

**Endpoint:** `POST /api/v1/search/bulk-filters`

Search for multiple ENS names with filter and sort support. Unlike the regular `/search/bulk` endpoint, this endpoint:
- Applies filters during search (only returns names matching both terms AND filter criteria)
- Paginates the filtered results (not the input terms)
- Does NOT return placeholder objects for not-found or filtered-out terms

---

## Request Format

```json
{
  "terms": ["vitalik", "ethereum", "opensea"],
  "page": 1,
  "limit": 20,
  "sortBy": "price",
  "sortOrder": "asc",
  "filters": {
    "showListings": true,
    "minPrice": "1000000000000000000"
  }
}
```

### Required Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `terms` | `string[]` | Array of ENS names to search (1-10,000 terms). Terms are normalized: `.eth` suffix is added if missing, case is ignored. |

### Optional Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `page` | `number` | 1 | Page number for pagination |
| `limit` | `number` | 20 | Results per page (max: 100) |
| `sortBy` | `string` | - | Sort field (see Sort Options below) |
| `sortOrder` | `"asc"` \| `"desc"` | `"desc"` | Sort direction |
| `filters` | `object` | - | Filter criteria (see Filter Options below) |

---

## Response Format

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "id": 12345,
        "name": "vitalik.eth",
        "token_id": "...",
        "owner": "0x...",
        "expiry_date": "2025-09-01T00:00:00.000Z",
        "registration_date": "2017-06-19T00:00:00.000Z",
        "clubs": ["10k"],
        "has_numbers": false,
        "has_emoji": false,
        "listings": [
          {
            "id": 1,
            "price": "10000000000000000000",
            "status": "active",
            "source": "opensea"
          }
        ],
        "highest_offer_wei": "5000000000000000000",
        "watchers_count": 42,
        "view_count": 1234
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 2,
      "totalPages": 1,
      "hasNext": false,
      "hasPrev": false
    },
    "stats": {
      "inputTerms": 3,
      "matchedTerms": 2
    }
  },
  "meta": {
    "timestamp": "2025-01-26T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

### Response Fields

| Field | Description |
|-------|-------------|
| `results` | Array of matching ENS names with full details |
| `pagination.total` | Total number of names matching terms AND filters |
| `pagination.totalPages` | Total pages available |
| `stats.inputTerms` | Number of terms provided in request |
| `stats.matchedTerms` | Number of terms that exist AND pass filters (same as `total`) |

---

## Sort Options

| Value | Description |
|-------|-------------|
| `price` | Sort by listing price |
| `expiry_date` | Sort by expiration date |
| `registration_date` | Sort by registration date |
| `last_sale_date` | Sort by last sale date |
| `last_sale_price` | Sort by last sale price |
| `character_count` | Sort by name length (excluding .eth) |
| `watchers_count` | Sort by number of watchers |
| `alphabetical` | Sort alphabetically by name |
| `offer` | Sort by highest offer |

---

## Filter Options

All filters from the regular search endpoint are supported:

### Listing Filters

| Filter | Type | Description |
|--------|------|-------------|
| `showListings` | `boolean` | Only names with active listings |
| `showUnlisted` | `boolean` | Only names without active listings |
| `listed` | `boolean` | Unified listing filter (`true` = listed, `false` = unlisted) |
| `hasOffer` | `boolean` | Filter by offer status |
| `marketplace` | `"grails"` \| `"opensea"` \| `"all"` | Filter by listing source |

### Price Filters

| Filter | Type | Description |
|--------|------|-------------|
| `minPrice` | `string` | Minimum price in wei |
| `maxPrice` | `string` | Maximum price in wei |
| `minOffer` | `string` | Minimum offer in wei |
| `maxOffer` | `string` | Maximum offer in wei |

### Length Filters

| Filter | Type | Description |
|--------|------|-------------|
| `minLength` | `number` | Minimum label length (excluding .eth) |
| `maxLength` | `number` | Maximum label length (excluding .eth) |

### Character Filters

| Filter | Type | Description |
|--------|------|-------------|
| `hasNumbers` | `boolean` | Contains/excludes digits |
| `hasEmoji` | `boolean` | Contains/excludes emoji |
| `digits` | `"include"` \| `"exclude"` \| `"only"` | Tri-state digit filter |
| `letters` | `"include"` \| `"exclude"` \| `"only"` | Tri-state letter filter |
| `emoji` | `"include"` \| `"exclude"` \| `"only"` | Tri-state emoji filter |
| `repeatingChars` | `"include"` \| `"exclude"` \| `"only"` | Filter by repeating characters |

### String Pattern Filters

| Filter | Type | Description |
|--------|------|-------------|
| `contains` | `string` | Name contains substring |
| `startsWith` | `string` | Name starts with prefix |
| `endsWith` | `string` | Name ends with suffix (before .eth) |
| `doesNotContain` | `string` | Name does not contain substring |
| `doesNotStartWith` | `string` | Name does not start with prefix |
| `doesNotEndWith` | `string` | Name does not end with suffix |

### Club Filters

| Filter | Type | Description |
|--------|------|-------------|
| `clubs` | `string[]` | Filter by club membership (e.g., `["999", "10k"]`) |
| `excludeClubs` | `string[]` | Exclude specific clubs |
| `inAnyClub` | `boolean` | In any club / not in any club |

### Status/Expiration Filters

| Filter | Type | Description |
|--------|------|-------------|
| `status` | `string` \| `string[]` | Registration status: `"registered"`, `"grace"`, `"premium"`, `"available"` |
| `isExpired` | `boolean` | Expired / not expired |
| `isGracePeriod` | `boolean` | In 90-day grace period |
| `isPremiumPeriod` | `boolean` | In premium auction period (90-111 days after expiry) |
| `expiringWithinDays` | `number` | Expiring within X days |
| `includeExpired` | `boolean` | Include expired names in results |

### Sale History Filters

| Filter | Type | Description |
|--------|------|-------------|
| `hasSales` | `boolean` | Has/lacks sale history |
| `lastSoldAfter` | `string` | Sold after date (ISO format) |
| `lastSoldBefore` | `string` | Sold before date (ISO format) |
| `minDaysSinceLastSale` | `number` | Minimum days since last sale |
| `maxDaysSinceLastSale` | `number` | Maximum days since last sale |

### Owner Filter

| Filter | Type | Description |
|--------|------|-------------|
| `owner` | `string` | Filter by owner address or ENS name |

---

## Examples

### Basic Search

Find specific names from a list:

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["vitalik", "ethereum", "opensea", "grails"]
  }'
```

### Find Listed Names Only

From a list, return only names that have active listings:

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["vitalik", "ethereum", "opensea"],
    "filters": {
      "showListings": true
    }
  }'
```

### Find Listed Names Sorted by Price

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["vitalik", "ethereum", "opensea"],
    "filters": {
      "showListings": true
    },
    "sortBy": "price",
    "sortOrder": "asc"
  }'
```

### Find Names in Price Range

Find names priced between 1-10 ETH:

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["vitalik", "ethereum", "opensea"],
    "filters": {
      "showListings": true,
      "minPrice": "1000000000000000000",
      "maxPrice": "10000000000000000000"
    }
  }'
```

### Find 3-Letter Names in 999 Club

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["eth", "btc", "sol", "xrp", "ada"],
    "filters": {
      "maxLength": 3,
      "clubs": ["999"]
    }
  }'
```

### Find Expiring Names

From a watchlist, find names expiring within 30 days:

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["name1", "name2", "name3"],
    "filters": {
      "expiringWithinDays": 30
    },
    "sortBy": "expiry_date",
    "sortOrder": "asc"
  }'
```

### Find Names with Offers

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["vitalik", "ethereum", "opensea"],
    "filters": {
      "hasOffer": true
    },
    "sortBy": "offer",
    "sortOrder": "desc"
  }'
```

### Paginated Results

Get page 2 with 10 results per page:

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["name1", "name2", "name3", "name4", "name5", "name6", "name7", "name8", "name9", "name10", "name11", "name12"],
    "page": 2,
    "limit": 10
  }'
```

### Complex Filter Combination

Find registered (not expired), listed names with numbers, sorted by price:

```bash
curl -X POST http://localhost:3000/api/v1/search/bulk-filters \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["001", "123", "999", "1234", "0000"],
    "filters": {
      "showListings": true,
      "status": "registered",
      "hasNumbers": true,
      "minLength": 3,
      "maxLength": 4
    },
    "sortBy": "price",
    "sortOrder": "asc"
  }'
```

---

## Error Responses

### Validation Error

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [
      {
        "code": "too_small",
        "minimum": 1,
        "type": "array",
        "inclusive": true,
        "exact": false,
        "message": "Array must contain at least 1 element(s)",
        "path": ["terms"]
      }
    ]
  },
  "meta": {
    "timestamp": "2025-01-26T12:00:00.000Z"
  }
}
```

### Server Error

```json
{
  "success": false,
  "error": {
    "code": "SEARCH_ERROR",
    "message": "Bulk filters search failed"
  },
  "meta": {
    "timestamp": "2025-01-26T12:00:00.000Z"
  }
}
```

---

## Comparison with /search/bulk

| Feature | `/search/bulk` | `/search/bulk-filters` |
|---------|----------------|------------------------|
| Filters | None | Full filter support |
| Sorting | None (preserves input order) | Full sort support |
| Pagination | Paginates input terms | Paginates filtered results |
| Not-found terms | Returns placeholder objects | Omits from results |
| Use case | Check if names exist | Find names matching criteria |

---

## Frontend Integration (TypeScript)

```typescript
interface BulkFiltersRequest {
  terms: string[];
  page?: number;
  limit?: number;
  sortBy?: 'price' | 'expiry_date' | 'registration_date' | 'last_sale_date' |
           'last_sale_price' | 'character_count' | 'watchers_count' | 'alphabetical' | 'offer';
  sortOrder?: 'asc' | 'desc';
  filters?: {
    showListings?: boolean;
    showUnlisted?: boolean;
    minPrice?: string;
    maxPrice?: string;
    minLength?: number;
    maxLength?: number;
    clubs?: string[];
    status?: string | string[];
    expiringWithinDays?: number;
    // ... other filters
  };
}

async function bulkFiltersSearch(request: BulkFiltersRequest) {
  const response = await fetch('/api/v1/search/bulk-filters', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  });
  return response.json();
}

// Example usage
const results = await bulkFiltersSearch({
  terms: ['vitalik', 'ethereum', 'opensea'],
  filters: { showListings: true },
  sortBy: 'price',
  sortOrder: 'asc',
});

console.log(`Found ${results.data.stats.matchedTerms} of ${results.data.stats.inputTerms} names`);
```
