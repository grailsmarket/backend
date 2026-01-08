# Search API Filters Documentation

**Endpoint:** `GET /api/v1/search`

**Query format:** `filters[filterName]=value`

**Pagination:** `page` (default: 1), `limit` (default: 20, max: 100)

**Sorting:** `sortBy` + `sortOrder` (asc/desc)

---

## Listing Status Filters

### `listed` (Recommended)
Unified filter for listing status. Use this instead of `showListings`/`showUnlisted`.

| Value | Description |
|-------|-------------|
| `true` | Only names with active listings |
| `false` | Only names without active listings |

```
?filters[listed]=true
```

### `showListings` / `showUnlisted` (Legacy)
Boolean filters for listing status. Prefer using `listed` instead.

| Filter | Value | Description |
|--------|-------|-------------|
| `showListings` | `true` | Only names with active listings |
| `showUnlisted` | `true` | Only names without active listings |

---

## Marketplace Filter

### `marketplace`
Filter by listing source/marketplace.

| Value | Description |
|-------|-------------|
| `grails` | Only names listed on Grails |
| `opensea` | Only names listed on OpenSea |

```
?filters[marketplace]=grails&filters[listed]=true
```

**Note:** Should be combined with `listed=true` to ensure results have active listings.

---

## Price Filters

| Filter | Type | Description | Example |
|--------|------|-------------|---------|
| `minPrice` | string (wei) | Minimum listing price | `1000000000000000000` (1 ETH) |
| `maxPrice` | string (wei) | Maximum listing price | `5000000000000000000` (5 ETH) |

```
?filters[minPrice]=1000000000000000000&filters[maxPrice]=5000000000000000000
```

**Note:** Prices are in wei. 1 ETH = 1000000000000000000 wei.

---

## Character Length Filters

| Filter | Type | Description |
|--------|------|-------------|
| `minLength` | number | Minimum label length (excluding .eth) |
| `maxLength` | number | Maximum label length (excluding .eth) |

```
# 3-4 character names
?filters[minLength]=3&filters[maxLength]=4
```

---

## Tri-State Character Filters

These filters support three states for fine-grained control:

| Value | Meaning |
|-------|---------|
| `include` | Names that contain this character type (mixed allowed) |
| `exclude` | Names that do NOT contain this character type |
| `only` | Names that contain ONLY this character type |

### `digits`
Filter by digit (0-9) content.

| Value | Example Matches | Example Non-Matches |
|-------|-----------------|---------------------|
| `include` | `abc123`, `999` | `abc`, `hello` |
| `exclude` | `abc`, `hello` | `abc123`, `999` |
| `only` | `123`, `999`, `0000` | `abc123`, `abc` |

```
?filters[digits]=only    # Digit-only names like 999.eth, 1234.eth
?filters[digits]=exclude # No digits allowed
```

### `letters`
Filter by letter (a-z, A-Z) content.

| Value | Example Matches | Example Non-Matches |
|-------|-----------------|---------------------|
| `include` | `abc`, `abc123` | `999`, `🔥` |
| `exclude` | `999`, `🔥🔥` | `abc`, `abc123` |
| `only` | `abc`, `hello` | `abc123`, `999` |

```
?filters[letters]=only   # Letter-only names like vitalik.eth
?filters[letters]=exclude # No letters allowed
```

### `emoji`
Filter by emoji content.

| Value | Example Matches | Example Non-Matches |
|-------|-----------------|---------------------|
| `include` | `🔥`, `fire🔥` | `abc`, `999` |
| `exclude` | `abc`, `999` | `🔥`, `fire🔥` |
| `only` | `🔥🔥🔥`, `😀` | `fire🔥`, `abc` |

```
?filters[emoji]=only     # Emoji-only names
?filters[emoji]=exclude  # No emoji allowed
```

### `repeatingChars`
Filter by whether all characters are the same.

| Value | Example Matches | Example Non-Matches |
|-------|-----------------|---------------------|
| `include` | Any name | N/A (always matches) |
| `exclude` | `abc`, `123` | `aaa`, `999`, `🔥🔥🔥` |
| `only` | `aaa`, `999`, `🔥🔥🔥` | `abc`, `123`, `ab` |

```
?filters[repeatingChars]=only  # Names like 999.eth, aaa.eth, 🔥🔥🔥.eth
```

---

## Legacy Boolean Character Filters

These are still supported but the tri-state filters above provide more control.

| Filter | Type | Description |
|--------|------|-------------|
| `hasNumbers` | boolean | `true` = contains digits, `false` = no digits |
| `hasEmoji` | boolean | `true` = contains emoji, `false` = no emoji |

---

## String Pattern Filters

| Filter | Type | Description |
|--------|------|-------------|
| `contains` | string | Label contains exact substring |
| `startsWith` | string | Label starts with prefix |
| `endsWith` | string | Label ends with suffix (before .eth) |

```
?filters[startsWith]=the    # Names starting with "the" (theblock.eth, etc.)
?filters[endsWith]=dao      # Names ending with "dao" (metadao.eth, etc.)
?filters[contains]=crypto   # Names containing "crypto"
```

**Note:** Matching is case-insensitive. The label is the name without `.eth`.

---

## Club Filters

### `clubs[]`
Filter by club membership. Multiple clubs use OR logic.

