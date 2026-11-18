# ENS Metadata Fetching Guide

## Overview

This guide documents how to fetch and work with ENS (Ethereum Name Service) metadata using the Grails API. The API provides comprehensive access to ENS name information including ownership, expiry dates, text records, multi-chain addresses, and contenthash data.

## Table of Contents

- [Quick Start](#quick-start)
- [Metadata Types](#metadata-types)
- [API Endpoints](#api-endpoints)
- [Authentication](#authentication)
- [Rate Limiting](#rate-limiting)
- [Error Handling](#error-handling)
- [Code Examples](#code-examples)
- [Advanced Usage](#advanced-usage)

## Quick Start

### Base URL
```
http://localhost:3002/api/v1
```

### Basic Example - Get ENS Name Details

```bash
curl http://localhost:3002/api/v1/names/vitalik.eth
```

Response:
```json
{
  "success": true,
  "data": {
    "id": 12345,
    "token_id": "123456789",
    "name": "vitalik.eth",
    "owner_address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    "expiry_date": "2025-12-31T23:59:59.000Z",
    "registration_date": "2017-05-04T12:00:00.000Z",
    "metadata": {
      "avatar": "ipfs://QmSP4nq9fnN9dAiCj42ug9Wa79rqmQerZXZch82VqpiH7U/image.png",
      "description": "Ethereum co-founder",
      "url": "https://vitalik.ca",
      "email": "vitalik@ethereum.org",
      "twitter": "VitalikButerin",
      "github": "vbuterin",
      "chains": [
        {
          "coinType": 0,
          "chainName": "Bitcoin",
          "address": "bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh"
        },
        {
          "coinType": 2147483658,
          "chainId": 10,
          "chainName": "Optimism",
          "address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045"
        }
      ],
      "contenthash": {
        "protocol": "ipfs",
        "value": "QmRAQB6YaCyidP37UdDnjFY5vQuiBrcqdyoW1CuDgwxkD4",
        "raw": "0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f"
      }
    },
    "metadata_updated_at": "2025-01-15T10:30:00.000Z",
    "listings": [],
    "upvotes": 42,
    "downvotes": 3,
    "net_score": 39,
    "watchers_count": 128,
    "view_count": 1543
  },
  "meta": {
    "timestamp": "2025-01-16T14:30:00.000Z",
    "version": "1.0.0"
  }
}
```

## Metadata Types

### 1. Text Records

ENS supports arbitrary text records following [ENSIP-5](https://docs.ens.domains/ensip/5). Common keys include:

| Key | Description | Example |
|-----|-------------|---------|
| `avatar` | Profile image (IPFS, HTTP, or data URL) | `ipfs://QmSP4nq9fnN9...` |
| `description` | Short bio or description | `"Ethereum co-founder"` |
| `url` | Website or homepage | `"https://vitalik.ca"` |
| `email` | Email address | `"hello@example.com"` |
| `twitter` | Twitter username (no @) | `"VitalikButerin"` |
| `github` | GitHub username | `"vbuterin"` |
| `com.discord` | Discord username | `"user#1234"` |
| `com.reddit` | Reddit username | `"u/vbuterin"` |
| `com.telegram` | Telegram username | `"@username"` |
| `notice` | Legal or usage notice | `"© 2024 All rights reserved"` |
| `keywords` | Comma-separated keywords | `"ethereum,crypto,blockchain"` |

### 2. Address Records (Multi-Chain)

ENS names can resolve to addresses on multiple blockchains using [ENSIP-11](https://docs.ens.domains/ensip/11) (multi-chain address resolution).

**Address Record Format:**
```typescript
{
  coinType: number,        // SLIP-44 coin type or ENSIP-11 EVM chain ID
  chainId?: number,        // Chain ID for EVM chains
  chainName: string,       // Human-readable chain name
  address: string          // Formatted address for the chain
}
```

**Supported Chains:**
- Bitcoin (coinType: 0)
- Ethereum (coinType: 60)
- Litecoin (coinType: 2)
- Dogecoin (coinType: 3)
- EVM chains via ENSIP-11: `coinType = 0x80000000 + chainId`
  - Optimism (chainId: 10 → coinType: 2147483658)
  - Polygon (chainId: 137 → coinType: 2147483785)
  - Arbitrum (chainId: 42161 → coinType: 2147525809)
  - Base (chainId: 8453 → coinType: 2147492101)

### 3. Contenthash

ENS supports decentralized content storage pointers via [ENSIP-7](https://docs.ens.domains/ensip/7).

**Contenthash Format:**
```typescript
{
  protocol: string,  // 'ipfs', 'ipns', 'swarm', 'arweave', 'skynet', 'onion', 'onion3'
  value: string,     // Decoded content identifier
  raw?: string       // Raw hex bytes (optional)
}
```

**Examples:**
- IPFS: `{ protocol: "ipfs", value: "QmRAQB6YaCyidP37UdDnjFY5vQuiBrcqdyoW1CuDgwxkD4" }`
- IPNS: `{ protocol: "ipns", value: "k51qzi5uqu5dkkciu33khkzbcmxtyhn376i1e83tya8kuy7z9euedzyr5nhoew" }`
- Arweave: `{ protocol: "arweave", value: "jkSDc6bpJmQKN..." }`

## API Endpoints

### Get ENS Name Details

**Endpoint:** `GET /api/v1/names/:name`

Retrieves comprehensive information about an ENS name including metadata, listings, and user-specific data.

**Features:**
- Auto-imports from The Graph if name not in database
- Refreshes metadata if stale (>72 hours)
- Tracks view count asynchronously
- Supports optional authentication for personalized data

**Parameters:**
- `name` (path parameter): ENS name (with or without .eth suffix)

**Response Fields:**
```typescript
{
  id: number,
  token_id: string,
  name: string,
  owner_address: string,
  resolver_address?: string,
  expiry_date?: string,
  registration_date?: string,
  metadata: {
    [key: string]: string | AddressRecord[] | ContenthashRecord
  },
  metadata_updated_at?: string,
  listings: Listing[],
  upvotes: number,
  downvotes: number,
  net_score: number,
  watchers_count: number,
  is_user_watching: boolean,  // Requires authentication
  view_count: number
}
```

**Example:**
```bash
curl http://localhost:3002/api/v1/names/alice.eth
```

### Get Fresh Metadata (Always Up-to-Date)

**Endpoint:** `GET /api/v1/names/:name/metadata`

Always fetches fresh metadata directly from The Graph ENS subgraph, bypassing cache.

**Use Case:** When you need guaranteed up-to-date metadata (e.g., after a user updates their records).

**Parameters:**
- `name` (path parameter): ENS name

**Response:**
```typescript
{
  success: boolean,
  data: {
    name: string,
    metadata: {
      [key: string]: string | AddressRecord[] | ContenthashRecord
    },
    source: "graph"
  },
  meta: {
    timestamp: string,
    version: string
  }
}
```

**Example:**
```bash
curl http://localhost:3002/api/v1/names/bob.eth/metadata
```

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "bob.eth",
    "metadata": {
      "avatar": "https://example.com/avatar.jpg",
      "description": "Builder and creator",
      "url": "https://bob.example",
      "chains": [
        {
          "coinType": 60,
          "chainName": "Ethereum",
          "address": "0x1234567890123456789012345678901234567890"
        }
      ]
    },
    "source": "graph"
  },
  "meta": {
    "timestamp": "2025-01-16T14:35:00.000Z",
    "version": "1.0.0"
  }
}
```

### List ENS Names

**Endpoint:** `GET /api/v1/names`

List ENS names with pagination and filtering.

**Query Parameters:**
- `page` (integer, default: 1): Page number
- `limit` (integer, default: 20, max: 100): Results per page
- `owner` (string): Filter by owner address or ENS name
- `status` (enum): Filter by status (`available`, `listed`, `expiring`)
- `sort` (enum): Sort field (`name`, `price`, `expiry`, `created`)
- `order` (enum): Sort order (`asc`, `desc`)

**Example:**
```bash
# Get names owned by an address
curl "http://localhost:3002/api/v1/names?owner=0xd8da6bf26964af9d7eed9e03e53415d37aa96045&limit=10"

# Get listed names sorted by price
curl "http://localhost:3002/api/v1/names?status=listed&sort=price&order=asc"
```

### Get Transaction History

**Endpoint:** `GET /api/v1/names/:name/history`

Retrieve transaction history for an ENS name (transfers, registrations, renewals, sales).

**Query Parameters:**
- `page` (integer, default: 1): Page number
- `limit` (integer, default: 20): Results per page

**Example:**
```bash
curl "http://localhost:3002/api/v1/names/alice.eth/history?page=1&limit=20"
```

**Response:**
```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": 123,
        "transaction_hash": "0xabc...",
        "block_number": 18500000,
        "from_address": "0x123...",
        "to_address": "0x456...",
        "price_wei": "100000000000000000",
        "transaction_type": "sale",
        "timestamp": "2024-12-01T10:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 5,
      "totalPages": 1,
      "hasNext": false,
      "hasPrev": false
    }
  },
  "meta": {
    "timestamp": "2025-01-16T14:40:00.000Z",
    "version": "1.0.0"
  }
}
```

### Search ENS Names

**Endpoint:** `GET /api/v1/search`

Powerful search endpoint with filtering, sorting, and optional CSV export.

**Query Parameters:**
- `q` (string): Search query (name substring)
- `page` (integer): Page number
- `limit` (integer): Results per page
- `sortBy` (enum): Sort field
- `sortOrder` (enum): `asc` or `desc`
- `filters[...]`: Filter parameters (see Advanced Filtering)

**Example:**
```bash
# Search for names containing "alice"
curl "http://localhost:3002/api/v1/search?q=alice&limit=20"

# Search with filters
curl "http://localhost:3002/api/v1/search?filters[minLength]=3&filters[maxLength]=5&filters[hasNumbers]=false"
```

### Bulk Exact Search

**Endpoint:** `POST /api/v1/search/bulk`

Search for multiple specific ENS names in a single request (up to 10,000 names).

**Request Body:**
```typescript
{
  terms: string[],      // Array of ENS names to search (required)
  page?: number,        // Page number (default: 1)
  limit?: number        // Results per page (default: 20, max: 100)
}
```

**Response:** Returns results in the same order as input terms. Names not found return placeholder objects.

**Example:**
```bash
curl -X POST http://localhost:3002/api/v1/search/bulk \
  -H "Content-Type: application/json" \
  -d '{
    "terms": ["alice.eth", "bob.eth", "charlie.eth"],
    "page": 1,
    "limit": 10
  }'
```

## Authentication

Most endpoints support optional authentication via JWT tokens. Authentication enables:
- Personalized data (watchlist status, vote status)
- CSV export functionality
- Higher rate limits

**Using JWT Token:**
```bash
curl http://localhost:3002/api/v1/names/alice.eth \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

**Getting a Token:**
1. Authenticate via `/api/v1/auth/login` or wallet signature
2. Receive JWT token in response
3. Include token in subsequent requests

## Rate Limiting

The API implements rate limiting to ensure fair usage:

- **Default Limit:** 150 requests per minute per IP
- **Authenticated Users:** Higher limits may apply
- **Rate Limit Headers:** Response includes `X-RateLimit-*` headers

**Rate Limit Response:**
```json
{
  "success": false,
  "error": {
    "code": "RATE_LIMIT_EXCEEDED",
    "message": "Too many requests, please try again later"
  },
  "meta": {
    "timestamp": "2025-01-16T14:45:00.000Z"
  }
}
```

## Error Handling

All errors follow a consistent format:

```typescript
{
  success: false,
  error: {
    code: string,           // Machine-readable error code
    message: string,        // Human-readable message
    details?: any          // Additional context (optional)
  },
  meta: {
    timestamp: string
  }
}
```

**Common Error Codes:**

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `NAME_NOT_FOUND` | 404 | ENS name not found in database or on-chain |
| `INVALID_NAME` | 400 | Invalid ENS name format |
| `VALIDATION_ERROR` | 400 | Request validation failed |
| `UNAUTHORIZED` | 401 | Authentication required |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `SEARCH_ERROR` | 500 | Search service temporarily unavailable |

**Example Error Response:**
```json
{
  "success": false,
  "error": {
    "code": "NAME_NOT_FOUND",
    "message": "ENS name \"nonexistent.eth\" not found"
  },
  "meta": {
    "timestamp": "2025-01-16T14:50:00.000Z"
  }
}
```

## Code Examples

### JavaScript/Node.js

#### Basic Fetch

```javascript
async function getENSMetadata(name) {
  const response = await fetch(`http://localhost:3002/api/v1/names/${name}`);

  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error.message);
  }

  return data.data;
}

// Usage
const metadata = await getENSMetadata('vitalik.eth');
console.log('Owner:', metadata.owner_address);
console.log('Avatar:', metadata.metadata?.avatar);
console.log('Twitter:', metadata.metadata?.twitter);
```

#### Get Fresh Metadata

```javascript
async function getFreshMetadata(name) {
  const response = await fetch(
    `http://localhost:3002/api/v1/names/${name}/metadata`
  );
  const data = await response.json();
  return data.data.metadata;
}

// Usage
const metadata = await getFreshMetadata('alice.eth');
console.log('Metadata:', metadata);
```

#### Search with Filters

```javascript
async function searchENSNames(query, filters = {}) {
  const params = new URLSearchParams({
    q: query,
    page: 1,
    limit: 20,
  });

  // Add filters
  Object.entries(filters).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach(v => params.append(`filters[${key}][]`, v));
    } else {
      params.append(`filters[${key}]`, value);
    }
  });

  const response = await fetch(
    `http://localhost:3002/api/v1/search?${params}`
  );
  const data = await response.json();
  return data.data.results;
}

