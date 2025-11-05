# Analytics Platform - Quick Start Guide

## Step 1: Run Database Migration

```bash
cd /home/throw/work/grails/grails-testing/services/api

# Run the migration
psql -d grails -f migrations/add_analytics_features.sql

# Verify materialized views were created
psql -d grails -c "\dv trending_*"

# Verify functions were created
psql -d grails -c "\df get_collectors_also_viewed"
psql -d grails -c "\df calculate_trending_score"
```

Expected output: You should see 12 materialized views and 4 functions.

---

## Step 2: Restart Services

```bash
# Restart API service (pick your method)
cd /home/throw/work/grails/grails-testing/services/api
npm run dev
# or
pm2 restart api

# Restart Worker service (pick your method)
cd /home/throw/work/grails/grails-testing/services/workers
npm run dev
# or
pm2 restart workers
```

Check worker logs for: `"Scheduled analytics refresh job to run every 15 minutes"`

---

## Step 3: Initial Data Refresh

The materialized views start empty. Manually trigger the first refresh:

### Option A: Wait 15 minutes for automatic refresh

### Option B: Manually trigger refresh via SQL

```bash
psql -d grails -c "REFRESH MATERIALIZED VIEW CONCURRENTLY trending_composite_24h;"
psql -d grails -c "REFRESH MATERIALIZED VIEW CONCURRENTLY trending_views_24h;"
# ... or refresh all at once:

psql -d grails << 'EOF'
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_views_24h;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_views_7d;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_watchlist_24h;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_watchlist_7d;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_votes_24h;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_votes_7d;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_sales_24h;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_sales_7d;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_offers_24h;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_offers_7d;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_composite_24h;
REFRESH MATERIALIZED VIEW CONCURRENTLY trending_composite_7d;
EOF
```

### Option C: Trigger via pg-boss job (requires worker running)

```bash
# Connect to database and manually insert job
psql -d grails << 'EOF'
INSERT INTO pgboss.job (name, data, state, priority, retrylimit, startafter, expirein)
VALUES ('refresh-analytics', '{}', 'created', 0, 3, NOW(), INTERVAL '1 hour');
EOF
```

---

## Step 4: Verify Data

Check that trending data is populated:

```bash
# Check composite trending
psql -d grails -c "SELECT name, trending_score FROM trending_composite_24h LIMIT 5;"

# Check views trending
psql -d grails -c "SELECT name, view_count_24h FROM trending_views_24h LIMIT 5;"

# Check sales trending
psql -d grails -c "SELECT name, sales_count_24h, total_volume_24h FROM trending_sales_24h LIMIT 5;"
```

---

## Step 5: Test API Endpoints

### Public Endpoints (No Auth)

```bash
# Test trending composite
curl "http://localhost:3002/api/v1/trending/composite?period=24h&limit=5" | jq

# Test trending by views
curl "http://localhost:3002/api/v1/trending/views?period=7d&limit=10" | jq

# Test trending by sales
curl "http://localhost:3002/api/v1/trending/sales?period=24h" | jq

# Test also-viewed recommendations (pick an existing name)
curl "http://localhost:3002/api/v1/recommendations/also-viewed?name=vitalik.eth&limit=5" | jq

# Test market analytics
curl "http://localhost:3002/api/v1/analytics/market?period=7d" | jq

# Test club analytics (replace with actual club name)
curl "http://localhost:3002/api/v1/analytics/clubs/10k%20Club?period=7d" | jq

# Test price trends
curl "http://localhost:3002/api/v1/analytics/price-trends?period=30d" | jq

# Test volume distribution
curl "http://localhost:3002/api/v1/analytics/volume?period=7d" | jq
```

### Authenticated Endpoints (Requires JWT Token)

First, get a token by authenticating:

```bash
# Step 1: Get nonce
NONCE=$(curl -s "http://localhost:3002/api/v1/auth/nonce?address=0xYourAddress" | jq -r '.data.nonce')

# Step 2: Sign the message with your wallet (use ethers.js, web3.py, or wallet UI)
# Message to sign: "Sign in to Grails\n\nNonce: ${NONCE}"

# Step 3: Verify and get token (replace SIGNATURE)
TOKEN=$(curl -s -X POST "http://localhost:3002/api/v1/auth/verify" \
  -H "Content-Type: application/json" \
  -d '{
    "address": "0xYourAddress",
    "signature": "0xYourSignature",
    "nonce": "'"$NONCE"'"
  }' | jq -r '.data.token')

# Now use the token for authenticated requests:

# Test "for you" recommendations
curl "http://localhost:3002/api/v1/recommendations/for-you?limit=10" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test similar to watchlist
curl "http://localhost:3002/api/v1/recommendations/similar-to-watchlist?limit=10" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test based on votes
curl "http://localhost:3002/api/v1/recommendations/based-on-votes?limit=10" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test personal analytics
curl "http://localhost:3002/api/v1/analytics/user/me" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test recently viewed names
curl "http://localhost:3002/api/v1/user/history/viewed?page=1&limit=20" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test watchlist history
curl "http://localhost:3002/api/v1/user/history/watched" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test voting history
curl "http://localhost:3002/api/v1/user/history/voted" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test offers made
curl "http://localhost:3002/api/v1/user/history/offers" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test purchase history
curl "http://localhost:3002/api/v1/user/history/purchases" \
  -H "Authorization: Bearer $TOKEN" | jq

# Test sales history
curl "http://localhost:3002/api/v1/user/history/sales" \
  -H "Authorization: Bearer $TOKEN" | jq
```

