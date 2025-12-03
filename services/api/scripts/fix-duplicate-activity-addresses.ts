/**
 * Fix Activity History Records with Duplicate Actor/Counterparty Addresses
 *
 * This script identifies and fixes activity_history records where actor_address
 * equals counterparty_address for 'bought' and 'sold' events.
 *
 * Root causes:
 * 1. Offer acceptance race condition (fixed in WAL listener)
 * 2. Bad data in imported sales CSV (from/to addresses were identical)
 *
 * Fix strategy:
 * - For records with offer_id: Look up correct seller from sales table
 * - For records with sale_id: Look up correct buyer/seller from sales table
 * - Delete records that cannot be fixed (no valid sale data)
 *
 * Usage:
 *   npx tsx scripts/fix-duplicate-activity-addresses.ts [--dry-run] [--delete-unfixable]
 *
 * Options:
 *   --dry-run            Preview changes without updating database
 *   --delete-unfixable   Delete records that cannot be fixed (default: keep them)
 */

import { getPostgresPool } from '../../shared/src';

const pool = getPostgresPool();

interface FixStats {
  totalDuplicates: number;
  fixedFromOffer: number;
  fixedFromSale: number;
  unfixable: number;
  deleted: number;
  errors: number;
}

interface DuplicateRecord {
  id: number;
  event_type: 'bought' | 'sold';
  actor_address: string;
  counterparty_address: string;
  ens_name_id: number;
  metadata: any;
  created_at: Date;
}

/**
 * Get all activity records with duplicate addresses
 */
async function getDuplicateRecords(): Promise<DuplicateRecord[]> {
  const result = await pool.query<DuplicateRecord>(
    `SELECT id, event_type, actor_address, counterparty_address, ens_name_id, metadata, created_at
     FROM activity_history
     WHERE actor_address = counterparty_address
       AND event_type IN ('bought', 'sold')
     ORDER BY created_at DESC`
  );

  return result.rows;
}

/**
 * Try to fix record by looking up sale from offer_id
 */