// Usage
const results = await searchENSNames('alice', {
  minLength: 3,
  maxLength: 10,
  clubs: ['999', '10k']
});
```

#### Bulk Search

```javascript
async function bulkSearchENS(names) {
  const response = await fetch('http://localhost:3002/api/v1/search/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      terms: names,
      page: 1,
      limit: 100,
    }),
  });

  const data = await response.json();
  return data.data.results;
}

// Usage
const names = ['alice.eth', 'bob.eth', 'charlie.eth'];
const results = await bulkSearchENS(names);
results.forEach(result => {
  if (result.id === 0) {
    console.log(`${result.name} not found`);
  } else {
    console.log(`${result.name} owned by ${result.owner}`);
  }
});
```

#### Extract Multi-Chain Addresses

```javascript
function getChainAddresses(metadata) {
  const chains = metadata.chains || [];
  const addresses = {};

  chains.forEach(chain => {
    addresses[chain.chainName] = chain.address;
  });

  return addresses;
}

// Usage
const metadata = await getENSMetadata('vitalik.eth');
const addresses = getChainAddresses(metadata.metadata);
console.log('Bitcoin:', addresses.Bitcoin);
console.log('Ethereum:', addresses.Ethereum);
console.log('Optimism:', addresses.Optimism);
```

#### Get IPFS Content from Contenthash

```javascript
function getIPFSUrl(metadata) {
  const contenthash = metadata.contenthash;

  if (!contenthash) {
    return null;
  }

  if (contenthash.protocol === 'ipfs') {
    return `https://ipfs.io/ipfs/${contenthash.value}`;
  } else if (contenthash.protocol === 'ipns') {
    return `https://ipfs.io/ipns/${contenthash.value}`;
  }

  return null;
}

