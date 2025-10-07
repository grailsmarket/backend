# Database Migration Audit Guide

This guide helps you verify the current state of your production database against the expected state from all migrations.

## Migration Timeline (Based on File Timestamps)

1. **normalize_addresses.sql** (Oct 1, 2024)
2. **fix_duplicate_order_hash.sql** (Oct 1, 2024)
3. **create_activity_history.sql** (Oct 2, 2024)
4. **fix_conflict_constraints.sql** (Oct 2, 2024)
5. **fix_null_order_hashes.sql** (Oct 2, 2024)
6. **fix_offers_source_nulls.sql** (Oct 2, 2024)
7. **force_fix_offers_index.sql** (Oct 2, 2024)
8. **add_transfer_event_types.sql** (Oct 3, 2024)
9. **fix_listing_unique_constraint.sql** (Oct 3, 2024) ⚠️ **CONFLICTING**
10. **fix_notify_payload_size.sql** (Oct 5, 2024)

---

## ⚠️ **CRITICAL ISSUE IDENTIFIED**

**Migration #9 (fix_listing_unique_constraint.sql) CONFLICTS with earlier migrations!**

- **Migration #4 (fix_conflict_constraints.sql)** creates: `listings_order_hash_source_unique` WITHOUT WHERE clause
- **Migration #9 (fix_listing_unique_constraint.sql)** recreates it WITH `WHERE status = 'active'`

This is the issue you mentioned where listings couldn't be created for a day. The partial index (WITH WHERE clause) is incompatible with `ON CONFLICT` clauses in your INSERT statements.

---

## Verification Queries

Run these queries in order to verify each migration's state:

### 1. normalize_addresses.sql

**Purpose**: Normalize all addresses to lowercase

**Verification Queries**:

```sql
-- Check if any uppercase addresses exist (should return 0 rows)
SELECT 'listings' as table_name, COUNT(*) as uppercase_count
FROM listings
WHERE seller_address != LOWER(seller_address)
   OR currency_address != LOWER(currency_address);

-- Check offers
SELECT 'offers' as table_name, COUNT(*) as uppercase_count
FROM offers
WHERE buyer_address != LOWER(buyer_address)
   OR currency_address != LOWER(currency_address);

-- Check ens_names
SELECT 'ens_names' as table_name, COUNT(*) as uppercase_count
FROM ens_names
WHERE owner_address != LOWER(owner_address);

-- Check indexes exist
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename IN ('listings', 'offers', 'ens_names')
AND indexname LIKE '%address%lower%';
```

**Expected Result**:
- All uppercase counts should be 0
- Should see 3 indexes: `idx_listings_seller_address_lower`, `idx_offers_buyer_address_lower`, `idx_ens_names_owner_address_lower`

---

### 2. fix_duplicate_order_hash.sql

**Purpose**: Add `source` column and create composite unique constraint

**Verification Queries**:

```sql
-- Check if source column exists
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'listings' AND column_name = 'source';

-- Check constraint (should exist but may be modified by later migrations)
SELECT conname, pg_get_constraintdef(oid) as definition
FROM pg_constraint
WHERE conrelid = 'listings'::regclass
AND conname LIKE '%order_hash%';

-- Check index
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'listings' AND indexname LIKE '%source%';
```

**Expected Result**:
- `source` column exists as VARCHAR(20)
- Constraint or index named `listings_order_hash_source_unique` exists
- Index `idx_listings_source` exists

---

### 3. create_activity_history.sql

**Purpose**: Create activity_history table and enum

**Verification Queries**:

```sql
-- Check if activity_event_type enum exists
SELECT typname, array_agg(enumlabel ORDER BY enumsortorder) as enum_values
FROM pg_type t
JOIN pg_enum e ON t.oid = e.enumtypid
WHERE typname = 'activity_event_type'
GROUP BY typname;

-- Check if table exists
SELECT table_name FROM information_schema.tables
WHERE table_name = 'activity_history';

-- Check columns
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'activity_history'
ORDER BY ordinal_position;

-- Check indexes
SELECT indexname FROM pg_indexes
WHERE tablename = 'activity_history'
ORDER BY indexname;

-- Check comments
SELECT obj_description('activity_history'::regclass);
```

**Expected Result**:
- Enum should have: `['listed', 'listing_updated', 'offer_made', 'bought', 'sold', 'offer_accepted', 'cancelled']` (initially, more added later)
- Table exists with all columns from migration
- 10+ indexes exist (listed in migration file)
- Table comment exists

---

### 4. fix_conflict_constraints.sql

**Purpose**: Fix constraints for listings, offers, and ens_names

**Verification Queries**:

```sql
-- Check offers.source column
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'offers' AND column_name = 'source';

-- Check listings constraint/index (IMPORTANT - this should be FULL index, not partial)
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'listings' AND indexname = 'listings_order_hash_source_unique';

-- Check offers constraint/index
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'offers' AND indexname = 'offers_order_hash_source_unique';

-- Check ens_names unique constraint (should NOT exist)
SELECT conname FROM pg_constraint
WHERE conrelid = 'ens_names'::regclass AND conname = 'ens_names_name_key';

-- Check ens_names partial unique index (should exist)
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'ens_names' AND indexname = 'ens_names_real_name_unique';
```

**Expected Result**:
- `offers.source` exists, default 'opensea'
- `listings_order_hash_source_unique` is a UNIQUE INDEX **WITHOUT WHERE clause**
- `offers_order_hash_source_unique` is a UNIQUE INDEX **WITHOUT WHERE clause**
- `ens_names_name_key` constraint does NOT exist
- `ens_names_real_name_unique` partial index exists WITH WHERE clause

---

### 5. fix_null_order_hashes.sql

**Purpose**: Replace NULL order_hash values with placeholders

**Verification Queries**:

```sql
-- Check for NULL order_hash in offers (should be 0)
SELECT COUNT(*) as null_order_hash_count
FROM offers
WHERE order_hash IS NULL;

-- Check for placeholder values
SELECT COUNT(*) as placeholder_count
FROM offers
WHERE order_hash LIKE 'placeholder_%';

-- Sample placeholder values
SELECT id, order_hash, source
FROM offers
WHERE order_hash LIKE 'placeholder_%'
LIMIT 5;
```

**Expected Result**:
- No NULL order_hash values
- May have some placeholder values (format: `placeholder_{id}_{source}`)

---

### 6. fix_offers_source_nulls.sql

**Purpose**: Fix NULL source values and make column NOT NULL

**Verification Queries**:

```sql
-- Check for NULL source (should be 0)
SELECT COUNT(*) as null_source_count
FROM offers
WHERE source IS NULL;

-- Check column constraints
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'offers' AND column_name = 'source';

-- Check if trigger exists
SELECT tgname, tgenabled
FROM pg_trigger
WHERE tgrelid = 'offers'::regclass
AND tgname = 'notify_offers_changes';
```

**Expected Result**:
- No NULL source values
- `is_nullable` should be 'NO'
- `column_default` should be 'grails'
- Trigger exists and is enabled

---

### 7. force_fix_offers_index.sql

**Purpose**: Remove WHERE clause from offers index

**Verification Queries**:

```sql
-- Check the exact index definition (should NOT have WHERE clause)
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'offers' AND indexname = 'offers_order_hash_source_unique';
```

**Expected Result**:
- Index definition: `CREATE UNIQUE INDEX offers_order_hash_source_unique ON offers USING btree (order_hash, source)`
- **NO WHERE clause**

---

### 8. add_transfer_event_types.sql

**Purpose**: Add mint, burn, sent, received to enum

**Verification Queries**:

```sql
-- Check enum values (should include new types)
SELECT array_agg(enumlabel ORDER BY enumsortorder) as all_event_types
FROM pg_enum e
JOIN pg_type t ON e.enumtypid = t.oid
WHERE t.typname = 'activity_event_type';
```

**Expected Result**:
- Array should include: `['listed', 'listing_updated', 'offer_made', 'bought', 'sold', 'offer_accepted', 'cancelled', 'mint', 'burn', 'sent', 'received']`

---

### 9. fix_listing_unique_constraint.sql ⚠️

**Purpose**: Make listings index partial (WITH WHERE status = 'active')

**⚠️ CONFLICT**: This migration conflicts with #4 (fix_conflict_constraints.sql)

**Verification Query**:

```sql
-- Check current state of listings index
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'listings' AND indexname = 'listings_order_hash_source_unique';
```

**Possible States**:

**State A** (If migration #9 was applied last):
```
CREATE UNIQUE INDEX listings_order_hash_source_unique ON listings USING btree (order_hash, source) WHERE status = 'active'
```
❌ **PROBLEM**: Partial index breaks `ON CONFLICT` in INSERT statements

**State B** (If migration #4 was applied or #9 was reverted):
```
CREATE UNIQUE INDEX listings_order_hash_source_unique ON listings USING btree (order_hash, source)
```
✅ **CORRECT**: Full index works with `ON CONFLICT`

---

### 10. fix_notify_payload_size.sql

**Purpose**: Reduce pg_notify payload size

**Verification Queries**:

```sql
-- Check notify_changes function definition
SELECT pg_get_functiondef(oid)
FROM pg_proc
WHERE proname = 'notify_changes';

-- Check which tables have this trigger
SELECT DISTINCT tgrelid::regclass::text as table_name
FROM pg_trigger
WHERE tgfoid = 'notify_changes'::regproc;
```

**Expected Result**:
- Function should build minimal payload (table, operation, id, timestamp only)
- Function should check payload size < 7500 bytes
- Multiple tables should have notify triggers

---

## Summary Verification Script

Run this comprehensive check to see overall database state:

```sql
-- COMPREHENSIVE DATABASE STATE CHECK

SELECT '=== ADDRESSES ===' as check_section;

SELECT 'listings uppercase' as check_name, COUNT(*) as count
FROM listings WHERE seller_address != LOWER(seller_address);

SELECT 'offers uppercase' as check_name, COUNT(*) as count
FROM offers WHERE buyer_address != LOWER(buyer_address);

SELECT 'ens_names uppercase' as check_name, COUNT(*) as count
FROM ens_names WHERE owner_address != LOWER(owner_address);

SELECT '=== COLUMNS ===' as check_section;

SELECT 'listings.source exists' as check_name,
       EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='listings' AND column_name='source') as result;

SELECT 'offers.source exists' as check_name,
       EXISTS(SELECT 1 FROM information_schema.columns WHERE table_name='offers' AND column_name='source') as result;

SELECT '=== NULL VALUES ===' as check_section;

SELECT 'offers.order_hash NULLs' as check_name, COUNT(*) as count
FROM offers WHERE order_hash IS NULL;

SELECT 'offers.source NULLs' as check_name, COUNT(*) as count
FROM offers WHERE source IS NULL;

SELECT '=== CRITICAL INDEXES ===' as check_section;

SELECT 'listings_order_hash_source_unique' as index_name,
       CASE WHEN indexdef LIKE '%WHERE%' THEN 'PARTIAL (BAD)' ELSE 'FULL (GOOD)' END as status,
       indexdef
FROM pg_indexes
WHERE indexname = 'listings_order_hash_source_unique';

SELECT 'offers_order_hash_source_unique' as index_name,
       CASE WHEN indexdef LIKE '%WHERE%' THEN 'PARTIAL (BAD)' ELSE 'FULL (GOOD)' END as status,
       indexdef
FROM pg_indexes
WHERE indexname = 'offers_order_hash_source_unique';

SELECT '=== ACTIVITY HISTORY ===' as check_section;

SELECT 'activity_history table exists' as check_name,
       EXISTS(SELECT 1 FROM information_schema.tables WHERE table_name='activity_history') as result;

SELECT 'activity_event_type enum count' as check_name,
       COUNT(*) as count
FROM pg_enum e
JOIN pg_type t ON e.enumtypid = t.oid
WHERE t.typname = 'activity_event_type';

SELECT '=== TRIGGERS ===' as check_section;

SELECT 'notify_changes function exists' as check_name,
       EXISTS(SELECT 1 FROM pg_proc WHERE proname='notify_changes') as result;
```

---

## Recommended Actions

Based on your description of the listing creation issue, here's what likely happened:

1. **Migration #4** created `listings_order_hash_source_unique` as a FULL unique index (correct)
2. **Migration #9** was applied later, converting it to a PARTIAL index with `WHERE status = 'active'`
3. This caused listing creation failures because `ON CONFLICT (order_hash, source)` requires a FULL index
4. You likely manually fixed it by running migration #4 again or manually recreating the index

### To Fix Permanently:

**Option 1: Delete Migration #9** (Recommended)
```bash
rm /home/throw/work/grails/grails-testing/services/api/migrations/fix_listing_unique_constraint.sql
```
This migration should not have been created - it conflicts with the design decision in migration #4.

**Option 2: Update Migration #9**
Change it to match migration #4 (remove WHERE clause):
```sql
DROP INDEX IF EXISTS listings_order_hash_source_unique;
CREATE UNIQUE INDEX listings_order_hash_source_unique
ON listings (order_hash, source);
-- No WHERE clause!
```

### Current State Check:

Run this to see your current listings index state:
```sql
SELECT indexdef
FROM pg_indexes
WHERE indexname = 'listings_order_hash_source_unique';
```

**If it has `WHERE status = 'active'`**: Re-run migration #4 or manually fix:
```sql
DROP INDEX IF EXISTS listings_order_hash_source_unique;
CREATE UNIQUE INDEX listings_order_hash_source_unique ON listings (order_hash, source);
```

**If it has NO WHERE clause**: You're good! Just delete migration #9 file to prevent future confusion.
