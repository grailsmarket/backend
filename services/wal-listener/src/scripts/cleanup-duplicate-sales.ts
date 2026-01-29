#!/usr/bin/env tsx

/**
 * Cleanup Duplicate Sales
 *
 * This script identifies and removes duplicate sales that were created when both
 * the OpenSea stream and Seaport indexer recorded the same sale.
 *
 * Duplicates are identified by:
 * 1. Same ens_name_id
 * 2. Sale dates within 10 seconds of each other
 * 3. Similar sale prices (within 5% to account for fee differences)
 *
 * The script keeps the sale with:
 * - Higher price value
 * - Buyer != seller
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node dist/wal-listener/src/scripts/cleanup-duplicate-sales.js [options]
 *
 * Options:
 *   --dry-run        Preview duplicates without deleting (default: true)
 *   --delete         Actually delete duplicates (sets dry-run to false)
 *   --limit N        Limit to N duplicate groups (default: 1000)
 *   --verbose        Show detailed information for each duplicate
 */

import { getPostgresPool } from '../../../shared/src';

interface SaleRecord {
  id: number;
  ens_name_id: number;
  name: string;
  seller_address: string;
  buyer_address: string;
  sale_price_wei: string;
  currency_address: string;
  transaction_hash: string;
  block_number: number;
  order_hash: string;
  source: string;
  sale_date: Date;
  created_at: Date;
}

interface DuplicateGroup {
  ens_name_id: number;
  name: string;
  sales: SaleRecord[];
  keepSaleId: number;
  deleteSaleIds: number[];
  reason: string;
}

function hasCorrectBuyerSeller(sale: SaleRecord): boolean {
  return sale.buyer_address.toLowerCase() !== sale.seller_address.toLowerCase();
}

function arePricesSimilar(price1: string, price2: string, tolerancePercent: number = 5): boolean {
  try {
    const p1 = BigInt(price1);
    const p2 = BigInt(price2);

    if (p1 === BigInt(0) && p2 === BigInt(0)) return true;
    if (p1 === BigInt(0) || p2 === BigInt(0)) return false;

    const diff = p1 > p2 ? p1 - p2 : p2 - p1;
    const maxPrice = p1 > p2 ? p1 : p2;
    const percentDiff = (diff * BigInt(100)) / maxPrice;

    return percentDiff <= BigInt(tolerancePercent);
  } catch {
    return false;
  }
}

function chooseBestSale(sales: SaleRecord[]): { keep: SaleRecord; delete: SaleRecord[]; reason: string } {
  // First, prefer sales where buyer != seller
  const validSales = sales.filter(s => hasCorrectBuyerSeller(s));
  const invalidSales = sales.filter(s => !hasCorrectBuyerSeller(s));

  if (validSales.length > 0) {
    // Among valid sales, pick the one with highest price
    const sorted = validSales.sort((a, b) => {
      const priceA = BigInt(a.sale_price_wei);
      const priceB = BigInt(b.sale_price_wei);
      return priceB > priceA ? 1 : priceB < priceA ? -1 : 0;
    });

    const keep = sorted[0];
    const toDelete = [...sorted.slice(1), ...invalidSales];

    let reason = 'buyer != seller';
    if (sorted.length > 1) {
      reason += ', highest price';
    }

    return { keep, delete: toDelete, reason };
  }

  // All sales have buyer == seller (shouldn't happen often), just pick highest price
  const sorted = sales.sort((a, b) => {
    const priceA = BigInt(a.sale_price_wei);
    const priceB = BigInt(b.sale_price_wei);
    return priceB > priceA ? 1 : priceB < priceA ? -1 : 0;
  });

  return {
    keep: sorted[0],
    delete: sorted.slice(1),
    reason: 'highest price (all have buyer=seller)'
  };
}

