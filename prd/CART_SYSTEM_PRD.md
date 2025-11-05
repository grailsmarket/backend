# Cart System - Product Requirements Document (PRD)

## Overview
Implement a cart/basket system that allows authenticated users to organize ENS names into different action categories (sales, registrations) for batch processing on the frontend.

## Goals
- Allow users to add ENS names to shopping carts categorized by action type
- Enable users to view, update, and manage their cart contents
- Support multiple cart types (baskets) for different user workflows
- Provide fast, efficient cart operations via API
- Use standard response builder for consistent ENS name data format

## Non-Goals
- Cart checkout/payment processing (handled by frontend)
- Guest/anonymous cart (requires authentication)
- Cart expiration/cleanup (can be added later)
- Cart sharing between users

## Success Metrics
- Users can add/remove items from cart with <100ms response time
- Cart operations have 99.9% success rate
- Support for multiple cart types without schema changes

---

## Database Schema

### Table: `cart_types`
Defines the available cart/basket categories.

```sql
CREATE TABLE cart_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Initial cart types
INSERT INTO cart_types (name, description) VALUES
  ('sales', 'Names to purchase from listings'),
  ('registrations', 'Names to register (not yet owned)');
```

**Columns:**
- `id` - Primary key
- `name` - Unique identifier (e.g., 'sales', 'registrations')
- `description` - Human-readable description
- `created_at` - Timestamp of creation

---

### Table: `cart_items`
Stores individual items in users' carts.

```sql
CREATE TABLE cart_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  cart_type_id INTEGER NOT NULL REFERENCES cart_types(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  -- Ensure a user can't add the same name to the same cart type twice
  UNIQUE(user_id, ens_name_id, cart_type_id)
);

CREATE INDEX idx_cart_items_user ON cart_items(user_id);
CREATE INDEX idx_cart_items_user_cart_type ON cart_items(user_id, cart_type_id);
CREATE INDEX idx_cart_items_ens_name ON cart_items(ens_name_id);

-- Updated_at trigger
CREATE TRIGGER update_cart_items_updated_at
BEFORE UPDATE ON cart_items
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**Columns:**
- `id` - Primary key
- `user_id` - Foreign key to users table (authenticated user only)
- `ens_name_id` - Foreign key to ens_names table
- `cart_type_id` - Foreign key to cart_types table
- `created_at` - When item was added to cart
- `updated_at` - When item was last modified

**Constraints:**
- `UNIQUE(user_id, ens_name_id, cart_type_id)` - Prevents duplicate items in same cart
- `ON DELETE CASCADE` - Auto-cleanup if user/name/type is deleted

**Indexes:**
- `idx_cart_items_user` - Fast lookup by user
- `idx_cart_items_user_cart_type` - Fast lookup by user + cart type
- `idx_cart_items_ens_name` - Fast lookup to check if name is in any cart

---

## API Endpoints

All endpoints require authentication (`requireAuth` middleware).

### 1. Get Cart Items

**Endpoint:** `GET /api/v1/cart`

**Query Parameters:**
- `type` (optional) - Filter by cart type name (e.g., 'sales', 'registrations')

**Response:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": 123,
        "cart_type": "sales",
        "created_at": "2025-11-04T10:00:00.000Z",
        "ens_name": {
          // Standard SearchResult format from response-builder.ts
          "id": 456,
          "name": "vitalik.eth",
          "token_id": "12345...",
          "owner": "0x...",
          "expiry_date": "2026-05-03T21:07:12.000Z",
          "registration_date": "2017-06-14T22:40:38.000Z",
          "last_sale_date": null,
          "last_sale_price": null,
          "last_sale_currency": null,
          "last_sale_price_usd": null,
          "metadata": {},
          "clubs": ["10k Club"],
          "has_numbers": false,
          "has_emoji": false,
          "listings": [
            {
              "id": 789,
              "price": "1000000000000000000",
              "currency_address": "0x0000000000000000000000000000000000000000",
              "status": "active",
              "seller_address": "0x...",
              "order_hash": "0x...",
              "order_data": {},
              "expires_at": null,
              "created_at": "2025-11-01T00:00:00.000Z",
              "source": "opensea"
            }
          ],
          "upvotes": 10,
          "downvotes": 2,
          "net_score": 8,
          "user_vote": 1,
          "watchers_count": 5,
          "highest_offer_wei": "500000000000000000",
          "highest_offer_currency": "0x0000000000000000000000000000000000000000",
          "highest_offer_id": 111,
          "view_count": 42
        }
      }
    ],
    "count": 1
  }
}
```