// Usage
const metadata = await getENSMetadata('mysite.eth');
const url = getIPFSUrl(metadata.metadata);
if (url) {
  console.log('Website:', url);
}
```

### Python

```python
import requests
from typing import Optional, Dict, List, Any

class GrailsAPI:
    def __init__(self, base_url: str = "http://localhost:3002/api/v1"):
        self.base_url = base_url
        self.session = requests.Session()

    def get_ens_metadata(self, name: str) -> Dict[str, Any]:
        """Get ENS name details with cached metadata"""
        response = self.session.get(f"{self.base_url}/names/{name}")
        response.raise_for_status()
        data = response.json()

        if not data['success']:
            raise Exception(data['error']['message'])

        return data['data']

    def get_fresh_metadata(self, name: str) -> Dict[str, Any]:
        """Get fresh metadata directly from The Graph"""
        response = self.session.get(f"{self.base_url}/names/{name}/metadata")
        response.raise_for_status()
        data = response.json()

        if not data['success']:
            raise Exception(data['error']['message'])

        return data['data']['metadata']

    def search_names(self, query: str, filters: Optional[Dict] = None,
                     page: int = 1, limit: int = 20) -> List[Dict]:
        """Search ENS names with filters"""
        params = {'q': query, 'page': page, 'limit': limit}

        if filters:
            for key, value in filters.items():
                if isinstance(value, list):
                    for v in value:
                        params[f'filters[{key}][]'] = v
                else:
                    params[f'filters[{key}]'] = value

        response = self.session.get(f"{self.base_url}/search", params=params)
        response.raise_for_status()
        data = response.json()

        return data['data']['results']

    def bulk_search(self, names: List[str]) -> List[Dict]:
        """Bulk search for multiple ENS names"""
        response = self.session.post(
            f"{self.base_url}/search/bulk",
            json={'terms': names, 'page': 1, 'limit': len(names)}
        )
        response.raise_for_status()
        data = response.json()

        return data['data']['results']

