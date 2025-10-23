#!/usr/bin/env node
/**
 * Ultra-minimal backfill script with no heavy dependencies
 *
 * Usage:
 *   node --max-old-space-size=1024 --loader tsx src/scripts/backfill-simple.ts --limit 100
 */

import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
});

interface Stats {
  processed: number;
  resolved: number;
  skipped: number;
  failed: number;
  duplicates: number;
}

/**
 * Resolve token IDs using The Graph
 */
async function resolveTokenIds(tokenIds: string[]): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();

  if (tokenIds.length === 0) return results;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const labelhashes = tokenIds.map(id => {
      const hex = BigInt(id).toString(16).padStart(64, '0');
      return '0x' + hex;
    });

    const graphUrl = process.env.GRAPH_ENS_SUBGRAPH_URL || 'https://api.thegraph.com/subgraphs/name/ensdomains/ens';

    const response = await fetch(graphUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `
          query GetENSNames($labelhashes: [String!]!) {
            domains(where: { labelhash_in: $labelhashes }) {
              name
              labelName
              labelhash
            }
          }
        `,
        variables: { labelhashes }
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      for (const id of tokenIds) results.set(id, null);
      return results;
    }

    const data: any = await response.json();
    const domains = data.data?.domains || [];

    const domainMap = new Map<string, any>();
    for (const domain of domains) {
      if (domain.labelhash) {
        domainMap.set(domain.labelhash.toLowerCase(), domain);
      }
    }

    for (let i = 0; i < tokenIds.length; i++) {
      const labelhash = labelhashes[i].toLowerCase();
      const domain = domainMap.get(labelhash);
      results.set(tokenIds[i], domain ? (domain.name || domain.labelName || null) : null);
    }

    return results;
  } catch (error) {
    clearTimeout(timeoutId);
    for (const id of tokenIds) results.set(id, null);
    return results;
  }
}

async function backfill(batchSize: number, limit?: number) {
  const stats: Stats = { processed: 0, resolved: 0, skipped: 0, failed: 0, duplicates: 0 };

  let batchNum = 0;
  let lastId: number | null = null;

  console.log(`Starting backfill (batch size: ${batchSize})...`);

  while (true) {
    batchNum++;

    if (limit && stats.processed >= limit) break;

    const currentBatchSize = limit ? Math.min(batchSize, limit - stats.processed) : batchSize;

    // Fetch batch
    const batchResult: any = lastId === null
      ? await pool.query(`SELECT id, token_id, name FROM ens_names WHERE name LIKE 'token-%' ORDER BY id DESC LIMIT $1`, [currentBatchSize])
      : await pool.query(`SELECT id, token_id, name FROM ens_names WHERE name LIKE 'token-%' AND id < $1 ORDER BY id DESC LIMIT $2`, [lastId, currentBatchSize]);

    const batch: any[] = batchResult.rows;
    if (batch.length === 0) break;

    lastId = batch[batch.length - 1].id;

    const tokenIds = batch.map((r: any) => r.token_id);
    const resolved = await resolveTokenIds(tokenIds);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const row of batch) {
        const name = resolved.get(row.token_id);

        if (name && name !== row.name) {
          const hasNumbers = /\d/.test(name);
          const hasEmoji = /[\u{1F600}-\u{1F64F}]|[\u{1F300}-\u{1F5FF}]|[\u{1F680}-\u{1F6FF}]|[\u{1F1E0}-\u{1F1FF}]/u.test(name);

          const existing = await client.query('SELECT id FROM ens_names WHERE name = $1 AND id != $2', [name, row.id]);

          if (existing.rows.length > 0) {
            await client.query('DELETE FROM ens_names WHERE id = $1', [row.id]);
            stats.duplicates++;
          } else {
            await client.query('UPDATE ens_names SET name = $1, has_numbers = $2, has_emoji = $3 WHERE id = $4', [name, hasNumbers, hasEmoji, row.id]);
            stats.resolved++;
          }
        } else {
          stats.skipped++;
        }
        stats.processed++;
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      stats.failed += batch.length;
    } finally {
      client.release();
    }

    console.log(`Batch ${batchNum}: ${stats.processed} processed | ${stats.resolved} resolved | ${stats.skipped} skipped | ${stats.duplicates} dupes`);

    // Clear and wait
    batch.length = 0;
    resolved.clear();

    if (global.gc) global.gc();
    await new Promise(resolve => setTimeout(resolve, 2000));
  }

  console.log('\nDone!');
  console.log(`Processed: ${stats.processed}, Resolved: ${stats.resolved}, Skipped: ${stats.skipped}, Duplicates: ${stats.duplicates}, Failed: ${stats.failed}`);
}

async function main() {
  console.log('Script starting...');

  const args = process.argv.slice(2);
  let batchSize = 10;
  let limit: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    }
  }

  console.log(`Batch size: ${batchSize}, Limit: ${limit || 'unlimited'}`);
  console.log(`Database URL: ${process.env.DATABASE_URL ? 'Set' : 'NOT SET'}`);

  if (!process.env.DATABASE_URL) {
    console.error('ERROR: DATABASE_URL environment variable not set!');
    process.exit(1);
  }

  try {
    console.log('Connecting to database...');
    await pool.query('SELECT 1');
    console.log('Database connected!');

    await backfill(batchSize, limit);

    console.log('Closing pool...');
    await pool.end();
    console.log('Done!');
    process.exit(0);
  } catch (error) {
    console.error('Fatal error:', error);
    try {
      await pool.end();
    } catch (e) {
      // ignore
    }
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
