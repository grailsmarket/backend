#!/usr/bin/env node

/**
 * Backfill Highest Offers Script
 *
 * This script recalculates the highest active offer for all ENS names
 * that have pending offers. It publishes jobs to the highest-offer worker
 * queue for asynchronous processing.
 *
 * Usage:
 *   ts-node src/scripts/backfill-highest-offers.ts
 *
 * Environment variables required:
 *   DATABASE_URL - PostgreSQL connection string
 */

import { getPostgresPool } from '../../../shared/src';
import PgBoss from 'pg-boss';

interface ENSNameWithOffers {
  id: number;
  name: string;
  offer_count: number;
}

async function main() {
  console.log('Starting highest offers backfill...\n');

  const pool = getPostgresPool();
  let boss: PgBoss | null = null;

  try {
    // Initialize pg-boss
    console.log('Connecting to job queue...');
    boss = new PgBoss({
      connectionString: process.env.DATABASE_URL,
    });

    await boss.start();
    console.log('✓ Connected to job queue\n');

    // Get all ENS names that have active offers
    console.log('Fetching ENS names with active offers...');
    const result = await pool.query<ENSNameWithOffers>(`
      SELECT
        en.id,
        en.name,
        COUNT(o.id) as offer_count
      FROM ens_names en
      JOIN offers o ON o.ens_name_id = en.id
      WHERE o.status = 'pending'
        AND (o.currency_address = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' OR o.currency_address = '0x0000000000000000000000000000000000000000')
        AND (o.expires_at IS NULL OR o.expires_at > NOW())
      GROUP BY en.id, en.name
      ORDER BY offer_count DESC, en.name ASC
    `);

    const ensNames = result.rows;
    console.log(`✓ Found ${ensNames.length} ENS names with active offers\n`);

    if (ensNames.length === 0) {
      console.log('No ENS names with active offers found. Exiting.');
      return;
    }

    // Publish recalculation jobs for each ENS name
    console.log('Publishing recalculation jobs...');
    let jobsPublished = 0;

    for (const ensName of ensNames) {
      try {
        await boss.send('recalculate-highest-offer', {
          ensNameId: ensName.id,
        });
        jobsPublished++;
        process.stdout.write(`\r  Published ${jobsPublished}/${ensNames.length} jobs...`);
      } catch (error) {
        console.error(`\n✗ Failed to publish job for ENS name "${ensName.name}" (ID: ${ensName.id}):`, error);
      }
    }

    console.log(`\n✓ Successfully published ${jobsPublished} recalculation jobs\n`);

    // Display summary
    console.log('Backfill Summary:');
    console.log('─────────────────────────────────────');
    console.log(`ENS names with offers: ${ensNames.length}`);
    console.log(`Jobs published:        ${jobsPublished}`);
    console.log(`Failed jobs:           ${ensNames.length - jobsPublished}`);
    console.log('─────────────────────────────────────\n');

    if (ensNames.length > 0) {
      console.log('Top 10 ENS names by offer count:');
      ensNames.slice(0, 10).forEach((ensName, index) => {
        console.log(`  ${(index + 1).toString().padStart(2)}. ${ensName.name.padEnd(30)} - ${ensName.offer_count} active offers`);
      });
      console.log();
    }

    console.log('Jobs have been queued for processing.');
    console.log('Monitor worker logs to track progress.');
    console.log('Highest offers will be calculated asynchronously.\n');

  } catch (error) {
    console.error('\n✗ Backfill failed with error:', error);
    process.exit(1);
  } finally {
    // Cleanup
    if (boss) {
      await boss.stop();
      console.log('✓ Disconnected from job queue');
    }
    await pool.end();
    console.log('✓ Database connection closed\n');
  }
}

// Run the script
main()
  .then(() => {
    console.log('Backfill script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
