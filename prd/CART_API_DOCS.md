# Cart API Endpoints Overview

## Authentication
All cart endpoints require authentication via JWT token in the `Authorization` header:
```
Authorization: Bearer <your-jwt-token>
```

---

## 1. GET /api/v1/cart
Get all items in the user's cart, optionally filtered by cart type.

**Query Parameters:**
- `type` (optional): Filter by cart type ('sales' or 'registrations')

**Example Calls:**
```bash
# Get all cart items
curl -H "Authorization: Bearer <token>" \
  http://localhost:3002/api/v1/cart

# Get only sales cart items
curl -H "Authorization: Bearer <token>" \
  http://localhost:3002/api/v1/cart?type=sales

# Get only registrations cart items
curl -H "Authorization: Bearer <token>" \
  http://localhost:3002/api/v1/cart?type=registrations
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "cartItemId": 123,
        "cartType": "sales",
        "addedAt": "2025-01-04T12:00:00.000Z",
        "id": 456,
        "name": "vitalik.eth",
        "token_id": "12345",
        "owner": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
        "expiry_date": "2036-05-03T00:00:00.000Z",
        "listings": [...],
        "upvotes": 10,
        "downvotes": 2,
        "highest_offer_wei": "1000000000000000000",
        ...
      }
    ]
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

---

## 2. GET /api/v1/cart/summary
Get a summary of cart item counts by type.

**Example Call:**
```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:3002/api/v1/cart/summary
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "sales": 5,
      "registrations": 3
    },
    "total": 8
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

---

## 3. POST /api/v1/cart
Add a single ENS name to a cart using the ENS name ID.

**Request Body:**
```json
{
  "ensNameId": 456,
  "cartType": "sales"
}
```

**Field Descriptions:**
- `ensNameId` (number, required): The database ID of the ENS name (from `ens_names.id`)
- `cartType` (string, required): The cart type ('sales' or 'registrations')

**Example Call:**
```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"ensNameId":456,"cartType":"sales"}' \
  http://localhost:3002/api/v1/cart
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "message": "Added to cart",
    "cartItemId": 789,
    "ensNameId": 456,
    "ensName": "vitalik.eth",
    "cartType": "sales"
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

**If already in cart:**
```json
{
  "success": true,
  "data": {
    "message": "Item already in cart",
    "cartItemId": null,
    "ensNameId": 456,
    "ensName": "vitalik.eth",
    "cartType": "sales"
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

---

## 4. POST /api/v1/cart/bulk
Add multiple ENS names to cart at once (max 100 items) using ENS name IDs.

**Request Body:**
```json
{
  "items": [
    {
      "ensNameId": 456,
      "cartType": "sales"
    },
    {
      "ensNameId": 789,
      "cartType": "sales"
    },
    {
      "ensNameId": 123,
      "cartType": "registrations"
    }
  ]
}
```

**Field Descriptions:**
- `items` (array, required): Array of cart items to add (1-100 items)
  - `ensNameId` (number, required): The database ID of the ENS name
  - `cartType` (string, required): The cart type ('sales' or 'registrations')

**Example Call:**
```bash
curl -X POST \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{
    "items": [
      {"ensNameId":456,"cartType":"sales"},
      {"ensNameId":789,"cartType":"sales"},
      {"ensNameId":123,"cartType":"registrations"}
    ]
  }' \
  http://localhost:3002/api/v1/cart/bulk
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "message": "Added 3 items to cart",
    "addedCount": 3,
    "totalRequested": 3,
    "skippedCount": 0
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

**Response when some items already exist:**
```json
{
  "success": true,
  "data": {
    "message": "Added 2 items to cart",
    "addedCount": 2,
    "totalRequested": 3,
    "skippedCount": 1
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

---

## 5. DELETE /api/v1/cart/:id
Remove a single item from cart by cart item ID.

**URL Parameters:**
- `id`: The cart item ID (not the ENS name ID)

**Example Call:**
```bash
curl -X DELETE \
  -H "Authorization: Bearer <token>" \
  http://localhost:3002/api/v1/cart/123
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "message": "Removed from cart"
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

---

## 6. DELETE /api/v1/cart
Clear all cart items or clear by cart type.

**Request Body (optional):**
```json
{
  "cartType": "sales"
}
```

**Example Calls:**
```bash
# Clear all cart items
curl -X DELETE \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3002/api/v1/cart

# Clear only sales cart
curl -X DELETE \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"cartType":"sales"}' \
  http://localhost:3002/api/v1/cart

# Clear only registrations cart
curl -X DELETE \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"cartType":"registrations"}' \
  http://localhost:3002/api/v1/cart
```

**Example Response:**
```json
{
  "success": true,
  "data": {
    "message": "Cleared sales cart",
    "deletedCount": 5
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z",
    "version": "1.0.0"
  }
}
```

---

## Error Responses

**401 Unauthorized (missing or invalid token):**
```json
{
  "success": false,
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Not authenticated"
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z"
  }
}
```

**404 ENS Name Not Found:**
```json
{
  "success": false,
  "error": {
    "code": "ENS_NAME_NOT_FOUND",
    "message": "ENS name with ID 999 not found"
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z"
  }
}
```

**404 ENS Names Not Found (Bulk):**
```json
{
  "success": false,
  "error": {
    "code": "ENS_NAMES_NOT_FOUND",
    "message": "ENS name IDs not found: 999, 1000, 1001"
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z"
  }
}
```

**400 Invalid Cart Type:**
```json
{
  "success": false,
  "error": {
    "code": "INVALID_CART_TYPE",
    "message": "Cart type \"invalid\" does not exist"
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z"
  }
}
```

**400 Validation Error:**
```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request body",
    "details": [
      {
        "code": "invalid_type",
        "expected": "number",
        "received": "string",
        "path": ["ensNameId"],
        "message": "Expected number, received string"
      }
    ]
  },
  "meta": {
    "timestamp": "2025-01-04T12:00:00.000Z"
  }
}
```

---

## Frontend Integration Notes

When using these endpoints from the frontend:

1. **Getting ENS Name IDs**: The `id` field is available in all search results from `/api/v1/names/search` and `/api/v1/names/:name`

2. **Adding to Cart**: Use the `id` field directly from search results:
   ```javascript
   // From search result
   const ensName = { id: 456, name: "vitalik.eth", ... };

   // Add to cart
   await fetch('/api/v1/cart', {
     method: 'POST',
     headers: {
       'Authorization': `Bearer ${token}`,
       'Content-Type': 'application/json'
     },
     body: JSON.stringify({
       ensNameId: ensName.id,
       cartType: 'sales'
     })
   });
   ```

3. **Bulk Operations**: Efficiently add multiple items at once:
   ```javascript
   const selectedNames = [
     { id: 456, name: "vitalik.eth" },
     { id: 789, name: "nick.eth" }
   ];

   await fetch('/api/v1/cart/bulk', {
     method: 'POST',
     headers: {
       'Authorization': `Bearer ${token}`,
       'Content-Type': 'application/json'
     },
     body: JSON.stringify({
       items: selectedNames.map(name => ({
         ensNameId: name.id,
         cartType: 'sales'
       }))
     })
   });
   ```
