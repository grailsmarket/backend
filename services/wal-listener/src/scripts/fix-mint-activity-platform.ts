#!/usr/bin/env node

/**
 * Fix Mint Activity Platform
 *
 * Re-stamps 'mint' activity_history rows that were recorded with
 * platform = 'blockchain' but whose registration referrer now maps to a
 * known source in ENS_REFERRER_CODES (e.g. after adding a new marketplace
 * to the map). Also merges referrer/registration_source into metadata,
 * matching what the live indexer writes.
 *
 * Companion to backfill-renewal-activity.ts --fix-platforms, but for
 * registrations/mints (the one-off equivalents were migrations 0720/0730).
 *
 * Usage:
 *   Build first: npm run build (from repo root)
 *   Then run: node dist/wal-listener/src/scripts/fix-mint-activity-platform.js [options]
 *
 * Options:
 *   --dry-run              Preview counts without updating
 *   --since <YYYY-MM-DD>   Only registrations with registration_date on/after this date
 *   --referrer <0x...>     Only registrations with this referrer (bytes32 or plain address)
 *   --verbose              Show detailed logs
 */

import { getPostgresPool, closeAllConnections, ENS_REFERRER_CODES } from '../../../shared/src';

interface Options {
  dryRun: boolean;
  since: string | undefined;
  referrer: string | undefined;
  verbose: boolean;
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const options: Options = {
    dryRun: false,
    since: undefined,
    referrer: undefined,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--dry-run':
        options.dryRun = true;
        break;
      case '--since':
        options.since = args[++i];
        break;
      case '--referrer':
        options.referrer = args[++i]?.toLowerCase();
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
    // Accept a plain 20-byte address and pad it to the bytes32 form stored in registrations.referrer
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

  console.log('=== Fix Mint Activity Platform ===');
  console.log(`Options: ${JSON.stringify(options)}`);

  try {
    // Extra registration filters (validated in parseArgs, safe to inline)
    const extraConditions: string[] = [];
    if (options.since !== undefined) {
      extraConditions.push(`r.registration_date >= '${options.since}'`);
    }
    if (options.referrer !== undefined) {
      extraConditions.push(`r.referrer = '${options.referrer}'`);
    }
    const extraSql = extraConditions.map((c) => ` AND ${c}`).join('');

    const referrerCase = buildReferrerCaseExpression();

    const countResult = await pool.query(`
      SELECT COUNT(*) as total
      FROM activity_history ah
      JOIN registrations r
        ON r.ens_name_id = ah.ens_name_id
        AND r.transaction_hash = ah.transaction_hash
      LEFT JOIN LATERAL (
        SELECT ${referrerCase} AS registration_source
      ) src ON true
      WHERE ah.event_type = 'mint'
        AND ah.platform = 'blockchain'
        AND src.registration_source IS NOT NULL${extraSql}
    `);

    const total = parseInt(countResult.rows[0].total, 10);
    console.log(`Found ${total} mint activity records stamped 'blockchain' with a now-known referrer`);

    if (options.dryRun) {
      console.log('Dry run — no records will be updated.');
      await closeAllConnections();
      return;
    }

    if (total === 0) {
      console.log('Nothing to fix.');
      await closeAllConnections();
      return;
    }

    const fixResult = await pool.query(`
      UPDATE activity_history ah
      SET platform = src.registration_source,
        metadata = COALESCE(ah.metadata, '{}'::jsonb) || jsonb_build_object(
          'referrer', r.referrer,
          'registration_source', src.registration_source
        )
      FROM registrations r
      LEFT JOIN LATERAL (
        SELECT ${referrerCase} AS registration_source
      ) src ON true
      WHERE ah.event_type = 'mint'
        AND ah.platform = 'blockchain'
        AND ah.ens_name_id = r.ens_name_id
        AND ah.transaction_hash = r.transaction_hash
        AND src.registration_source IS NOT NULL${extraSql}
    `);

    console.log(`Re-stamped platform on ${fixResult.rowCount ?? 0} mint activity records.`);
  } catch (error: any) {
    console.error('Fix failed:', error.message);
    process.exit(1);
  } finally {
    await closeAllConnections();
  }
}

main();
