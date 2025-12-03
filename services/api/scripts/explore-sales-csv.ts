/**
 * Explore Sales CSV Data
 *
 * Safely inspects large CSV files without loading them fully into memory.
 * This script helps understand the data before importing.
 *
 * Usage:
 *   npx tsx scripts/explore-sales-csv.ts <path-to-csv-file>
 *
 * Example:
 *   npx tsx scripts/explore-sales-csv.ts ./data/sales-export.csv
 */

import * as fs from 'fs';
import * as readline from 'readline';
import * as path from 'path';

interface ColumnStats {
  name: string;
  nullCount: number;
  emptyCount: number;
  uniqueValues: Set<string>;
  sampleValues: string[];
}

async function exploreCSV(filePath: string) {
  console.log(`\n========================================`);
  console.log(`Exploring CSV: ${path.basename(filePath)}`);
  console.log(`========================================\n`);

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  // Get file size
  const stats = fs.statSync(filePath);
  const fileSizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`File size: ${fileSizeMB} MB`);

  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity
  });

  let headers: string[] = [];
  let rowCount = 0;
  let sampleRows: string[][] = [];
  const MAX_SAMPLES = 100;
  const columnStats: Map<string, ColumnStats> = new Map();

  for await (const line of rl) {
    if (rowCount === 0) {
      // Parse headers
      headers = line.split(',').map(h => h.trim());
      console.log(`\nColumns found (${headers.length}):`);
      headers.forEach((h, i) => console.log(`  ${i + 1}. ${h}`));

      // Initialize column stats
      headers.forEach(h => {
        columnStats.set(h, {
          name: h,
          nullCount: 0,
          emptyCount: 0,
          uniqueValues: new Set(),
          sampleValues: []
        });
      });
    } else {
      // Parse data row
      const values = parseCSVLine(line);

      if (rowCount <= MAX_SAMPLES) {
        sampleRows.push(values);
      }

      // Collect stats
      values.forEach((value, index) => {
        const header = headers[index];
        const stat = columnStats.get(header);
        if (stat) {
          if (value === null || value === 'null' || value === 'NULL') {
            stat.nullCount++;
          }
          if (value === '') {
            stat.emptyCount++;
          }
          if (stat.uniqueValues.size < 50) {
            stat.uniqueValues.add(value);
          }
          if (stat.sampleValues.length < 10 && value !== '') {
            stat.sampleValues.push(value);
          }
        }
      });

      // Progress reporting
      if (rowCount % 50000 === 0) {
        process.stdout.write(`\rProcessed ${rowCount.toLocaleString()} rows...`);
      }
    }

    rowCount++;

    // For very large files, stop after analyzing enough rows
    if (rowCount > 500000) {
      console.log(`\n\n⚠️  Stopping analysis at 500k rows (file is very large)`);
      break;
    }
  }

  console.log(`\n\nTotal rows analyzed: ${rowCount.toLocaleString()}`);

  // Display critical column analysis
  console.log(`\n========================================`);
  console.log(`Critical Column Analysis`);
  console.log(`========================================\n`);

  const criticalColumns = [
    'token_id',
    'order_kind',
    'tx_hash',
    'from',
    'to',
    'amount',
    'price',
    'currency_address',
    'tx_timestamp',
    'created_at'
  ];

  for (const col of criticalColumns) {
    const stat = columnStats.get(col);
    if (stat) {
      console.log(`\n${col}:`);
      console.log(`  Null values: ${stat.nullCount} (${((stat.nullCount / rowCount) * 100).toFixed(2)}%)`);
      console.log(`  Empty values: ${stat.emptyCount} (${((stat.emptyCount / rowCount) * 100).toFixed(2)}%)`);
      console.log(`  Unique values: ${stat.uniqueValues.size > 50 ? '50+' : stat.uniqueValues.size}`);

      if (stat.uniqueValues.size <= 20) {
        console.log(`  Values: ${Array.from(stat.uniqueValues).slice(0, 20).join(', ')}`);
      } else {
        console.log(`  Sample values: ${stat.sampleValues.slice(0, 5).join(', ')}`);
      }
    }
  }

  // Display first few rows
  console.log(`\n========================================`);
  console.log(`Sample Data (first 5 rows)`);
  console.log(`========================================\n`);

  for (let i = 0; i < Math.min(5, sampleRows.length); i++) {
    console.log(`\nRow ${i + 1}:`);
    sampleRows[i].forEach((value, index) => {
      if (criticalColumns.includes(headers[index])) {
        console.log(`  ${headers[index]}: ${value || '(empty)'}`);
      }
    });
  }

  // Recommendations
  console.log(`\n========================================`);
  console.log(`Recommendations`);
  console.log(`========================================\n`);

  const orderKindStat = columnStats.get('order_kind');
  if (orderKindStat && orderKindStat.uniqueValues.size > 0) {
    console.log(`✓ order_kind values found: ${Array.from(orderKindStat.uniqueValues).join(', ')}`);
    console.log(`  → Use these values to filter for sales events`);
  }

  const tokenIdStat = columnStats.get('token_id');
  if (tokenIdStat) {
    console.log(`\n✓ token_id analysis:`);
    console.log(`  Null: ${tokenIdStat.nullCount}, Empty: ${tokenIdStat.emptyCount}`);
    if (tokenIdStat.nullCount + tokenIdStat.emptyCount > 0) {
      console.log(`  ⚠️  WARNING: ${tokenIdStat.nullCount + tokenIdStat.emptyCount} rows missing token_id`);
    }
  }

  const txHashStat = columnStats.get('tx_hash');
  if (txHashStat && txHashStat.nullCount + txHashStat.emptyCount > rowCount * 0.1) {
    console.log(`\n⚠️  WARNING: ${((txHashStat.nullCount + txHashStat.emptyCount) / rowCount * 100).toFixed(1)}% of rows missing tx_hash`);
  }

  console.log(`\n✓ File analysis complete!`);
  console.log(`  Total rows: ${rowCount.toLocaleString()}`);
  console.log(`  Columns: ${headers.length}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Review the order_kind values to identify sales events`);
  console.log(`  2. Check if token_id needs cleaning/formatting`);
  console.log(`  3. Run the import script with appropriate filters`);
  console.log(`\n`);
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

// Run the script
const csvPath = process.argv[2];

if (!csvPath) {
  console.error('Usage: npx tsx scripts/explore-sales-csv.ts <path-to-csv-file>');
  process.exit(1);
}

exploreCSV(csvPath).catch(error => {
  console.error('Error exploring CSV:', error);
  process.exit(1);
});
