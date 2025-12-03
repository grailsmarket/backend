#!/usr/bin/env tsx

/**
 * Backfill Registration and Expiry Dates
 *
 * This script:
 * 1. Finds all ENS names where expiry_date or registration_date is null
 * 2. Queries The Graph ENS subgraph by name
 * 3. Updates expiry_date and registration_date in ens_names table
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node --max-old-space-size=4096 dist/wal-listener/src/scripts/backfill-registration-dates.js [--dry-run] [--limit 1000] [--batch-size 50] [--offset 0]
 */

import { getPostgresPool } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';

interface EnsRecord {
  id: number;
  name: string;
  token_id: string;
  expiry_date: string | null;
  registration_date: string | null;
}

interface DomainData {
  name: string;
  expiryDate: string | null;
  registrationDate: string | null;
  createdAt: string | null;
}

// Query The Graph for multiple domains by names in a single batch
async function queryGraphForNamesBatch(names: string[]): Promise<Map<string, DomainData>> {
  console.log(`    Querying The Graph for ${names.length} names...`);

  const query = `
    query GetDomainsByNames($names: [String!]!) {
      domains(where: { name_in: $names }) {
        name
        createdAt
        registration {
          expiryDate
          registrationDate
        }
      }
    }
  `;

  try {
    const response = await fetch(GRAPH_ENS_SUBGRAPH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        variables: {
          names: names,
        },
      }),
    });

    if (!response.ok) {
      console.error(`Graph API error: ${response.status} ${response.statusText}`);
      return new Map();
    }

    const result: any = await response.json();

    if (result.errors) {
      console.error('GraphQL errors:', result.errors);
      return new Map();
    }

    const resultsMap = new Map<string, DomainData>();

    if (result.data?.domains) {
      for (const domain of result.data.domains) {
        resultsMap.set(domain.name.toLowerCase(), {
          name: domain.name,
          expiryDate: domain.registration?.expiryDate || null,
          registrationDate: domain.registration?.registrationDate || domain.createdAt || null,
          createdAt: domain.createdAt || null,
        });
      }
    }

    return resultsMap;
  } catch (error: any) {
    console.error(`Error querying The Graph: ${error.message}`);
    return new Map();
  }
}

// Sleep helper for rate limiting
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillRegistrationDates(options: {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun || false;
  const limit = options.limit || 10000;
  const batchSize = options.batchSize || 50;
  const offset = options.offset || 0;

  try {
    console.log('\n=== Backfilling Registration and Expiry Dates from The Graph ===\n');
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Batch size: ${batchSize}\n`);

    // Fetch all records with null expiry_date or registration_date
    console.log('Fetching records with missing dates...\n');

    const query = `
      SELECT
        id,
        name,
        token_id,
        expiry_date,
        registration_date
      FROM ens_names
      WHERE (expiry_date IS NULL)
        AND name NOT LIKE '#%'
        AND name NOT LIKE 'token-%'
        AND name NOT LIKE '%.%.eth'
      ORDER BY id
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);
    const records: EnsRecord[] = result.rows;

    console.log(`Found ${records.length} records with missing dates\n`);

    if (records.length === 0) {
      console.log('No records to process!');
      await pool.end();
      return;
    }

    // Show examples
    console.log('Sample records:');
    records.slice(0, 5).forEach((r) => {
      console.log(`  ID ${r.id}: ${r.name}`);
      console.log(`    Expiry: ${r.expiry_date || 'NULL'}`);
      console.log(`    Registration: ${r.registration_date || 'NULL'}`);
    });
    console.log('');

    // Process in batches
    let processed = 0;
    let updated = 0;
    let failed = 0;
    let skipped = 0;

    console.log('Starting backfill...\n');

    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);

      console.log(`Processing batch ${Math.floor(i / batchSize) + 1} (records ${i + 1}-${Math.min(i + batchSize, records.length)})...`);

      // Collect names for this batch
      const nameMap = new Map<string, EnsRecord>();
      const namesArray: string[] = [];

      for (const record of batch) {
        nameMap.set(record.name.toLowerCase(), record);
        namesArray.push(record.name);
      }

      // Query The Graph for all names in this batch
      const domainDataMap = await queryGraphForNamesBatch(namesArray);

      // Process results
      for (const [nameLower, record] of nameMap.entries()) {
        processed++;

        const domainData = domainDataMap.get(nameLower);

        if (domainData) {
          const expiryDate = domainData.expiryDate ? new Date(parseInt(domainData.expiryDate) * 1000) : null;
          const registrationDate = domainData.registrationDate ? new Date(parseInt(domainData.registrationDate) * 1000) : null;

          console.log(`  ✅ ${record.name}`);
          if (expiryDate) {
            console.log(`     Expiry: ${expiryDate.toISOString()}`);
          }
          if (registrationDate) {
            console.log(`     Registration: ${registrationDate.toISOString()}`);
          }

          if (!dryRun) {
            // Update database
            try {
              await pool.query(
                `UPDATE ens_names
                 SET expiry_date = COALESCE($1, expiry_date),
                     registration_date = COALESCE($2, registration_date)
                 WHERE id = $3`,
                [
                  expiryDate,
                  registrationDate,
                  record.id
                ]
              );
              updated++;
            } catch (updateError: any) {
              console.error(`     ❌ Failed to update database: ${updateError.message}`);
              failed++;
            }
          } else {
            updated++;
          }
        } else {
          console.log(`  ⚠️  ${record.name} - No result from The Graph`);
          skipped++;
        }
      }

      // Rate limiting - wait between batches
      await sleep(200); // 200ms between batches

      console.log('');
    }

    // Summary
    console.log('\n=== Backfill Summary ===\n');
    console.log(`Total processed: ${processed}`);
    console.log(`Successfully updated: ${updated}`);
    console.log(`Failed to update: ${failed}`);
    console.log(`Not found in Graph: ${skipped}`);
    console.log(`Success rate: ${((updated / processed) * 100).toFixed(2)}%\n`);

    if (dryRun) {
      console.log('⚠️  DRY RUN - No changes were made to the database');
      console.log('Run without --dry-run to apply updates\n');
    } else {
      console.log('✅ Database has been updated!\n');
    }

    // Export results
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = `registration-dates-backfill-${timestamp}.json`;

    const results = {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      summary: {
        total: processed,
        updated,
        failed,
        skipped,
      },
      records: records.map((r) => ({
        id: r.id,
        name: r.name,
        token_id: r.token_id,
        had_expiry: r.expiry_date !== null,
        had_registration: r.registration_date !== null,
      })),
    };

    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results exported to: ${outputFile}\n`);

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: { dryRun?: boolean; limit?: number; batchSize?: number; offset?: number } = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    options.dryRun = true;
  } else if (args[i] === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--batch-size' && args[i + 1]) {
    options.batchSize = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--offset' && args[i + 1]) {
    options.offset = parseInt(args[i + 1], 10);
    i++;
  }
}

// Main execution
backfillRegistrationDates(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
