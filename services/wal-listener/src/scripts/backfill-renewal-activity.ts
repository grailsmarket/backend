#!/usr/bin/env node

/**
 * Backfill Renewal Activity History
 *
 * Populates activity_history with 'renewal' events from the existing
 * renewals table. Sets platform to the registration source (e.g. 'grails')
 * when a known referrer is present, otherwise 'blockchain'.
 *
 * Usage:
 *   Build first: npm run build (from repo root)
 *   Then run: node dist/wal-listener/src/scripts/backfill-renewal-activity.js [options]
 *
 * Options:
 *   --dry-run              Preview counts without inserting
 *   --batch-size <n>       Renewals per batch (default: 500)
 *   --limit <n>            Maximum renewals to process
 *   --start-id <n>         Resume from renewal id (processes rows with id > n)
 *   --verbose              Show detailed logs
 */

import { getPostgresPool, closeAllConnections, ENS_REFERRER_CODES } from '../../../shared/src';

interface Options {
  dryRun: boolean;
  batchSize: number;
  limit: number | undefined;
  startId: number | undefined;
  verbose: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    dryRun: false,
    batchSize: 500,
    limit: undefined,
    startId: undefined,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--batch-size':
        options.batchSize = parseInt(args[++i], 10);
        break;
      case '--limit':
        options.limit = parseInt(args[++i], 10);
        break;
      case '--start-id':
        options.startId = parseInt(args[++i], 10);
        break;
      case '--verbose':
        options.verbose = true;
        break;
    }
  }

  return options;
}

// Build SQL CASE expression from ENS_REFERRER_CODES
function buildReferrerCaseExpression(): string {
  const cases = Object.entries(ENS_REFERRER_CODES)
    .map(([code, name]) => `    WHEN '${code}' THEN '${name}'`)
    .join('\n');

  return `CASE r.referrer\n${cases}\n    ELSE NULL\n  END`;
}

async function main() {
  const options = parseArgs();
  const pool = getPostgresPool();

  console.log('=== Backfill Renewal Activity History ===');
  console.log(`Options: ${JSON.stringify(options)}`);

  try {
    // Count total renewals to process
    const countConditions = ['1=1'];
    if (options.startId !== undefined) {
      countConditions.push(`r.id > ${options.startId}`);
    }

    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM renewals r
      WHERE ${countConditions.join(' AND ')}
        AND NOT EXISTS (
          SELECT 1 FROM activity_history ah
          WHERE ah.ens_name_id = r.ens_name_id
            AND ah.event_type = 'renewal'
            AND ah.transaction_hash = r.transaction_hash
        )
    `);

    const total = parseInt(countResult.rows[0].total, 10);
    console.log(`Found ${total} renewals without activity_history records`);

    if (options.dryRun) {
      console.log('Dry run — no records will be inserted.');
      await closeAllConnections();
      return;
    }

    if (total === 0) {
      console.log('Nothing to backfill.');
      await closeAllConnections();
      return;
    }

    const referrerCase = buildReferrerCaseExpression();
    let processed = 0;
    let inserted = 0;
    let lastId = options.startId ?? 0;

    while (true) {
      const remaining = options.limit !== undefined ? options.limit - processed : undefined;
      if (remaining !== undefined && remaining <= 0) break;

      const batchLimit = remaining !== undefined
        ? Math.min(options.batchSize, remaining)
        : options.batchSize;

      const batchResult = await pool.query(`
        INSERT INTO activity_history (
          ens_name_id, event_type, actor_address, platform,
          chain_id, price_wei, transaction_hash, block_number, metadata, created_at
        )
        SELECT
          r.ens_name_id,
          'renewal',
          r.renewer_address,
          COALESCE(src.registration_source, 'blockchain'),
          1,
          r.cost_wei,
          r.transaction_hash,
          r.block_number,
          jsonb_build_object(
            'referrer', r.referrer,
            'registration_source', src.registration_source,
            'cost_wei', r.cost_wei
          ),
          r.renewal_date
        FROM (
          SELECT * FROM renewals
          WHERE id > $1
          ORDER BY id ASC
          LIMIT $2
        ) r
        LEFT JOIN LATERAL (
          SELECT ${referrerCase} AS registration_source
        ) src ON true
        WHERE NOT EXISTS (
          SELECT 1 FROM activity_history ah
          WHERE ah.ens_name_id = r.ens_name_id
            AND ah.event_type = 'renewal'
            AND ah.transaction_hash = r.transaction_hash
        )
        RETURNING id
      `, [lastId, batchLimit]);

      // Get the actual max id from the batch to advance
      const batchMaxResult = await pool.query(`
        SELECT id FROM renewals WHERE id > $1 ORDER BY id ASC LIMIT $2
      `, [lastId, batchLimit]);

      if (batchMaxResult.rows.length === 0) break;

      lastId = batchMaxResult.rows[batchMaxResult.rows.length - 1].id;
      const batchInserted = batchResult.rowCount ?? 0;
      inserted += batchInserted;
      processed += batchMaxResult.rows.length;

      if (options.verbose) {
        console.log(`  Batch: processed=${batchMaxResult.rows.length}, inserted=${batchInserted}, lastId=${lastId}`);
      }

      if (batchMaxResult.rows.length < batchLimit) break;
    }

    console.log(`\nDone! Processed ${processed} renewals, inserted ${inserted} activity records.`);
  } catch (error: any) {
    console.error('Backfill failed:', error.message);
    process.exit(1);
  } finally {
    await closeAllConnections();
  }
}

main();