**Implementation:**
- Query `cart_items` for current user
- Extract list of ENS name IDs
- Call `buildSearchResults(nameIds, userId)` from response-builder to get full name data
- Combine cart metadata (id, cart_type, created_at) with SearchResult data
- Filter by `cart_type_id` if `type` query param provided
- Order by `created_at DESC`

---

### 2. Add Item to Cart

**Endpoint:** `POST /api/v1/cart`

**Request Body:**
```json
{
  "ens_name_id": 456,
  "cart_type": "sales"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 123,
    "cart_type": "sales",
    "ens_name_id": 456,
    "created_at": "2025-11-04T10:00:00.000Z"
  }
}
```

**Validation:**
- `ens_name_id` - Required, must exist in `ens_names` table
- `cart_type` - Required, must exist in `cart_types` table

**Implementation:**
- Look up `cart_type_id` from `cart_type` name
- Insert into `cart_items` with `user_id` from auth token
- Use `ON CONFLICT DO NOTHING` to handle duplicates gracefully
- Return 200 even if already exists (idempotent)

---

### 3. Remove Item from Cart

**Endpoint:** `DELETE /api/v1/cart/:id`

**Path Parameters:**
- `id` - Cart item ID

**Response:**
```json
{
  "success": true,
  "message": "Item removed from cart"
}
```

**Implementation:**
- Delete cart item where `id = :id AND user_id = <auth_user_id>`
- Ensures users can only delete their own cart items
- Return 404 if not found or not owned by user

---

### 4. Bulk Add to Cart

**Endpoint:** `POST /api/v1/cart/bulk`

**Request Body:**
```json
{
  "cart_type": "sales",
  "ens_name_ids": [456, 789, 101]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "added": 3,
    "skipped": 0,
    "total": 3
  }
}
```

**Implementation:**
- Look up `cart_type_id` from `cart_type` name
- Batch insert into `cart_items` using `INSERT INTO ... VALUES (...), (...), (...)`
- Use `ON CONFLICT DO NOTHING` to skip duplicates
- Count rows affected to determine added vs skipped
- Return count of added vs skipped items

---

### 5. Clear Cart

**Endpoint:** `DELETE /api/v1/cart`

**Query Parameters:**
- `type` (optional) - Clear specific cart type, or all if omitted

**Response:**
```json
{
  "success": true,
  "data": {
    "deleted": 5
  }
}
```

**Implementation:**
- Delete all cart items for user
- Filter by `cart_type_id` if `type` param provided
- Return count of deleted items

---

### 6. Get Cart Summary

**Endpoint:** `GET /api/v1/cart/summary`

**Response:**
```json
{
  "success": true,
  "data": {
    "sales": 3,
    "registrations": 7,
    "total": 10
  }
}
```

**Implementation:**
- Group count by cart type for current user
- Return counts for each cart type
- Useful for badge/counter display on frontend

---

## Response Builder Integration

Cart endpoints will use the existing `buildSearchResults()` function from `response-builder.ts` to ensure consistent ENS name data format across all API endpoints.

**Benefits:**
- ✅ Consistent response format with /listings/search and /names/search
- ✅ Includes all enriched data (listings, votes, offers, watchlist counts)
- ✅ Single source of truth for ENS name response structure
- ✅ Automatic inclusion of user-specific data (user_vote) when userId provided
- ✅ No need to maintain separate query logic

**Implementation Pattern:**

```typescript
// In GET /cart endpoint
const cartItemsResult = await pool.query(`
  SELECT
    ci.id as cart_item_id,
    ci.created_at as cart_created_at,
    ct.name as cart_type,
    ci.ens_name_id,
    en.name as ens_name
  FROM cart_items ci
  JOIN cart_types ct ON ci.cart_type_id = ct.id
  JOIN ens_names en ON ci.ens_name_id = en.id
  WHERE ci.user_id = $1
  ORDER BY ci.created_at DESC
`, [userId]);

// Extract ENS names for response builder
const ensNames = cartItemsResult.rows.map(row => row.ens_name);

// Get enriched name data using standard response builder
const enrichedNames = await buildSearchResults(ensNames, userId);

// Combine cart metadata with enriched name data
const items = cartItemsResult.rows.map(row => {
  const nameData = enrichedNames.find(n => n.name === row.ens_name);
  return {
    id: row.cart_item_id,
    cart_type: row.cart_type,
    created_at: row.cart_created_at,
    ens_name: nameData
  };
});
```