# Usage example
api = GrailsAPI()

# Get metadata
metadata = api.get_ens_metadata('vitalik.eth')
print(f"Owner: {metadata['owner_address']}")
print(f"Twitter: {metadata['metadata'].get('twitter')}")

# Get fresh metadata
fresh = api.get_fresh_metadata('alice.eth')
print(f"Avatar: {fresh.get('avatar')}")

# Search with filters
results = api.search_names('alice', filters={
    'minLength': 3,
    'maxLength': 10,
    'hasNumbers': False
})
print(f"Found {len(results)} names")

# Bulk search
names = ['alice.eth', 'bob.eth', 'charlie.eth']
results = api.bulk_search(names)
for result in results:
    if result['id'] == 0:
        print(f"{result['name']} not found")
    else:
        print(f"{result['name']} owned by {result['owner']}")
```

### cURL Examples

```bash
# Basic name lookup
curl http://localhost:3002/api/v1/names/vitalik.eth

# Get fresh metadata
curl http://localhost:3002/api/v1/names/vitalik.eth/metadata

# Search with filters
curl "http://localhost:3002/api/v1/search?q=alice&filters[minLength]=3&filters[maxLength]=5"

# Bulk search
curl -X POST http://localhost:3002/api/v1/search/bulk \
  -H "Content-Type: application/json" \
  -d '{"terms": ["alice.eth", "bob.eth"], "limit": 10}'

