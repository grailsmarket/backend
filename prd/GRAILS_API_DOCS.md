# Grails ENS Marketplace API Documentation

## Base URL
```
http://localhost:3000/api/v1
```

## Response Format
All API responses follow a consistent structure:

```typescript
{
  success: boolean;
  data?: any;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
  meta: {
    timestamp: string;
    version: string;
  };
}
```

## Authentication
Protected endpoints require a JWT token in the Authorization header:

```
Authorization: Bearer <your_jwt_token>
```

---

## Authentication Endpoints

### Request Nonce
Get a one-time nonce for SIWE authentication.

**Endpoint:** `GET /auth/nonce`

**Query Parameters:**
- `address` (required): Ethereum address (0x...)

**Response:**
```json
{
  "success": true,
  "data": {
    "nonce": "a1b2c3d4e5f6...",
    "expiresAt": "2025-10-07T12:05:00.000Z"
  }
}
```

### Verify SIWE Signature
Verify signed SIWE message and create authenticated session.

**Endpoint:** `POST /auth/verify`

**Body:**
```json
{
  "message": "localhost wants you to sign in...",
  "signature": "0xabcdef..."
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": 1,
      "address": "0x1234...",
      "email": null,
      "emailVerified": false,
      "telegram": null,
      "discord": null,
      "createdAt": "2025-10-07T12:00:00.000Z",
      "lastSignIn": "2025-10-07T12:00:00.000Z"
    }
  }
}
```

### Get Current User
Get authenticated user details.

**Endpoint:** `GET /auth/me`

