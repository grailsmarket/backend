#!/usr/bin/env tsx
/**
 * Backfill Metadata Script
 *
 * One-time script to fix ENS names that have incomplete metadata
 * (only resolverAddress: zero address). This will:
 * 1. Find all names with broken metadata state
 * 2. Fetch fresh metadata from The Graph in batches
 * 3. Update the database directly
 *
 * Usage:
 *   npx tsx src/scripts/backfill-metadata.ts [options]
 *
 * Options:
 *   --dry-run              Preview changes without updating database
 *   --batch-size=100       Number of names to process per batch (default: 100)
 *   --rate-limit=500       Delay between Graph batch requests in ms (default: 500)
 *   --help                 Show this help message
 *
 * Examples:
 *   npx tsx src/scripts/backfill-metadata.ts --dry-run
 *   npx tsx src/scripts/backfill-metadata.ts --batch-size=200 --rate-limit=1000
 */

import { getPostgresPool, closeAllConnections, config } from '../../../shared/src';

const pool = getPostgresPool();
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface Stats {
  totalNames: number;
  processed: number;
  updated: number;
  noDataFound: number;
  errors: number;
  startTime: Date;
  endTime?: Date;
}

interface GraphMetadata {
  [key: string]: string | undefined;
  resolverAddress?: string;
}

interface Options {
  dryRun: boolean;
  batchSize: number;
  rateLimit: number;
}

interface NameRow {
  id: number;
  name: string;
  token_id: string;
}

/**
 * Parse command line arguments
 */