# Get transaction history
curl "http://localhost:3002/api/v1/names/alice.eth/history?page=1&limit=20"

# List names by owner
curl "http://localhost:3002/api/v1/names?owner=0xd8da6bf26964af9d7eed9e03e53415d37aa96045"

# Authenticated request
curl http://localhost:3002/api/v1/names/alice.eth \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIs..."

# Export search results as CSV (requires authentication)
curl "http://localhost:3002/api/v1/search?export=true&filename=ens-export&limit=1000" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -o ens-export.csv
```

## Advanced Usage

### Advanced Filtering

The search endpoint supports extensive filtering via `filters[...]` parameters:

#### Character Filters

```bash
# Only names with numbers
curl "http://localhost:3002/api/v1/search?filters[hasNumbers]=true"

# Only names with emoji
curl "http://localhost:3002/api/v1/search?filters[hasEmoji]=true"

# Tri-state filters (include, exclude, only)
curl "http://localhost:3002/api/v1/search?filters[digits]=only"      # Only digits
curl "http://localhost:3002/api/v1/search?filters[letters]=exclude"  # No letters
curl "http://localhost:3002/api/v1/search?filters[emoji]=only"       # Only emoji
```

#### Pattern Filters

```bash
# Names containing "alice"
curl "http://localhost:3002/api/v1/search?filters[contains]=alice"

# Names starting with "alice"
curl "http://localhost:3002/api/v1/search?filters[startsWith]=alice"

# Names ending with "dao"
curl "http://localhost:3002/api/v1/search?filters[endsWith]=dao"

# Names NOT containing "test"
curl "http://localhost:3002/api/v1/search?filters[doesNotContain]=test"
```

#### Price and Length Filters

```bash
# Names priced between 0.1 and 1 ETH (in wei)
curl "http://localhost:3002/api/v1/search?filters[minPrice]=100000000000000000&filters[maxPrice]=1000000000000000000"

