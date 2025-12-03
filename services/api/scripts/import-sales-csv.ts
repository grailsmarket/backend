/**
 * Import Sales CSV Data
 *
 * Streams large CSV files and imports sales data into the database.
 * Handles column mapping, token_id lookup, and excludes mint events.
 *
 * Usage:
 *   npx tsx scripts/import-sales-csv.ts <csv-file> [options]
 *
 * Options:
 *   --dry-run             Preview import without writing to database
 *   --batch-size=<n>      Number of rows to batch (default: 500)
 *   --skip-rows=<n>       Skip first N data rows (for resuming)
 *   --order-kind=<value>  Optional: filter for specific order_kind
 *
 * Example:
 *   npx tsx scripts/import-sales-csv.ts ~/Downloads/ens_data/basereg-sales-1st-half.csv
 *   npx tsx scripts/import-sales-csv.ts ~/Downloads/ens_data/wrapper-sales-full.csv --dry-run
 *   npx tsx scripts/import-sales-csv.ts ~/Downloads/ens_data/basereg-sales-2nd-half.csv --skip-rows=100000
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { getPostgresPool } from '../../shared/src';

const pool = getPostgresPool();

interface CSVRow {
  created_at: string;
  amount: string;
  id: string;
  contract: string;
  from: string;
  order_id: string;
  to: string;
  currency_address: string;
  tx_hash: string;
  fill_source: string;
  order_kind: string;
  order_side: string;
  order_source: string;
  price: string;
  price_decimal: string;
  usd_price_decimal: string;
  token_id: string;
  tx_batch_index: string;
  tx_log_index: string;
  tx_timestamp: string;
  updated_at: string;
  aggregator_source: string;
  currency_symbol: string;
  currency_price: string;
  usd_price: string;
  wash_trading_score: string;
  is_primary: string;
  tx_timestamp_dt: string;
  block_number?: string; // Optional - may not be in all CSVs
}

interface ImportStats {
  rowsRead: number;
  rowsSkipped: number;
  rowsFiltered: number;
  rowsImported: number;
  rowsErrored: number;
  tokenIdNotFound: number;
  duplicates: number;
  startTime: Date;
}

interface ImportOptions {
  csvPath: string;
  orderKind?: string;
  dryRun: boolean;
  batchSize: number;
  skipRows: number;
}

// Cache for token_id to ens_name_id lookups
const tokenIdCache = new Map<string, number | null>();

/**
 * Look up ENS name ID from token_id
 */
async function getEnsNameId(tokenId: string): Promise<number | null> {
  // Check cache first
  if (tokenIdCache.has(tokenId)) {
    return tokenIdCache.get(tokenId)!;
  }

  const result = await pool.query(
    'SELECT id FROM ens_names WHERE token_id = $1',
    [tokenId]
  );

  const ensNameId = result.rows.length > 0 ? result.rows[0].id : null;
  tokenIdCache.set(tokenId, ensNameId);

  return ensNameId;
}

/**
 * Parse CSV line handling quoted values and commas
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
 * Map CSV row to our sales table schema
 */
