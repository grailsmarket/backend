/**
 * Import Sales CSV (Simple Format)
 *
 * Imports ENS sales data from a simplified CSV format with name-based lookup.
 * Disables triggers and manually creates activity_history records for performance.
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
 *   npx tsx src/scripts/import-sales-simple.ts ../data/sales/ens-sales-simple-top3source.csv --dry-run
 *   npx tsx src/scripts/import-sales-simple.ts ../data/sales/ens-sales-simple-top3source.csv
 *   npx tsx src/scripts/import-sales-simple.ts ../data/sales/ens-sales-simple-top3source.csv --skip-rows=100000
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

// Cache for name to ens_name_id lookups
const nameIdCache = new Map<string, number | null>();

// Source mapping: CSV source -> DB source
const SOURCE_MAP: Record<string, string> = {
  'opensea.io': 'opensea',
  'looksrare.org': 'looksrare',
  'x2y2.io': 'x2y2',
  'blur.io': 'blur',
};

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
 * Look up ENS name ID from name
 */
async function getEnsNameId(name: string): Promise<number | null> {
  const normalizedName = name.toLowerCase();

  // Check cache first
  if (nameIdCache.has(normalizedName)) {
    return nameIdCache.get(normalizedName)!;
  }

  const result = await pool.query('SELECT id FROM ens_names WHERE LOWER(name) = $1', [
    normalizedName,
  ]);

  const ensNameId = result.rows.length > 0 ? result.rows[0].id : null;
  nameIdCache.set(normalizedName, ensNameId);

  return ensNameId;
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

/**
 * Import a batch of sales and create activity history
 */
async function importBatch(
  records: CSVRow[],
  stats: ImportStats,
  dryRun: boolean
): Promise<void> {
  if (records.length === 0) return;

  if (dryRun) {
    // In dry-run mode, just count and show sample
    for (const record of records) {
      const ensNameId = await getEnsNameId(record.name);
      if (!ensNameId) {
        stats.nameNotFound++;
        continue;
      }
      stats.salesImported++;
      stats.activitiesCreated += 2;
    }
    if (stats.salesImported <= 5) {
      console.log(`\n[DRY RUN] Sample record:`, JSON.stringify(records[0], null, 2));
    }
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const record of records) {
      try {
        const ensNameId = await getEnsNameId(record.name);
        if (!ensNameId) {
          stats.nameNotFound++;
          continue;
        }

        const source = mapSource(record.source);
        const saleDate = parseSaleDate(record.sale_date_dt);

        // Insert sale with RETURNING to check if it was inserted
        const saleResult = await client.query(
          `INSERT INTO sales (
            ens_name_id, seller_address, buyer_address, sale_price_wei,
            currency_address, transaction_hash, block_number, source, sale_date
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
          ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING
          RETURNING id`,
          [
            ensNameId,
            record.seller_address.toLowerCase(),
            record.buyer_address.toLowerCase(),
            record.currency_price,
            record.currency_address.toLowerCase(),
            record.tx_hash.toLowerCase(),
            parseInt(record.block_number),
            source,
            saleDate,
          ]
        );

        // Only create activity if sale was actually inserted (not duplicate)
        if (saleResult.rows.length > 0) {
          stats.salesImported++;

          // Insert 'sold' activity (seller perspective)
          await client.query(
            `INSERT INTO activity_history (
              ens_name_id, event_type, actor_address, counterparty_address,
              platform, chain_id, price_wei, currency_address,
              transaction_hash, block_number, metadata, created_at
            ) VALUES ($1, 'sold', $2, $3, $4, 1, $5, $6, $7, $8, '{}', $9)`,
            [
              ensNameId,
              record.seller_address.toLowerCase(),
              record.buyer_address.toLowerCase(),
              source,
              record.currency_price,
              record.currency_address.toLowerCase(),
              record.tx_hash.toLowerCase(),
              parseInt(record.block_number),
              saleDate,
            ]
          );
          stats.activitiesCreated++;

          // Insert 'bought' activity (buyer perspective)
          await client.query(
            `INSERT INTO activity_history (
              ens_name_id, event_type, actor_address, counterparty_address,
              platform, chain_id, price_wei, currency_address,
              transaction_hash, block_number, metadata, created_at
            ) VALUES ($1, 'bought', $2, $3, $4, 1, $5, $6, $7, $8, '{}', $9)`,
            [
              ensNameId,
              record.buyer_address.toLowerCase(),
              record.seller_address.toLowerCase(),
              source,
              record.currency_price,
              record.currency_address.toLowerCase(),
              record.tx_hash.toLowerCase(),
              parseInt(record.block_number),
              saleDate,
            ]
          );
          stats.activitiesCreated++;
        } else {
          stats.duplicates++;
        }
      } catch (error: any) {
        stats.errors++;
        if (!error.message?.includes('duplicate')) {
          console.error(`Error processing ${record.name}:`, error.message);
        }
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
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
