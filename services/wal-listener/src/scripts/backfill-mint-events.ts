#!/usr/bin/env tsx
/**
 * Backfill Mint Events - Phase 1
 *
 * This script:
 * 1. Updates existing mint events with correct blockchain timestamps and cost data
 * 2. Inserts missing mint events for ENS names that don't have them
 *
 * Data source: The Graph ENS Subgraph
 * URL: ensnode-api-production-500f.up.railway.app/subgraph
 *
 * Usage:
 *   npx tsx src/scripts/backfill-mint-events.ts [--resume] [--dry-run] [--missing-cost-only]
 *
 * Options:
 *   --missing-cost-only  Only update existing mint events that are missing cost
 *                        (price_wei IS NULL), and skip the insert phase. Use this to
 *                        repair just the broken mints instead of re-querying The Graph
 *                        for every mint event.
 */

import { getPostgresPool, closeAllConnections } from '../../../shared/src';
import * as fs from 'fs/promises';
import * as path from 'path';

const pool = getPostgresPool();
const GRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const DB_BATCH_SIZE = 50; // Fetch 50 records from DB at a time
const DELAY_MS = 2000; // 5 seconds between batches
const PROGRESS_FILE = path.join(process.cwd(), 'backfill-mint-progress.json');

interface Progress {
  phase: 'update' | 'insert' | 'completed';
  lastProcessedId: number;
  totalProcessed: number;
  updated: number;
  inserted: number;
  skipped: number;
  errors: Array<{ id: number; name: string; error: string }>;
  startTime: string;
  lastUpdateTime: string;
}

interface Domain {
  name: string;
  labelName: string;
  labelhash: string;
  parent: {
    id: string;
  };
  registration: {
    id: string;
    registrant: {
      id: string;
    };
    registrationDate: string;
    expiryDate: string;
    cost: string;
    events: Array<{
      id: string;
      transactionID: string;
      blockNumber: string;
    }>;
  };
}

interface GraphQLResponse {
  data?: {
    domains?: Domain[];
  };
  errors?: Array<{ message: string }>;
}

// GraphQL query for batch fetching registrations by name
const BATCH_REGISTRATION_QUERY = `
  query GetRegistrations($names: [String!]!) {
    domains(
      where: {
        name_in: $names
      }
      first: 1000
    ) {
      name
      labelName
      labelhash
      parent {
        id
      }
      registration {
        id
        registrant {
          id
        }
        registrationDate
        expiryDate
        cost
        events {
          id
          transactionID
          blockNumber
        }
      }
    }
  }
`;

