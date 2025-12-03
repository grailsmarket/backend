#!/usr/bin/env tsx

/**
 * Recover owner addresses for records with zero address
 *
 * This script:
 * 1. Finds all ENS names where owner_address = 0x0000000000000000000000000000000000000000
 * 2. Queries The Graph ENS subgraph by name
 * 3. Updates owner_address (wrappedOwner if exists, otherwise registrant)
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node --max-old-space-size=4096 dist/wal-listener/src/scripts/recover-zero-address-owners.js [--dry-run] [--limit 100] [--batch-size 50] [--offset 0]
 */

import { getPostgresPool } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface ZeroAddressRecord {
  id: number;
  name: string;
  token_id: string;
}

interface DomainData {
  name: string;
  owner: string | null;
}

// Query The Graph for multiple domains by names in a single batch
async function queryGraphForNamesBatch(names: string[]): Promise<Map<string, DomainData>> {
  console.log(`    Querying The Graph for ${names.length} names...`);

  const query = `
    query GetDomainsByNames($names: [String!]!) {
      domains(where: { name_in: $names }) {
        name
        registrant {
            id
        }
        wrappedOwner {
            id
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
          owner: domain.wrappedOwner?.id || domain.registrant?.id || null,
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

async function recoverZeroAddresses(options: {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun || false;
  const limit = options.limit || 118000;
  const batchSize = options.batchSize || 50;
  const offset = options.offset || 0;

  try {
    console.log('\n=== Recovering Zero Address Owners from The Graph ===\n');
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Batch size: ${batchSize}\n`);

    // Fetch all records with zero address
    console.log('Fetching zero address records...\n');

    const query = `
      SELECT
        id,
        name,
        token_id
      FROM ens_names
      WHERE LOWER(owner_address) IN (
        '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401',
        '0x0000000000000000000000000000000000000000', 
        '0x283af0b28c62c092c9727f1ee09c02ca627eb7f5'
      )
      AND name NOT LIKE '#%'
      AND name NOT LIKE '%.%.eth'
      AND name NOT LIKE 'token-%'
      AND name NOT LIKE '[%].eth'
      AND name LIKE '%.eth'
      ORDER BY id
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);
    const zeroAddressRecords: ZeroAddressRecord[] = result.rows;

    console.log(`Found ${zeroAddressRecords.length} records with zero address\n`);

    if (zeroAddressRecords.length === 0) {
      console.log('No zero address records to process!');
      await pool.end();
      return;
    }

    // Show examples
    console.log('Sample records:');
    zeroAddressRecords.slice(0, 5).forEach((r) => {
      console.log(`  ID ${r.id}: ${r.name} (token: ${r.token_id})`);
    });
    console.log('');

    // Process in batches
    let processed = 0;
    let recovered = 0;
    let failed = 0;
    let skipped = 0;

    console.log('Starting recovery...\n');

    for (let i = 0; i < zeroAddressRecords.length; i += batchSize) {
      const batch = zeroAddressRecords.slice(i, i + batchSize);

      console.log(`Processing batch ${Math.floor(i / batchSize) + 1} (records ${i + 1}-${Math.min(i + batchSize, zeroAddressRecords.length)})...`);

      // Collect names for this batch
      const nameMap = new Map<string, ZeroAddressRecord>();
      const namesArray: string[] = [];

      for (const record of batch) {
        nameMap.set(record.name.toLowerCase(), record);
        namesArray.push(record.name);
      }

      // Query The Graph for all names in this batch
      const domainDataMap = await queryGraphForNamesBatch(namesArray);

      // Collect updates for batch processing
      const batchUpdates: Array<{ id: number; owner: string; name: string }> = [];

      // Process results
      for (const [nameLower, record] of nameMap.entries()) {
        processed++;

        const domainData = domainDataMap.get(nameLower);

        if (domainData && domainData.owner && domainData.owner.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
          console.log(`  ✅ ${record.name}`);
          console.log(`     New Owner: ${domainData.owner}`);

          batchUpdates.push({
            id: record.id,
            owner: domainData.owner.toLowerCase(),
            name: record.name
          });
          recovered++;
        } else if (domainData && domainData.owner === ZERO_ADDRESS) {
          console.log(`  ⚠️  ${record.name} - Owner is still zero address on The Graph`);
          skipped++;
        } else {
          console.log(`  ⚠️  ${record.name} - No result from The Graph`);
          skipped++;
        }
      }

      // Execute batch update if we have records to update
      if (!dryRun && batchUpdates.length > 0) {
        try {
          const ids = batchUpdates.map(u => u.id);
          const owners = batchUpdates.map(u => u.owner);

          await pool.query(
            `UPDATE ens_names
             SET owner_address = updates.owner
             FROM (
               SELECT unnest($1::int[]) AS id, unnest($2::text[]) AS owner
             ) AS updates
             WHERE ens_names.id = updates.id`,
            [ids, owners]
          );
          console.log(`  📦 Batch updated ${batchUpdates.length} records`);
        } catch (updateError: any) {
          console.error(`  ❌ Failed to batch update: ${updateError.message}`);
          failed += batchUpdates.length;
          recovered -= batchUpdates.length;
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
    console.log(`Not found/still zero: ${skipped}`);
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
    const outputFile = `zero-address-recovery-${timestamp}.json`;

    const results = {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      summary: {
        total: processed,
        recovered,
        failed,
        skipped,
      },
      records: zeroAddressRecords.map((r) => ({
        id: r.id,
        name: r.name,
        token_id: r.token_id,
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
recoverZeroAddresses(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