# Names with 3-5 characters
curl "http://localhost:3002/api/v1/search?filters[minLength]=3&filters[maxLength]=5"
```

#### Status Filters

```bash
# Only registered names (not expired)
curl "http://localhost:3002/api/v1/search?filters[status]=registered"

# Names in grace period
curl "http://localhost:3002/api/v1/search?filters[status]=grace"

# Multiple statuses (OR logic)
curl "http://localhost:3002/api/v1/search?filters[status]=registered,grace"
```

#### Club Filters

```bash
# Names in 999 club
curl "http://localhost:3002/api/v1/search?filters[clubs][]=999"

# Names in 999 OR 10k club
curl "http://localhost:3002/api/v1/search?filters[clubs][]=999&filters[clubs][]=10k"

# Names in any club
curl "http://localhost:3002/api/v1/search?filters[clubs][]=any"

# Names NOT in any club
curl "http://localhost:3002/api/v1/search?filters[clubs][]=none"
```

#### Listing and Offer Filters

```bash
# Only listed names
curl "http://localhost:3002/api/v1/search?filters[listed]=true"

# Only unlisted names
curl "http://localhost:3002/api/v1/search?filters[listed]=false"

# Names with offers
curl "http://localhost:3002/api/v1/search?filters[hasOffer]=true"

# Filter by marketplace
curl "http://localhost:3002/api/v1/search?filters[marketplace]=grails"
curl "http://localhost:3002/api/v1/search?filters[marketplace]=opensea"
```

### Sorting

```bash
# Sort by price (ascending)
curl "http://localhost:3002/api/v1/search?sortBy=price&sortOrder=asc"

# Sort by expiry date
curl "http://localhost:3002/api/v1/search?sortBy=expiry_date&sortOrder=desc"

# Sort alphabetically
curl "http://localhost:3002/api/v1/search?sortBy=alphabetical&sortOrder=asc"

# Sort by watchers count
curl "http://localhost:3002/api/v1/search?sortBy=watchers_count&sortOrder=desc"
```

### CSV Export

Export search results to CSV format (requires authentication):

```bash
curl "http://localhost:3002/api/v1/search?export=true&filename=ens-data&limit=5000" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -o ens-data.csv
```

**CSV Columns:**
- name
- owner_address
- expiry_date
- registration_date
- price_wei
- price_eth
- listing_currency
- listing_source
- highest_offer_wei
- highest_offer_eth
- watchers_count
- view_count
- clubs
- has_numbers
- has_emoji

### Metadata Caching Strategy

The API uses a 72-hour metadata cache to balance freshness and performance:

**Use cached endpoint** (`GET /api/v1/names/:name`) when:
- Displaying name information in lists or search results
- Metadata freshness is not critical
- You want faster response times

**Use fresh endpoint** (`GET /api/v1/names/:name/metadata`) when:
- User just updated their ENS records
- You need guaranteed up-to-date information
- Building real-time profile viewers

**Example Flow:**
```javascript
// Initial page load - use cached data
const cachedData = await fetch('/api/v1/names/alice.eth').then(r => r.json());