async function findDuplicateSales(pool: any, limit: number): Promise<DuplicateGroup[]> {
  // Find potential duplicates: same ens_name_id with multiple sales within 10 seconds
  const query = `
    WITH sale_groups AS (
      SELECT
        s1.id as sale1_id,
        s2.id as sale2_id,
        s1.ens_name_id,
        en.name,
        ABS(EXTRACT(EPOCH FROM (s1.sale_date - s2.sale_date))) as time_diff_seconds
      FROM sales s1
      JOIN sales s2 ON s1.ens_name_id = s2.ens_name_id
        AND s1.id < s2.id
        AND ABS(EXTRACT(EPOCH FROM (s1.sale_date - s2.sale_date))) <= 10
      JOIN ens_names en ON s1.ens_name_id = en.id
      ORDER BY s1.sale_date DESC
      LIMIT $1
    )
    SELECT DISTINCT ens_name_id, name
    FROM sale_groups
  `;

  const groupsResult = await pool.query(query, [limit * 2]);
  const duplicateGroups: DuplicateGroup[] = [];

  for (const row of groupsResult.rows) {
    // Get all sales for this ENS name that might be duplicates
    const salesQuery = `
      SELECT
        s.id,
        s.ens_name_id,
        en.name,
        s.seller_address,
        s.buyer_address,
        s.sale_price_wei,
        s.currency_address,
        s.transaction_hash,
        s.block_number,
        s.order_hash,
        s.source,
        s.sale_date,
        s.created_at
      FROM sales s
      JOIN ens_names en ON s.ens_name_id = en.id
      WHERE s.ens_name_id = $1
      ORDER BY s.sale_date DESC, s.created_at DESC
    `;

    const salesResult = await pool.query(salesQuery, [row.ens_name_id]);
    const allSales: SaleRecord[] = salesResult.rows;

    // Group sales that are within 10 seconds of each other with similar prices
    const processed = new Set<number>();

    for (let i = 0; i < allSales.length; i++) {
      if (processed.has(allSales[i].id)) continue;

      const group: SaleRecord[] = [allSales[i]];
      processed.add(allSales[i].id);

      for (let j = i + 1; j < allSales.length; j++) {
        if (processed.has(allSales[j].id)) continue;

        const timeDiff = Math.abs(
          new Date(allSales[i].sale_date).getTime() -
          new Date(allSales[j].sale_date).getTime()
        ) / 1000;

        const pricesSimilar = arePricesSimilar(
          allSales[i].sale_price_wei,
          allSales[j].sale_price_wei
        );

        if (timeDiff <= 10 && pricesSimilar) {
          group.push(allSales[j]);
          processed.add(allSales[j].id);
        }
      }

      // If we found duplicates (more than 1 sale in the group)
      if (group.length > 1) {
        const { keep, delete: toDelete, reason } = chooseBestSale(group);

        duplicateGroups.push({
          ens_name_id: row.ens_name_id,
          name: row.name,
          sales: group,
          keepSaleId: keep.id,
          deleteSaleIds: toDelete.map(s => s.id),
          reason
        });

        if (duplicateGroups.length >= limit) {
          return duplicateGroups;
        }
      }
    }
  }

  return duplicateGroups;
}

async function deleteDuplicates(
  pool: any,
  duplicateGroups: DuplicateGroup[],
  verbose: boolean
): Promise<{ deletedSales: number; deletedActivities: number }> {
  let deletedSales = 0;
  let deletedActivities = 0;

  for (const group of duplicateGroups) {
    if (group.deleteSaleIds.length === 0) continue;

    // Start transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Delete related activity_history records first
      const deleteActivitiesQuery = `
        DELETE FROM activity_history
        WHERE metadata->>'sale_id' = ANY($1::text[])
        RETURNING id
      `;
      const activityResult = await client.query(
        deleteActivitiesQuery,
        [group.deleteSaleIds.map(id => id.toString())]
      );
      deletedActivities += activityResult.rowCount || 0;

      // Delete the duplicate sales
      const deleteSalesQuery = `
        DELETE FROM sales
        WHERE id = ANY($1::int[])
        RETURNING id
      `;
      const salesResult = await client.query(deleteSalesQuery, [group.deleteSaleIds]);
      deletedSales += salesResult.rowCount || 0;

      await client.query('COMMIT');

      if (verbose) {
        console.log(`  ✅ Deleted ${salesResult.rowCount} sale(s) and ${activityResult.rowCount} activity record(s) for ${group.name}`);
      }
    } catch (error: any) {
      await client.query('ROLLBACK');
      console.error(`  ❌ Failed to delete duplicates for ${group.name}: ${error.message}`);
    } finally {
      client.release();
    }
  }

  return { deletedSales, deletedActivities };
}