---

## Step 6: Monitor Refresh Jobs

```bash
# Check if refresh job is scheduled
psql -d grails -c "SELECT * FROM pgboss.schedule WHERE name = 'refresh-analytics';"

# Check recent refresh job executions
psql -d grails -c "
SELECT
  name,
  state,
  createdon,
  startedon,
  completedon,
  output
FROM pgboss.archive
WHERE name = 'refresh-analytics'
ORDER BY completedon DESC
LIMIT 5;
"

# Check worker logs for refresh activity
# Look for: "Refreshed materialized view" and "Successfully refreshed all analytics materialized views"
tail -f /path/to/worker/logs
# or
pm2 logs workers
```

---

## Troubleshooting

### Issue: Materialized views are empty

**Solution**: Views only populate when there's activity data. Check source tables:

```bash
psql -d grails << 'EOF'
-- Check if there's recent view activity
SELECT COUNT(*) FROM name_views WHERE viewed_at > NOW() - INTERVAL '24 hours';

-- Check if there's recent watchlist activity
SELECT COUNT(*) FROM watchlist WHERE added_at > NOW() - INTERVAL '24 hours';

-- Check if there's recent sales
SELECT COUNT(*) FROM sales WHERE sale_date > NOW() - INTERVAL '24 hours';
EOF
```

If counts are zero, you need activity data first. View some names, add to watchlist, or wait for sales data.

### Issue: "Relation does not exist" error

**Solution**: Migration didn't run correctly. Re-run:

```bash
psql -d grails -f /home/throw/work/grails/grails-testing/services/api/migrations/add_analytics_features.sql
```

### Issue: Recommendations return empty arrays

**Solution**: Collaborative filtering requires overlapping user behavior. You need:
- Multiple authenticated users
- Overlapping views/watchlist/votes between users
- At least 2-3 users with shared activity

### Issue: API returns 404

**Solution**: API service wasn't restarted after code changes. Restart:

```bash
cd /home/throw/work/grails/grails-testing/services/api
npm run dev
```

### Issue: Worker not running refresh job

**Solution**: Check worker logs. Verify registration:

```bash
# Should see: "Scheduled analytics refresh job to run every 15 minutes"
pm2 logs workers | grep analytics

# Check pg-boss schedule
psql -d grails -c "SELECT * FROM pgboss.schedule WHERE name = 'refresh-analytics';"
```

---

## Performance Benchmarks

Expected response times (with warm cache):

- Trending endpoints: 50-100ms
- Recommendations: 100-200ms (includes enrichment)
- Analytics endpoints: 50-150ms
- User insights: 100-200ms (includes enrichment)

Materialized view refresh: 2-5 seconds for all 12 views (concurrent)

---

## Next Steps

Once verified that all endpoints work:

1. **Frontend Integration**: Implement UI components
2. **Monitoring**: Set up alerts for failed refresh jobs
3. **Optimization**: Add Redis caching if needed
4. **Analytics**: Track endpoint usage and user engagement

---

## Quick Reference: All Endpoints

### Trending (6)
- `GET /api/v1/trending/composite?period={24h|7d}&limit={1-100}`
- `GET /api/v1/trending/views?period={24h|7d}&limit={1-100}`
- `GET /api/v1/trending/watchlist?period={24h|7d}&limit={1-100}`
- `GET /api/v1/trending/votes?period={24h|7d}&limit={1-100}`
- `GET /api/v1/trending/sales?period={24h|7d}&limit={1-100}`
- `GET /api/v1/trending/offers?period={24h|7d}&limit={1-100}`

### Recommendations (4)
- `GET /api/v1/recommendations/also-viewed?name={name}&limit={1-50}` [public]
- `GET /api/v1/recommendations/similar-to-watchlist?limit={1-50}` [auth]
- `GET /api/v1/recommendations/based-on-votes?limit={1-50}` [auth]
- `GET /api/v1/recommendations/for-you?limit={1-50}` [auth]

### Analytics (6)
- `GET /api/v1/analytics/market?period={24h|7d|30d|90d|all}` [public]
- `GET /api/v1/analytics/clubs/:club?period={24h|7d|30d|90d}` [public]
- `GET /api/v1/analytics/price-trends?period={24h|7d|30d|90d|all}` [public]
- `GET /api/v1/analytics/volume?period={24h|7d|30d|90d|all}` [public]
- `GET /api/v1/analytics/user/me` [auth]

### User Insights (6)
- `GET /api/v1/user/history/viewed?page={n}&limit={1-100}` [auth]
- `GET /api/v1/user/history/watched?page={n}&limit={1-100}` [auth]
- `GET /api/v1/user/history/voted?page={n}&limit={1-100}` [auth]
- `GET /api/v1/user/history/offers?page={n}&limit={1-100}` [auth]
- `GET /api/v1/user/history/purchases?page={n}&limit={1-100}` [auth]
- `GET /api/v1/user/history/sales?page={n}&limit={1-100}` [auth]

**Total: 22 new endpoints**

---

## Support

For issues or questions:
1. Check `/services/api/ANALYTICS_IMPLEMENTATION.md` for detailed documentation
2. Review logs: `pm2 logs api` and `pm2 logs workers`
3. Query database directly to verify data exists
4. Check pg-boss tables: `SELECT * FROM pgboss.job WHERE name LIKE '%analytics%'`