// User clicks "Refresh Metadata" button - fetch fresh data
async function refreshMetadata() {
  const fresh = await fetch('/api/v1/names/alice.eth/metadata').then(r => r.json());
  // Update UI with fresh metadata
  updateUI(fresh.data.metadata);
}
```

### Handling Wrapped Names

ENS Name Wrapper adds an extra layer to name ownership. The API automatically resolves wrapped names:

```javascript
async function getActualOwner(name) {
  const data = await fetch(`/api/v1/names/${name}`).then(r => r.json());

  // owner_address is already resolved to the actual owner
  // even if the name is wrapped
  return data.data.owner_address;
}
```

**Behind the scenes:**
1. API checks if owner is Name Wrapper contract (0xd4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401)
2. If wrapped, queries The Graph for `wrappedOwner`
3. Falls back to Name Wrapper contract `ownerOf()` if needed
4. Returns actual owner, not wrapper contract

### Pagination Best Practices

```javascript
async function fetchAllPages(query) {
  const allResults = [];
  let page = 1;
  let hasNext = true;

  while (hasNext) {
    const response = await fetch(
      `http://localhost:3002/api/v1/search?q=${query}&page=${page}&limit=100`
    );
    const data = await response.json();

    allResults.push(...data.data.results);
    hasNext = data.data.pagination.hasNext;
    page++;

    // Rate limiting: wait between requests
    if (hasNext) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  return allResults;
}
```

### Working with The Graph Directly

The API uses The Graph ENS subgraph internally. You can also query it directly for advanced use cases:

**Subgraph URL:**
```
https://gateway.thegraph.com/api/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH
```

**Example GraphQL Query:**
```graphql
query GetDomain($name: String!) {
  domains(where: { name: $name }) {
    id
    name
    labelhash
    owner {
      id
    }
    resolver {
      texts
      textChangeds {
        key
        value
      }
      multicoinAddrChangeds {
        coinType
        addr
      }
      contenthashChangeds {
        hash
      }
    }
    registration {
      expiryDate
      registrationDate
    }
  }
}
```

## Best Practices

### 1. Use Appropriate Endpoints

- **Listing/browsing:** Use cached `GET /api/v1/names/:name`
- **After user updates:** Use `GET /api/v1/names/:name/metadata`
- **Bulk operations:** Use `POST /api/v1/search/bulk`

### 2. Respect Rate Limits

- Implement exponential backoff for 429 responses
- Cache responses on your end when possible
- Use bulk endpoints instead of individual requests

### 3. Handle Errors Gracefully

```javascript
async function safeGetMetadata(name) {
  try {
    const response = await fetch(`/api/v1/names/${name}`);
    const data = await response.json();

    if (!data.success) {
      console.error(`API error: ${data.error.code}`, data.error.message);
      return null;
    }

    return data.data;
  } catch (error) {
    console.error('Network error:', error);
    return null;
  }
}
```

### 4. Optimize for Performance

- Use pagination for large result sets
- Request only the data you need
- Leverage CSV export for bulk data analysis
- Implement client-side caching

### 5. Validate ENS Names

```javascript
function isValidENSName(name) {
  // Basic validation
  if (!name || typeof name !== 'string') return false;

  // Must end with .eth (or allow API to add it)
  const normalized = name.toLowerCase();
  if (!normalized.endsWith('.eth')) {
    return false;
  }

  // Check for invalid characters (basic check)
  const label = normalized.slice(0, -4);
  if (label.length === 0) return false;

  return true;
}
```

## Troubleshooting

### Issue: Metadata is Outdated

**Solution:** Use the fresh metadata endpoint
```bash
curl http://localhost:3002/api/v1/names/name.eth/metadata
```

### Issue: Name Not Found

**Possible Causes:**
1. Name doesn't exist on-chain
2. Name recently registered (not indexed yet)
3. Typo in name

**Solution:** Verify name exists using The Graph or Etherscan

### Issue: Rate Limit Exceeded

**Solution:** Implement retry logic with exponential backoff
```javascript
async function fetchWithRetry(url, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    const response = await fetch(url);

    if (response.status !== 429) {
      return response;
    }

    // Exponential backoff: 1s, 2s, 4s
    const delay = Math.pow(2, i) * 1000;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  throw new Error('Max retries exceeded');
}
```

### Issue: Slow Response Times

**Possible Causes:**
1. Large result set without pagination
2. Complex filters forcing PostgreSQL fallback
3. Network latency

**Solutions:**
- Use smaller page sizes
- Simplify filters when possible
- Enable compression on HTTP client

## Support

For issues, questions, or feature requests:
- Check existing documentation in `/CLAUDE.md` and service-specific docs
- Review database schema in `services/api/prisma/schema.prisma`
- Examine source code in `services/api/src/routes/names.ts`

## Additional Resources

- [ENS Documentation](https://docs.ens.domains/)
- [ENSIP-5: Text Records](https://docs.ens.domains/ensip/5)
- [ENSIP-7: Contenthash](https://docs.ens.domains/ensip/7)
- [ENSIP-11: Multi-Chain Addresses](https://docs.ens.domains/ensip/11)
- [The Graph ENS Subgraph](https://thegraph.com/explorer/subgraphs/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH)
