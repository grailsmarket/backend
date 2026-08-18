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
 *   --since <YYYY-MM-DD>   Only renewals with renewal_date on/after this date
 *   --referrer <0x...>     Only renewals with this referrer (bytes32 or plain address)
 *   --fix-platforms        Also re-stamp existing 'blockchain' renewal activity rows
 *                          whose referrer now maps to a known source (use after adding
 *                          a new entry to ENS_REFERRER_CODES)
 *   --verbose              Show detailed logs
 */

import { getPostgresPool, closeAllConnections, ENS_REFERRER_CODES } from '../../../shared/src';

interface Options {
  dryRun: boolean;
  batchSize: number;
  limit: number | undefined;
  startId: number | undefined;
  since: string | undefined;
  referrer: string | undefined;
  fixPlatforms: boolean;
  verbose: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    dryRun: false,
    batchSize: 500,
    limit: undefined,
    startId: undefined,
    since: undefined,
    referrer: undefined,
    fixPlatforms: false,
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
      case '--since':
        options.since = args[++i];
        break;
      case '--referrer':
        options.referrer = args[++i]?.toLowerCase();
        break;
      case '--fix-platforms':
        options.fixPlatforms = true;
        break;
      case '--verbose':
        options.verbose = true;
        break;
    }
  }

  if (options.since !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(options.since)) {
    console.error('Invalid --since value; expected YYYY-MM-DD');
    process.exit(1);
  }

  if (options.referrer !== undefined) {
    // Accept a plain 20-byte address and pad it to the bytes32 form stored in renewals.referrer
    if (/^0x[0-9a-f]{40}$/.test(options.referrer)) {
      options.referrer = `0x${'0'.repeat(24)}${options.referrer.slice(2)}`;
    }
    if (!/^0x[0-9a-f]{64}$/.test(options.referrer)) {
      console.error('Invalid --referrer value; expected 0x-prefixed 20-byte address or 32-byte referrer code');
      process.exit(1);
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
    // Extra renewal filters (validated in parseArgs, safe to inline)
    const extraConditions: string[] = [];
    if (options.since !== undefined) {
      extraConditions.push(`renewal_date >= '${options.since}'`);
    }
    if (options.referrer !== undefined) {
      extraConditions.push(`referrer = '${options.referrer}'`);
    }
    const extraBare = extraConditions.map((c) => ` AND ${c}`).join('');
    const extraAliased = extraConditions.map((c) => ` AND r.${c}`).join('');

    const referrerCase = buildReferrerCaseExpression();

    // Count total renewals to process
    const countConditions = ['1=1'];
    if (options.startId !== undefined) {
      countConditions.push(`r.id > ${options.startId}`);
    }

    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM renewals r
      WHERE ${countConditions.join(' AND ')}${extraAliased}
        AND NOT EXISTS (
          SELECT 1 FROM activity_history ah
          WHERE ah.ens_name_id = r.ens_name_id
            AND ah.event_type = 'renewal'
            AND ah.transaction_hash = r.transaction_hash
        )
    `);

    const total = parseInt(countResult.rows[0].total, 10);
    console.log(`Found ${total} renewals without activity_history records`);

    let fixTotal = 0;
    if (options.fixPlatforms) {
      const fixCountResult = await pool.query(`
        SELECT COUNT(*) as total
        FROM activity_history ah
        JOIN renewals r
          ON r.ens_name_id = ah.ens_name_id
          AND r.transaction_hash = ah.transaction_hash
        LEFT JOIN LATERAL (
          SELECT ${referrerCase} AS registration_source
        ) src ON true
        WHERE ah.event_type = 'renewal'
          AND ah.platform = 'blockchain'
          AND src.registration_source IS NOT NULL${extraAliased}
      `);
      fixTotal = parseInt(fixCountResult.rows[0].total, 10);
      console.log(`Found ${fixTotal} renewal activity records stamped 'blockchain' with a now-known referrer`);
    }

    if (options.dryRun) {
      console.log('Dry run — no records will be inserted or updated.');
      await closeAllConnections();
      return;
    }

    if (total === 0 && fixTotal === 0) {
      console.log('Nothing to backfill.');
      await closeAllConnections();
      return;
    }

    if (options.fixPlatforms && fixTotal > 0) {
      const fixResult = await pool.query(`
        UPDATE activity_history ah
        SET platform = src.registration_source,
          metadata = COALESCE(ah.metadata, '{}'::jsonb) || jsonb_build_object(
            'referrer', r.referrer,
            'registration_source', src.registration_source
          )
        FROM renewals r
        LEFT JOIN LATERAL (
          SELECT ${referrerCase} AS registration_source
        ) src ON true
        WHERE ah.event_type = 'renewal'
          AND ah.platform = 'blockchain'
          AND ah.ens_name_id = r.ens_name_id
          AND ah.transaction_hash = r.transaction_hash
          AND src.registration_source IS NOT NULL${extraAliased}
      `);
      console.log(`Re-stamped platform on ${fixResult.rowCount ?? 0} renewal activity records.`);
    }

    if (total === 0) {
      console.log('No missing activity records to insert.');
      await closeAllConnections();
      return;
    }

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
          WHERE id > $1${extraBare}
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
        SELECT id FROM renewals WHERE id > $1${extraBare} ORDER BY id ASC LIMIT $2
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
