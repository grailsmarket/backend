# Redis Cache Implementation

## Overview
Redis caching has been implemented for public API endpoints to reduce database load and improve response times.

## Configuration

### Environment Variables
Add these to your `.env` file:

```env
REDIS_URL=redis://localhost:6379
REDIS_ENABLED=true
CACHE_TTL_SECONDS=15
```

- `REDIS_URL`: Redis connection string (default: redis://localhost:6379)
- `REDIS_ENABLED`: Enable/disable caching (default: true)
- `CACHE_TTL_SECONDS`: Default cache TTL in seconds (default: 15)

## Features

- **Automatic caching**: Responses are automatically cached for configured TTL
- **Auth-aware**: Requests with Authorization headers bypass cache
- **Query-param aware**: Cache keys include query parameters
- **Status-code aware**: Only successful responses (2xx) are cached
- **Cache headers**: Responses include `X-Cache: HIT` or `X-Cache: MISS` header

## Cache TTL Options

Three pre-configured cache handlers:

- `cacheHandler`: 15 seconds (default) - For frequently changing data
- `longCacheHandler`: 60 seconds - For moderate-frequency changes
- `veryLongCacheHandler`: 300 seconds (5 minutes) - For very stable data

## Cached Endpoints

### Names Routes (`/api/v1/names/*`)
- `GET /names` - 15s TTL
- `GET /names/:name` - Uses optionalAuth, caching handled per-request
- `GET /names/:name/legacy` - 15s TTL
- `GET /names/:name/history` - 15s TTL

### Listings Routes (`/api/v1/listings/*`)
- `GET /listings` - 15s TTL
- `GET /listings/name/:name` - 15s TTL
- `GET /listings/:id` - 15s TTL

### Sales Routes (`/api/v1/sales/*`)
- `GET /sales` - 15s TTL
- `GET /sales/name/:name` - 60s TTL (historical data, changes less frequently)
- `GET /sales/address/:address` - 15s TTL
- `GET /sales/:nameOrId/analytics` - 60s TTL

### Offers Routes (`/api/v1/offers/*`)
- `GET /offers/name/:name` - 15s TTL
- `GET /offers/:id` - 15s TTL
- `GET /offers/buyer/:address` - 15s TTL
- `GET /offers/owner/:address` - 15s TTL

### Clubs Routes (`/api/v1/clubs/*`)
- `GET /clubs` - 300s TTL (very stable data)
- `GET /clubs/:clubName` - 15s TTL

### Activity Routes (`/api/v1/activity/*`)
- `GET /activity/:name` - 15s TTL
- `GET /activity/address/:address` - 15s TTL
- `GET /activity` - 15s TTL

## Not Cached

The following routes are **NOT** cached because they require authentication:

- All POST, PATCH, DELETE endpoints
- Watchlist endpoints (`/api/v1/watchlist/*`)
- User profile endpoints (`/api/v1/users/*`)
- Notification endpoints (`/api/v1/notifications/*`)
- Any endpoint with authentication middleware

## Cache Invalidation

### Manual Invalidation
Use the utility functions in `src/utils/redis.ts`:

```typescript
import { invalidateCache, clearAllCache } from '../utils/redis';

// Invalidate specific pattern
await invalidateCache('cache:/api/v1/listings*');

// Clear all cache
await clearAllCache();
```

### Automatic Invalidation (Future)
Consider adding cache invalidation triggers in the WAL listener when data changes:

```typescript
// In WAL listener when listing changes
await invalidateCache('cache:/api/v1/listings*');
await invalidateCache(`cache:/api/v1/names/${ensName}*`);
```

## Monitoring

### Check Cache Performance
Response headers indicate cache hit/miss:
```bash
curl -I http://localhost:3002/api/v1/listings
# Look for: X-Cache: HIT or X-Cache: MISS
```

### Redis Stats
```bash
redis-cli INFO stats
redis-cli DBSIZE
redis-cli KEYS 'cache:*'
```

## Disabling Cache

To disable caching without code changes:

```env
REDIS_ENABLED=false
```

Or to disable Redis entirely, stop the Redis server. The app will gracefully handle Redis being unavailable.

## Custom Cache Handlers

To create custom cache behavior for specific routes:

```typescript
import { createCacheHandler } from '../middleware/cache';

// Custom 30-second cache
const customCache = createCacheHandler({ ttl: 30 });

fastify.get('/my-route', { preHandler: customCache }, async (request, reply) => {
  // ...
});

// Skip cache based on custom logic
const conditionalCache = createCacheHandler({
  ttl: 15,
  skipCache: (req) => req.query.nocache === 'true'
});
```

## Performance Impact

Expected benefits:
- **Reduced database load**: 80-95% reduction for frequently accessed endpoints
- **Improved response time**: 10-50ms instead of 50-200ms for cached responses
- **Better scalability**: Can handle more concurrent users

Trade-offs:
- **Stale data**: Up to 15-300 seconds depending on endpoint
- **Memory usage**: Minimal with 15s default TTL
- **Additional complexity**: Need to manage cache invalidation

## Troubleshooting

### Redis Connection Issues
If Redis is unavailable, the app continues to work without caching. Check logs for:
```
Redis client error: ...
```

### Cache Not Working
1. Check `REDIS_ENABLED=true` in environment
2. Verify Redis is running: `redis-cli ping` (should return `PONG`)
3. Check for Authorization header in requests (bypasses cache)
4. Look for `X-Cache` header in responses

### Stale Data
If data appears stale:
1. Check cache TTL settings
2. Consider lowering TTL for that endpoint
3. Implement cache invalidation on data changes