async function queryTheGraph(names: string[]): Promise<Domain[]> {
  try {
    const response = await fetch(GRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: BATCH_REGISTRATION_QUERY,
        variables: { names }
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json() as GraphQLResponse;

    if (result.errors) {
      throw new Error(`GraphQL errors: ${JSON.stringify(result.errors)}`);
    }

    return result.data?.domains || [];
  } catch (error: any) {
    console.error('❌ The Graph query failed:', error.message);
    // Return empty array instead of throwing - let the processing continue
    return [];
  }
}

async function loadProgress(): Promise<Progress | null> {
  try {
    const data = await fs.readFile(PROGRESS_FILE, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    return null;
  }
}

async function saveProgress(progress: Progress): Promise<void> {
  progress.lastUpdateTime = new Date().toISOString();
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

async function updateExistingMintEvents(progress: Progress, dryRun: boolean, missingCostOnly: boolean): Promise<void> {
  console.log('\n📝 Phase 1: Updating Existing Mint Events\n');
  console.log('Processing mint events in batches (cursor-based)...\n');
  if (missingCostOnly) {
    console.log('🔎 Filter: only mint events missing cost data (price_wei IS NULL)\n');
  }

  let processedCount = 0;
  let lastProcessedActivityId = progress.lastProcessedId;
  let hasMore = true;

  while (hasMore) {
    // Fetch one batch from database using cursor (WHERE id > lastId)
    const mintEventsQuery = `
      SELECT
        ah.id,
        ah.ens_name_id,
        ah.metadata,
        en.name,
        en.token_id
      FROM activity_history ah
      JOIN ens_names en ON en.id = ah.ens_name_id
      WHERE ah.event_type = 'mint'
        AND ah.id > $1
        ${missingCostOnly ? 'AND ah.price_wei IS NULL' : ''}
        AND en.name NOT LIKE '#%'
        AND en.name NOT LIKE '%.%.eth'
      ORDER BY ah.id
      LIMIT $2
    `;

    const result = await pool.query(mintEventsQuery, [lastProcessedActivityId, DB_BATCH_SIZE]);

    if (result.rows.length === 0) break;

    // Collect names for batch Graph query
    const names = result.rows.map(row => row.name);

    // Query The Graph for all domains in this batch at once
    const domains = await queryTheGraph(names);
    const domainMap = new Map(
      domains.map(domain => [domain.name.toLowerCase(), domain])
    );

    // Process each record in this DB batch
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];

      try {
        // Lookup by name
        const domain = domainMap.get(row.name.toLowerCase());

        if (!domain || !domain.registration) {
          console.log(`  ⚠️  No registration found for ${row.name} (${row.token_id})`);
          progress.skipped++;
          progress.lastProcessedId = row.id;
          continue;
        }

        // Extract transaction data from events
        const event = domain.registration.events?.[0];
        if (!event) {
          console.log(`  ⚠️  No event data for ${row.name}`);
          progress.skipped++;
          progress.lastProcessedId = row.id;
          continue;
        }

        const registrationDate = new Date(parseInt(domain.registration.registrationDate) * 1000);
        const metadata = {
          ...(row.metadata || {}),
          token_id: row.token_id,
          cost: domain.registration.cost,
          from_address: '0x0000000000000000000000000000000000000000',
          labelhash: domain.labelhash
        };

        if (dryRun) {
          console.log(`  [DRY RUN] Would update ${row.name}:`);
          console.log(`    Timestamp: ${registrationDate.toISOString()}`);
          console.log(`    TX: ${event.transactionID}`);
          console.log(`    Block: ${event.blockNumber}`);
          console.log(`    Cost: ${domain.registration.cost} wei`);
        } else {
          await pool.query(`
            UPDATE activity_history
            SET
              created_at = $1,
              -- Only set tx hash / block when the row doesn't already have one. The Graph's
              -- events[0] isn't guaranteed to be the registration event, so we must not clobber a
              -- transaction_hash that the indexer already recorded. block_number is paired with the
              -- tx hash so it only moves together with it.
              transaction_hash = COALESCE(transaction_hash, $2),
              block_number = CASE WHEN transaction_hash IS NULL THEN $3 ELSE block_number END,
              metadata = $4,
              price_wei = $5,
              currency_address = $6
            WHERE id = $7
          `, [
            registrationDate,
            event.transactionID,
            parseInt(event.blockNumber),
            JSON.stringify(metadata),
            domain.registration.cost,
            '0x0000000000000000000000000000000000000000',
            row.id
          ]);

          console.log(`  ✅ Updated ${row.name} (cost: ${(parseFloat(domain.registration.cost) / 1e18).toFixed(4)} ETH)`);
        }

        progress.updated++;
        progress.totalProcessed++;
        progress.lastProcessedId = row.id;
        lastProcessedActivityId = row.id;
        processedCount++;

        console.log(`  ✅ Updated ${row.name} (processed: ${processedCount})`);

      } catch (error: any) {
        console.error(`  ❌ Error processing ${row.name}:`, error.message);
        progress.errors.push({
          id: row.id,
          name: row.name,
          error: error.message
        });
        progress.skipped++;
        progress.lastProcessedId = row.id;
        lastProcessedActivityId = row.id;
        processedCount++;
      }
    }

    // Check if there are more records
    hasMore = result.rows.length === DB_BATCH_SIZE;

    // Save progress after each batch
    await saveProgress(progress);

    // Delay 5 seconds after completing this batch before starting the next one
    if (hasMore) {
      console.log(`\n⏳ Waiting 5 seconds before next batch...\n`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(`\n✅ Phase 1 complete: Updated ${progress.updated} mint events\n`);
  // In missing-cost-only mode we only repair existing mints that lack a price; skip the insert
  // phase (which scans every ENS name for entirely-missing mints).
  progress.phase = missingCostOnly ? 'completed' : 'insert';
  progress.lastProcessedId = 0;
  await saveProgress(progress);
}

async function insertMissingMintEvents(progress: Progress, dryRun: boolean): Promise<void> {
  console.log('\n📝 Phase 2: Inserting Missing Mint Events\n');
  console.log('Processing ENS names in batches (cursor-based)...\n');

  let processedCount = 0;
  let lastProcessedEnsId = progress.lastProcessedId;
  let hasMore = true;

  while (hasMore) {
    // Fetch one batch from database using cursor (WHERE id > lastId)
    const missingMintsQuery = `
      SELECT
        en.id,
        en.name,
        en.token_id,
        en.owner_address
      FROM ens_names en
      LEFT JOIN activity_history ah ON ah.ens_name_id = en.id AND ah.event_type = 'mint'
      WHERE ah.id IS NULL
        AND en.id > $1
        AND en.token_id IS NOT NULL
        AND en.name NOT LIKE '#%'
        AND en.name NOT LIKE '%.%.eth'
      ORDER BY en.id
      LIMIT $2
    `;

    const result = await pool.query(missingMintsQuery, [lastProcessedEnsId, DB_BATCH_SIZE]);

    if (result.rows.length === 0) break;

    // Collect names for batch Graph query
    const names = result.rows.map(row => row.name);

    // Query The Graph for all domains in this batch at once
    const domains = await queryTheGraph(names);
    const domainMap = new Map(
      domains.map(domain => [domain.name.toLowerCase(), domain])
    );

    // Process each record in this DB batch
    for (let i = 0; i < result.rows.length; i++) {
      const row = result.rows[i];

      try {
        // Lookup by name
        const domain = domainMap.get(row.name.toLowerCase());

        if (!domain || !domain.registration) {
          console.log(`  ⚠️  No registration found for ${row.name} (${row.token_id})`);
          progress.skipped++;
          progress.lastProcessedId = row.id;
          continue;
        }

        // Extract transaction data from events
        const event = domain.registration.events?.[0];
        if (!event) {
          console.log(`  ⚠️  No event data for ${row.name}`);
          progress.skipped++;
          progress.lastProcessedId = row.id;
          continue;
        }

        const registrationDate = new Date(parseInt(domain.registration.registrationDate) * 1000);
        const metadata = {
          token_id: row.token_id,
          cost: domain.registration.cost,
          from_address: '0x0000000000000000000000000000000000000000',
          labelhash: domain.labelhash
        };

        if (dryRun) {
          console.log(`  [DRY RUN] Would insert mint event for ${row.name}:`);
          console.log(`    Registrant: ${domain.registration.registrant.id}`);
          console.log(`    Timestamp: ${registrationDate.toISOString()}`);
          console.log(`    TX: ${event.transactionID}`);
          console.log(`    Block: ${event.blockNumber}`);
          console.log(`    Cost: ${domain.registration.cost} wei`);
        } else {
          await pool.query(`
            INSERT INTO activity_history (
              ens_name_id,
              event_type,
              actor_address,
              counterparty_address,
              platform,
              chain_id,
              transaction_hash,
              block_number,
              metadata,
              created_at,
              price_wei,
              currency_address
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          `, [
            row.id,
            'mint',
            domain.registration.registrant.id.toLowerCase(),
            null,
            'blockchain',
            1,
            event.transactionID,
            parseInt(event.blockNumber),
            JSON.stringify(metadata),
            registrationDate,
            domain.registration.cost,
            '0x0000000000000000000000000000000000000000'
          ]);

          console.log(`  ✅ Inserted mint event for ${row.name} (cost: ${(parseFloat(domain.registration.cost) / 1e18).toFixed(4)} ETH)`);
        }

        progress.inserted++;
        progress.totalProcessed++;
        progress.lastProcessedId = row.id;
        lastProcessedEnsId = row.id;
        processedCount++;

        console.log(`  ✅ Inserted ${row.name} (processed: ${processedCount})`);

      } catch (error: any) {
        console.error(`  ❌ Error processing ${row.name}:`, error.message);
        progress.errors.push({
          id: row.id,
          name: row.name,
          error: error.message
        });
        progress.skipped++;
        progress.lastProcessedId = row.id;
        lastProcessedEnsId = row.id;
        processedCount++;
      }
    }

    // Check if there are more records
    hasMore = result.rows.length === DB_BATCH_SIZE;

    // Save progress after each batch
    await saveProgress(progress);

    // Delay 5 seconds after completing this batch before starting the next one
    if (hasMore) {
      console.log(`\n⏳ Waiting 5 seconds before next batch...\n`);
      await new Promise(resolve => setTimeout(resolve, DELAY_MS));
    }
  }

  console.log(`\n✅ Phase 2 complete: Inserted ${progress.inserted} mint events\n`);
  progress.phase = 'completed';
  await saveProgress(progress);
}

async function main() {
  const args = process.argv.slice(2);
  const shouldResume = args.includes('--resume');
  const dryRun = args.includes('--dry-run');
  const missingCostOnly = args.includes('--missing-cost-only');

  console.log('🔄 Backfilling Mint Events from The Graph\n');

  if (dryRun) {
    console.log('⚠️  DRY RUN MODE - No changes will be made\n');
  }

  if (missingCostOnly) {
    console.log('🎯 MISSING-COST-ONLY MODE - Only repairing mints with no price; insert phase skipped\n');
  }

  try {
    // Load or create progress
    let progress = shouldResume ? await loadProgress() : null;

    if (progress && shouldResume) {
      console.log(`📂 Resuming from saved progress:`);
      console.log(`   Phase: ${progress.phase}`);
      console.log(`   Last ID: ${progress.lastProcessedId}`);
      console.log(`   Updated: ${progress.updated}`);
      console.log(`   Inserted: ${progress.inserted}`);
      console.log(`   Skipped: ${progress.skipped}`);
      console.log(`   Errors: ${progress.errors.length}\n`);
    } else {
      progress = {
        phase: 'update',
        lastProcessedId: 0,
        totalProcessed: 0,
        updated: 0,
        inserted: 0,
        skipped: 0,
        errors: [],
        startTime: new Date().toISOString(),
        lastUpdateTime: new Date().toISOString()
      };
      await saveProgress(progress);
      console.log('📝 Starting fresh backfill process\n');
    }

    // In missing-cost-only mode the update phase IS the entire job. If a prior (full) run left
    // saved progress in the 'insert' or 'completed' phase, a plain --resume would skip the update
    // block (wrong phase) and the insert block (missingCostOnly), then exit as a silent no-op that
    // looks successful. Force the update phase to run from the start instead.
    if (missingCostOnly && progress.phase !== 'update') {
      console.warn(`⚠️  Saved progress is in '${progress.phase}' phase; resetting to 'update' for the missing-cost-only repair.\n`);
      progress.phase = 'update';
      progress.lastProcessedId = 0;
      await saveProgress(progress);
    }

    // Execute phases
    if (progress.phase === 'update') {
      await updateExistingMintEvents(progress, dryRun, missingCostOnly);
    }

    if (progress.phase === 'insert' && !missingCostOnly) {
      await insertMissingMintEvents(progress, dryRun);
    }

    // Final summary
    console.log('═══════════════════════════════════════════════');
    console.log('✨ Backfill Complete!');
    console.log('═══════════════════════════════════════════════');
    console.log(`Total Processed: ${progress.totalProcessed}`);
    console.log(`Updated: ${progress.updated}`);
    console.log(`Inserted: ${progress.inserted}`);
    console.log(`Skipped: ${progress.skipped}`);
    console.log(`Errors: ${progress.errors.length}`);
    console.log(`Duration: ${Math.floor((new Date().getTime() - new Date(progress.startTime).getTime()) / 1000)}s`);
    console.log('═══════════════════════════════════════════════\n');

    if (progress.errors.length > 0) {
      console.log('⚠️  Errors encountered:');
      progress.errors.slice(0, 10).forEach(err => {
        console.log(`   ${err.name} (ID: ${err.id}): ${err.error}`);
      });
      if (progress.errors.length > 10) {
        console.log(`   ... and ${progress.errors.length - 10} more errors`);
      }
      console.log(`\nSee ${PROGRESS_FILE} for complete error list\n`);
    }

    await closeAllConnections();
    process.exit(0);
  } catch (error: any) {
    console.error('💥 Fatal error:', error.message);
    console.error(error.stack);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
