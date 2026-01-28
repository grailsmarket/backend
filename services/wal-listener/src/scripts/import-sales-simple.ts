/**
 * Import Sales CSV (Simple Format) - OPTIMIZED
 *
 * Imports ENS sales data from a simplified CSV format with name-based lookup.
 * Disables triggers and manually creates activity_history records for performance.
 *
 * Optimizations:
 * - Pre-loads all name→id mappings into cache before starting
 * - Uses bulk multi-row INSERT statements
 *
 * Usage:
 *   npx tsx src/scripts/import-sales-simple.ts <csv-file> [options]
 *
 * Options:
 *   --dry-run             Preview import without writing to database
 *   --batch-size=<n>      Number of rows to batch (default: 500)
 *   --skip-rows=<n>       Skip first N data rows (for resuming)
 *
 * Example:
 *   npx tsx src/scripts/import-sales-simple.ts data/sales/ens-sales-simple-top3source.csv --dry-run
 *   npx tsx src/scripts/import-sales-simple.ts data/sales/ens-sales-simple-top3source.csv
 *   npx tsx src/scripts/import-sales-simple.ts data/sales/ens-sales-simple-top3source.csv --skip-rows=83000
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { getPostgresPool, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();

interface CSVRow {
  name: string;
  seller_address: string;
  buyer_address: string;
  currency_price: string;
  currency_address: string;
  tx_hash: string;
  block_number: string;
  source: string;
  sale_date_dt: string;
}

interface ImportStats {
  rowsRead: number;
  rowsSkipped: number;
  salesImported: number;
  activitiesCreated: number;
  nameNotFound: number;
  duplicates: number;
  errors: number;
  startTime: Date;
}

interface ImportOptions {
  csvPath: string;
  dryRun: boolean;
  batchSize: number;
  skipRows: number;
}

// Cache for name to ens_name_id lookups (populated on-demand per batch)
const nameIdCache = new Map<string, number>();

// Source mapping: CSV source -> DB source
const SOURCE_MAP: Record<string, string> = {
  'opensea.io': 'opensea',
  'looksrare.org': 'looksrare',
  'x2y2.io': 'x2y2',
  'blur.io': 'blur',
};

/**
 * Batch lookup ENS name IDs - only fetches names not already in cache
 */
async function batchLookupNames(names: string[]): Promise<void> {
  // Filter to names not already in cache
  const uncachedNames = names
    .map((n) => n.toLowerCase())
    .filter((n) => !nameIdCache.has(n));

  if (uncachedNames.length === 0) return;

  // Deduplicate
  const uniqueNames = [...new Set(uncachedNames)];

  const result = await pool.query(
    'SELECT id, LOWER(name) as name FROM ens_names WHERE LOWER(name) = ANY($1)',
    [uniqueNames]
  );

  for (const row of result.rows) {
    nameIdCache.set(row.name, row.id);
  }
}

/**
 * Map CSV source to valid DB source
 */
function mapSource(csvSource: string): string {
  if (!csvSource || csvSource.trim() === '') {
    return 'other';
  }
  const normalized = csvSource.toLowerCase().trim();
  return SOURCE_MAP[normalized] || 'other';
}

/**
 * Look up ENS name ID from cache
 */
function getEnsNameId(name: string): number | undefined {
  return nameIdCache.get(name.toLowerCase());
}

/**
 * Parse CSV line handling quoted values
 */
function parseCSVLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

/**
 * Parse sale date from CSV format
 */
function parseSaleDate(dateStr: string): Date {
  // Format: "2022-06-20 12:57:51.000 UTC"
  // Remove "UTC" suffix and parse
  const cleaned = dateStr.replace(' UTC', 'Z').replace(' ', 'T');
  return new Date(cleaned);
}

interface PreparedRecord {
  ensNameId: number;
  sellerAddress: string;
  buyerAddress: string;
  currencyPrice: string;
  currencyAddress: string;
  txHash: string;
  blockNumber: number;
  source: string;
  saleDate: Date;
}

/**
 * Import a batch of sales and create activity history using bulk inserts
 */