**Headers:** `Authorization: Bearer <token>` (required)

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "address": "0x1234...",
    "email": "user@example.com",
    "emailVerified": false,
    "telegram": "@username",
    "discord": "user#1234",
    "createdAt": "2025-10-07T12:00:00.000Z",
    "updatedAt": "2025-10-07T12:00:00.000Z",
    "lastSignIn": "2025-10-07T12:00:00.000Z"
  }
}
```

### Logout
Logout current user.

**Endpoint:** `POST /auth/logout`

**Headers:** `Authorization: Bearer <token>` (required)

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

## User Profile Endpoints

### Update Profile
Update current user's profile information.

**Endpoint:** `PATCH /users/me`

**Headers:** `Authorization: Bearer <token>` (required)

**Body:**
```json
{
  "email": "user@example.com",
  "telegram": "@username",
  "discord": "user#1234"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "address": "0x1234...",
    "email": "user@example.com",
    "emailVerified": false,
    "telegram": "@username",
    "discord": "user#1234",
    "updatedAt": "2025-10-07T12:00:00.000Z"
  }
}
```

---

## Watchlist Endpoints

### Get Watchlist
Get user's ENS name watchlist with notification preferences.

**Endpoint:** `GET /watchlist`

**Headers:** `Authorization: Bearer <token>` (required)

**Query Parameters:**
- `page` (optional, default: 1): Page number
- `limit` (optional, default: 20): Items per page (max: 100)

**Response:**
```json
{
  "success": true,
  "data": {
    "watchlist": [
      {
        "id": 1,
        "userId": 1,
        "ensNameId": 123,
        "ensName": "vitalik.eth",
        "notifyOnSale": true,
        "notifyOnOffer": true,
        "notifyOnListing": true,
        "notifyOnPriceChange": false,
        "addedAt": "2025-10-07T12:00:00.000Z",
        "nameData": {
          "name": "vitalik.eth",
          "tokenId": "12345...",
          "ownerAddress": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          "expiryDate": "2026-10-07T12:00:00.000Z",
          "hasActiveListing": true,
          "activeListing": {
            "id": 456,
            "price_wei": "1000000000000000000",
            "currency_address": "0x0000000000000000000000000000000000000000",
            "source": "opensea",
            "created_at": "2025-10-07T12:00:00.000Z"
          }
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

### Add to Watchlist
Add an ENS name to user's watchlist.

**Endpoint:** `POST /watchlist`

**Headers:** `Authorization: Bearer <token>` (required)

**Body:**
```json
{
  "ensName": "vitalik.eth",
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
    "ensNameId": 123,
    "ensName": "vitalik.eth",
    "notifyOnSale": true,
    "notifyOnOffer": true,
    "notifyOnListing": true,
    "notifyOnPriceChange": false,
    "addedAt": "2025-10-07T12:00:00.000Z"
  }
}
```

### Update Watchlist Item
Update notification preferences for a watchlist entry.

**Endpoint:** `PATCH /watchlist/:id`

**Headers:** `Authorization: Bearer <token>` (required)

**Body:**
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

### Remove from Watchlist
Remove an ENS name from user's watchlist.

**Endpoint:** `DELETE /watchlist/:id`

**Headers:** `Authorization: Bearer <token>` (required)

**Response:**
```json
{
  "success": true,
  "data": {
    "message": "Removed from watchlist"
  }
}
```

---

## ENS Names Endpoints

### List ENS Names
Get paginated list of ENS names with optional filters.

**Endpoint:** `GET /names`

**Query Parameters:**
- `page` (optional, default: 1): Page number
- `limit` (optional, default: 20, max: 100): Items per page
- `owner` (optional): Filter by owner address
- `status` (optional): Filter by status (`available`, `listed`, `expiring`)
- `sort` (optional, default: `created`): Sort field (`name`, `price`, `expiry`, `created`)
- `order` (optional, default: `desc`): Sort order (`asc`, `desc`)

**Response:**
```json
{
  "success": true,
  "data": {
    "names": [
      {
        "id": 123,
        "token_id": "12345...",
        "name": "vitalik.eth",
        "owner_address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "expiry_date": "2026-10-07T12:00:00.000Z",
        "registration_date": "2015-05-04T00:00:00.000Z",
        "created_at": "2025-10-07T12:00:00.000Z",
        "listings": [
          {
            "id": 456,
            "price_wei": "1000000000000000000",
            "currency_address": "0x0000000000000000000000000000000000000000",
            "status": "active",
            "source": "opensea",
            "expires_at": null,
            "created_at": "2025-10-07T12:00:00.000Z"
          }
        ]
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 150,
      "totalPages": 8,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

### Search ENS Names
Search for ENS names with advanced filters.

**Endpoint:** `GET /names/search`

**Query Parameters:**
- `q` (required): Search query
- `page` (optional, default: 1): Page number
- `limit` (optional, default: 20, max: 100): Items per page
- `filters[minPrice]` (optional): Minimum price in wei
- `filters[maxPrice]` (optional): Maximum price in wei
- `filters[minLength]` (optional): Minimum name length
- `filters[maxLength]` (optional): Maximum name length
- `filters[hasNumbers]` (optional): Filter names with numbers (true/false)
- `filters[hasEmoji]` (optional): Filter names with emoji (true/false)

**Example:**
```
GET /names/search?q=vitalik&filters[minLength]=3&filters[maxLength]=10
```

**Response:**
```json
{
  "success": true,
  "data": {
    "results": [...],
    "pagination": {...}
  }
}
```

### Get ENS Name Details
Get detailed information about a specific ENS name.

**Endpoint:** `GET /names/:name`

**Example:** `GET /names/vitalik.eth`

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 123,
    "token_id": "12345...",
    "name": "vitalik.eth",
    "owner_address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "expiry_date": "2026-10-07T12:00:00.000Z",
    "registration_date": "2015-05-04T00:00:00.000Z",
    "listing_price": "1000000000000000000",
    "listing_status": "active",
    "listing_expires_at": null,
    "listing_seller": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "active_offers_count": 3,
    "recent_transactions": [
      {
        "transaction_hash": "0xabc...",
        "block_number": 12345678,
        "from_address": "0x123...",
        "to_address": "0x456...",
        "price_wei": "500000000000000000",
        "transaction_type": "sale",
        "timestamp": "2025-10-07T12:00:00.000Z"
      }
    ],
    "opensea_listing": {
      "price": "1.5",
      "currency": "ETH",
      "url": "https://opensea.io/..."
    },
    "opensea_offer": {
      "price": "0.8",
      "currency": "WETH"
    }
  }
}
```

**Note:** If the name doesn't exist in the database, the API will query The Graph and insert it automatically.

### Get Name Transaction History
Get transaction history for a specific ENS name.

**Endpoint:** `GET /names/:name/history`

**Query Parameters:**
- `page` (optional, default: 1): Page number
- `limit` (optional, default: 20): Items per page

**Response:**
```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "id": 789,
        "ens_name_id": 123,
        "transaction_hash": "0xabc...",
        "block_number": 12345678,
        "from_address": "0x123...",
        "to_address": "0x456...",
        "price_wei": "500000000000000000",
        "transaction_type": "sale",
        "timestamp": "2025-10-07T12:00:00.000Z"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 45,
      "totalPages": 3,
      "hasNext": true,
      "hasPrev": false
    }
  }
}
```

---

## Listings Endpoints

### List All Listings
Get paginated list of marketplace listings.

**Endpoint:** `GET /listings`

**Query Parameters:**
- `page` (optional, default: 1): Page number
- `limit` (optional, default: 20, max: 100): Items per page
- `status` (optional, default: `active`): Filter by status (`active`, `sold`, `cancelled`, `expired`)
- `seller` (optional): Filter by seller address
- `minPrice` (optional): Minimum price in wei
- `maxPrice` (optional): Maximum price in wei
- `sort` (optional, default: `created`): Sort field (`price`, `created`, `expiry`, `name`)
- `order` (optional, default: `desc`): Sort order (`asc`, `desc`)

**Response:**
```json
{
  "success": true,
  "data": {
    "listings": [
      {
        "id": 456,
        "ens_name_id": 123,
        "seller_address": "0x123...",
        "price_wei": "1000000000000000000",
        "currency_address": "0x0000000000000000000000000000000000000000",
        "order_hash": "0xabc...",
        "order_data": {...},
        "status": "active",
        "source": "opensea",
        "expires_at": null,
        "created_at": "2025-10-07T12:00:00.000Z",
        "ens_name": "vitalik.eth",
        "token_id": "12345...",
        "current_owner": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "name_expiry_date": "2026-10-07T12:00:00.000Z",
        "registration_date": "2015-05-04T00:00:00.000Z"
      }
    ],
    "pagination": {...}
  }
}
```

### Create Listing
Create a new marketplace listing (typically done internally via OpenSea events).

**Endpoint:** `POST /listings`

**Body:**
```json
{
  "ensNameId": 123,
  "sellerAddress": "0x123...",
  "priceWei": "1000000000000000000",
  "currencyAddress": "0x0000000000000000000000000000000000000000",
  "orderData": {...},
  "expiresAt": "2025-12-31T23:59:59.000Z"
}
```

---

## Offers Endpoints

### Get Offers
Get all offers with optional filters.

**Endpoint:** `GET /offers`

**Query Parameters:**
- `page` (optional, default: 1): Page number
- `limit` (optional, default: 20): Items per page
- `status` (optional): Filter by status (`pending`, `accepted`, `rejected`, `expired`)
- `ensName` (optional): Filter by ENS name
- `buyer` (optional): Filter by buyer address
- `minPrice` (optional): Minimum price in wei
- `maxPrice` (optional): Maximum price in wei

**Response:**
```json
{
  "success": true,
  "data": {
    "offers": [
      {
        "id": 789,
        "ens_name_id": 123,
        "ens_name": "vitalik.eth",
        "buyer_address": "0x789...",
        "price_wei": "800000000000000000",
        "currency_address": "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "order_data": {...},
        "status": "pending",
        "expires_at": "2025-10-14T12:00:00.000Z",
        "created_at": "2025-10-07T12:00:00.000Z"
      }
    ],
    "pagination": {...}
  }
}
```

### Get Offers for Name
Get all offers for a specific ENS name.

**Endpoint:** `GET /offers/:name`

**Example:** `GET /offers/vitalik.eth`

**Response:**
```json
{
  "success": true,
  "data": {
    "offers": [...],
    "pagination": {...}
  }
}
```

---

## Activity Endpoints

### Get Activity Feed
Get recent marketplace activity (sales, listings, offers).

**Endpoint:** `GET /activity`

**Query Parameters:**
- `page` (optional, default: 1): Page number
- `limit` (optional, default: 20, max: 100): Items per page
- `eventType` (optional): Filter by event type (`mint`, `burn`, `send`, `receive`, `sale`, `listing`, `offer`)
- `name` (optional): Filter by ENS name

**Response:**
```json
{
  "success": true,
  "data": {
    "events": [
      {
        "id": 1,
        "event_type": "sale",
        "ens_name": "vitalik.eth",
        "from_address": "0x123...",
        "to_address": "0x456...",
        "price_wei": "1000000000000000000",
        "transaction_hash": "0xabc...",
        "timestamp": "2025-10-07T12:00:00.000Z"
      }
    ],
    "pagination": {...}
  }
}
```

### Get Activity for Name
Get activity history for a specific ENS name.

**Endpoint:** `GET /activity/:name`

**Query Parameters:**
- `limit` (optional, default: 10): Number of events to return

**Response:**
```json
{
  "success": true,
  "data": {
    "name": "vitalik.eth",
    "events": [...]
  }
}
```

---

## Profile Endpoints

### Get User Profile
Get public profile information for an Ethereum address.

**Endpoint:** `GET /profiles/:address`

**Example:** `GET /profiles/0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`

**Response:**
```json
{
  "success": true,
  "data": {
    "address": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "ensName": "vitalik.eth",
    "ownedNames": [
      {
        "name": "vitalik.eth",
        "token_id": "12345...",
        "expiry_date": "2026-10-07T12:00:00.000Z"
      }
    ],
    "activeListings": 2,
    "totalSales": 5,
    "totalPurchases": 10,
    "joinedAt": "2015-05-04T00:00:00.000Z"
  }
}
```

---

## Health Check

### Health Status
Check API health status.

**Endpoint:** `GET /health`

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2025-10-07T12:00:00.000Z",
  "uptime": 12345.67,
  "database": "connected",
  "elasticsearch": "connected"
}
```

---

## Error Codes

Common error codes returned by the API:

| Code | Description |
|------|-------------|
| `UNAUTHORIZED` | Missing or invalid authentication token |
| `FORBIDDEN` | Insufficient permissions for the requested resource |
| `NOT_FOUND` | Requested resource not found |
| `VALIDATION_ERROR` | Request validation failed (invalid parameters) |
| `INTERNAL_ERROR` | Internal server error |
| `INVALID_NONCE` | Nonce not found, expired, or already used |
| `NONCE_EXPIRED` | Authentication nonce has expired |
| `INVALID_SIGNATURE` | SIWE signature verification failed |
| `ENS_NAME_NOT_FOUND` | ENS name does not exist |
| `NO_UPDATES` | No fields provided to update |

---

## Rate Limiting

The API implements rate limiting to prevent abuse:
- **Default**: 100 requests per minute per IP address
- **Authenticated**: 500 requests per minute per user

Rate limit headers are included in responses:
```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 95
X-RateLimit-Reset: 1696680000
```

---

## WebSocket API

### Real-time Updates
Connect to WebSocket for real-time marketplace updates.

**Endpoint:** `ws://localhost:3000/ws`

**Events:**
- `listing_created`: New listing created
- `listing_updated`: Listing price or status updated
- `listing_sold`: Listing successfully sold
- `offer_created`: New offer submitted
- `offer_accepted`: Offer accepted by seller
- `transfer`: ENS name transferred

**Example Message:**
```json
{
  "event": "listing_created",
  "data": {
    "ensName": "vitalik.eth",
    "priceWei": "1000000000000000000",
    "seller": "0x123...",
    "timestamp": "2025-10-07T12:00:00.000Z"
  }
}
```

---

## Best Practices

1. **Authentication**: Always store JWT tokens securely (e.g., httpOnly cookies or secure storage)
2. **Error Handling**: Check the `success` field before accessing `data`
3. **Pagination**: Use pagination for large datasets to improve performance
4. **Rate Limits**: Implement exponential backoff when rate limited
5. **Timestamps**: All timestamps are in ISO 8601 format (UTC)
6. **Wei Values**: All ETH prices are in wei (1 ETH = 10^18 wei)
7. **Address Format**: Always use checksummed Ethereum addresses

---

## Code Examples

### JavaScript/TypeScript (Frontend)

```typescript
// Sign in with Ethereum
async function signInWithEthereum(address: string, signMessage: Function) {
  // 1. Request nonce
  const nonceRes = await fetch(`/api/v1/auth/nonce?address=${address}`);
  const { data: { nonce } } = await nonceRes.json();

  // 2. Create SIWE message
  const siweMessage = new SiweMessage({
    domain: window.location.host,
    address,
    statement: 'Sign in to Grails',
    uri: window.location.origin,
    version: '1',
    chainId: 1,
    nonce,
  });

  const message = siweMessage.prepareMessage();

  // 3. Sign message
  const signature = await signMessage({ message });

  // 4. Verify and get token
  const verifyRes = await fetch('/api/v1/auth/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, signature }),
  });

  const { data: { token, user } } = await verifyRes.json();
  return { token, user };
}

// Get user's watchlist
async function getWatchlist(token: string) {
  const res = await fetch('/api/v1/watchlist?page=1&limit=20', {
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  const { data } = await res.json();
  return data.watchlist;
}

// Add to watchlist
async function addToWatchlist(token: string, ensName: string) {
  const res = await fetch('/api/v1/watchlist', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({
      ensName,
      notifyOnSale: true,
      notifyOnOffer: true,
      notifyOnListing: true,
      notifyOnPriceChange: false,
    }),
  });

  return await res.json();
}
```

### Node.js (Backend)

```javascript
const axios = require('axios');

const API_BASE = 'http://localhost:3000/api/v1';

// Get all active listings
async function getActiveListings() {
  const response = await axios.get(`${API_BASE}/listings`, {
    params: {
      status: 'active',
      sort: 'price',
      order: 'asc',
      page: 1,
      limit: 50,
    },
  });

  return response.data.data.listings;
}

// Search for ENS names
async function searchNames(query) {
  const response = await axios.get(`${API_BASE}/names/search`, {
    params: {
      q: query,
      'filters[minLength]': 3,
      'filters[maxLength]': 10,
    },
  });

  return response.data.data.results;
}
```

---

## Support

For questions or issues:
- GitHub Issues: https://github.com/yourusername/grails-testing/issues
- Documentation: See individual service CLAUDE.md files
- API Status: `GET /health`

---

**Version:** 1.0.0
**Last Updated:** October 7, 2025
