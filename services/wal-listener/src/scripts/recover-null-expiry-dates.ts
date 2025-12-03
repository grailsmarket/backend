#!/usr/bin/env tsx

/**
 * Recover expiry dates for records with null expiry_date
 *
 * This script:
 * 1. Finds all ENS names where expiry_date IS NULL
 * 2. Queries The Graph ENS subgraph by name
 * 3. Updates expiry_date and registration_date from The Graph
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node --max-old-space-size=4096 dist/wal-listener/src/scripts/recover-null-expiry-dates.js [--dry-run] [--limit 100] [--batch-size 50] [--offset 0]
 */

import { getPostgresPool } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';

interface NullExpiryRecord {
  id: number;
  name: string;
  token_id: string;
}

interface DomainData {
  name: string;
  expiryDate: string | null;
  registrationDate: string | null;
}

// Query The Graph for multiple domains by names in a single batch
async function queryGraphForNamesBatch(names: string[]): Promise<Map<string, DomainData>> {
  console.log(`    Querying The Graph for ${names.length} names...`);

  const query = `
    query GetDomainsByNames($names: [String!]!) {
      domains(where: { name_in: $names }) {
        name
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
          registrationDate: domain.registration?.registrationDate || null,
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

async function recoverNullExpiryDates(options: {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun || false;
  const limit = options.limit || 16000;
  const batchSize = options.batchSize || 50;
  const offset = options.offset || 0;

  try {
    console.log('\n=== Recovering Null Expiry Dates from The Graph ===\n');
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Batch size: ${batchSize}\n`);

    // Fetch all records with null expiry_date
    console.log('Fetching records with null expiry_date...\n');

    const query = `
      SELECT
        id,
        name,
        token_id
      FROM ens_names
      WHERE expiry_date IS NULL
      AND name NOT LIKE '#%'
      AND name NOT LIKE 'token-%'
      AND name NOT LIKE '%.%.eth'
      AND name NOT LIKE '[%].eth'
      ORDER BY id
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);
    const nullExpiryRecords: NullExpiryRecord[] = result.rows;

    console.log(`Found ${nullExpiryRecords.length} records with null expiry_date\n`);

    if (nullExpiryRecords.length === 0) {
      console.log('No null expiry records to process!');
      await pool.end();
      return;
    }

    // Show examples
    console.log('Sample records:');
    nullExpiryRecords.slice(0, 5).forEach((r) => {
      console.log(`  ID ${r.id}: ${r.name} (token: ${r.token_id})`);
    });
    console.log('');

    // Process in batches
    let processed = 0;
    let recovered = 0;
    let failed = 0;
    let skipped = 0;

    console.log('Starting recovery...\n');

    for (let i = 0; i < nullExpiryRecords.length; i += batchSize) {
      const batch = nullExpiryRecords.slice(i, i + batchSize);

      console.log(`Processing batch ${Math.floor(i / batchSize) + 1} (records ${i + 1}-${Math.min(i + batchSize, nullExpiryRecords.length)})...`);

      // Collect names for this batch
      const nameMap = new Map<string, NullExpiryRecord>();
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

        if (domainData && domainData.expiryDate) {
          // Convert Unix timestamp (seconds) to JavaScript Date
          const expiryDate = new Date(parseInt(domainData.expiryDate) * 1000);
          const registrationDate = domainData.registrationDate
            ? new Date(parseInt(domainData.registrationDate) * 1000)
            : null;

          console.log(`  ✅ ${record.name}`);
          console.log(`     Expiry: ${expiryDate.toISOString()}`);
          if (registrationDate) {
            console.log(`     Registration: ${registrationDate.toISOString()}`);
          }

          if (!dryRun) {
            // Update database
            try {
              await pool.query(
                `UPDATE ens_names
                 SET expiry_date = $1,
                     registration_date = COALESCE(registration_date, $2)
                 WHERE id = $3`,
                [
                  expiryDate,
                  registrationDate,
                  record.id
                ]
              );
              recovered++;
            } catch (updateError: any) {
              console.error(`     ❌ Failed to update database: ${updateError.message}`);
              failed++;
            }
          } else {
            recovered++;
          }
        } else if (domainData) {
          console.log(`  ⚠️  ${record.name} - No expiry date found on The Graph`);
          skipped++;
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
    console.log('\n=== Recovery Summary ===\n');
    console.log(`Total processed: ${processed}`);
    console.log(`Successfully recovered: ${recovered}`);
    console.log(`Failed to update: ${failed}`);
    console.log(`Not found/no expiry: ${skipped}`);
    console.log(`Success rate: ${((recovered / processed) * 100).toFixed(2)}%\n`);

    if (dryRun) {
      console.log('⚠️  DRY RUN - No changes were made to the database');
      console.log('Run without --dry-run to apply updates\n');
    } else {
      console.log('✅ Database has been updated!\n');
    }

    // Export results
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = `null-expiry-recovery-${timestamp}.json`;

    const results = {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      summary: {
        total: processed,
        recovered,
        failed,
        skipped,
      },
    };

    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results exported to: ${outputFile}\n`);

  } catch (error: any) {
    console.error('\n❌ Fatal error:', error.message);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: any = {
  dryRun: args.includes('--dry-run'),
};

// Parse limit
const limitIndex = args.indexOf('--limit');
if (limitIndex !== -1 && args[limitIndex + 1]) {
  options.limit = parseInt(args[limitIndex + 1], 10);
}

// Parse batch size
const batchSizeIndex = args.indexOf('--batch-size');
if (batchSizeIndex !== -1 && args[batchSizeIndex + 1]) {
  options.batchSize = parseInt(args[batchSizeIndex + 1], 10);
}

// Parse offset
const offsetIndex = args.indexOf('--offset');
if (offsetIndex !== -1 && args[offsetIndex + 1]) {
  options.offset = parseInt(args[offsetIndex + 1], 10);
}

// Run the recovery
recoverNullExpiryDates(options);