async function fixFromOffer(record: DuplicateRecord): Promise<{ buyer: string; seller: string } | null> {
  const offerId = record.metadata?.offer_id;
  if (!offerId) {
    return null;
  }

  // Look up sale by offer_id and ens_name_id
  const result = await pool.query(
    `SELECT seller_address, buyer_address
     FROM sales
     WHERE ens_name_id = $1
       AND metadata->>'offer_id' = $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [record.ens_name_id, offerId.toString()]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const { seller_address, buyer_address } = result.rows[0];

  // Validate that addresses are different and not null
  if (!seller_address || !buyer_address || seller_address === buyer_address) {
    return null;
  }

  return {
    buyer: buyer_address,
    seller: seller_address,
  };
}

/**
 * Try to fix record by looking up sale from sale_id
 */
async function fixFromSale(record: DuplicateRecord): Promise<{ buyer: string; seller: string } | null> {
  const saleId = record.metadata?.sale_id;
  if (!saleId) {
    return null;
  }

  // Look up sale by sale_id
  const result = await pool.query(
    `SELECT seller_address, buyer_address
     FROM sales
     WHERE id = $1`,
    [saleId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const { seller_address, buyer_address } = result.rows[0];

  // Validate that addresses are different and not null
  if (!seller_address || !buyer_address || seller_address === buyer_address) {
    return null;
  }

  return {
    buyer: buyer_address,
    seller: seller_address,
  };
}

/**
 * Update activity record with correct addresses
 */
async function updateRecord(
  record: DuplicateRecord,
  buyer: string,
  seller: string,
  dryRun: boolean
): Promise<boolean> {
  const newActorAddress = record.event_type === 'bought' ? buyer : seller;
  const newCounterpartyAddress = record.event_type === 'bought' ? seller : buyer;

  if (dryRun) {
    console.log(`  [DRY RUN] Would update record ${record.id}:`);
    console.log(`    Event: ${record.event_type}`);
    console.log(`    Old: actor=${record.actor_address}, counterparty=${record.counterparty_address}`);
    console.log(`    New: actor=${newActorAddress}, counterparty=${newCounterpartyAddress}`);
    return true;
  }

  try {
    await pool.query(
      `UPDATE activity_history
       SET actor_address = $1,
           counterparty_address = $2
       WHERE id = $3`,
      [newActorAddress, newCounterpartyAddress, record.id]
    );
    return true;
  } catch (error: any) {
    console.error(`  Error updating record ${record.id}: ${error.message}`);
    return false;
  }
}

/**
 * Delete unfixable record
 */
async function deleteRecord(record: DuplicateRecord, dryRun: boolean): Promise<boolean> {
  if (dryRun) {
    console.log(`  [DRY RUN] Would delete unfixable record ${record.id}`);
    return true;
  }

  try {
    await pool.query('DELETE FROM activity_history WHERE id = $1', [record.id]);
    return true;
  } catch (error: any) {
    console.error(`  Error deleting record ${record.id}: ${error.message}`);
    return false;
  }
}

/**
 * Main cleanup function
 */
async function cleanupDuplicateAddresses(dryRun: boolean, deleteUnfixable: boolean) {
  console.log('\n========================================');
  console.log('Fix Activity History Duplicate Addresses');
  console.log('========================================');
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Delete unfixable: ${deleteUnfixable ? 'YES' : 'NO'}`);
  console.log('========================================\n');

  const stats: FixStats = {
    totalDuplicates: 0,
    fixedFromOffer: 0,
    fixedFromSale: 0,
    unfixable: 0,
    deleted: 0,
    errors: 0,
  };

  // Get all duplicate records
  console.log('Fetching duplicate records...');
  const duplicates = await getDuplicateRecords();
  stats.totalDuplicates = duplicates.length;
  console.log(`Found ${duplicates.length} records with duplicate addresses\n`);

  if (duplicates.length === 0) {
    console.log('No duplicates found. Exiting.\n');
    return;
  }

  // Process each duplicate
  for (const record of duplicates) {
    console.log(`\nProcessing record ${record.id} (${record.event_type}):`);
    console.log(`  ENS Name ID: ${record.ens_name_id}`);
    console.log(`  Current address: ${record.actor_address}`);
    console.log(`  Metadata: ${JSON.stringify(record.metadata)}`);

    let addresses: { buyer: string; seller: string } | null = null;

    // Try to fix from offer_id first
    if (record.metadata?.offer_id) {
      console.log(`  Attempting to fix from offer_id ${record.metadata.offer_id}...`);
      addresses = await fixFromOffer(record);
      if (addresses) {
        console.log(`  ✓ Found correct addresses from offer`);
        const success = await updateRecord(record, addresses.buyer, addresses.seller, dryRun);
        if (success) {
          stats.fixedFromOffer++;
        } else {
          stats.errors++;
        }
        continue;
      }
    }

    // Try to fix from sale_id
    if (record.metadata?.sale_id) {
      console.log(`  Attempting to fix from sale_id ${record.metadata.sale_id}...`);
      addresses = await fixFromSale(record);
      if (addresses) {
        console.log(`  ✓ Found correct addresses from sale`);
        const success = await updateRecord(record, addresses.buyer, addresses.seller, dryRun);
        if (success) {
          stats.fixedFromSale++;
        } else {
          stats.errors++;
        }
        continue;
      }
    }

    // Could not fix this record
    console.log(`  ✗ Cannot fix: No valid sale data found`);
    stats.unfixable++;

    if (deleteUnfixable) {
      const success = await deleteRecord(record, dryRun);
      if (success) {
        stats.deleted++;
      } else {
        stats.errors++;
      }
    }
  }

  // Print summary
  console.log('\n========================================');
  console.log('Cleanup Summary');
  console.log('========================================');
  console.log(`Total duplicates:       ${stats.totalDuplicates}`);
  console.log(`Fixed from offer:       ${stats.fixedFromOffer}`);
  console.log(`Fixed from sale:        ${stats.fixedFromSale}`);
  console.log(`Unfixable:              ${stats.unfixable}`);
  console.log(`Deleted:                ${stats.deleted}`);
  console.log(`Errors:                 ${stats.errors}`);
  console.log('========================================\n');

  if (dryRun) {
    console.log('This was a DRY RUN. No changes were made.');
    console.log('Run without --dry-run to apply changes.\n');
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const deleteUnfixable = args.includes('--delete-unfixable');

// Run cleanup
cleanupDuplicateAddresses(dryRun, deleteUnfixable)
  .then(() => {
    console.log('Done!');
    process.exit(0);
  })
  .catch(error => {
    console.error('Cleanup failed:', error);
    process.exit(1);
  });