async function mapToSalesRecord(row: CSVRow, stats: ImportStats): Promise<any | null> {
  // Look up ens_name_id from token_id
  const ensNameId = await getEnsNameId(row.token_id);

  if (!ensNameId) {
    stats.tokenIdNotFound++;
    return null;
  }

  // Determine seller and buyer based on order_side
  // Usually: order_side = 'sell' means from=seller, to=buyer
  //          order_side = 'buy' means from=buyer, to=seller
  const isSellOrder = row.order_side?.toLowerCase() === 'sell';
  const sellerAddress = isSellOrder ? row.from : row.to;
  const buyerAddress = isSellOrder ? row.to : row.from;

  // Parse sale date from tx_timestamp or tx_timestamp_dt
  let saleDate: Date;
  if (row.tx_timestamp_dt) {
    saleDate = new Date(row.tx_timestamp_dt);
  } else if (row.tx_timestamp) {
    // Unix timestamp
    saleDate = new Date(parseInt(row.tx_timestamp) * 1000);
  } else {
    saleDate = new Date(row.created_at);
  }

  // Convert price to wei (assuming price is in ETH decimal format)
  const salePriceWei = convertToWei(row.price_decimal || row.price);

  // Handle block_number - use from CSV if available, otherwise default to 0
  // (we can backfill later with actual block numbers if needed)
  const blockNumber = row.block_number ? parseInt(row.block_number) : 0;

  // Map source to valid values (constraint allows: opensea, grails, blur, looksrare, x2y2, other)
  let source = row.order_source || row.fill_source || 'other';
  const validSources = ['opensea', 'grails', 'blur', 'looksrare', 'x2y2', 'other'];
  if (!validSources.includes(source.toLowerCase())) {
    source = 'other';
  } else {
    source = source.toLowerCase();
  }

  return {
    ens_name_id: ensNameId,
    seller_address: sellerAddress?.toLowerCase() || null,
    buyer_address: buyerAddress?.toLowerCase() || null,
    sale_price_wei: salePriceWei,
    currency_address: row.currency_address?.toLowerCase() || '0x0000000000000000000000000000000000000000',
    transaction_hash: row.tx_hash || null,
    block_number: blockNumber,
    order_hash: row.order_id || null,
    source: source,
    metadata: JSON.stringify({
      order_kind: row.order_kind,
      order_side: row.order_side,
      aggregator_source: row.aggregator_source,
      currency_symbol: row.currency_symbol,
      usd_price: row.usd_price_decimal || row.usd_price,
      wash_trading_score: row.wash_trading_score,
      is_primary: row.is_primary,
      tx_log_index: row.tx_log_index,
      tx_batch_index: row.tx_batch_index,
    }),
    sale_date: saleDate,
    created_at: new Date(row.created_at || saleDate),
  };
}

/**
 * Convert decimal price string to wei
 */
function convertToWei(priceStr: string): string {
  if (!priceStr || priceStr === '') return '0';

  try {
    // Parse as float and multiply by 10^18
    const priceFloat = parseFloat(priceStr);
    if (isNaN(priceFloat)) return '0';

    // Convert to wei (multiply by 10^18)
    const weiValue = BigInt(Math.floor(priceFloat * 1e18));
    return weiValue.toString();
  } catch {
    return '0';
  }
}

/**
 * Import sales in batches
 */
