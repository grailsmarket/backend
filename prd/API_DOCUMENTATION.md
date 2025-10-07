# ENS Marketplace API Documentation

## Table of Contents
- [Overview](#overview)
- [Authentication](#authentication)
- [Base URL](#base-url)
- [Response Format](#response-format)
- [Error Handling](#error-handling)
- [Rate Limiting](#rate-limiting)
- [Endpoints](#endpoints)
  - [Health Check](#health-check)
  - [ENS Names](#ens-names)
  - [Search](#search)
  - [Listings](#listings)
  - [Offers](#offers)
  - [Orders](#orders)
  - [WebSocket](#websocket)
- [Advanced Search Features](#advanced-search-features)
- [Examples](#examples)

## Overview

The ENS Marketplace API provides a comprehensive interface for interacting with ENS (Ethereum Name Service) domain names, including listing, searching, making offers, and tracking transaction history. The API is built with performance and scalability in mind, featuring Elasticsearch-powered search, real-time WebSocket updates, and PostgreSQL-backed data persistence.

## Authentication

Currently, the API does not require authentication for read operations. Write operations will require authentication in future versions.

## Base URL

```
http://localhost:3000/api/v1
```

## Response Format

All API responses follow a consistent format:

```json
{
  "success": true,
  "data": {
    // Response data
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "1.0.0"
  }
}
```

Error responses:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message"
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

## Error Handling

| Status Code | Description |
|-------------|-------------|
| 200 | Success |
| 201 | Created |
| 400 | Bad Request - Invalid input |
| 404 | Not Found - Resource doesn't exist |
| 429 | Too Many Requests - Rate limit exceeded |
| 500 | Internal Server Error |

## Rate Limiting

Default rate limits:
- 100 requests per minute per IP address
- Configurable via environment variables

## Endpoints

### Health Check

#### GET /health

Check API health status and service connectivity.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "services": {
    "database": "connected",
    "elasticsearch": "connected",
    "redis": "connected"
  }
}
```

### ENS Names

#### GET /api/v1/names

List ENS names with filtering and pagination.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 20 | Items per page (max 100) |
| owner | string | - | Filter by owner address |
| status | enum | - | Filter by status: `available`, `listed`, `expiring` |
| sort | enum | created | Sort by: `name`, `price`, `expiry`, `created` |
| order | enum | desc | Sort order: `asc`, `desc` |

**Example Request:**
```bash
GET /api/v1/names?page=1&limit=10&status=listed&sort=price&order=asc
```

**Response:**
```json
{
  "success": true,
  "data": {
    "names": [
      {
        "id": 1,
        "token_id": "12345",
        "name": "example.eth",
        "owner_address": "0x123...",
        "expiry_date": "2025-01-01T00:00:00.000Z",
        "registration_date": "2024-01-01T00:00:00.000Z",
        "last_transfer_date": "2024-06-01T00:00:00.000Z",
        "listing_price": "1000000000000000000",
        "listing_status": "active",
        "listing_expires_at": "2024-12-01T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 100,
      "totalPages": 10,
      "hasNext": true,
      "hasPrev": false
    }
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "1.0.0"
  }
}
```

#### GET /api/v1/names/{name}

Get detailed information about a specific ENS name.

**Path Parameters:**
- `name` - The ENS name (e.g., "example.eth")

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "token_id": "12345",
    "name": "example.eth",
    "owner_address": "0x123...",
    "expiry_date": "2025-01-01T00:00:00.000Z",
    "registration_date": "2024-01-01T00:00:00.000Z",
    "listing_price": "1000000000000000000",
    "listing_status": "active",
    "listing_seller": "0x456...",
    "active_offers_count": 3,
    "recent_transactions": [
      {
        "transaction_hash": "0xabc...",
        "block_number": 18000000,
        "from_address": "0x123...",
        "to_address": "0x456...",
        "price_wei": "1000000000000000000",
        "transaction_type": "sale",
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    ]
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "1.0.0"
  }
}
```

#### GET /api/v1/names/{name}/history

Get transaction history for an ENS name.

**Path Parameters:**
- `name` - The ENS name

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20, max: 100)

**Response:**
```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": 1,
        "ens_name_id": 1,
        "transaction_hash": "0xabc...",
        "block_number": 18000000,
        "from_address": "0x123...",
        "to_address": "0x456...",
        "price_wei": "1000000000000000000",
        "transaction_type": "sale",
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 50,
      "totalPages": 3,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### Search

#### GET /api/v1/names/search

Advanced search with Elasticsearch integration.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| q | string | Yes | Search query |
| page | number | No | Page number (default: 1) |
| limit | number | No | Results per page (default: 20, max: 100) |
| filters.minPrice | string | No | Minimum price in wei |
| filters.maxPrice | string | No | Maximum price in wei |
| filters.minLength | number | No | Minimum character length |
| filters.maxLength | number | No | Maximum character length |
| filters.hasNumbers | boolean | No | Filter names with numbers |
| filters.hasEmoji | boolean | No | Filter names with emoji |

**Example Request:**
```bash
GET /api/v1/names/search?q=cool&filters[minLength]=4&filters[maxLength]=10&filters[hasNumbers]=false
```

**Response:**
```json
{
  "success": true,
  "data": {
    "results": [
      {
        "name": "coolname.eth",
        "token_id": "12345",
        "owner": "0x123...",
        "price": "1000000000000000000",
        "character_count": 8,
        "has_numbers": false,
        "has_emoji": false,
        "status": "listed",
        "tags": ["alphabetic", "8-letter"],
        "score": 9.5,
        "highlight": {
          "name": ["<em>cool</em>name.eth"]
        }
      }
    ],
    "total": 25,
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 25,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### Listings

#### GET /api/v1/listings

Get all listings with filtering and pagination.

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 20 | Items per page (max 100) |
| status | enum | active | Filter by status: `active`, `sold`, `cancelled`, `expired` |
| seller | string | - | Filter by seller address |
| minPrice | string | - | Minimum price in wei |
| maxPrice | string | - | Maximum price in wei |
| sort | enum | created | Sort by: `price`, `created`, `expiry`, `name` |
| order | enum | desc | Sort order: `asc`, `desc` |

**Example Request:**
```bash
GET /api/v1/listings?page=1&limit=10&status=active&sort=price&order=asc
```

**Response:**
```json
{
  "success": true,
  "data": {
    "listings": [
      {
        "id": 1,
        "ens_name_id": 1,
        "seller_address": "0x123...",
        "price_wei": "1000000000000000000",
        "currency_address": "0x0000000000000000000000000000000000000000",
        "order_hash": "0xabc...",
        "order_data": {},
        "status": "active",
        "created_at": "2024-01-01T00:00:00.000Z",
        "expires_at": "2024-12-31T23:59:59.000Z",
        "ens_name": "example.eth",
        "token_id": "12345",
        "current_owner": "0x123...",
        "name_expiry_date": "2025-01-01T00:00:00.000Z",
        "registration_date": "2024-01-01T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 100,
      "totalPages": 10,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

#### GET /api/v1/listings/name/{name}

Get active listing for a specific ENS name.

**Path Parameters:**
- `name` - ENS name (e.g., "example.eth")

**Example Request:**
```bash
GET /api/v1/listings/name/vitalik.eth
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "ens_name_id": 1,
    "seller_address": "0x123...",
    "price_wei": "1000000000000000000",
    "currency_address": "0x0000000000000000000000000000000000000000",
    "order_hash": "0xabc...",
    "order_data": {
      // Full Seaport order data
    },
    "status": "active",
    "created_at": "2024-01-01T00:00:00.000Z",
    "expires_at": "2024-12-31T23:59:59.000Z",
    "ens_name": "vitalik.eth",
    "token_id": "12345",
    "current_owner": "0x123...",
    "name_expiry_date": "2025-01-01T00:00:00.000Z"
  }
}
```

#### GET /api/v1/listings/{id}

Get listing by ID.

**Path Parameters:**
- `id` - Listing ID

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "ens_name_id": 1,
    "seller_address": "0x123...",
    "price_wei": "1000000000000000000",
    "order_data": {},
    "status": "active",
    "ens_name": "example.eth",
    "token_id": "12345"
  }
}
```

#### GET /api/v1/listings/search

Search listings using Elasticsearch.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| q | string | No | Search query for ENS names |
| page | number | No | Page number (default: 1) |
| limit | number | No | Results per page (default: 20) |
| minPrice | string | No | Minimum price filter |
| maxPrice | string | No | Maximum price filter |

**Example Request:**
```bash
GET /api/v1/listings/search?q=cool&minPrice=100000000000000000&maxPrice=1000000000000000000
```

**Response:**
```json
{
  "success": true,
  "data": {
    "listings": [
      {
        "id": 1,
        "price_wei": "500000000000000000",
        "ens_name": "coolname.eth",
        "seller_address": "0x123...",
        "order_data": {},
        "status": "active"
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
  }
}
```

#### POST /api/v1/listings

Create a new listing.

**Request Body:**
```json
{
  "ensNameId": 1,
  "sellerAddress": "0x123...",
  "priceWei": "1000000000000000000",
  "currencyAddress": "0x0000000000000000000000000000000000000000",
  "orderData": {},
  "expiresAt": "2024-12-31T23:59:59.000Z"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "ens_name_id": 1,
    "seller_address": "0x123...",
    "price_wei": "1000000000000000000",
    "currency_address": "0x0000000000000000000000000000000000000000",
    "order_hash": "0xdef...",
    "status": "active",
    "created_at": "2024-01-01T00:00:00.000Z",
    "expires_at": "2024-12-31T23:59:59.000Z"
  }
}
```

#### PUT /api/v1/listings/{id}

Update a listing.

**Path Parameters:**
- `id` - Listing ID

**Request Body:**
```json
{
  "priceWei": "2000000000000000000",
  "expiresAt": "2025-01-31T23:59:59.000Z"
}
```

#### DELETE /api/v1/listings/{id}

Cancel a listing.

**Path Parameters:**
- `id` - Listing ID

### Offers

#### POST /api/v1/offers

Create a new offer.

**Request Body:**
```json
{
  "ensNameId": 1,
  "buyerAddress": "0x789...",
  "offerAmountWei": "900000000000000000",
  "currencyAddress": "0x0000000000000000000000000000000000000000",
  "orderData": {},
  "expiresAt": "2024-12-31T23:59:59.000Z"
}
```

#### GET /api/v1/offers/{name}

Get offers for an ENS name.

**Path Parameters:**
- `name` - ENS name

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)
- `status` - Filter by status: `pending`, `accepted`, `rejected`, `expired`

**Response:**
```json
{
  "success": true,
  "data": {
    "offers": [
      {
        "id": 1,
        "ens_name_id": 1,
        "buyer_address": "0x789...",
        "offer_amount_wei": "900000000000000000",
        "currency_address": "0x0000000000000000000000000000000000000000",
        "status": "pending",
        "created_at": "2024-01-01T00:00:00.000Z",
        "expires_at": "2024-12-31T23:59:59.000Z"
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
  }
}
```

#### PUT /api/v1/offers/{id}

Update an offer.

**Path Parameters:**
- `id` - Offer ID

**Request Body:**
```json
{
  "offerAmountWei": "950000000000000000",
  "status": "accepted"
}
```

### Orders

#### POST /api/v1/orders/create

Create a Seaport order.

**Request Body:**
```json
{
  "tokenId": "12345",
  "price": "1000000000000000000",
  "currency": "0x0000000000000000000000000000000000000000",
  "duration": 7,
  "offerer": "0x123..."
}
```

#### POST /api/v1/orders/validate

Validate a Seaport order.

**Request Body:**
```json
{
  "orderData": {
    // Seaport order structure
  }
}
```

#### GET /api/v1/orders/{id}

Get order details by ID or hash.

**Path Parameters:**
- `id` - Order ID or order hash

#### DELETE /api/v1/orders/{id}

Cancel an order.

**Path Parameters:**
- `id` - Order ID or order hash

### WebSocket

#### WS /ws

Real-time updates via WebSocket connection.

**Connection:**
```javascript
const ws = new WebSocket('ws://localhost:3000/ws');
```

**Subscribe to events:**
```javascript
ws.send(JSON.stringify({
  type: 'subscribe',
  channels: ['listings', 'offers', 'sales']
}));
```

**Event Types:**
- `listing_created` - New listing created
- `listing_updated` - Listing price or status changed
- `listing_cancelled` - Listing cancelled
- `offer_created` - New offer received
- `offer_accepted` - Offer accepted
- `sale_completed` - Sale transaction completed

**Event Format:**
```json
{
  "type": "listing_created",
  "data": {
    "ensName": "example.eth",
    "price": "1000000000000000000",
    "seller": "0x123...",
    "timestamp": "2024-01-01T00:00:00.000Z"
  }
}
```

## Advanced Search Features

The search endpoint leverages Elasticsearch to provide powerful search capabilities:

### Search Strategies

1. **Exact Match**: Searches for exact ENS name matches
   ```
   GET /api/v1/names/search?q=coolname.eth
   ```

2. **Partial Match**: Uses n-gram analysis for partial name matching
   ```
   GET /api/v1/names/search?q=cool
   ```

3. **Fuzzy Search**: Automatically handles typos and similar names
   ```
   GET /api/v1/names/search?q=coll (finds "cool", "call", etc.)
   ```

### Filter Combinations

Filters can be combined for precise results:

```bash
# Find short premium names
GET /api/v1/names/search?q=*&filters[maxLength]=3&filters[hasNumbers]=false

# Find numeric domains in a price range
GET /api/v1/names/search?q=*&filters[hasNumbers]=true&filters[minPrice]=100000000000000000&filters[maxPrice]=1000000000000000000

# Find emoji domains
GET /api/v1/names/search?q=*&filters[hasEmoji]=true
```

### Search Tags

The system automatically tags ENS names:
- `short` - 3 characters or less
- `4-letter` - Exactly 4 characters
- `5-letter` - Exactly 5 characters
- `numeric` - Only numbers
- `alphabetic` - Only letters
- `emoji` - Contains emoji

### Sorting and Relevance

Search results are sorted by:
1. **Relevance Score** - How well the name matches the query
2. **Listing Date** - Recently listed names appear higher
3. **Price** - Can be configured in filters

## Examples

### Example 1: Find Available Premium Names

```bash
curl -X GET "http://localhost:3000/api/v1/names/search?q=*&filters[maxLength]=4&filters[hasNumbers]=false&filters[hasEmoji]=false" \
  -H "Accept: application/json"
```

### Example 2: Get Listing History

```bash
curl -X GET "http://localhost:3000/api/v1/names/vitalik.eth/history?page=1&limit=10" \
  -H "Accept: application/json"
```

### Example 3: Create a Listing

```bash
curl -X POST "http://localhost:3000/api/v1/listings" \
  -H "Content-Type: application/json" \
  -d '{
    "ensNameId": 1,
    "sellerAddress": "0x1234567890123456789012345678901234567890",
    "priceWei": "1000000000000000000",
    "expiresAt": "2024-12-31T23:59:59.000Z"
  }'
```

### Example 4: WebSocket Subscription

```javascript
const ws = new WebSocket('ws://localhost:3000/ws');

ws.onopen = () => {
  // Subscribe to all events
  ws.send(JSON.stringify({
    type: 'subscribe',
    channels: ['listings', 'offers', 'sales']
  }));
};

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  console.log('Received event:', data.type, data.data);
};
```

### Example 5: Advanced Search with Multiple Filters

```bash
# Find 4-5 letter alphabetic names under 1 ETH
curl -X GET "http://localhost:3000/api/v1/names/search?q=*&filters[minLength]=4&filters[maxLength]=5&filters[hasNumbers]=false&filters[hasEmoji]=false&filters[maxPrice]=1000000000000000000" \
  -H "Accept: application/json"
```

## Future Enhancements

The API is designed with extensibility in mind. Planned features include:

1. **Authentication & Authorization**
   - JWT-based authentication
   - Role-based access control
   - API key management

2. **Advanced Analytics**
   - Price history charts
   - Market trends
   - Volume statistics

3. **Bulk Operations**
   - Batch listing creation
   - Bulk offer management
   - CSV import/export

4. **Notification System**
   - Email notifications
   - Push notifications
   - Webhook integrations

5. **Advanced Filters**
   - Dictionary word detection
   - Brandable name scoring
   - Similar name suggestions

6. **Performance Optimizations**
   - GraphQL API endpoint
   - Response caching
   - Query optimization

## Support

For questions, issues, or feature requests, please open an issue in the GitHub repository.