| Club | Description |
|------|-------------|
| `999` | 3-digit names (000-999) |
| `10k` | 4-digit names (0000-9999) |
| `100k` | 5-digit names (00000-99999) |
| `24h` | Time-based names (00:00-23:59) |
| `aaa` | 3-letter names |
| `aaaa` | 4-letter names |

```
# Names in 999 OR 10k club
?filters[clubs][]=999&filters[clubs][]=10k
```

### `inAnyClub`
Boolean filter for club membership.

| Value | Description |
|-------|-------------|
| `true` | Names in at least one club |
| `false` | Names not in any club |

```
?filters[inAnyClub]=true
```

---

## Expiration Status Filters

### `status` (Recommended)
Unified expiration status filter. Use this instead of individual boolean filters.

| Value | Description | Time Range |
|-------|-------------|------------|
| `registered` | Active, non-expired names | expiry > now |
| `grace` | In 90-day grace period | expired 0-90 days ago |
| `premium` | In premium auction period | expired 90-111 days ago |
| `available` | Available for registration | expired > 111 days ago |

```
?filters[status]=registered  # Active names only
?filters[status]=grace       # Grace period names
```

### Legacy Boolean Filters
Still supported but `status` is preferred.

| Filter | Type | Description |
|--------|------|-------------|
| `isExpired` | boolean | `true` = expired, `false` = not expired |
| `isGracePeriod` | boolean | `true` = in 90-day grace period |
| `isPremiumPeriod` | boolean | `true` = in premium auction (90-111 days) |
| `expiringWithinDays` | number | Expiring within X days from now |

```
?filters[expiringWithinDays]=30  # Expiring in next 30 days
```

---

## Sale History Filters

| Filter | Type | Description |
|--------|------|-------------|
| `hasSales` | boolean | `true` = has sale history, `false` = never sold |
| `lastSoldAfter` | ISO date | Sold on or after this date |
| `lastSoldBefore` | ISO date | Sold on or before this date |

```
?filters[hasSales]=true&filters[lastSoldAfter]=2024-01-01T00:00:00Z
```

---

## Offer Filter

### `hasOffer`
Filter by whether the name has active offers.

| Value | Description |
|-------|-------------|
| `true` | Names with at least one active offer |
| `false` | Names without any offers |

```
?filters[hasOffer]=true
```

---

## Owner Filter

| Filter | Type | Description |
|--------|------|-------------|
| `owner` | address | Filter by owner wallet address |

```
?filters[owner]=0xd8da6bf26964af9d7eed9e03e53415d37aa96045
```

---

## Sorting

### Sort Options

| Value | Description |
|-------|-------------|
| `price` | Sort by listing price |
| `expiry_date` | Sort by expiration date |
| `registration_date` | Sort by registration date |
| `last_sale_date` | Sort by last sale date |
| `character_count` | Sort by name length |
| `watchers_count` | Sort by watcher count |
| `alphabetical` | Sort by name (A-Z or Z-A) |

### Sort Order

| Value | Description |
|-------|-------------|
| `asc` | Ascending (A-Z, lowest first) |
| `desc` | Descending (Z-A, highest first) |

```
?sortBy=alphabetical&sortOrder=asc   # A-Z
?sortBy=price&sortOrder=desc          # Highest price first
```

---

## Example Queries

### Premium 3-digit names
```
?filters[clubs][]=999&filters[listed]=true&sortBy=price&sortOrder=asc
```

### Cheap 4-letter names under 1 ETH
```
?filters[letters]=only&filters[minLength]=4&filters[maxLength]=4&filters[listed]=true&filters[maxPrice]=1000000000000000000
```

### Repeating digit names (999, 1111, etc.)
```
?filters[repeatingChars]=only&filters[digits]=only&filters[maxLength]=4
```

### Names starting with "meta" that are listed on Grails
```
?filters[startsWith]=meta&filters[marketplace]=grails&filters[listed]=true
```

### Names expiring soon with active offers
```
?filters[expiringWithinDays]=30&filters[hasOffer]=true
```

### Emoji-only names without active listings
```
?filters[emoji]=only&filters[listed]=false
```

### Recently sold names in the 10k club
```
?filters[clubs][]=10k&filters[hasSales]=true&filters[lastSoldAfter]=2024-06-01T00:00:00Z&sortBy=last_sale_date&sortOrder=desc
```

---

## Filter Combinations

Filters are combined with AND logic. For example:

```
?filters[digits]=only&filters[minLength]=3&filters[maxLength]=3&filters[listed]=true
```

This returns names that:
- Contain ONLY digits AND
- Are exactly 3 characters AND
- Have an active listing

---

## Response Format

```json
{
  "success": true,
  "data": {
    "results": [
      {
        "name": "999.eth",
        "owner": "0x...",
        "expiry_date": "2025-12-31T00:00:00.000Z",
        "clubs": ["999"],
        "listings": [
          {
            "status": "active",
            "price": "1000000000000000000",
            "source": "opensea"
          }
        ],
        "highest_offer_wei": "500000000000000000",
        "last_sale_date": "2024-01-15T00:00:00.000Z",
        "has_numbers": true,
        "has_emoji": false
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "totalPages": 8
    }
  }
}
```