async function importBatch(
  records: CSVRow[],
  stats: ImportStats,
  dryRun: boolean
): Promise<void> {
  if (records.length === 0) return;

  // Batch lookup all names in this batch (one query instead of N)
  await batchLookupNames(records.map((r) => r.name));

  // Pre-process records: resolve name IDs and filter out not-found
  const prepared: PreparedRecord[] = [];
  for (const record of records) {
    const ensNameId = getEnsNameId(record.name);
    if (!ensNameId) {
      stats.nameNotFound++;
      continue;
    }
    prepared.push({
      ensNameId,
      sellerAddress: record.seller_address.toLowerCase(),
      buyerAddress: record.buyer_address.toLowerCase(),
      currencyPrice: record.currency_price,
      currencyAddress: record.currency_address.toLowerCase(),
      txHash: record.tx_hash.toLowerCase(),
      blockNumber: parseInt(record.block_number),
      source: mapSource(record.source),
      saleDate: parseSaleDate(record.sale_date_dt),
    });
  }

  if (prepared.length === 0) return;

  if (dryRun) {
    stats.salesImported += prepared.length;
    stats.activitiesCreated += prepared.length * 2;
    if (stats.rowsRead <= 1000) {
      console.log(`\n[DRY RUN] Sample record:`, JSON.stringify(records[0], null, 2));
    }
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    // Build bulk INSERT for sales
    const salesValues: any[] = [];
    const salesPlaceholders: string[] = [];
    let paramIndex = 1;

    for (const rec of prepared) {
      salesPlaceholders.push(
        `($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++})`
      );
      salesValues.push(
        rec.ensNameId,
        rec.sellerAddress,
        rec.buyerAddress,
        rec.currencyPrice,
        rec.currencyAddress,
        rec.txHash,
        rec.blockNumber,
        rec.source,
        rec.saleDate
      );
    }

    // Bulk insert sales, returning which ones were actually inserted
    const salesResult = await client.query(
      `INSERT INTO sales (
        ens_name_id, seller_address, buyer_address, sale_price_wei,
        currency_address, transaction_hash, block_number, source, sale_date
      ) VALUES ${salesPlaceholders.join(', ')}
      ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING
      RETURNING transaction_hash`,
      salesValues
    );

    // Track which tx_hashes were actually inserted
    const insertedTxHashes = new Set(salesResult.rows.map((r) => r.transaction_hash));
    stats.salesImported += insertedTxHashes.size;
    stats.duplicates += prepared.length - insertedTxHashes.size;

    // Only create activities for newly inserted sales
    const insertedRecords = prepared.filter((r) => insertedTxHashes.has(r.txHash));

    if (insertedRecords.length > 0) {
      // Build bulk INSERT for activity_history (2 records per sale: sold + bought)
      const activityValues: any[] = [];
      const activityPlaceholders: string[] = [];
      paramIndex = 1;

      for (const rec of insertedRecords) {
        // 'sold' activity (seller perspective)
        activityPlaceholders.push(
          `($${paramIndex++}, 'sold', $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, 1, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, '{}', $${paramIndex++})`
        );
        activityValues.push(
          rec.ensNameId,
          rec.sellerAddress,
          rec.buyerAddress,
          rec.source,
          rec.currencyPrice,
          rec.currencyAddress,
          rec.txHash,
          rec.blockNumber,
          rec.saleDate
        );

        // 'bought' activity (buyer perspective)
        activityPlaceholders.push(
          `($${paramIndex++}, 'bought', $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, 1, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, '{}', $${paramIndex++})`
        );
        activityValues.push(
          rec.ensNameId,
          rec.buyerAddress,
          rec.sellerAddress,
          rec.source,
          rec.currencyPrice,
          rec.currencyAddress,
          rec.txHash,
          rec.blockNumber,
          rec.saleDate
        );
      }

      await client.query(
        `INSERT INTO activity_history (
          ens_name_id, event_type, actor_address, counterparty_address,
          platform, chain_id, price_wei, currency_address,
          transaction_hash, block_number, metadata, created_at
        ) VALUES ${activityPlaceholders.join(', ')}`,
        activityValues
      );

      stats.activitiesCreated += insertedRecords.length * 2;
    }

    await client.query('COMMIT');
  } catch (error: any) {
    await client.query('ROLLBACK');
    stats.errors += prepared.length;
    console.error(`Batch error:`, error.message);
  } finally {
    client.release();
  }
}

/**
 * Main import function
 */
