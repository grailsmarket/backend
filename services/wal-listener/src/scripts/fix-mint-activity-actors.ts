/**
 * Fix Mint Activity Actors Script
 *
 * Finds mint activity records where the actor_address is the ETH Registrar Controller
 * (0x59e16fccd424cc24e280be16e11bcd56fb0ce547) and updates them to use the actual
 * transaction sender (tx.from) as the actor.
 *
 * Usage:
 *   npx tsx src/scripts/fix-mint-activity-actors.ts          # Check only (dry run)
 *   npx tsx src/scripts/fix-mint-activity-actors.ts --fix    # Check and fix
 */

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { config, getPostgresPool, closeAllConnections } from '../../../shared/src';

const FIX_MODE = process.argv.includes('--fix');
const BATCH_SIZE = 50; // Process in batches to avoid RPC rate limits

// Known controller addresses that should be replaced with actual tx.from
const CONTROLLER_ADDRESSES = [
  '0x59e16fccd424cc24e280be16e11bcd56fb0ce547', // Current ETH Registrar Controller
  '0x253553366da8546fc250f225fe3d25d0c782303b', // Old ETH Registrar Controller
];

interface MintActivity {
  id: number;
  ens_name_id: number;
  actor_address: string;
  transaction_hash: string;
  name?: string;
}

async function fixMintActivityActors() {
  console.log('=== Fix Mint Activity Actors ===\n');
  console.log(`Mode: ${FIX_MODE ? 'FIX (will update DB)' : 'CHECK ONLY (dry run)'}\n`);

  const pool = getPostgresPool();
  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  try {
    // Find all mint activities with controller as actor
    console.log('Finding mint activities with controller as actor...');

    const result = await pool.query<MintActivity>(`
      SELECT
        ah.id,
        ah.ens_name_id,
        ah.actor_address,
        ah.transaction_hash,
        en.name
      FROM activity_history ah
      LEFT JOIN ens_names en ON en.id = ah.ens_name_id
      WHERE ah.event_type = 'mint'
        AND ah.transaction_hash IS NOT NULL
        AND LOWER(ah.actor_address) = ANY($1)
      ORDER BY ah.id DESC
    `, [CONTROLLER_ADDRESSES]);

    const activities = result.rows;
    console.log(`Found ${activities.length} mint activities with controller as actor\n`);

    if (activities.length === 0) {
      console.log('No activities to fix.');
      return;
    }

    // Process in batches
    let processed = 0;
    let fixed = 0;
    let failed = 0;
    const fixes: Array<{ id: number; name: string; oldActor: string; newActor: string }> = [];

    for (let i = 0; i < activities.length; i += BATCH_SIZE) {
      const batch = activities.slice(i, i + BATCH_SIZE);

      for (const activity of batch) {
        try {
          // Fetch the transaction to get the actual sender
          const tx = await client.getTransaction({
            hash: activity.transaction_hash as `0x${string}`,
          });

          if (tx && tx.from) {
            const actualMinter = tx.from.toLowerCase();

            // Only fix if the actual minter is different from current actor
            if (actualMinter !== activity.actor_address.toLowerCase()) {
              fixes.push({
                id: activity.id,
                name: activity.name || `ID:${activity.ens_name_id}`,
                oldActor: activity.actor_address,
                newActor: actualMinter,
              });

              if (FIX_MODE) {
                await pool.query(
                  'UPDATE activity_history SET actor_address = $1 WHERE id = $2',
                  [actualMinter, activity.id]
                );
                fixed++;
              }
            }
          }
        } catch (error: any) {
          failed++;
          console.error(`  [FAILED] Activity ${activity.id} (${activity.name}): ${error.message}`);
        }

        processed++;
      }

      process.stdout.write(`\r  Processed ${processed} / ${activities.length}...`);

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < activities.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    console.log('\n');

    // Report results
    console.log('=== Results ===\n');
    console.log(`Total mint activities with controller: ${activities.length}`);
    console.log(`Activities that need fixing:           ${fixes.length}`);
    console.log(`Failed to process:                     ${failed}`);

    if (fixes.length > 0) {
      console.log('\n=== Fixes (first 30) ===\n');

      for (const fix of fixes.slice(0, 30)) {
        console.log(`${fix.name}`);
        console.log(`  Activity ID: ${fix.id}`);
        console.log(`  Old actor: ${fix.oldActor}`);
        console.log(`  New actor: ${fix.newActor}`);
        console.log('');
      }

      if (fixes.length > 30) {
        console.log(`... and ${fixes.length - 30} more\n`);
      }
    }

    if (FIX_MODE) {
      console.log(`\n=== Fix Summary ===`);
      console.log(`Fixed:  ${fixed}`);
      console.log(`Failed: ${failed}`);
    } else {
      console.log('\n=== To fix these records, run with --fix flag ===');
      console.log('npx tsx src/scripts/fix-mint-activity-actors.ts --fix\n');
    }

  } catch (error) {
    console.error('Error during processing:', error);
  } finally {
    await closeAllConnections();
  }
}

fixMintActivityActors();
