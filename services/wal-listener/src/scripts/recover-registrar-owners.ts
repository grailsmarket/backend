#!/usr/bin/env tsx

/**
 * Recover owner addresses for records with ENS registrar as owner
 *
 * This script:
 * 1. Finds all ENS names where owner_address or registrant = 0x283af0b28c62c092c9727f1ee09c02ca627eb7f5 (ENS Registrar)
 * 2. Queries The Graph ENS subgraph by name
 * 3. Updates owner_address and registrant:
 *    - If wrappedOwner exists on The Graph → set as owner_address
 *    - If wrappedOwner is null → use registrant from The Graph for both owner_address and registrant
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node --max-old-space-size=4096 dist/wal-listener/src/scripts/recover-registrar-owners.js [--dry-run] [--limit 100] [--batch-size 50] [--offset 0]
 */

import { getPostgresPool } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const ENS_REGISTRAR_ADDRESS = '0x283af0b28c62c092c9727f1ee09c02ca627eb7f5';

interface RegistrarRecord {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
  registrant: string | null;
}

interface DomainData {
  name: string;
  wrappedOwner: string | null;
  registrant: string | null;
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
          wrappedOwner: domain.wrappedOwner?.id || null,
          registrant: domain.registrant?.id || null,
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

async function recoverRegistrarOwners(options: {
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
    console.log('\n=== Recovering ENS Registrar Owners from The Graph ===\n');
    console.log(`ENS Registrar Address: ${ENS_REGISTRAR_ADDRESS}`);
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Batch size: ${batchSize}\n`);

    // Fetch all records with registrar address as owner or registrant
    console.log('Fetching records with ENS registrar address...\n');

    const query = `
      SELECT
        id,
        name,
        token_id,
        owner_address,
        registrant
      FROM ens_names
      WHERE (
        LOWER(owner_address) = $1
        OR LOWER(registrant) = $1
      )
      AND name NOT LIKE '#%'
      AND name NOT LIKE 'token-%'
      AND name NOT LIKE '%.%.eth'
      AND name NOT LIKE '[%].eth'
      ORDER BY id
      LIMIT $2 OFFSET $3
    `;

    const result = await pool.query(query, [ENS_REGISTRAR_ADDRESS.toLowerCase(), limit, offset]);
    const registrarRecords: RegistrarRecord[] = result.rows;

    console.log(`Found ${registrarRecords.length} records with ENS registrar address\n`);

    if (registrarRecords.length === 0) {
      console.log('No registrar records to process!');
      await pool.end();
      return;
    }

    // Show examples
    console.log('Sample records:');
    registrarRecords.slice(0, 5).forEach((r) => {
      console.log(`  ID ${r.id}: ${r.name} (owner: ${r.owner_address}, registrant: ${r.registrant || 'null'})`);
    });
    console.log('');

    // Process in batches
    let processed = 0;
    let recovered = 0;
    let failed = 0;
    let skipped = 0;

    console.log('Starting recovery...\n');

    for (let i = 0; i < registrarRecords.length; i += batchSize) {
      const batch = registrarRecords.slice(i, i + batchSize);

      console.log(`Processing batch ${Math.floor(i / batchSize) + 1} (records ${i + 1}-${Math.min(i + batchSize, registrarRecords.length)})...`);

      // Collect names for this batch
      const nameMap = new Map<string, RegistrarRecord>();
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

        if (!domainData) {
          console.log(`  ⚠️  ${record.name} - No result from The Graph`);
          skipped++;
          continue;
        }

        // Determine the correct owner based on wrappedOwner and registrant
        let newOwner: string | null = null;
        let newRegistrant: string | null = null;

        if (domainData.wrappedOwner) {
          // If wrapped, use wrappedOwner as owner
          newOwner = domainData.wrappedOwner.toLowerCase();
          newRegistrant = domainData.registrant?.toLowerCase() || null;
          console.log(`  ✅ ${record.name} (WRAPPED)`);
          console.log(`     New Owner (wrappedOwner): ${newOwner}`);
          if (newRegistrant) {
            console.log(`     New Registrant: ${newRegistrant}`);
          }
        } else if (domainData.registrant) {
          // If not wrapped, use registrant for both owner and registrant
          newOwner = domainData.registrant.toLowerCase();
          newRegistrant = domainData.registrant.toLowerCase();
          console.log(`  ✅ ${record.name} (UNWRAPPED)`);
          console.log(`     New Owner & Registrant: ${newOwner}`);
        } else {
          console.log(`  ⚠️  ${record.name} - No owner data found on The Graph`);
          skipped++;
          continue;
        }

        // Check if owner is still the registrar (skip if already fixed)
        if (newOwner.toLowerCase() === ENS_REGISTRAR_ADDRESS.toLowerCase()) {
          console.log(`  ⚠️  ${record.name} - Owner is still registrar on The Graph`);
          skipped++;
          continue;
        }

        if (!dryRun) {
          // Update database
          try {
            await pool.query(
              `UPDATE ens_names
               SET owner_address = $1,
                   registrant = $2
               WHERE id = $3`,
              [
                newOwner,
                newRegistrant,
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
    console.log(`Not found/still registrar: ${skipped}`);
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
    const outputFile = `registrar-recovery-${timestamp}.json`;

    const results = {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      registrar_address: ENS_REGISTRAR_ADDRESS,
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
recoverRegistrarOwners(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