---

## Database Migration

**File:** `services/api/migrations/seq/0250_create_cart_system.sql`

```sql
-- Create cart system tables
-- Migration: create_cart_system
-- Created: 2025-11-04

-- Cart types table
CREATE TABLE IF NOT EXISTS cart_types (
  id SERIAL PRIMARY KEY,
  name VARCHAR(50) UNIQUE NOT NULL,
  description TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

-- Cart items table
CREATE TABLE IF NOT EXISTS cart_items (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ens_name_id INTEGER NOT NULL REFERENCES ens_names(id) ON DELETE CASCADE,
  cart_type_id INTEGER NOT NULL REFERENCES cart_types(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),

  UNIQUE(user_id, ens_name_id, cart_type_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_cart_items_user ON cart_items(user_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_user_cart_type ON cart_items(user_id, cart_type_id);
CREATE INDEX IF NOT EXISTS idx_cart_items_ens_name ON cart_items(ens_name_id);

-- Updated_at trigger
DROP TRIGGER IF EXISTS update_cart_items_updated_at ON cart_items;
CREATE TRIGGER update_cart_items_updated_at
BEFORE UPDATE ON cart_items
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Insert initial cart types
INSERT INTO cart_types (name, description) VALUES
  ('sales', 'Names to purchase from listings'),
  ('registrations', 'Names to register (not yet owned)')
ON CONFLICT (name) DO NOTHING;

-- Verify
SELECT
  'cart_types' as table_name,
  COUNT(*) as row_count
FROM cart_types
UNION ALL
SELECT
  'cart_items' as table_name,
  COUNT(*) as row_count
FROM cart_items;
```

---

## API Route Implementation

**File:** `services/api/src/routes/cart.ts`

### Route Structure

```typescript
import { FastifyInstance } from 'fastify';
import { requireAuth } from '../middleware/auth';
import { buildSearchResults } from '../utils/response-builder';
import { getPostgresPool } from '../../../shared/src';
import { z } from 'zod';

const pool = getPostgresPool();

// Validation schemas
const AddToCartSchema = z.object({
  ens_name_id: z.number().int().positive(),
  cart_type: z.string().min(1).max(50),
});

const BulkAddToCartSchema = z.object({
  cart_type: z.string().min(1).max(50),
  ens_name_ids: z.array(z.number().int().positive()).min(1).max(100),
});

const GetCartQuerySchema = z.object({
  type: z.string().optional(),
});

const ClearCartQuerySchema = z.object({
  type: z.string().optional(),
});

export default async function cartRoutes(fastify: FastifyInstance) {
  // GET /cart - Get cart items with full ENS name data
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const userId = (request as any).user.sub;
    const { type } = GetCartQuerySchema.parse(request.query);

    // Query cart items
    // Extract ENS names
    // Call buildSearchResults(ensNames, userId)
    // Combine and return
  });

  // GET /cart/summary - Get cart counts by type
  fastify.get('/summary', { preHandler: requireAuth }, async (request, reply) => {
    // Implementation
  });

  // POST /cart - Add single item
  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
    // Implementation
  });

  // POST /cart/bulk - Add multiple items
  fastify.post('/bulk', { preHandler: requireAuth }, async (request, reply) => {
    // Implementation
  });

  // DELETE /cart/:id - Remove single item
  fastify.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
    // Implementation
  });

  // DELETE /cart - Clear cart (all or by type)
  fastify.delete('/', { preHandler: requireAuth }, async (request, reply) => {
    // Implementation
  });
}
```

**Register in main app:**

```typescript
// In services/api/src/index.ts
import cartRoutes from './routes/cart';

// Register cart routes
await app.register(cartRoutes, { prefix: '/api/v1/cart' });
```

---

## Error Handling

### Common Error Cases

1. **Invalid cart type**
   - Status: 400 Bad Request
   - Message: "Invalid cart type. Must be one of: sales, registrations"

2. **ENS name not found**
   - Status: 404 Not Found
   - Message: "ENS name with ID {id} not found"

3. **Unauthorized access**
   - Status: 401 Unauthorized
   - Message: "Authentication required"

4. **Delete non-existent item**
   - Status: 404 Not Found
   - Message: "Cart item not found"

