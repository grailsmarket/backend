#!/usr/bin/env node

/**
 * Backfill Club Statistics Script
 *
 * This script recalculates all club statistics (floor price, sales count, sales volume)
 * for all clubs in the database. It publishes jobs to the club-stats worker queue
 * for asynchronous processing.
 *
 * Usage:
 *   ts-node src/scripts/backfill-club-stats.ts
 *
 * Environment variables required:
 *   DATABASE_URL - PostgreSQL connection string
 */

import { getPostgresPool } from '../../../shared/src';
import PgBoss from 'pg-boss';

interface Club {
  name: string;
  member_count: number;
}

async function main() {
  console.log('Starting club stats backfill...\n');

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

    // Get all clubs
    console.log('Fetching clubs from database...');
    const result = await pool.query<Club>(`
      SELECT name, member_count
      FROM clubs
      ORDER BY member_count DESC, name ASC
    `);

    const clubs = result.rows;
    console.log(`✓ Found ${clubs.length} clubs\n`);

    if (clubs.length === 0) {
      console.log('No clubs found. Exiting.');
      return;
    }

    // Publish recalculation jobs for each club
    console.log('Publishing recalculation jobs...');
    let jobsPublished = 0;

    for (const club of clubs) {
      try {
        await boss.send('recalculate-club-stats', {
          clubName: club.name,
        });
        jobsPublished++;
        process.stdout.write(`\r  Published ${jobsPublished}/${clubs.length} jobs...`);
      } catch (error) {
        console.error(`\n✗ Failed to publish job for club "${club.name}":`, error);
      }
    }

    console.log(`\n✓ Successfully published ${jobsPublished} recalculation jobs\n`);

    // Display summary
    console.log('Backfill Summary:');
    console.log('─────────────────────────────────────');
    console.log(`Total clubs:          ${clubs.length}`);
    console.log(`Jobs published:       ${jobsPublished}`);
    console.log(`Failed jobs:          ${clubs.length - jobsPublished}`);
    console.log('─────────────────────────────────────\n');

    if (clubs.length > 0) {
      console.log('Top 10 clubs by member count:');
      clubs.slice(0, 10).forEach((club, index) => {
        console.log(`  ${(index + 1).toString().padStart(2)}. ${club.name.padEnd(20)} - ${club.member_count} members`);
      });
      console.log();
    }

    console.log('Jobs have been queued for processing.');
    console.log('Monitor worker logs to track progress.');
    console.log('Statistics will be calculated asynchronously.\n');

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