async function importBatch(records: any[], stats: ImportStats, dryRun: boolean) {
  if (records.length === 0) return;

  if (dryRun) {
    console.log(`\n[DRY RUN] Would import batch of ${records.length} records:`);
    console.log(JSON.stringify(records[0], null, 2));
    stats.rowsImported += records.length;
    return;
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const record of records) {
      try {
        await client.query(
          `INSERT INTO sales (
            ens_name_id, seller_address, buyer_address, sale_price_wei,
            currency_address, transaction_hash, block_number, order_hash, source,
            metadata, sale_date, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          ON CONFLICT (transaction_hash, ens_name_id) DO NOTHING`,
          [
            record.ens_name_id,
            record.seller_address,
            record.buyer_address,
            record.sale_price_wei,
            record.currency_address,
            record.transaction_hash,
            record.block_number,
            record.order_hash,
            record.source,
            record.metadata,
            record.sale_date,
            record.created_at,
          ]
        );
        stats.rowsImported++;
      } catch (error: any) {
        if (error.code === '23505') {
          // Duplicate
          stats.duplicates++;
        } else {
          stats.rowsErrored++;
          console.error(`Error inserting record:`, error.message);
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
async function importSalesCSV(options: ImportOptions) {
  const { csvPath, orderKind, dryRun, batchSize, skipRows } = options;

  console.log(`\n========================================`);
  console.log(`Importing Sales CSV`);
  console.log(`========================================`);
  console.log(`File: ${csvPath}`);
  console.log(`Excluding: mint events (only importing sales)`);
  console.log(`Order Kind Filter: ${orderKind || 'none (all non-mint sales)'}`);
  console.log(`Dry Run: ${dryRun ? 'YES' : 'NO'}`);
  console.log(`Batch Size: ${batchSize}`);
  console.log(`Skip Rows: ${skipRows}`);
  console.log(`========================================\n`);

  const stats: ImportStats = {
    rowsRead: 0,
    rowsSkipped: 0,
    rowsFiltered: 0,
    rowsImported: 0,
    rowsErrored: 0,
    tokenIdNotFound: 0,
    duplicates: 0,
    startTime: new Date(),
  };

  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: any[] = [];
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
    const row: any = {};

    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });

    // Skip mint events (we only want secondary sales)
    if (row.order_kind === 'mint') {
      stats.rowsFiltered++;
      continue;
    }

    // Filter by order_kind if specified (optional)
    if (orderKind && row.order_kind !== orderKind) {
      stats.rowsFiltered++;
      continue;
    }

    // Validate required fields
    if (!row.token_id || !row.tx_hash) {
      stats.rowsErrored++;
      continue;
    }

    // Map to sales record
    const salesRecord = await mapToSalesRecord(row as CSVRow, stats);

    if (salesRecord) {
      batch.push(salesRecord);
    }

    // Import batch when full
    if (batch.length >= batchSize) {
      await importBatch(batch, stats, dryRun);
      batch = [];

      // Progress report
      const elapsed = (new Date().getTime() - stats.startTime.getTime()) / 1000;
      const rate = stats.rowsRead / elapsed;
      console.log(
        `Progress: ${stats.rowsRead.toLocaleString()} rows read, ` +
        `${stats.rowsImported.toLocaleString()} imported, ` +
        `${rate.toFixed(0)} rows/sec`
      );
    }
  }

  // Import remaining batch
  if (batch.length > 0) {
    await importBatch(batch, stats, dryRun);
  }

  // Final report
  const elapsed = (new Date().getTime() - stats.startTime.getTime()) / 1000;

  console.log(`\n========================================`);
  console.log(`Import Complete!`);
  console.log(`========================================`);
  console.log(`Total rows read:        ${stats.rowsRead.toLocaleString()}`);
  console.log(`Rows skipped:           ${stats.rowsSkipped.toLocaleString()}`);
  console.log(`Rows filtered:          ${stats.rowsFiltered.toLocaleString()}`);
  console.log(`Rows imported:          ${stats.rowsImported.toLocaleString()}`);
  console.log(`Token ID not found:     ${stats.tokenIdNotFound.toLocaleString()}`);
  console.log(`Duplicates skipped:     ${stats.duplicates.toLocaleString()}`);
  console.log(`Errors:                 ${stats.rowsErrored.toLocaleString()}`);
  console.log(`Time elapsed:           ${elapsed.toFixed(1)}s`);
  console.log(`========================================\n`);

  process.exit(0);
}

// Parse command line arguments
const csvPath = process.argv[2];
const args = process.argv.slice(3);

if (!csvPath) {
  console.error('Usage: npx tsx scripts/import-sales-csv.ts <csv-file> [options]');
  console.error('\nOptions:');
  console.error('  --order-kind=<value>  Filter for specific order_kind');
  console.error('  --dry-run             Preview without writing to database');
  console.error('  --batch-size=<n>      Batch size (default: 500)');
  console.error('  --skip-rows=<n>       Skip first N rows (for resuming)');
  process.exit(1);
}

const options: ImportOptions = {
  csvPath,
  orderKind: args.find(a => a.startsWith('--order-kind='))?.split('=')[1],
  dryRun: args.includes('--dry-run'),
  batchSize: parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '500'),
  skipRows: parseInt(args.find(a => a.startsWith('--skip-rows='))?.split('=')[1] || '0'),
};

importSalesCSV(options).catch(error => {
  console.error('Import failed:', error);
  process.exit(1);
});
