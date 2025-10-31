# Grails WAL Listener Service

Monitors PostgreSQL's Write-Ahead Log (WAL) for database changes and synchronizes data to Elasticsearch for fast search capabilities.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Edit .env with your configuration

# Set up PostgreSQL logical replication (one-time setup)
npm run wal:setup

# Development mode
npm run dev

# Production
npm run build
npm start
```

## What This Service Does

- **Real-Time Sync**: Monitors PostgreSQL changes via logical replication
- **Elasticsearch Indexing**: Keeps search index up-to-date with database
- **Zero Polling**: Push-based updates (sub-second latency)
- **Selective Sync**: Only syncs relevant tables (ens_names, listings, offers, sales)

## How It Improves Search

### The Problem
PostgreSQL is great for relational queries but slow for:
- Full-text search across large datasets
- Complex filtering (price + length + character type + expiration)
- Aggregations (club membership counts, sales statistics)

### The Solution
- **PostgreSQL**: Source of truth for all data
- **Elasticsearch**: Optimized search index with denormalized data
- **WAL Listener**: Keeps them in perfect sync

### Benefits
```
Traditional Approach (PostgreSQL only):
- Complex query: 2-5 seconds
- Full-text search: 500ms-2s
- No scoring/relevance

With Elasticsearch:
- Same complex query: 50-200ms (10-40x faster)
- Full-text search: 10-50ms (10-40x faster)
- Relevance scoring built-in
```

## Tables Monitored

| Table | Changes Synced | What Gets Indexed |
|-------|---------------|-------------------|
| ens_names | INSERT, UPDATE | name, token_id, owner, expiry, clubs, character_count, has_numbers, has_emoji, is_expired, days_until_expiry |
| listings | INSERT, UPDATE, DELETE | All listing data joined with ens_names |
| sales | INSERT | Updates last_sale_price, last_sale_date, has_sales fields |
| offers | INSERT, UPDATE | Offer count per name |

## Elasticsearch Index Structure

```json
{
  "ens_names": {
    "mappings": {
      "properties": {
        "name": { "type": "text", "fields": { "keyword": { "type": "keyword" } } },
        "token_id": { "type": "keyword" },
        "owner": { "type": "keyword" },
        "price": { "type": "long" },
        "character_count": { "type": "integer" },
        "has_numbers": { "type": "boolean" },
        "has_emoji": { "type": "boolean" },
        "clubs": { "type": "keyword" },
        "expiry_date": { "type": "date" },
        "is_expired": { "type": "boolean" },
        "is_grace_period": { "type": "boolean" },
        "is_premium_period": { "type": "boolean" },
        "days_until_expiry": { "type": "integer" },
        "has_sales": { "type": "boolean" },
        "last_sale_date": { "type": "date" },
        "days_since_last_sale": { "type": "integer" }
      }
    }
  }
}
```

## Required Environment Variables

```env
# Database
DATABASE_URL=postgresql://user:password@localhost:5432/grails
REPLICATION_SLOT=grails_wal_slot
PUBLICATION_NAME=grails_publication

# Elasticsearch
ELASTICSEARCH_URL=http://localhost:9200
ELASTICSEARCH_INDEX=ens_names

# WAL Config
WAL_SENDER_TIMEOUT=60000  # 60 seconds
HEARTBEAT_INTERVAL=30000   # 30 seconds
```

## PostgreSQL Setup

### 1. Enable Logical Replication

Edit `postgresql.conf`:
```conf
wal_level = logical
max_replication_slots = 4
max_wal_senders = 4
```

Restart PostgreSQL:
```bash
sudo systemctl restart postgresql
```

### 2. Create Publication

```sql
CREATE PUBLICATION grails_publication FOR TABLE
  ens_names, listings, offers, sales;
```

### 3. Create Replication Slot

```sql
SELECT pg_create_logical_replication_slot('grails_wal_slot', 'pgoutput');
```

## Data Flow

```
PostgreSQL Write → WAL → WAL Listener → Process Change → Update Elasticsearch
                                              ↓
                                        Batch Updates (500ms)
                                              ↓
                                        Bulk Index to ES
```

### Change Processing Example

```
1. User creates listing in API
2. API inserts into listings table
3. PostgreSQL writes to WAL
4. WAL Listener captures INSERT event
5. Listener fetches related ens_names data
6. Calculates derived fields (is_expired, days_until_expiry, etc.)
7. Updates Elasticsearch document
8. Change visible in search within 500ms
```

## Resync Process

If Elasticsearch gets out of sync (rare), run full resync:

```bash
# Reindex all data from PostgreSQL to Elasticsearch
npm run resync

# This will:
# 1. Drop existing Elasticsearch index
# 2. Create new index with mapping
# 3. Read all ens_names from PostgreSQL
# 4. Batch index to Elasticsearch (100 at a time)
# 5. Verify counts match
```

## Monitoring

### Check Replication Status
```sql
SELECT * FROM pg_replication_slots WHERE slot_name = 'grails_wal_slot';
```

### Check Replication Lag
```sql
SELECT
  pg_wal_lsn_diff(pg_current_wal_lsn(), confirmed_flush_lsn) AS lag_bytes
FROM pg_replication_slots
WHERE slot_name = 'grails_wal_slot';
```

### Compare Counts
```bash
# PostgreSQL count
psql $DATABASE_URL -c "SELECT COUNT(*) FROM ens_names;"

# Elasticsearch count
curl http://localhost:9200/ens_names/_count
```

## Common Issues

### Replication Slot Full/Growing
```bash
# Check slot status
SELECT * FROM pg_stat_replication;

# If WAL Listener is down, slot accumulates WAL
# Restart listener to consume backlog

# If permanently stuck, recreate slot:
SELECT pg_drop_replication_slot('grails_wal_slot');
SELECT pg_create_logical_replication_slot('grails_wal_slot', 'pgoutput');
npm run resync  # Reindex all data
```

### Elasticsearch Connection Failures
```bash
# Check Elasticsearch is running
curl http://localhost:9200

# Check index exists
curl http://localhost:9200/ens_names

# Recreate index if needed
npm run resync
```

### Sync Lag (Changes Not Appearing)
- Check WAL Listener is running
- Check logs for errors
- Verify PostgreSQL publication includes all tables
- Run resync to catch up

## Utilities

### Resync Elasticsearch
```bash
npm run resync
```

### Check Index Health
```bash
curl http://localhost:9200/_cat/indices?v
```

### View Sample Documents
```bash
curl http://localhost:9200/ens_names/_search?size=5
```

### Delete and Recreate Index
```bash
curl -X DELETE http://localhost:9200/ens_names
npm run resync
```

## Architecture Benefits

### Separation of Concerns
- **PostgreSQL**: ACID compliance, relational integrity, source of truth
- **Elasticsearch**: Fast search, complex filtering, relevance scoring
- **WAL Listener**: Keeps them in sync automatically

### Scalability
- Add Elasticsearch nodes for read scalability
- PostgreSQL handles write load
- WAL Listener is stateless (can run multiple instances)

### Reliability
- If Elasticsearch goes down, PostgreSQL unaffected
- When Elasticsearch comes back, resync catches it up
- WAL ensures no data loss (PostgreSQL is source of truth)

## Documentation

- **Architecture Details**: See `CLAUDE.md` in this directory
- **WAL Protocol**: https://www.postgresql.org/docs/current/logical-replication.html
- **Elasticsearch Mapping**: See `src/services/elasticsearch-sync.ts`
