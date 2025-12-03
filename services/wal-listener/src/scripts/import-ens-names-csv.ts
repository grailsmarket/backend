#!/usr/bin/env tsx
/**
 * Import ENS Names CSV Data
 *
 * Imports ENS names from CSV files into the ens_names table.
 * Processes in batches with conflict handling and progress tracking.
 *
 * Usage:
 *   npm run import-csv -- <csv-file> [options]
 *   npm run import-csv:dry -- <csv-file>
 *
 * Options:
 *   --dry-run             Preview import without writing to database
 *   --batch-size=<n>      Number of rows to batch (default: 50)
 *   --skip-rows=<n>       Skip first N data rows (for resuming)
 *   --progress-file=<path> File to track progress (default: .import-progress.json)
 *
 * Example:
 *   npm run import-csv -- ~/Desktop/EFP/GRAILS/db/first_mil_names.csv
 *   npm run import-csv -- ~/Desktop/EFP/GRAILS/db/second_mil_names.csv --skip-rows=50000
 *   npm run import-csv -- ~/Desktop/EFP/GRAILS/db/first_mil_names.csv --batch-size=100
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { getPostgresPool, closeAllConnections } from '../../../shared/src';

const pool = getPostgresPool();

interface CSVRow {
  token_id: string;
  name: string;
  owner_address: string;
  registrant: string;
  expiry_date: string;
  registration_date: string;
  last_transfer_date: string;
  metadata: string;
  resolver_address: string;
  has_emoji: string;
  has_numbers: string;
  clubs: string;
  upvotes: string;
  downvotes: string;
  net_score: string;
  last_sale_date: string;
  last_sale_price: string;
  last_sale_currency: string;
  last_sale_price_usd: string;
  highest_offer_wei: string;
  highest_offer_currency: string;
  highest_offer_id: string;
  last_offer_update: string;
  view_count: string;
  created_at: string;
  updated_at: string;
}

interface ImportStats {
  rowsRead: number;
  rowsSkipped: number;
  rowsImported: number;
  rowsErrored: number;
  duplicates: number;
  startTime: Date;
  lastProcessedRow: number;
}

interface ImportOptions {
  csvPath: string;
  dryRun: boolean;
  batchSize: number;
  skipRows: number;
  progressFile: string;
}

interface ProgressData {
  fileName: string;
  lastProcessedRow: number;
  totalImported: number;
  timestamp: string;
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
 * Parse boolean from CSV
 */
function parseBoolean(value: string): boolean | null {
  if (!value || value === 'NULL' || value === '') return null;
  const lower = value.toLowerCase().trim();
  if (lower === 'true' || lower === 't') return true;
  if (lower === 'false' || lower === 'f') return false;
  return null;
}

/**
 * Parse timestamp from CSV
 */
function parseTimestamp(value: string): Date | null {
  if (!value || value === 'NULL' || value === '') return null;
  try {
    const date = new Date(value);
    return isNaN(date.getTime()) ? null : date;
  } catch {
    return null;
  }
}

/**
 * Parse integer from CSV
 */
function parseInteger(value: string): number {
  if (!value || value === 'NULL' || value === '') return 0;
  const num = Number(value);
  return isNaN(num) ? 0 : Math.floor(num);
}

/**
 * Parse JSON from CSV
 */
