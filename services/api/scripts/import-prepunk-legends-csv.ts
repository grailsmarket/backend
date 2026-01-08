/**
 * Import Prepunks CSV Data
 *
 * Streams prepunks CSV file and imports into the legends table.
 * Prepunks are ENS names minted before CryptoPunks launched.
 *
 * Usage:
 *   npx tsx scripts/import-prepunk-legends-csv.ts <csv-file> [options]
 *
 * Options:
 *   --dry-run             Preview import without writing to database
 *   --batch-size=<n>      Number of rows to batch (default: 500)
 *   --skip-rows=<n>       Skip first N data rows (for resuming)
 *
 * Example:
 *   npx tsx scripts/import-prepunk-legends-csv.ts ../prepunk-comprehensive.csv
 *   npx tsx scripts/import-prepunk-legends-csv.ts ../prepunk-comprehensive.csv --dry-run
 */

import * as fs from 'fs';
import * as readline from 'readline';
import { getPostgresPool } from '../../shared/src';

const pool = getPostgresPool();

interface CSVRow {
  row_number: string;
  block_number: string;
  block_time: string;
  name: string;
  labelhash_hex: string;
  labelhash_numeric: string;
  namehash_hex: string;
  namehash_numeric: string;
  tx_hash: string;
  minter_address: string;
}

interface ImportStats {
  rowsRead: number;
  rowsSkipped: number;
  rowsImported: number;
  rowsErrored: number;
  duplicates: number;
  startTime: Date;
}

interface ImportOptions {
  csvPath: string;
  dryRun: boolean;
  batchSize: number;
  skipRows: number;
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
 * Map CSV row to legends table record
 */
function mapToLegendsRecord(row: CSVRow): any {
  // Parse block_time (format: "2017-05-09 11:22:19.000 UTC")
  const blockTime = new Date(row.block_time.replace(' UTC', 'Z').replace(' ', 'T'));

  return {
    legend_type: 'prepunk',
    minter_address: row.minter_address.toLowerCase(),
    name: row.name,
    labelhash: row.labelhash_hex || null,
    namehash: row.namehash_hex || null,
    tx_hash: row.tx_hash,
    block_number: parseInt(row.block_number),
    block_time: blockTime,
  };
}

/**
 * Import legends in batches
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
          `INSERT INTO legends (
            legend_type, minter_address, name, labelhash, namehash,
            tx_hash, block_number, block_time
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (legend_type, tx_hash, name) DO NOTHING`,
          [
            record.legend_type,
            record.minter_address,
            record.name,
            record.labelhash,
            record.namehash,
            record.tx_hash,
            record.block_number,
            record.block_time,
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
async function importPrepunkLegendsCSV(options: ImportOptions) {
  const { csvPath, dryRun, batchSize, skipRows } = options;

  console.log(`\n========================================`);
  console.log(`Importing Prepunk Legends CSV`);
  console.log(`========================================`);
  console.log(`File: ${csvPath}`);
  console.log(`Legend Type: prepunk`);
  console.log(`Dry Run: ${dryRun ? 'YES' : 'NO'}`);
  console.log(`Batch Size: ${batchSize}`);
  console.log(`Skip Rows: ${skipRows}`);
  console.log(`========================================\n`);

  const stats: ImportStats = {
    rowsRead: 0,
    rowsSkipped: 0,
    rowsImported: 0,
    rowsErrored: 0,
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

    // Validate required fields
    if (!row.tx_hash || !row.minter_address || !row.name) {
      const missing = [];
      if (!row.tx_hash) missing.push('tx_hash');
      if (!row.minter_address) missing.push('minter_address');
      if (!row.name) missing.push('name');
      console.log(`[SKIPPED] Row ${stats.rowsRead}: missing ${missing.join(', ')} | tx_hash=${row.tx_hash || '(empty)'} | minter=${row.minter_address || '(empty)'}`);
      stats.rowsErrored++;
      continue;
    }

    // Map to legends record
    const legendsRecord = mapToLegendsRecord(row as CSVRow);
    batch.push(legendsRecord);

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
  console.log(`Rows imported:          ${stats.rowsImported.toLocaleString()}`);
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
  console.error('Usage: npx tsx scripts/import-prepunk-legends-csv.ts <csv-file> [options]');
  console.error('\nOptions:');
  console.error('  --dry-run             Preview without writing to database');
  console.error('  --batch-size=<n>      Batch size (default: 500)');
  console.error('  --skip-rows=<n>       Skip first N rows (for resuming)');
  process.exit(1);
}

const options: ImportOptions = {
  csvPath,
  dryRun: args.includes('--dry-run'),
  batchSize: parseInt(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '500'),
  skipRows: parseInt(args.find(a => a.startsWith('--skip-rows='))?.split('=')[1] || '0'),
};

importPrepunkLegendsCSV(options).catch(error => {
  console.error('Import failed:', error);
  process.exit(1);
});