function formatWei(wei: string): string {
  try {
    const value = BigInt(wei);
    const eth = Number(value) / 1e18;
    return `${eth.toFixed(4)} ETH`;
  } catch {
    return wei;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let dryRun = true;
  let limit = 1000;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--delete') {
      dryRun = false;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--verbose') {
      verbose = true;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    }
  }

  const pool = getPostgresPool();

  try {
    console.log('\n=== Duplicate Sales Cleanup ===\n');
    console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : '⚠️  DELETE MODE'}`);
    console.log(`Limit: ${limit} duplicate groups`);
    console.log(`Verbose: ${verbose}\n`);

    // Get total sales count
    const totalResult = await pool.query('SELECT COUNT(*) as count FROM sales');
    console.log(`Total sales in database: ${totalResult.rows[0].count}\n`);

    console.log('Searching for duplicate sales...\n');
    const duplicateGroups = await findDuplicateSales(pool, limit);

    if (duplicateGroups.length === 0) {
      console.log('✅ No duplicate sales found!\n');
      await pool.end();
      return;
    }

    console.log(`Found ${duplicateGroups.length} duplicate group(s)\n`);

    // Summary statistics
    const totalDuplicates = duplicateGroups.reduce((sum, g) => sum + g.deleteSaleIds.length, 0);
    console.log(`Total duplicate records to delete: ${totalDuplicates}\n`);

    // Show details
    console.log('='.repeat(80));
    console.log('Duplicate Details:');
    console.log('='.repeat(80) + '\n');

    for (const group of duplicateGroups) {
      console.log(`📋 ${group.name} (ens_name_id: ${group.ens_name_id})`);
      console.log(`   Keeping sale #${group.keepSaleId} (reason: ${group.reason})`);
      console.log(`   Deleting sale(s): ${group.deleteSaleIds.join(', ')}`);

      if (verbose) {
        console.log('   Sales in group:');
        for (const sale of group.sales) {
          const isKeep = sale.id === group.keepSaleId;
          const marker = isKeep ? '✓ KEEP' : '✗ DELETE';
          const sameBuyerSeller = !hasCorrectBuyerSeller(sale) ? ' (buyer=seller!)' : '';

          console.log(`     [${marker}] Sale #${sale.id}:`);
          console.log(`       Price: ${formatWei(sale.sale_price_wei)}`);
          console.log(`       Buyer: ${sale.buyer_address.substring(0, 10)}...${sameBuyerSeller}`);
          console.log(`       Seller: ${sale.seller_address.substring(0, 10)}...`);
          console.log(`       Date: ${sale.sale_date}`);
        }
      }
      console.log('');
    }

    if (dryRun) {
      console.log('='.repeat(80));
      console.log('⚠️  DRY RUN - No changes made');
      console.log('Run with --delete flag to actually remove duplicates');
      console.log('='.repeat(80) + '\n');
    } else {
      console.log('='.repeat(80));
      console.log('Deleting duplicates...');
      console.log('='.repeat(80) + '\n');

      const { deletedSales, deletedActivities } = await deleteDuplicates(
        pool,
        duplicateGroups,
        verbose
      );

      console.log('\n=== Cleanup Summary ===\n');
      console.log(`Deleted sales: ${deletedSales}`);
      console.log(`Deleted activity records: ${deletedActivities}`);
      console.log('\n✅ Cleanup complete!\n');
    }

    // Export results
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = `duplicate-sales-${dryRun ? 'report' : 'cleanup'}-${timestamp}.json`;

    const results = {
      timestamp: new Date().toISOString(),
      dryRun,
      summary: {
        duplicateGroups: duplicateGroups.length,
        totalDuplicatesToDelete: totalDuplicates,
      },
      groups: duplicateGroups.map(g => ({
        name: g.name,
        ens_name_id: g.ens_name_id,
        keepSaleId: g.keepSaleId,
        deleteSaleIds: g.deleteSaleIds,
        reason: g.reason,
        sales: g.sales.map(s => ({
          id: s.id,
          price: s.sale_price_wei,
          buyer: s.buyer_address,
          seller: s.seller_address,
          sale_date: s.sale_date,
        })),
      })),
    };

    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results exported to: ${outputFile}\n`);

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