function parseJSON(value: string): any {
  if (!value || value === 'NULL' || value === '' || value === '{}') return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/**
 * Map CSV row to database record
 */
function mapToEnsNameRecord(row: CSVRow): any {
  // Clean address values
  const cleanAddress = (addr: string) => {
    if (!addr || addr === 'NULL' || addr === '') return null;
    return addr.toLowerCase().trim();
  };

  return {
    token_id: row.token_id?.trim() || null,
    name: row.name?.trim() || null,
    owner_address: cleanAddress(row.owner_address),
    registrant: cleanAddress(row.registrant),
    expiry_date: parseTimestamp(row.expiry_date),
    registration_date: parseTimestamp(row.registration_date),
    last_transfer_date: parseTimestamp(row.last_transfer_date),
    metadata: parseJSON(row.metadata),
    resolver_address: cleanAddress(row.resolver_address),
    has_emoji: parseBoolean(row.has_emoji),
    has_numbers: parseBoolean(row.has_numbers),
    clubs: row.clubs && row.clubs !== 'NULL' && row.clubs !== '' ? [row.clubs.trim()] : null,
    upvotes: parseInteger(row.upvotes),
    downvotes: parseInteger(row.downvotes),
    net_score: parseInteger(row.net_score),
    last_sale_date: parseTimestamp(row.last_sale_date),
    last_sale_price: row.last_sale_price && row.last_sale_price !== 'NULL' && row.last_sale_price !== '' ? row.last_sale_price.trim() : null,
    last_sale_currency: cleanAddress(row.last_sale_currency),
    last_sale_price_usd: row.last_sale_price_usd && row.last_sale_price_usd !== 'NULL' && row.last_sale_price_usd !== '' ? parseFloat(row.last_sale_price_usd) : null,
    highest_offer_wei: row.highest_offer_wei && row.highest_offer_wei !== 'NULL' && row.highest_offer_wei !== '' ? row.highest_offer_wei.trim() : null,
    highest_offer_currency: cleanAddress(row.highest_offer_currency),
    highest_offer_id: row.highest_offer_id && row.highest_offer_id !== 'NULL' && row.highest_offer_id !== '' ? parseInteger(row.highest_offer_id) : null,
    last_offer_update: parseTimestamp(row.last_offer_update),
    view_count: parseInteger(row.view_count),
    created_at: parseTimestamp(row.created_at) || new Date(),
    updated_at: parseTimestamp(row.updated_at) || new Date(),
  };
}

/**
 * Import batch with conflict handling - skips duplicates instead of upserting
 */
async function importBatch(
  records: any[],
  stats: ImportStats,
  dryRun: boolean
): Promise<void> {
  if (records.length === 0) return;

  if (dryRun) {
    console.log(`\n[DRY RUN] Would import batch of ${records.length} records:`);
    console.log(JSON.stringify(records[0], null, 2));
    stats.rowsImported += records.length;
    return;
  }

  const insertQuery = `
    INSERT INTO ens_names (
      token_id, name, owner_address, registrant,
      expiry_date, registration_date, last_transfer_date,
      metadata, resolver_address, has_emoji, has_numbers,
      clubs, upvotes, downvotes, net_score,
      last_sale_date, last_sale_price, last_sale_currency, last_sale_price_usd,
      highest_offer_wei, highest_offer_currency, highest_offer_id, last_offer_update,
      view_count, created_at, updated_at
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15,
      $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26
    )
    ON CONFLICT (token_id) DO NOTHING
  `;

  const client = await pool.connect();

  // Process each record in its own transaction to avoid batch failures
  for (const record of records) {
    try {
      await client.query('BEGIN');

      const result = await client.query(insertQuery, [
        record.token_id,
        record.name,
        record.owner_address,
        record.registrant,
        record.expiry_date,
        record.registration_date,
        record.last_transfer_date,
        record.metadata,
        record.resolver_address,
        record.has_emoji,
        record.has_numbers,
        record.clubs,
        record.upvotes,
        record.downvotes,
        record.net_score,
        record.last_sale_date,
        record.last_sale_price,
        record.last_sale_currency,
        record.last_sale_price_usd,
        record.highest_offer_wei,
        record.highest_offer_currency,
        record.highest_offer_id,
        record.last_offer_update,
        record.view_count,
        record.created_at,
        record.updated_at,
      ]);

      await client.query('COMMIT');

      if (result.rowCount && result.rowCount > 0) {
        stats.rowsImported++;
      } else {
        stats.duplicates++;
      }
    } catch (error: any) {
      await client.query('ROLLBACK');

      // Check if it's a duplicate error (23505 = unique_violation)
      if (error.code === '23505') {
        stats.duplicates++;
      } else {
        stats.rowsErrored++;
        console.error(`\nError inserting ${record.name}:`);
        console.error(`  Code: ${error.code}`);
        console.error(`  Message: ${error.message}`);
        console.error(`  Detail: ${error.detail}`);
      }
    }
  }

  client.release();
}

/**
 * Save progress to file
 */
function saveProgress(progressFile: string, data: ProgressData): void {
  try {
    fs.writeFileSync(progressFile, JSON.stringify(data, null, 2));
  } catch (error) {
    console.warn('Could not save progress file:', error);
  }
}

/**
 * Load progress from file
 */
function loadProgress(progressFile: string): ProgressData | null {
  try {
    if (fs.existsSync(progressFile)) {
      const content = fs.readFileSync(progressFile, 'utf8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.warn('Could not load progress file:', error);
  }
  return null;
}

/**
 * Main import function
 */
async function importEnsNamesCSV(options: ImportOptions) {
  const { csvPath, dryRun, batchSize, skipRows, progressFile } = options;

  console.log(`\n========================================`);
  console.log(`Importing ENS Names CSV`);
  console.log(`========================================`);
  console.log(`File: ${csvPath}`);
  console.log(`Dry Run: ${dryRun ? 'YES' : 'NO'}`);
  console.log(`Batch Size: ${batchSize}`);
  console.log(`Skip Rows: ${skipRows}`);
  console.log(`Progress File: ${progressFile}`);
  console.log(`========================================\n`);

  // Load previous progress if available
  const previousProgress = loadProgress(progressFile);
  const fileName = path.basename(csvPath);

  if (previousProgress && previousProgress.fileName === fileName && skipRows === 0) {
    console.log(`Found previous progress:`);
    console.log(`  Last processed row: ${previousProgress.lastProcessedRow.toLocaleString()}`);
    console.log(`  Total imported: ${previousProgress.totalImported.toLocaleString()}`);
    console.log(`  Timestamp: ${previousProgress.timestamp}`);
    console.log(`  Resuming from row ${previousProgress.lastProcessedRow + 1}...\n`);
  }

  const stats: ImportStats = {
    rowsRead: 0,
    rowsSkipped: skipRows || (previousProgress?.lastProcessedRow || 0),
    rowsImported: previousProgress?.totalImported || 0,
    rowsErrored: 0,
    duplicates: 0,
    startTime: new Date(),
    lastProcessedRow: previousProgress?.lastProcessedRow || 0,
  };

  const fileStream = fs.createReadStream(csvPath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let headers: string[] = [];
  let batch: any[] = [];
  let isFirstRow = true;
  let rowNumber = 0;

  for await (const line of rl) {
    if (isFirstRow) {
      headers = parseCSVLine(line);
      isFirstRow = false;
      continue;
    }

    rowNumber++;
    stats.rowsRead++;

    // Skip rows if resuming
    if (rowNumber <= stats.rowsSkipped) {
      continue;
    }

    const values = parseCSVLine(line);
    const row: any = {};

    headers.forEach((header, index) => {
      row[header] = values[index] || '';
    });

    // Validate required fields
    if (!row.token_id || !row.name) {
      stats.rowsErrored++;
      console.warn(`Row ${rowNumber}: Missing required fields (token_id or name)`);
      continue;
    }

    // Map to ens_names record
    const ensNameRecord = mapToEnsNameRecord(row as CSVRow);
    batch.push(ensNameRecord);

    // Import batch when full
    if (batch.length >= batchSize) {
      await importBatch(batch, stats, dryRun);
      batch = [];
      stats.lastProcessedRow = rowNumber;

      // Save progress
      if (!dryRun) {
        saveProgress(progressFile, {
          fileName,
          lastProcessedRow: rowNumber,
          totalImported: stats.rowsImported,
          timestamp: new Date().toISOString(),
        });
      }

      // Progress report
      const elapsed = (new Date().getTime() - stats.startTime.getTime()) / 1000;
      const rate = stats.rowsRead / elapsed;
      console.log(
        `Progress: ${rowNumber.toLocaleString()} rows processed, ` +
        `${stats.rowsImported.toLocaleString()} imported, ` +
        `${stats.duplicates.toLocaleString()} duplicates skipped, ` +
        `${stats.rowsErrored.toLocaleString()} errors, ` +
        `${rate.toFixed(0)} rows/sec`
      );
    }
  }

  // Import remaining batch
  if (batch.length > 0) {
    await importBatch(batch, stats, dryRun);
    stats.lastProcessedRow = rowNumber;

    if (!dryRun) {
      saveProgress(progressFile, {
        fileName,
        lastProcessedRow: rowNumber,
        totalImported: stats.rowsImported,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Final report
  const elapsed = (new Date().getTime() - stats.startTime.getTime()) / 1000;

  console.log(`\n========================================`);
  console.log(`Import Complete!`);
  console.log(`========================================`);
  console.log(`Total rows processed:   ${stats.rowsRead.toLocaleString()}`);
  console.log(`Rows skipped (resume):  ${stats.rowsSkipped.toLocaleString()}`);
  console.log(`Rows imported:          ${stats.rowsImported.toLocaleString()}`);
  console.log(`Duplicates skipped:     ${stats.duplicates.toLocaleString()}`);
  console.log(`Errors:                 ${stats.rowsErrored.toLocaleString()}`);
  console.log(`Time elapsed:           ${elapsed.toFixed(1)}s`);
  console.log(`Average rate:           ${(stats.rowsRead / elapsed).toFixed(0)} rows/sec`);
  console.log(`========================================\n`);

  // Clean up progress file on successful completion
  if (!dryRun && stats.rowsErrored === 0) {
    try {
      fs.unlinkSync(progressFile);
      console.log(`Progress file deleted (import completed successfully)`);
    } catch {
      // Ignore errors
    }
  }

  await closeAllConnections();
  process.exit(0);
}

// Parse command line arguments
const csvPath = process.argv[2];
const args = process.argv.slice(3);

if (!csvPath) {
  console.error('Usage: npm run import-csv -- <csv-file> [options]');
  console.error('\nOptions:');
  console.error('  --dry-run                 Preview without writing to database');
  console.error('  --batch-size=<n>          Batch size (default: 50)');
  console.error('  --skip-rows=<n>           Skip first N rows (for manual resuming)');
  console.error('  --progress-file=<path>    Progress tracking file (default: .import-progress.json)');
  console.error('\nExamples:');
  console.error('  npm run import-csv -- ~/Desktop/EFP/GRAILS/db/first_mil_names.csv');
  console.error('  npm run import-csv -- ~/Desktop/EFP/GRAILS/db/first_mil_names.csv --batch-size=100');
  console.error('  npm run import-csv:dry -- ~/Desktop/EFP/GRAILS/db/first_mil_names.csv');
  process.exit(1);
}

const options: ImportOptions = {
  csvPath,
  dryRun: args.includes('--dry-run'),
  batchSize: Number(args.find(a => a.startsWith('--batch-size='))?.split('=')[1] || '1000'),
  skipRows: Number(args.find(a => a.startsWith('--skip-rows='))?.split('=')[1] || '0'),
  progressFile: args.find(a => a.startsWith('--progress-file='))?.split('=')[1] || '.import-progress.json',
};

importEnsNamesCSV(options).catch(error => {
  console.error('Import failed:', error);
  process.exit(1);
});
