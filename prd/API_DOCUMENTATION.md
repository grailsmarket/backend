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
  - [Authentication (SIWE)](#authentication-siwe)
  - [Users](#users)
  - [ENS Names](#ens-names)
  - [Search](#search)
  - [Listings](#listings)
  - [Offers](#offers)
  - [Orders](#orders)
  - [Clubs](#clubs)
  - [Votes](#votes)
  - [Watchlist](#watchlist)
  - [Notifications](#notifications)
  - [Sales](#sales)
  - [Profiles](#profiles)
  - [Activity](#activity)
  - [WebSocket](#websocket)
- [Advanced Search Features](#advanced-search-features)
- [Examples](#examples)

## Overview

The ENS Marketplace API provides a comprehensive interface for interacting with ENS (Ethereum Name Service) domain names, including listing, searching, making offers, and tracking transaction history. The API features:

- **Authentication**: Sign-In with Ethereum (SIWE/EIP-4361) for wallet-based authentication
- **Search**: Elasticsearch-powered search with advanced filtering
- **Real-time Updates**: WebSocket support for live marketplace events
- **Social Features**: Voting, watchlists, and clubs for categorizing names
- **Analytics**: Activity feeds and comprehensive transaction history

## Authentication

The API uses **Sign-In with Ethereum (SIWE)** standard (EIP-4361) for authentication. This allows users to authenticate using their Ethereum wallet without passwords.

### Authentication Flow:
1. Request a nonce from `GET /api/v1/auth/nonce?address=0x...`
2. Sign the SIWE message with the nonce using your wallet
3. Submit the signed message to `POST /api/v1/auth/verify`
4. Receive a JWT token to use in subsequent authenticated requests
5. Include the token in the `Authorization` header: `Bearer <token>`

### Protected Endpoints:
Some endpoints require authentication and will return `401 Unauthorized` without a valid token.

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
| 401 | Unauthorized - Authentication required |
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

---

### Authentication (SIWE)

#### GET /api/v1/auth/nonce

Request a cryptographic nonce for SIWE authentication.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| address | string | Yes | Ethereum address (0x...) |

**Example Request:**
```bash
GET /api/v1/auth/nonce?address=0x1234567890123456789012345678901234567890
```

**Response:**
```json
{
  "success": true,
  "data": {
    "nonce": "f4d3c2b1a09876543210",
    "expiresAt": "2024-01-01T00:05:00.000Z"
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "1.0.0"
  }
}
```

**Notes:**
- Nonce expires in 5 minutes
- Previous unused nonces for the address are automatically invalidated

#### POST /api/v1/auth/verify

Verify SIWE signature and create an authenticated session.

**Request Body:**
```json
{
  "message": "localhost:3000 wants you to sign in with your Ethereum account:\n0x123...",
  "signature": "0xabc..."
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "address": "0x1234567890123456789012345678901234567890",
      "email": null,
      "emailVerified": false,
      "telegram": null,
      "discord": null,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "lastSignIn": "2024-01-01T00:00:00.000Z"
    }
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "1.0.0"
  }
}
```

#### GET /api/v1/auth/me

Get current authenticated user information.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "address": "0x1234567890123456789012345678901234567890",
    "email": "user@example.com",
    "emailVerified": true,
    "telegram": "@username",
    "discord": "username#1234",
    "createdAt": "2024-01-01T00:00:00.000Z",
    "updatedAt": "2024-01-01T00:00:00.000Z",
    "lastSignIn": "2024-01-01T00:00:00.000Z"
  }
}
```

#### POST /api/v1/auth/logout

Logout user (client should discard JWT token).

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Logged out successfully"
  }
}
```

---

### Users

#### PATCH /api/v1/users/me

Update current user profile.

**Authentication:** Required

**Request Body:**
```json
{
  "email": "user@example.com",
  "telegram": "@username",
  "discord": "username#1234"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "address": "0x123...",
    "email": "user@example.com",
    "telegram": "@username",
    "discord": "username#1234",
    "updatedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

---

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
    "upvotes": 42,
    "downvotes": 3,
    "net_score": 39,
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

---

### Search

#### GET /api/v1/names/search

Advanced search with Elasticsearch integration supporting comprehensive filtering.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| q | string | No | Search query (default: "*" for all) |
| page | number | No | Page number (default: 1) |
| limit | number | No | Results per page (default: 20, max: 100) |
| filters[minPrice] | string | No | Minimum price in wei |
| filters[maxPrice] | string | No | Maximum price in wei |
| filters[minLength] | number | No | Minimum character length |
| filters[maxLength] | number | No | Maximum character length |
| filters[hasNumbers] | boolean | No | Filter names with numbers |
| filters[hasEmoji] | boolean | No | Filter names with emoji |
| filters[clubs][] | string | No | Filter by club membership (can pass multiple) |
| filters[isExpired] | boolean | No | Filter by expiration status |
| filters[isGracePeriod] | boolean | No | Filter names in 90-day grace period |
| filters[isPremiumPeriod] | boolean | No | Filter names in Dutch auction period |
| filters[expiringWithinDays] | number | No | Filter names expiring within N days |
| filters[hasSales] | boolean | No | Filter names with sales history |
| filters[lastSoldAfter] | string | No | Filter by last sale date (ISO string) |
| filters[lastSoldBefore] | string | No | Filter by last sale date (ISO string) |
| filters[minDaysSinceLastSale] | number | No | Minimum days since last sale |
| filters[maxDaysSinceLastSale] | number | No | Maximum days since last sale |

**Example Request:**
```bash
GET /api/v1/names/search?q=cool&filters[minLength]=4&filters[maxLength]=10&filters[hasNumbers]=false&filters[hasSales]=true
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

---

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
        "source": "opensea",
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
    "source": "opensea",
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

Search listings using Elasticsearch with advanced filtering including expiration status and sales history.

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| q | string | No | Search query for ENS names (default: "*") |
| page | number | No | Page number (default: 1) |
| limit | number | No | Results per page (default: 20) |
| filters[showAll] | boolean | No | Show all names or active listings only |
| filters[minPrice] | string | No | Minimum price filter in wei |
| filters[maxPrice] | string | No | Maximum price filter in wei |
| filters[minLength] | number | No | Minimum name length |
| filters[maxLength] | number | No | Maximum name length |
| filters[hasNumbers] | boolean | No | Filter by presence of numbers |
| filters[hasEmoji] | boolean | No | Filter by presence of emoji |
| filters[clubs][] | string | No | Filter by club membership (can pass multiple) |
| filters[isExpired] | boolean | No | Filter by expiration status |
| filters[isGracePeriod] | boolean | No | Filter names in 90-day grace period |
| filters[isPremiumPeriod] | boolean | No | Filter names in Dutch auction period |
| filters[expiringWithinDays] | number | No | Filter names expiring within N days |
| filters[hasSales] | boolean | No | Filter names with sales history |
| filters[lastSoldAfter] | string | No | Filter by last sale date (ISO string) |
| filters[lastSoldBefore] | string | No | Filter by last sale date (ISO string) |
| filters[minDaysSinceLastSale] | number | No | Minimum days since last sale |
| filters[maxDaysSinceLastSale] | number | No | Maximum days since last sale |

**Example Request:**
```bash
# Find active names expiring within 30 days
GET /api/v1/listings/search?q=&filters[showAll]=true&filters[isExpired]=false&filters[expiringWithinDays]=30

# Find names in grace period with price range
GET /api/v1/listings/search?q=cool&filters[isGracePeriod]=true&filters[minPrice]=100000000000000000&filters[maxPrice]=1000000000000000000

# Find names in specific clubs
GET /api/v1/listings/search?q=&filters[clubs][]=10k%20Club&filters[clubs][]=999%20Club
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
        "expiry_date": "2025-02-01T00:00:00.000Z",
        "registration_date": "2024-01-01T00:00:00.000Z",
        "metadata": {
          "resolverAddress": "0x456..."
        },
        "clubs": ["10k Club"],
        "has_numbers": false,
        "has_emoji": false,
        "listings": [
          {
            "id": 1,
            "price": "500000000000000000",
            "currency_address": "0x0000000000000000000000000000000000000000",
            "status": "active",
            "seller_address": "0x123...",
            "order_hash": "0xabc...",
            "order_data": {},
            "expires_at": "2024-12-31T23:59:59.000Z",
            "created_at": "2024-01-01T00:00:00.000Z",
            "source": "opensea"
          }
        ],
        "upvotes": 10,
        "downvotes": 1,
        "net_score": 9
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

**Notes:**
- The search endpoint returns ENS names with nested `listings` arrays
- Each result can have zero or more active listings
- Expiration filters automatically exclude placeholder names without valid expiration dates
- The `showAll` filter determines whether to return all names or only those with active listings

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

---

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

---

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

---

### Clubs

Clubs are categories or collections of ENS names (e.g., "10k Club", "999 Club", "3-Digit Club").

#### GET /api/v1/clubs

Get all clubs with metadata.

**Response:**
```json
{
  "success": true,
  "data": {
    "clubs": [
      {
        "name": "10k Club",
        "description": "Premium numeric ENS names under 10,000",
        "member_count": 1234,
        "created_at": "2024-01-01T00:00:00.000Z",
        "updated_at": "2024-01-01T00:00:00.000Z"
      },
      {
        "name": "999 Club",
        "description": "Ultra-rare 3-digit ENS names",
        "member_count": 567,
        "created_at": "2024-01-01T00:00:00.000Z",
        "updated_at": "2024-01-01T00:00:00.000Z"
      }
    ],
    "total": 2
  },
  "meta": {
    "timestamp": "2024-01-01T00:00:00.000Z",
    "version": "1.0.0"
  }
}
```

#### GET /api/v1/clubs/{clubName}

Get names in a specific club.

**Path Parameters:**
- `clubName` - Name of the club (e.g., "10k Club")

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)

**Response:**
```json
{
  "success": true,
  "data": {
    "club": {
      "name": "10k Club",
      "description": "Premium numeric ENS names under 10,000",
      "member_count": 1234,
      "created_at": "2024-01-01T00:00:00.000Z"
    },
    "names": [
      {
        "name": "1234.eth",
        "token_id": "12345",
        "owner": "0x123...",
        "expiry_date": "2025-01-01T00:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 1234,
      "totalPages": 62,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

---

### Votes

Community voting system for ENS names.

#### POST /api/v1/votes

Cast or update a vote for an ENS name.

**Authentication:** Required

**Request Body:**
```json
{
  "ensName": "example.eth",
  "vote": 1
}
```

**Vote Values:**
- `1` - Upvote
- `0` - Remove vote
- `-1` - Downvote

**Response:**
```json
{
  "success": true,
  "data": {
    "vote": {
      "id": 1,
      "ensNameId": 1,
      "userId": 1,
      "vote": 1,
      "createdAt": "2024-01-01T00:00:00.000Z",
      "updatedAt": "2024-01-01T00:00:00.000Z"
    },
    "voteCounts": {
      "upvotes": 42,
      "downvotes": 3,
      "netScore": 39
    }
  }
}
```

#### GET /api/v1/votes/{ensName}

Get vote statistics for an ENS name.

**Path Parameters:**
- `ensName` - ENS name (e.g., "example.eth")

**Authentication:** Optional (returns user's vote if authenticated)

**Response:**
```json
{
  "success": true,
  "data": {
    "ensName": "example.eth",
    "upvotes": 42,
    "downvotes": 3,
    "netScore": 39,
    "userVote": 1
  }
}
```

#### GET /api/v1/votes/leaderboard

Get leaderboard of top-voted ENS names.

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20, max: 100)
- `sortBy` - Sort by: `upvotes`, `downvotes`, `netScore` (default: `netScore`)

**Response:**
```json
{
  "success": true,
  "data": {
    "leaderboard": [
      {
        "id": 1,
        "name": "vitalik.eth",
        "tokenId": "12345",
        "ownerAddress": "0x123...",
        "upvotes": 100,
        "downvotes": 5,
        "netScore": 95,
        "activeListing": {
          "id": 1,
          "price_wei": "10000000000000000000",
          "currency_address": "0x0000000000000000000000000000000000000000",
          "status": "active",
          "source": "opensea"
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 500,
      "totalPages": 25,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

---

### Watchlist

Authenticated users can maintain a watchlist of ENS names with customizable notification preferences.

#### GET /api/v1/watchlist

Get user's watchlist.

**Authentication:** Required

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)

**Response:**
```json
{
  "success": true,
  "data": {
    "watchlist": [
      {
        "id": 1,
        "userId": 1,
        "ensNameId": 1,
        "ensName": "example.eth",
        "notifyOnSale": true,
        "notifyOnOffer": true,
        "notifyOnListing": true,
        "notifyOnPriceChange": false,
        "addedAt": "2024-01-01T00:00:00.000Z",
        "nameData": {
          "name": "example.eth",
          "tokenId": "12345",
          "ownerAddress": "0x123...",
          "expiryDate": "2025-01-01T00:00:00.000Z",
          "hasActiveListing": true,
          "activeListing": {
            "id": 1,
            "price_wei": "1000000000000000000",
            "currency_address": "0x0000000000000000000000000000000000000000",
            "source": "opensea",
            "created_at": "2024-01-01T00:00:00.000Z"
          }
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 10,
      "totalPages": 1,
      "hasNext": false,
      "hasPrev": false
    }
  }
}
```

#### POST /api/v1/watchlist

Add ENS name to watchlist with notification preferences.

**Authentication:** Required

**Request Body:**
```json
{
  "ensName": "example.eth",
  "notifyOnSale": true,
  "notifyOnOffer": true,
  "notifyOnListing": true,
  "notifyOnPriceChange": false
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "userId": 1,
    "ensNameId": 1,
    "ensName": "example.eth",
    "notifyOnSale": true,
    "notifyOnOffer": true,
    "notifyOnListing": true,
    "notifyOnPriceChange": false,
    "addedAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### PATCH /api/v1/watchlist/{id}

Update watchlist notification preferences.

**Authentication:** Required

**Path Parameters:**
- `id` - Watchlist entry ID

**Request Body:**
```json
{
  "notifyOnSale": false,
  "notifyOnOffer": true,
  "notifyOnListing": true,
  "notifyOnPriceChange": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "notifyOnSale": false,
    "notifyOnOffer": true,
    "notifyOnListing": true,
    "notifyOnPriceChange": true
  }
}
```

#### DELETE /api/v1/watchlist/{id}

Remove ENS name from watchlist.

**Authentication:** Required

**Path Parameters:**
- `id` - Watchlist entry ID

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Removed from watchlist"
  }
}
```

#### GET /api/v1/watchlist/search

Search and filter user's watchlist using Elasticsearch with advanced filtering.

**Authentication:** Required

**Query Parameters:**
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| q | string | No | Search query (default: "*") |
| page | number | No | Page number (default: 1) |
| limit | number | No | Results per page (default: 20, max: 100) |
| filters[minPrice] | string | No | Minimum price filter in wei |
| filters[maxPrice] | string | No | Maximum price filter in wei |
| filters[minLength] | number | No | Minimum name length |
| filters[maxLength] | number | No | Maximum name length |
| filters[hasNumbers] | boolean | No | Filter by presence of numbers |
| filters[hasEmoji] | boolean | No | Filter by presence of emoji |
| filters[clubs][] | string | No | Filter by club membership (can pass multiple) |
| filters[isExpired] | boolean | No | Filter by expiration status |
| filters[isGracePeriod] | boolean | No | Filter names in 90-day grace period |
| filters[isPremiumPeriod] | boolean | No | Filter names in Dutch auction period |
| filters[expiringWithinDays] | number | No | Filter names expiring within N days |
| filters[hasSales] | boolean | No | Filter names with sales history |
| filters[lastSoldAfter] | string | No | Filter by last sale date (ISO string) |
| filters[lastSoldBefore] | string | No | Filter by last sale date (ISO string) |
| filters[minDaysSinceLastSale] | number | No | Minimum days since last sale |
| filters[maxDaysSinceLastSale] | number | No | Maximum days since last sale |

**Example Request:**
```bash
GET /api/v1/watchlist/search?q=cool&filters[minLength]=4&filters[maxLength]=8&filters[hasNumbers]=false
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
        "expiry_date": "2025-01-01T00:00:00.000Z",
        "has_numbers": false,
        "has_emoji": false,
        "clubs": ["10k Club"],
        "listings": [
          {
            "id": 1,
            "price": "1000000000000000000",
            "status": "active",
            "source": "opensea"
          }
        ],
        "watchlist": {
          "watchlistId": 1,
          "notifyOnSale": true,
          "notifyOnOffer": true,
          "notifyOnListing": true,
          "notifyOnPriceChange": false,
          "addedAt": "2024-01-01T00:00:00.000Z"
        }
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

---

### Notifications

User notification system for watchlist alerts and marketplace events.

#### GET /api/v1/notifications

Get user's notifications with optional filtering.

**Authentication:** Required

**Query Parameters:**
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| page | number | 1 | Page number |
| limit | number | 20 | Items per page (max 100) |
| unreadOnly | boolean | false | Only show unread notifications |

**Example Request:**
```bash
GET /api/v1/notifications?page=1&limit=20&unreadOnly=true
```

**Response:**
```json
{
  "success": true,
  "data": {
    "notifications": [
      {
        "id": 1,
        "type": "new-listing",
        "ensName": "example.eth",
        "ensTokenId": "12345",
        "metadata": {
          "priceWei": "1000000000000000000",
          "sellerAddress": "0x123...",
          "listingId": 1
        },
        "sentAt": "2024-01-01T00:00:00.000Z",
        "readAt": null,
        "isRead": false,
        "createdAt": "2024-01-01T00:00:00.000Z"
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

**Notification Types:**
- `new-listing` - New listing created for watched name
- `price-change` - Listing price changed
- `sale` - Name was sold
- `new-offer` - New offer received on watched name

#### GET /api/v1/notifications/unread/count

Get count of unread notifications.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "unreadCount": 5
  }
}
```

#### PATCH /api/v1/notifications/:id/read

Mark a specific notification as read.

**Authentication:** Required

**Path Parameters:**
- `id` - Notification ID

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "readAt": "2024-01-01T00:00:00.000Z"
  }
}
```

#### PATCH /api/v1/notifications/read-all

Mark all notifications as read.

**Authentication:** Required

**Response:**
```json
{
  "success": true,
  "data": {
    "markedCount": 5,
    "message": "5 notification(s) marked as read"
  }
}
```

---

### Sales

Sales history and analytics endpoints.

#### GET /api/v1/sales

Get recent sales across the marketplace.

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)

**Response:**
```json
{
  "success": true,
  "data": {
    "sales": [
      {
        "id": 1,
        "ensNameId": 1,
        "ensName": "example.eth",
        "fromAddress": "0x123...",
        "toAddress": "0x456...",
        "priceWei": "1000000000000000000",
        "transactionHash": "0xabc...",
        "blockNumber": 18000000,
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

#### GET /api/v1/sales/name/:name

Get sales history for a specific ENS name.

**Path Parameters:**
- `name` - ENS name (e.g., "vitalik.eth")

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)

**Example Request:**
```bash
GET /api/v1/sales/name/vitalik.eth?page=1&limit=10
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sales": [
      {
        "id": 1,
        "ensNameId": 1,
        "ensName": "vitalik.eth",
        "fromAddress": "0x123...",
        "toAddress": "0x456...",
        "priceWei": "5000000000000000000",
        "transactionHash": "0xabc...",
        "blockNumber": 18000000,
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

#### GET /api/v1/sales/address/:address

Get sales by Ethereum address (buyer or seller).

**Path Parameters:**
- `address` - Ethereum address (0x...)

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)
- `type` - Filter type: `buyer`, `seller`, or `both` (default: "both")

**Example Request:**
```bash
GET /api/v1/sales/address/0x123...?type=seller&page=1&limit=20
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sales": [
      {
        "id": 1,
        "ensNameId": 1,
        "ensName": "example.eth",
        "fromAddress": "0x123...",
        "toAddress": "0x456...",
        "priceWei": "1000000000000000000",
        "transactionHash": "0xabc...",
        "timestamp": "2024-01-01T00:00:00.000Z"
      }
    ]
  }
}
```

#### GET /api/v1/sales/:nameOrId/analytics

Get sales analytics for an ENS name.

**Path Parameters:**
- `nameOrId` - ENS name or ens_name_id

**Example Request:**
```bash
GET /api/v1/sales/vitalik.eth/analytics
```

**Response:**
```json
{
  "success": true,
  "data": {
    "totalSales": 5,
    "totalVolume": "15000000000000000000",
    "averagePrice": "3000000000000000000",
    "highestSale": "5000000000000000000",
    "lowestSale": "1000000000000000000",
    "lastSaleDate": "2024-01-01T00:00:00.000Z",
    "firstSaleDate": "2023-01-01T00:00:00.000Z"
  }
}
```

---

### Profiles

User and address profile endpoints with ENS data integration.

#### GET /api/v1/profiles/:addressOrName

Get comprehensive profile data for an Ethereum address or ENS name.

**Path Parameters:**
- `addressOrName` - Ethereum address (0x...) or ENS name (example.eth)

**Example Requests:**
```bash
# By address
GET /api/v1/profiles/0x1234567890123456789012345678901234567890

# By ENS name
GET /api/v1/profiles/vitalik.eth
```

**Response:**
```json
{
  "success": true,
  "data": {
    "address": "0x1234567890123456789012345678901234567890",
    "primaryName": "vitalik.eth",
    "ensRecords": {
      "avatar": "https://example.com/avatar.png",
      "name": "Vitalik Buterin",
      "description": "Ethereum founder",
      "email": "vitalik@ethereum.org",
      "url": "https://vitalik.ca",
      "location": "Singapore",
      "twitter": "VitalikButerin",
      "github": "vbuterin",
      "header": "https://example.com/header.png",
      "address": "0x123...",
      "records": {
        "com.twitter": "VitalikButerin",
        "com.github": "vbuterin"
      }
    },
    "ownedNames": [
      {
        "id": 1,
        "token_id": "12345",
        "name": "vitalik.eth",
        "expiry_date": "2025-01-01T00:00:00.000Z",
        "registration_date": "2020-01-01T00:00:00.000Z",
        "created_at": "2024-01-01T00:00:00.000Z",
        "is_listed": true,
        "active_listing": {
          "id": 1,
          "price_wei": "10000000000000000000",
          "currency_address": "0x0000000000000000000000000000000000000000",
          "source": "opensea",
          "created_at": "2024-01-01T00:00:00.000Z"
        }
      }
    ],
    "stats": {
      "totalNames": 10,
      "listedNames": 2,
      "totalActivity": 50
    }
  }
}
```

**Notes:**
- If the input is an ENS name not in the database, the API will fetch it from The Graph
- ENS records are fetched from the EFP (EthFollow Protocol) API
- For names owned by the Name Wrapper contract, the API queries the contract to get the actual owner
- Returns primary ENS name automatically resolved for addresses

---

### Activity

Activity feed for ENS names and addresses.

#### GET /api/v1/activity/{name}

Get activity for a specific ENS name.

**Path Parameters:**
- `name` - ENS name (e.g., "example.eth")

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)

**Response:**
```json
{
  "success": true,
  "data": {
    "activities": [
      {
        "id": 1,
        "ensName": "example.eth",
        "activityType": "sale",
        "fromAddress": "0x123...",
        "toAddress": "0x456...",
        "price": "1000000000000000000",
        "transactionHash": "0xabc...",
        "timestamp": "2024-01-01T00:00:00.000Z"
      },
      {
        "id": 2,
        "ensName": "example.eth",
        "activityType": "listing_created",
        "sellerAddress": "0x123...",
        "price": "1000000000000000000",
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

#### GET /api/v1/activity/address/{address}

Get activity for a specific Ethereum address.

**Path Parameters:**
- `address` - Ethereum address (0x...)

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)

#### GET /api/v1/activity

Get global activity feed.

**Query Parameters:**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 20)
- `activityType` - Filter by type: `sale`, `transfer`, `listing_created`, `offer_made`, etc.

---

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

---

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

# Find names expiring soon in specific clubs
GET /api/v1/names/search?q=&filters[expiringWithinDays]=30&filters[clubs][]=10k%20Club
```

### Expiration Filtering

The API provides granular control over ENS name expiration status:

- **isExpired**: Filter by whether the name has expired
- **isGracePeriod**: Names in the 90-day grace period after expiration
- **isPremiumPeriod**: Names in the Dutch auction premium period
- **expiringWithinDays**: Names expiring within a specified number of days

**Important:** All expiration filters automatically exclude placeholder names (token IDs) that haven't been resolved to actual ENS names.

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

---

## Examples

### Example 1: Authenticate with SIWE

```bash
# Step 1: Request a nonce
curl -X GET "http://localhost:3000/api/v1/auth/nonce?address=0x1234567890123456789012345678901234567890" \
  -H "Accept: application/json"

# Step 2: Sign the SIWE message with your wallet (using ethers.js or similar)
# Step 3: Submit the signature
curl -X POST "http://localhost:3000/api/v1/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "localhost:3000 wants you to sign in...",
    "signature": "0xabc..."
  }'

# Step 4: Use the returned JWT token in subsequent requests
curl -X GET "http://localhost:3000/api/v1/auth/me" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

### Example 2: Find Available Premium Names

```bash
curl -X GET "http://localhost:3000/api/v1/names/search?q=*&filters[maxLength]=4&filters[hasNumbers]=false&filters[hasEmoji]=false" \
  -H "Accept: application/json"
```

### Example 3: Search Names Expiring Soon

```bash
# Find active names expiring within 30 days
curl -X GET "http://localhost:3000/api/v1/listings/search?q=&filters[showAll]=true&filters[isExpired]=false&filters[expiringWithinDays]=30" \
  -H "Accept: application/json"
```

### Example 4: Get Listing History

```bash
curl -X GET "http://localhost:3000/api/v1/names/vitalik.eth/history?page=1&limit=10" \
  -H "Accept: application/json"
```

### Example 5: Create a Listing

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

### Example 6: Vote on an ENS Name

```bash
curl -X POST "http://localhost:3000/api/v1/votes" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "ensName": "vitalik.eth",
    "vote": 1
  }'
```

### Example 7: Add Name to Watchlist

```bash
curl -X POST "http://localhost:3000/api/v1/watchlist" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <token>" \
  -d '{
    "ensName": "example.eth",
    "notes": "Waiting for price to drop",
    "targetPrice": "500000000000000000"
  }'
```

### Example 8: Get Names in a Club

```bash
curl -X GET "http://localhost:3000/api/v1/clubs/10k%20Club?page=1&limit=20" \
  -H "Accept: application/json"
```

### Example 9: WebSocket Subscription

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

### Example 10: Advanced Search with Multiple Filters

```bash
# Find 4-5 letter alphabetic names under 1 ETH in grace period
curl -X GET "http://localhost:3000/api/v1/listings/search?q=*&filters[minLength]=4&filters[maxLength]=5&filters[hasNumbers]=false&filters[hasEmoji]=false&filters[maxPrice]=1000000000000000000&filters[isGracePeriod]=true" \
  -H "Accept: application/json"
```

---

## Recent Updates

### Version 1.2.0 (Current)
- **Notifications System**: Complete notification endpoints for watchlist alerts
- **Sales Analytics**: Sales history and analytics endpoints
- **Profile System**: User/address profiles with ENS record integration
- **Watchlist Search**: Advanced Elasticsearch-powered watchlist filtering
- **Sales History Filters**: Filter by sales history, days since last sale
- **Notification Preferences**: Granular control over watchlist notifications

### Version 1.1.0
- **Authentication**: Added SIWE-based authentication system
- **Social Features**: Voting system and watchlists
- **Clubs**: Category system for grouping ENS names
- **Activity Feeds**: Comprehensive activity tracking
- **Expiration Filters**: Advanced filtering by expiration status, grace period, and premium period
- **Enhanced Search**: Added `showAll` and `clubs` filters to search endpoints

### Breaking Changes
- `/listings/search` now returns ENS name objects with nested `listings` arrays instead of flat listing objects
- All protected endpoints now require JWT authentication via `Authorization: Bearer <token>` header
- Watchlist schema changed to support notification preferences (notifyOnSale, notifyOnOffer, notifyOnListing, notifyOnPriceChange)

---

## Future Enhancements

The API is designed with extensibility in mind. Planned features include:

1. **Advanced Analytics**
   - Price history charts
   - Market trends
   - Volume statistics

2. **Bulk Operations**
   - Batch listing creation
   - Bulk offer management
   - CSV import/export

3. **Notification System**
   - Email notifications for watchlist price alerts
   - Push notifications
   - Webhook integrations

4. **Advanced Filters**
   - Dictionary word detection
   - Brandable name scoring
   - Similar name suggestions

5. **Performance Optimizations**
   - GraphQL API endpoint
   - Response caching
   - Query optimization

---

## Support

For questions, issues, or feature requests, please open an issue in the GitHub repository.