5. **Bulk add validation**
   - Status: 400 Bad Request
   - Message: "Too many items (max 100 per request)"

---

## Security Considerations

1. **Authentication Required**
   - All endpoints require valid JWT token
   - Users can only access their own cart items

2. **Authorization**
   - Users cannot view or modify other users' carts
   - Always filter by `user_id` from authenticated token

3. **Rate Limiting**
   - Apply standard rate limits to prevent abuse
   - Consider stricter limits on bulk operations

4. **Input Validation**
   - Validate all input with Zod schemas
   - Sanitize cart type names
   - Validate ENS name IDs exist before insertion

---

## Testing Checklist

### Database Tests
- [ ] Cart types are inserted on migration
- [ ] Unique constraint prevents duplicate cart items
- [ ] Cascade delete removes cart items when user deleted
- [ ] Cascade delete removes cart items when ENS name deleted
- [ ] Updated_at trigger works correctly

### API Tests
- [ ] GET /cart returns empty array for new user
- [ ] GET /cart returns standard SearchResult format for names
- [ ] POST /cart adds item successfully
- [ ] POST /cart is idempotent (adding same item twice)
- [ ] POST /cart validates cart_type exists
- [ ] POST /cart validates ens_name_id exists
- [ ] GET /cart?type=sales filters correctly
- [ ] DELETE /cart/:id removes item
- [ ] DELETE /cart/:id returns 404 for other user's item
- [ ] POST /cart/bulk adds multiple items
- [ ] POST /cart/bulk skips duplicates
- [ ] DELETE /cart clears all items
- [ ] DELETE /cart?type=sales clears only sales items
- [ ] GET /cart/summary returns correct counts
- [ ] All endpoints require authentication

### Integration Tests
- [ ] Adding name to cart, then deleting name removes cart item
- [ ] Adding name to cart, then deleting user removes cart item
- [ ] Can add same name to different cart types
- [ ] Cannot add same name to same cart type twice
- [ ] Response builder includes user's vote when userId provided
- [ ] Response builder includes all listings for names in cart

---

## Future Enhancements

### Phase 2 (Optional)
- Cart item metadata (e.g., notes, priority)
- Cart expiration/auto-cleanup
- Cart item ordering/sorting
- Move items between cart types
- Cart history/analytics
- Shared/collaborative carts
- Cart templates

### Phase 3 (Optional)
- Guest cart (session-based, merge on login)
- Cart notifications (price changes, expiry alerts)
- Saved carts (named collections)
- Export cart to CSV/JSON

---

## Timeline

**Estimated Effort:** 4-6 hours

- Database migration: 30 minutes
- API routes implementation: 2-3 hours
- Testing: 1-2 hours
- Documentation: 30 minutes

---

## Rollout Plan

1. **Deploy migration** to create tables
2. **Deploy API changes** with new cart endpoints
3. **Monitor logs** for errors in first 24 hours
4. **Frontend integration** can begin immediately after API deployment

---

## Open Questions

1. Should we add a `metadata` JSONB column to `cart_items` for future extensibility?
2. Do we need cart item ordering (position/rank)?
3. Should we track who added items to cart (for analytics)?
4. Do we want to limit the number of items per cart type?

---

## Appendix

### Database ER Diagram

```
users (1) ----< (N) cart_items
ens_names (1) ----< (N) cart_items
cart_types (1) ----< (N) cart_items
```

### Example Use Cases

**Use Case 1: User adds names to purchase cart**
1. User browses listings
2. Clicks "Add to Cart" on vitalik.eth
3. Frontend: POST /api/v1/cart { ens_name_id: 456, cart_type: "sales" }
4. Backend: Inserts cart item, returns success
5. Frontend: Updates cart badge count

**Use Case 2: User views their cart**
1. User clicks cart icon
2. Frontend: GET /api/v1/cart?type=sales
3. Backend: Returns list of cart items with full ENS name data (via buildSearchResults)
4. Frontend: Displays list with prices, listings, and remove buttons

**Use Case 3: User bulk adds names from search**
1. User searches for 3-letter names
2. Selects 10 names
3. Clicks "Add all to cart"
4. Frontend: POST /api/v1/cart/bulk { cart_type: "registrations", ens_name_ids: [...] }
5. Backend: Inserts all items, returns count
6. Frontend: Shows success message

---

## Sign-off

**Created by:** Claude Code
**Date:** 2025-11-04
**Status:** Draft - Ready for Review
