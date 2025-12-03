import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse';
import { getPostgresPool } from '../../shared/src';

/**
 * Import POAP links from CSV file
 *
 * CSV Format:
 * - Single column with header "link" (or no header, links only)
 * - One link per row
 *
 * Usage:
 *   npm run import:poap path/to/poap-links.csv
 */

const pool = getPostgresPool();

interface CSVRow {
  link?: string;
  [key: string]: any;
}

async function importPoapLinks(csvFilePath: string) {
  console.log(`\n=== POAP Links Import ===`);
  console.log(`Reading from: ${csvFilePath}\n`);

  if (!fs.existsSync(csvFilePath)) {
    console.error(`❌ Error: File not found at ${csvFilePath}`);
    process.exit(1);
  }

  const links: string[] = [];
  let rowCount = 0;

  // Parse CSV file
  await new Promise<void>((resolve, reject) => {
    fs.createReadStream(csvFilePath)
      .pipe(parse({
        columns: true,
        skip_empty_lines: true,
        trim: true,
      }))
      .on('data', (row: CSVRow) => {
        rowCount++;

        // Try to find the link in the row
        // Check common column names: 'link', 'url', 'mint_link', etc.
        const link = row.link || row.url || row.mint_link || row.Link || row.URL || Object.values(row)[0];

        if (link && typeof link === 'string' && link.trim()) {
          links.push(link.trim());
        } else {
          console.warn(`⚠️  Warning: Row ${rowCount} has no valid link, skipping`);
        }
      })
      .on('end', () => {
        console.log(`✅ Parsed ${rowCount} rows from CSV`);
        console.log(`✅ Found ${links.length} valid links\n`);
        resolve();
      })
      .on('error', (error) => {
        console.error('❌ Error parsing CSV:', error);
        reject(error);
      });
  });

  if (links.length === 0) {
    console.error('❌ No links found in CSV file');
    process.exit(1);
  }

  // Insert links into database
  console.log(`Inserting ${links.length} links into database...`);

  let insertedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  // Use a transaction for better performance
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const link of links) {
      try {
        await client.query(
          `INSERT INTO poap_links (link, claimed, created_at, updated_at)
           VALUES ($1, FALSE, NOW(), NOW())
           ON CONFLICT (link) DO NOTHING`,
          [link]
        );
        insertedCount++;

        if (insertedCount % 100 === 0) {
          process.stdout.write(`\rInserted: ${insertedCount}/${links.length}`);
        }
      } catch (error: any) {
        if (error.code === '23505') {
          // Unique constraint violation - link already exists
          skippedCount++;
        } else {
          console.error(`\n❌ Error inserting link: ${link}`, error.message);
          errorCount++;
        }
      }
    }

    await client.query('COMMIT');
    console.log(`\n\n✅ Import completed!`);
    console.log(`   Inserted: ${insertedCount}`);
    console.log(`   Skipped (duplicates): ${skippedCount}`);
    console.log(`   Errors: ${errorCount}`);

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Transaction failed:', error);
    throw error;
  } finally {
    client.release();
  }

  // Show current statistics
  const statsResult = await pool.query(
    `SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE claimed = TRUE) as claimed,
      COUNT(*) FILTER (WHERE claimed = FALSE) as remaining
     FROM poap_links`
  );

  const stats = statsResult.rows[0];
  console.log(`\n📊 Current POAP Statistics:`);
  console.log(`   Total links: ${stats.total}`);
  console.log(`   Claimed: ${stats.claimed}`);
  console.log(`   Remaining: ${stats.remaining}\n`);

  await pool.end();
}

// Main execution
const csvFilePath = process.argv[2];

if (!csvFilePath) {
  console.error('❌ Usage: npm run import:poap <path-to-csv-file>');
  console.error('   Example: npm run import:poap ./data/poap-links.csv');
  process.exit(1);
}

const absolutePath = path.isAbsolute(csvFilePath)
  ? csvFilePath
  : path.resolve(process.cwd(), csvFilePath);

importPoapLinks(absolutePath)
  .then(() => {
    console.log('✅ Import completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Import failed:', error);
    process.exit(1);
  });
