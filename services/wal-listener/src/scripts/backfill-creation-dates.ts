#!/usr/bin/env tsx

/**
 * Backfill Creation Dates from ENS Subgraph
 *
 * This script:
 * 1. Finds all ENS names where creation_date is null
 * 2. Queries The Graph ENS subgraph for domain.createdAt in batches
 * 3. Batch-updates creation_date in ens_names table using unnest
 *
 * Uses keyset pagination (WHERE id > lastId) for constant-speed queries.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-creation-dates.ts [--dry-run] [--limit 1000000] [--batch-size 200] [--from 0] [--concurrency 3]
 */

import { getPostgresPool } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';

// Query The Graph for multiple domains by names in a single batch
async function queryGraphForNamesBatch(names: string[]): Promise<Map<string, number>> {
  const query = `
    query GetDomainsByNames($names: [String!]!) {
      domains(where: { name_in: $names }, first: 1000) {
        name
        createdAt
      }
    }
  `;

  try {
    const response = await fetch(GRAPH_ENS_SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { names } }),
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

    const resultsMap = new Map<string, number>();
    if (result.data?.domains) {
      for (const domain of result.data.domains) {
        if (domain.createdAt) {
          resultsMap.set(domain.name.toLowerCase(), parseInt(domain.createdAt));
        }
      }
    }

    return resultsMap;
  } catch (error: any) {
    console.error(`Error querying The Graph: ${error.message}`);
    return new Map();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillCreationDates(options: {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
  concurrency?: number;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun || false;
  const limit = options.limit || 10000000;
  const batchSize = options.batchSize || 200;
  const offset = options.offset || 0;
  const concurrency = options.concurrency || 3;

  try {
    console.log('\n=== Backfilling Creation Dates from The Graph ===\n');
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Subgraph batch size: ${batchSize}`);
    console.log(`Concurrent subgraph requests: ${concurrency}\n`);

    // Fetch page size — pull more rows from DB than we send to subgraph at once
    // so we can fire concurrent subgraph requests from a single DB fetch
    const dbPageSize = batchSize * concurrency * 2;

    let totalProcessed = 0;
    let totalUpdated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    let lastId = offset; // keyset cursor — start after this id
    let pageNumber = 0;
    const startTime = Date.now();

    console.log('Starting backfill...\n');

    while (totalProcessed < limit) {
      const fetchSize = Math.min(dbPageSize, limit - totalProcessed);

      const result = await pool.query(`
        SELECT id, name
        FROM ens_names
        WHERE creation_date IS NULL
          AND id > $2
          AND name NOT LIKE '#%'
          AND name NOT LIKE 'token-%'
          AND name NOT LIKE '%.%.eth'
        ORDER BY id
        LIMIT $1
      `, [fetchSize, lastId]);

      if (result.rows.length === 0) break;
      pageNumber++;

      const rows = result.rows;

      // Build a lookup map: lowercased name -> record
      const nameToRecord = new Map<string, { id: number; name: string }>();
      for (const row of rows) {
        nameToRecord.set(row.name.toLowerCase(), row);
      }

      // Split into subgraph-sized chunks and fire concurrently
      const nameList = rows.map((r: any) => r.name);
      const chunks: string[][] = [];
      for (let i = 0; i < nameList.length; i += batchSize) {
        chunks.push(nameList.slice(i, i + batchSize));
      }

      // Process chunks with concurrency limit
      for (let c = 0; c < chunks.length; c += concurrency) {
        const concurrentChunks = chunks.slice(c, c + concurrency);
        const results = await Promise.all(
          concurrentChunks.map(chunk => queryGraphForNamesBatch(chunk))
        );

        // Merge results and batch-update DB
        const matchedIds: number[] = [];
        const matchedDates: Date[] = [];
        let chunkSkipped = 0;

        for (const graphMap of results) {
          // Count names we queried in this set of concurrent chunks
          for (const chunk of concurrentChunks) {
            for (const name of chunk) {
              const nameLower = name.toLowerCase();
              const timestamp = graphMap.get(nameLower);
              const record = nameToRecord.get(nameLower);

              if (timestamp && record) {
                matchedIds.push(record.id);
                matchedDates.push(new Date(timestamp * 1000));
                // Remove so we don't double-count across concurrent results
                nameToRecord.delete(nameLower);
              }
            }
          }
        }

        // Count unmatched from these chunks
        for (const chunk of concurrentChunks) {
          for (const name of chunk) {
            if (nameToRecord.has(name.toLowerCase())) {
              chunkSkipped++;
              nameToRecord.delete(name.toLowerCase());
            }
          }
        }

        // Batch UPDATE
        if (matchedIds.length > 0 && !dryRun) {
          try {
            await pool.query(
              `UPDATE ens_names AS en
               SET creation_date = v.creation_date
               FROM (SELECT unnest($1::int[]) AS id, unnest($2::timestamptz[]) AS creation_date) AS v
               WHERE en.id = v.id`,
              [matchedIds, matchedDates]
            );
          } catch (err: any) {
            console.error(`  ❌ Batch UPDATE failed: ${err.message}`);
            totalFailed += matchedIds.length;
            matchedIds.length = 0;
          }
        }

        totalUpdated += matchedIds.length;
        totalSkipped += chunkSkipped;

        // Brief pause between concurrent batches to be nice to the subgraph
        await sleep(100);
      }

      totalProcessed += rows.length;
      lastId = rows[rows.length - 1].id; // advance keyset cursor

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const rate = (totalProcessed / ((Date.now() - startTime) / 1000)).toFixed(0);
      console.log(`Page ${pageNumber}: ${rows.length} rows fetched | Updated: ${totalUpdated}, Skipped: ${totalSkipped}, Failed: ${totalFailed} | Total: ${totalProcessed} (${elapsed}s, ${rate}/s)`);
    }

    // Summary
    const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log('\n=== Backfill Summary ===\n');
    console.log(`Total processed: ${totalProcessed}`);
    console.log(`Successfully updated: ${totalUpdated}`);
    console.log(`Not found in Graph: ${totalSkipped}`);
    console.log(`Failed to update: ${totalFailed}`);
    console.log(`Success rate: ${totalProcessed > 0 ? ((totalUpdated / totalProcessed) * 100).toFixed(2) : 0}%`);
    console.log(`Time: ${totalTime}s\n`);

    if (dryRun) {
      console.log('⚠️  DRY RUN - No changes were made to the database');
      console.log('Run without --dry-run to apply updates\n');
    } else {
      console.log('✅ Database has been updated!\n');
    }

  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: { dryRun?: boolean; limit?: number; batchSize?: number; offset?: number; concurrency?: number } = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    options.dryRun = true;
  } else if (args[i] === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--batch-size' && args[i + 1]) {
    options.batchSize = parseInt(args[i + 1], 10);
    i++;
  } else if ((args[i] === '--offset' || args[i] === '--from') && args[i + 1]) {
    options.offset = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--concurrency' && args[i + 1]) {
    options.concurrency = parseInt(args[i + 1], 10);
    i++;
  }
}

// Main execution
backfillCreationDates(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
