/**
 * Fix Transfer Event Timestamps
 *
 * Deletes and re-creates sent/received/burn activity events with correct blockchain timestamps.
 * The existing ~400k events have incorrect created_at dates (database insertion time instead
 * of blockchain event time).
 *
 * This script:
 * 1. Deletes all existing sent/received/burn events from activity_history
 * 2. Re-creates them from the transactions table which has correct blockchain timestamps
 *
 * Usage:
 *   npm run script:fix-transfer-timestamps
 *
 * Safety:
 *   - Runs in a transaction (can be rolled back if something goes wrong)
 *   - Provides statistics and confirmation prompt
 *   - Can be run multiple times safely (idempotent)
 */

import { getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';
import * as readline from 'readline';

const pool = getPostgresPool();

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

interface Stats {
  deletedEvents: number;
  createdSent: number;
  createdReceived: number;
  createdBurn: number;
  skippedMints: number;
  errors: number;
}

async function confirmAction(message: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(`${message} (yes/no): `, (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'yes' || answer.toLowerCase() === 'y');
    });
  });
}

async function main() {
  logger.info('Starting transfer event timestamp fix...');

  const stats: Stats = {
    deletedEvents: 0,
    createdSent: 0,
    createdReceived: 0,
    createdBurn: 0,
    skippedMints: 0,
    errors: 0,
  };

  try {
    // ============================================================================
    // Step 1: Get current state statistics
    // ============================================================================
    logger.info('Analyzing current activity_history data...');

    const countResult = await pool.query(`
      SELECT
        event_type,
        COUNT(*) as count,
        MIN(created_at) as earliest,
        MAX(created_at) as latest
      FROM activity_history
      WHERE event_type IN ('sent', 'received', 'burn')
      GROUP BY event_type
      ORDER BY event_type
    `);

    console.log('\n========================================');
    console.log('Current Transfer Events in Database');
    console.log('========================================');
    for (const row of countResult.rows) {
      console.log(`${row.event_type.toUpperCase()}: ${row.count} events`);
      console.log(`  Earliest: ${row.earliest}`);
      console.log(`  Latest: ${row.latest}`);
    }

    const totalToDelete = countResult.rows.reduce((sum, row) => sum + parseInt(row.count), 0);
    console.log(`\nTotal events to delete: ${totalToDelete}`);

    // Get transaction count to re-create from
    const txCountResult = await pool.query(`
      SELECT
        transaction_type,
        COUNT(*) as count
      FROM transactions
      WHERE transaction_type IN ('transfer', 'renewal')
      GROUP BY transaction_type
    `);

    console.log('\n========================================');
    console.log('Transactions Available for Backfill');
    console.log('========================================');
    for (const row of txCountResult.rows) {
      console.log(`${row.transaction_type.toUpperCase()}: ${row.count} transactions`);
    }
    console.log('========================================\n');

    // ============================================================================
    // Step 2: Confirm action
    // ============================================================================
    const confirmed = await confirmAction(
      `\nThis will DELETE ${totalToDelete} events and re-create them. Continue?`
    );

    if (!confirmed) {
      console.log('Operation cancelled by user.');
      process.exit(0);
    }

    // ============================================================================
    // Step 3: Begin transaction
    // ============================================================================
    const client = await pool.connect();

    try {
      await client.query('BEGIN');
      logger.info('Transaction started');

      // ============================================================================
      // Step 4: Delete existing transfer events
      // ============================================================================
      logger.info('Deleting existing sent/received/burn events...');

      const deleteResult = await client.query(`
        DELETE FROM activity_history
        WHERE event_type IN ('sent', 'received', 'burn')
      `);

      stats.deletedEvents = deleteResult.rowCount || 0;
      logger.info({ count: stats.deletedEvents }, 'Deleted transfer events');

      // ============================================================================
      // Step 5: Re-create events from transactions table
      // ============================================================================
      logger.info('Re-creating transfer events from transactions table...');

      // Fetch all transfer transactions with proper timestamps
      const transfersResult = await client.query(`
        SELECT
          t.ens_name_id,
          t.from_address,
          t.to_address,
          t.transaction_hash,
          t.block_number,
          t.timestamp as event_timestamp,
          e.token_id
        FROM transactions t
        JOIN ens_names e ON e.id = t.ens_name_id
        WHERE t.transaction_type = 'transfer'
        ORDER BY t.timestamp ASC
      `);

      logger.info({ count: transfersResult.rows.length }, 'Found transfer transactions');

      // Process in batches to avoid memory issues
      const BATCH_SIZE = 1000;
      for (let i = 0; i < transfersResult.rows.length; i += BATCH_SIZE) {
        const batch = transfersResult.rows.slice(i, i + BATCH_SIZE);

        for (const tx of batch) {
          const from = tx.from_address?.toLowerCase();
          const to = tx.to_address?.toLowerCase();

          // Skip if addresses are missing
          if (!from || !to) {
            stats.errors++;
            continue;
          }

          try {
            // Determine event types based on from/to addresses
            const isMint = from === ZERO_ADDRESS.toLowerCase();
            const isBurn = to === ZERO_ADDRESS.toLowerCase();

            if (isMint) {
              // Skip mints - they're handled separately by the indexer
              stats.skippedMints++;
              continue;
            }

            if (isBurn) {
              // Create burn event
              await client.query(
                `INSERT INTO activity_history (
                  ens_name_id, event_type, actor_address, counterparty_address,
                  platform, chain_id, transaction_hash, block_number,
                  metadata, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT DO NOTHING`,
                [
                  tx.ens_name_id,
                  'burn',
                  from,
                  null,
                  'blockchain',
                  1,
                  tx.transaction_hash,
                  tx.block_number,
                  JSON.stringify({ token_id: tx.token_id, to_address: ZERO_ADDRESS }),
                  tx.event_timestamp
                ]
              );
              stats.createdBurn++;
            } else {
              // Create sent event for sender
              await client.query(
                `INSERT INTO activity_history (
                  ens_name_id, event_type, actor_address, counterparty_address,
                  platform, chain_id, transaction_hash, block_number,
                  metadata, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT DO NOTHING`,
                [
                  tx.ens_name_id,
                  'sent',
                  from,
                  to,
                  'blockchain',
                  1,
                  tx.transaction_hash,
                  tx.block_number,
                  JSON.stringify({ token_id: tx.token_id, role: 'sender' }),
                  tx.event_timestamp
                ]
              );
              stats.createdSent++;

              // Create received event for recipient
              await client.query(
                `INSERT INTO activity_history (
                  ens_name_id, event_type, actor_address, counterparty_address,
                  platform, chain_id, transaction_hash, block_number,
                  metadata, created_at
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                ON CONFLICT DO NOTHING`,
                [
                  tx.ens_name_id,
                  'received',
                  to,
                  from,
                  'blockchain',
                  1,
                  tx.transaction_hash,
                  tx.block_number,
                  JSON.stringify({ token_id: tx.token_id, role: 'recipient' }),
                  tx.event_timestamp
                ]
              );
              stats.createdReceived++;
            }
          } catch (error: any) {
            logger.error({ error: error.message, tx }, 'Error creating activity record');
            stats.errors++;
          }
        }

        const progress = Math.min(i + BATCH_SIZE, transfersResult.rows.length);
        logger.info({
          progress,
          total: transfersResult.rows.length,
          percent: Math.round((progress / transfersResult.rows.length) * 100)
        }, 'Re-creation progress');
      }

      // ============================================================================
      // Step 6: Commit transaction
      // ============================================================================
      await client.query('COMMIT');
      logger.info('Transaction committed successfully');

      console.log('\n========================================');
      console.log('Transfer Event Fix Complete!');
      console.log('========================================');
      console.log(`Events deleted:      ${stats.deletedEvents}`);
      console.log(`Sent events created: ${stats.createdSent}`);
      console.log(`Received events:     ${stats.createdReceived}`);
      console.log(`Burn events:         ${stats.createdBurn}`);
      console.log(`Mints skipped:       ${stats.skippedMints}`);
      console.log(`Errors:              ${stats.errors}`);
      console.log('========================================\n');

      process.exit(0);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error({ error }, 'Transaction rolled back due to error');
      throw error;
    } finally {
      client.release();
    }

  } catch (error: any) {
    logger.error({ error: error.message, stack: error.stack }, 'Fix failed');
    console.error('\n❌ Transfer event fix failed:', error.message);
    process.exit(1);
  }
}

// Handle script termination
process.on('SIGINT', () => {
  logger.info('Transfer event fix interrupted by user');
  console.log('\n\n⚠️  Transfer event fix interrupted');
  process.exit(130);
});

process.on('SIGTERM', () => {
  logger.info('Transfer event fix terminated');
  console.log('\n\n⚠️  Transfer event fix terminated');
  process.exit(143);
});

// Run the script
main().catch((error) => {
  logger.error({ error }, 'Fatal error in transfer event fix');
  console.error('Fatal error:', error);
  process.exit(1);
});
