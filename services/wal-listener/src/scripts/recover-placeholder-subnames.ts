#!/usr/bin/env tsx

/**
 * Recover subname data from # placeholders using The Graph
 *
 * This script:
 * 1. Finds all placeholder names like #123, #456, etc.
 * 2. Converts their token IDs to hex
 * 3. Queries The Graph ENS subgraph for the correct name
 * 4. Updates the database with the correct name
 *
 * Usage:
 *   Build first: cd services/wal-listener && npm run build
 *   Then run: node --max-old-space-size=4096 dist/scripts/recover-placeholder-subnames.js [--dry-run] [--limit 100] [--batch-size 50] [--offset 0]
 */

import { getPostgresPool } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';

interface PlaceholderRecord {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
}

interface DomainData {
  name: string;
  owner: string | null;
  expiryDate: string | null;
  registrationDate: string | null;
  textRecords: Record<string, string>;
}

// Query The Graph for multiple domains by token IDs in a single batch
async function queryGraphForNamesBatch(tokenIdHexArray: string[]): Promise<Map<string, DomainData>> {
  console.log(`    Querying The Graph for ${tokenIdHexArray.length} token IDs...`);

  const query = `
    query GetDomainsByIds($ids: [String!]!) {
      domains(where: { id_in: $ids }) {
        id
        name
        labelName
        labelhash
        createdAt
        registrant {
            id
        }
        wrappedOwner {
            id
        }
        registration {
            expiryDate
            registrationDate
        }
        resolver {
            textChangeds {
            value
            key
            }
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
          ids: tokenIdHexArray,
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
        // Process text records - keep the most recent value for each key
        // Loop through in order, later entries will overwrite earlier ones
        const textRecords: Record<string, string> = {};
        if (domain.resolver?.textChangeds) {
          for (const record of domain.resolver.textChangeds) {
            if (record.key && record.value) {
              textRecords[record.key] = record.value;
            }
          }
        }

        resultsMap.set(domain.id.toLowerCase(), {
          name: domain.name,
          owner: domain.wrappedOwner?.id || domain.registrant?.id || null,
          expiryDate: domain.registration?.expiryDate || null,
          registrationDate: domain.registration?.registrationDate || domain.createdAt || null,
          textRecords,
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

async function recoverPlaceholders(options: {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun || false;
  const limit = options.limit || 1000;
  const batchSize = options.batchSize || 50;
  const offset = options.offset || 0;

  try {
    console.log('\n=== Recovering Placeholder Subnames from The Graph ===\n');
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Batch size: ${batchSize}\n`);

    // Fetch all placeholder names starting with #
    console.log('Fetching placeholder records...\n');

    const query = `
      SELECT
        id,
        name,
        token_id,
        owner_address
      FROM ens_names
      WHERE name ~ '^#[0-9]+$'
      ORDER BY id
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);
    const placeholders: PlaceholderRecord[] = result.rows;

    console.log(`Found ${placeholders.length} placeholder records\n`);

    if (placeholders.length === 0) {
      console.log('No placeholders to process!');
      await pool.end();
      return;
    }

    // Show examples
    console.log('Sample placeholders:');
    placeholders.slice(0, 5).forEach((p) => {
      console.log(`  ID ${p.id}: ${p.name} (token: ${p.token_id})`);
    });
    console.log('');

    // Process in batches
    let processed = 0;
    let recovered = 0;
    let failed = 0;
    let skipped = 0;

    console.log('Starting recovery...\n');

    for (let i = 0; i < placeholders.length; i += batchSize) {
      const batch = placeholders.slice(i, i + batchSize);

      console.log(`Processing batch ${Math.floor(i / batchSize) + 1} (records ${i + 1}-${Math.min(i + batchSize, placeholders.length)})...`);

      // Convert all token IDs in this batch to hex
      const tokenIdMap = new Map<string, PlaceholderRecord>();
      const tokenIdHexArray: string[] = [];

      for (const placeholder of batch) {
        let tokenIdHex: string;
        if (placeholder.token_id.startsWith('0x')) {
          tokenIdHex = placeholder.token_id.toLowerCase();
        } else {
          tokenIdHex = '0x' + BigInt(placeholder.token_id).toString(16).padStart(64, '0');
        }
        tokenIdMap.set(tokenIdHex, placeholder);
        tokenIdHexArray.push(tokenIdHex);
      }
console.log({tokenIdHexArray})
      // Query The Graph for all token IDs in this batch
      const domainDataMap = await queryGraphForNamesBatch(tokenIdHexArray);

      // Process results
      for (const [tokenIdHex, placeholder] of tokenIdMap.entries()) {
        processed++;

        const domainData = domainDataMap.get(tokenIdHex);

        if (domainData) {
          console.log(`  ✅ ${placeholder.name} → ${domainData.name}`);
          console.log(`     Owner: ${domainData.owner || 'N/A'}`);
          console.log(`     Expiry: ${domainData.expiryDate ? new Date(parseInt(domainData.expiryDate) * 1000).toISOString() : 'N/A'}`);

          const expiryDate = domainData.expiryDate ? new Date(parseInt(domainData.expiryDate) * 1000) : null;
          const registrationDate = domainData.registrationDate ? new Date(parseInt(domainData.registrationDate) * 1000) : null;

          if (!dryRun) {
            // Update database
            try {
              // Update main fields
              await pool.query(
                `UPDATE ens_names
                 SET name = $1,
                     owner_address = $2,
                     expiry_date = $3,
                     registration_date = $4,
                     metadata = COALESCE(metadata, '{}'::jsonb) || $5::jsonb
                 WHERE id = $6`,
                [
                  domainData.name,
                  domainData.owner?.toLowerCase() || null,
                  expiryDate,
                  registrationDate,
                  JSON.stringify({ text_records: domainData.textRecords }),
                  placeholder.id
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
        } else {
          console.log(`  ⚠️  ${placeholder.name} - No result from The Graph (token: ${tokenIdHex.substring(0, 10)}...)`);
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
    console.log(`Not found in Graph: ${skipped}`);
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
    const outputFile = `recovery-results-${timestamp}.json`;

    const results = {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      summary: {
        total: processed,
        recovered,
        failed,
        skipped,
      },
      placeholders: placeholders.map((p) => ({
        id: p.id,
        original_name: p.name,
        token_id: p.token_id,
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
recoverPlaceholders(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