function parseArgs(): Options {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Backfill Metadata Script

Usage:
  npx tsx src/scripts/backfill-metadata.ts [options]

Options:
  --dry-run              Preview changes without updating database
  --batch-size=100       Number of names to process per batch (default: 100)
  --rate-limit=500       Delay between Graph batch requests in ms (default: 500)
  --help                 Show this help message

Examples:
  npx tsx src/scripts/backfill-metadata.ts --dry-run
  npx tsx src/scripts/backfill-metadata.ts --batch-size=200 --rate-limit=1000
`);
    process.exit(0);
  }

  const options: Options = {
    dryRun: args.includes('--dry-run'),
    batchSize: 100,
    rateLimit: 500,
  };

  // Parse --batch-size=N
  const batchSizeArg = args.find(arg => arg.startsWith('--batch-size='));
  if (batchSizeArg) {
    const value = parseInt(batchSizeArg.split('=')[1], 10);
    if (!isNaN(value) && value > 0) {
      options.batchSize = value;
    }
  }

  // Parse --rate-limit=N
  const rateLimitArg = args.find(arg => arg.startsWith('--rate-limit='));
  if (rateLimitArg) {
    const value = parseInt(rateLimitArg.split('=')[1], 10);
    if (!isNaN(value) && value >= 0) {
      options.rateLimit = value;
    }
  }

  return options;
}

/**
 * Fetch metadata from The Graph for multiple ENS names in a single request
 */
async function fetchMetadataBatchFromGraph(names: string[]): Promise<Map<string, GraphMetadata>> {
  const results = new Map<string, GraphMetadata>();

  if (names.length === 0) {
    return results;
  }

  // The Graph supports querying multiple domains with name_in
  const query = `
    query GetDomains($names: [String!]!) {
      domains(where: { name_in: $names }) {
        name
        resolver {
          address
          texts
          textChangeds {
            key
            value
          }
        }
      }
    }
  `;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.theGraph?.apiKey) {
    headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
  }

  const response = await fetch(config.theGraph.ensSubgraphUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables: { names: names.map(n => n.toLowerCase()) },
    }),
  });

  if (!response.ok) {
    throw new Error(`Graph request failed: ${response.status} ${response.statusText}`);
  }

  const json: any = await response.json();

  if (json.errors) {
    throw new Error(`Graph query error: ${JSON.stringify(json.errors)}`);
  }

  const domains = json.data?.domains || [];

  // Build a map of name -> metadata
  for (const domain of domains) {
    if (!domain.name) continue;

    const metadata: GraphMetadata = {
      resolverAddress: domain.resolver?.address || ZERO_ADDRESS,
    };

    if (domain.resolver?.textChangeds && Array.isArray(domain.resolver.textChangeds)) {
      for (const record of domain.resolver.textChangeds) {
        if (record.key && record.value) {
          metadata[record.key] = record.value;
        }
      }
    }

    results.set(domain.name.toLowerCase(), metadata);
  }

  return results;
}

/**
 * Sleep helper for rate limiting
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const options = parseArgs();

  const stats: Stats = {
    totalNames: 0,
    processed: 0,
    updated: 0,
    noDataFound: 0,
    errors: 0,
    startTime: new Date(),
  };

  console.log('\nStarting metadata backfill...');
  console.log(`  Batch size: ${options.batchSize}`);
  console.log(`  Rate limit: ${options.rateLimit}ms between batches`);

  if (options.dryRun) {
    console.log('\n⚠️  DRY RUN MODE - No changes will be made\n');
  } else {
    console.log('');
  }

  try {
    // Find all names with broken metadata state
    const countResult = await pool.query(`
      SELECT COUNT(*) as count
      FROM ens_names
      WHERE metadata = '{"resolverAddress": "0x0000000000000000000000000000000000000000"}'::jsonb
        AND name IS NOT NULL
    `);

    stats.totalNames = parseInt(countResult.rows[0].count, 10);

    if (stats.totalNames === 0) {
      console.log('✓ No names with incomplete metadata found. Nothing to do.\n');
      await closeAllConnections();
      process.exit(0);
    }

    console.log(`Found ${stats.totalNames} names with incomplete metadata\n`);

    // Process in batches using cursor-based pagination
    let lastId = 0;

    while (stats.processed < stats.totalNames) {
      const batchResult = await pool.query(`
        SELECT id, name, token_id
        FROM ens_names
        WHERE metadata = '{"resolverAddress": "0x0000000000000000000000000000000000000000"}'::jsonb
          AND name IS NOT NULL
          AND id > $1
        ORDER BY id
        LIMIT $2
      `, [lastId, options.batchSize]);

      if (batchResult.rows.length === 0) {
        break;
      }

      const rows: NameRow[] = batchResult.rows;
      const names = rows.map(r => r.name);
      lastId = rows[rows.length - 1].id;

      try {
        // Fetch metadata for entire batch from The Graph
        const metadataMap = await fetchMetadataBatchFromGraph(names);

        // Process each row with the fetched metadata
        for (const row of rows) {
          stats.processed++;
          const metadata = metadataMap.get(row.name.toLowerCase());

          // Check if we got meaningful data (more than just resolverAddress)
          const metadataKeys = metadata
            ? Object.keys(metadata).filter(k => k !== 'resolverAddress')
            : [];
          const hasTextRecords = metadataKeys.length > 0;

          if (hasTextRecords ) {
            // Has real metadata - update with the fetched data
            if (!options.dryRun) {
              await pool.query(`
                UPDATE ens_names
                SET metadata = $1,
                    metadata_updated_at = NOW(),
                    updated_at = NOW()
                WHERE id = $2
              `, [JSON.stringify(metadata), row.id]);
            }

            stats.updated++;
            console.log(`  ✓ ${row.name} (${metadataKeys.length} text records)`);
          } else {
            // No data found - clean up by setting metadata to empty object
            if (!options.dryRun) {
              await pool.query(`
                UPDATE ens_names
                SET metadata = '{}'::jsonb,
                    metadata_updated_at = NOW(),
                    updated_at = NOW()
                WHERE id = $1
              `, [row.id]);
            }

            stats.noDataFound++;
          }
        }
      } catch (error: any) {
        // If batch fails, count all as errors
        stats.errors += rows.length;
        stats.processed += rows.length;
        console.log(`  ✗ Batch failed: ${error.message}`);
      }

      // Progress update
      const percent = Math.round((stats.processed / stats.totalNames) * 100);
      console.log(`\nProgress: ${stats.processed}/${stats.totalNames} (${percent}%) - Updated: ${stats.updated}, No data: ${stats.noDataFound}, Errors: ${stats.errors}\n`);

      // Rate limiting between batches
      if (options.rateLimit > 0 && stats.processed < stats.totalNames) {
        await sleep(options.rateLimit);
      }
    }

    // ============================================================================
    // Summary
    // ============================================================================
    stats.endTime = new Date();
    const duration = (stats.endTime.getTime() - stats.startTime.getTime()) / 1000;

    console.log('\n========================================');
    console.log('Metadata Backfill Summary');
    console.log('========================================');
    console.log(`Total Names Found:      ${stats.totalNames}`);
    console.log(`Processed:              ${stats.processed}`);
    console.log(`Updated:                ${stats.updated}`);
    console.log(`No Data in Graph:       ${stats.noDataFound}`);
    console.log(`Errors:                 ${stats.errors}`);
    console.log(`Duration:               ${duration.toFixed(2)}s`);
    console.log('========================================\n');

    if (options.dryRun) {
      console.log('⚠️  DRY RUN - No changes were made');
      console.log('   Run without --dry-run to apply changes\n');
    } else {
      console.log('✓ Metadata backfill complete\n');
    }

    await closeAllConnections();
    process.exit(0);
  } catch (error: any) {
    console.error('\n❌ Metadata backfill failed:', error.message);
    await closeAllConnections();
    process.exit(1);
  }
}

// Handle script termination
process.on('SIGINT', async () => {
  console.log('\n\n⚠️  Metadata backfill interrupted');
  await closeAllConnections();
  process.exit(130);
});

process.on('SIGTERM', async () => {
  console.log('\n\n⚠️  Metadata backfill terminated');
  await closeAllConnections();
  process.exit(143);
});

// Run the script
main().catch(async (error) => {
  console.error('Fatal error:', error);
  await closeAllConnections();
  process.exit(1);
});