async function importSalesCSV(options: ImportOptions): Promise<void> {
  const { csvPath, dryRun, batchSize, skipRows } = options;

  console.log(`\n========================================`);
  console.log(`Import Sales CSV (Simple Format)`);
  console.log(`========================================`);
  console.log(`File: ${csvPath}`);
  console.log(`Dry Run: ${dryRun ? 'YES' : 'NO'}`);
  console.log(`Batch Size: ${batchSize}`);
  console.log(`Skip Rows: ${skipRows}`);
  console.log(`========================================\n`);

  const stats: ImportStats = {
    rowsRead: 0,
    rowsSkipped: 0,
    salesImported: 0,
    activitiesCreated: 0,
    nameNotFound: 0,
    duplicates: 0,
    errors: 0,
    startTime: new Date(),
  };

  // Disable triggers before import (if not dry run)
  if (!dryRun) {
    console.log('Disabling activity history trigger...');
    await pool.query('ALTER TABLE sales DISABLE TRIGGER create_activity_history_on_sale');
  }

  try {
    const fileStream = fs.createReadStream(csvPath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let headers: string[] = [];
    let batch: CSVRow[] = [];
    let isFirstRow = true;

    for await (const line of rl) {
      if (isFirstRow) {
        headers = parseCSVLine(line);
        isFirstRow = false;
        continue;
      }

      stats.rowsRead++;

      // Skip rows if resuming
      if (stats.rowsRead <= skipRows) {
        stats.rowsSkipped++;
        continue;
      }

      const values = parseCSVLine(line);
      const row: CSVRow = {
        name: values[headers.indexOf('name')] || '',
        seller_address: values[headers.indexOf('seller_address')] || '',
        buyer_address: values[headers.indexOf('buyer_address')] || '',
        currency_price: values[headers.indexOf('currency_price')] || '',
        currency_address: values[headers.indexOf('currency_address')] || '',
        tx_hash: values[headers.indexOf('tx_hash')] || '',
        block_number: values[headers.indexOf('block_number')] || '',
        source: values[headers.indexOf('source')] || '',
        sale_date_dt: values[headers.indexOf('sale_date_dt')] || '',
      };

      // Validate required fields
      if (!row.name || !row.tx_hash || !row.seller_address || !row.buyer_address) {
        stats.errors++;
        continue;
      }

      batch.push(row);

      // Import batch when full
      if (batch.length >= batchSize) {
        await importBatch(batch, stats, dryRun);
        batch = [];

        // Progress report
        const elapsed = (new Date().getTime() - stats.startTime.getTime()) / 1000;
        const rate = stats.rowsRead / elapsed;
        console.log(
          `Progress: ${stats.rowsRead.toLocaleString()} rows read, ` +
            `${stats.salesImported.toLocaleString()} sales, ` +
            `${stats.activitiesCreated.toLocaleString()} activities, ` +
            `${rate.toFixed(0)} rows/sec`
        );
      }
    }

    // Import remaining batch
    if (batch.length > 0) {
      await importBatch(batch, stats, dryRun);
    }
  } finally {
    // Re-enable triggers (if not dry run)
    if (!dryRun) {
      console.log('\nRe-enabling activity history trigger...');
      await pool.query('ALTER TABLE sales ENABLE TRIGGER create_activity_history_on_sale');
    }
  }

  // Final report
  const elapsed = (new Date().getTime() - stats.startTime.getTime()) / 1000;

  console.log(`\n========================================`);
  console.log(`Import Complete!`);
  console.log(`========================================`);
  console.log(`Total rows read:        ${stats.rowsRead.toLocaleString()}`);
  console.log(`Rows skipped:           ${stats.rowsSkipped.toLocaleString()}`);
  console.log(`Sales imported:         ${stats.salesImported.toLocaleString()}`);
  console.log(`Activities created:     ${stats.activitiesCreated.toLocaleString()}`);
  console.log(`Names not found:        ${stats.nameNotFound.toLocaleString()}`);
  console.log(`Duplicates skipped:     ${stats.duplicates.toLocaleString()}`);
  console.log(`Errors:                 ${stats.errors.toLocaleString()}`);
  console.log(`Time elapsed:           ${elapsed.toFixed(1)}s`);
  console.log(`========================================\n`);

  await closeAllConnections();
  process.exit(0);
}

// Parse command line arguments
const csvPath = process.argv[2];
const args = process.argv.slice(3);

if (!csvPath) {
  console.error('Usage: npx tsx src/scripts/import-sales-simple.ts <csv-file> [options]');
  console.error('\nOptions:');
  console.error('  --dry-run             Preview without writing to database');
  console.error('  --batch-size=<n>      Batch size (default: 500)');
  console.error('  --skip-rows=<n>       Skip first N rows (for resuming)');
  process.exit(1);
}

const options: ImportOptions = {
  csvPath,
  dryRun: args.includes('--dry-run'),
  batchSize: parseInt(args.find((a) => a.startsWith('--batch-size='))?.split('=')[1] || '500'),
  skipRows: parseInt(args.find((a) => a.startsWith('--skip-rows='))?.split('=')[1] || '0'),
};

importSalesCSV(options).catch((error) => {
  console.error('Import failed:', error);
  process.exit(1);
});
