/**
 * Repair script for ENS names where the Name Wrapper contract was incorrectly
 * stored as the owner_address.
 *
 * For each affected name, queries the Name Wrapper contract on-chain to get the
 * real owner, updates owner_address and registrant, and reactivates any listings
 * that were incorrectly marked as unfunded.
 *
 * Usage:
 *   npm run repair-wrapper-owners
 *   npm run repair-wrapper-owners -- --dry-run
 */

import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { namehash } from 'viem/ens';
import { config, getPostgresPool } from '../../../shared/src';

const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

const NAME_WRAPPER_ABI = [
  {
    inputs: [{ name: 'id', type: 'uint256' }],
    name: 'ownerOf',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

const DRY_RUN = process.argv.includes('--dry-run');

const client = createPublicClient({
  chain: mainnet,
  transport: http(config.blockchain.rpcUrl),
});

async function getWrappedNameOwner(ensName: string): Promise<string | null> {
  if (!ensName || !ensName.endsWith('.eth') || ensName.startsWith('token-')) {
    return null;
  }

  try {
    const node = namehash(ensName);
    const owner = await client.readContract({
      address: NAME_WRAPPER_ADDRESS as `0x${string}`,
      abi: NAME_WRAPPER_ABI,
      functionName: 'ownerOf',
      args: [BigInt(node)],
    });

    if (!owner || owner === '0x0000000000000000000000000000000000000000') {
      return null;
    }

    return owner.toLowerCase();
  } catch {
    return null;
  }
}

async function main() {
  const pool = getPostgresPool();

  console.log('='.repeat(70));
  console.log('Repair: Name Wrapper Stored as Owner');
  console.log('='.repeat(70));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log();

  // Find all names where owner_address is the Name Wrapper contract
  const result = await pool.query(
    `SELECT id, name, owner_address, registrant
     FROM ens_names
     WHERE owner_address = $1
     ORDER BY name`,
    [NAME_WRAPPER_ADDRESS]
  );

  console.log(`Found ${result.rows.length} names with Name Wrapper as owner`);
  console.log();

  if (result.rows.length === 0) {
    console.log('Nothing to fix!');
    await pool.end();
    return;
  }

  let fixedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;
  let listingsReactivated = 0;

  for (const row of result.rows) {
    const { id, name } = row;

    // Query the Name Wrapper contract for the real owner
    const realOwner = await getWrappedNameOwner(name);

    if (!realOwner) {
      console.log(`  SKIP: ${name} — could not resolve real owner from contract`);
      skippedCount++;
      continue;
    }

    if (realOwner === NAME_WRAPPER_ADDRESS) {
      console.log(`  SKIP: ${name} — contract returned Name Wrapper as owner (unexpected)`);
      skippedCount++;
      continue;
    }

    console.log(`  FIX: ${name} — ${NAME_WRAPPER_ADDRESS} -> ${realOwner}`);

    if (!DRY_RUN) {
      try {
        // Update owner_address and registrant
        await pool.query(
          `UPDATE ens_names
           SET owner_address = $1,
               registrant = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [realOwner, id]
        );

        // Reactivate listings that were incorrectly unfunded due to the wrong owner
        const reactivated = await pool.query(
          `UPDATE listings
           SET status = 'active',
               unfunded_at = NULL,
               unfunded_reason = NULL,
               last_validated_at = NOW(),
               updated_at = NOW()
           WHERE ens_name_id = $1
             AND status = 'unfunded'
             AND unfunded_reason = 'ownership_lost'
             AND seller_address = $2
           RETURNING id`,
          [id, realOwner]
        );

        if (reactivated.rows.length > 0) {
          console.log(`    Reactivated ${reactivated.rows.length} listing(s)`);
          listingsReactivated += reactivated.rows.length;
        }

        fixedCount++;
      } catch (err: any) {
        console.error(`    ERROR: ${err.message}`);
        errorCount++;
      }
    } else {
      fixedCount++;
    }

    // Rate limit RPC calls
    await new Promise(r => setTimeout(r, 100));
  }

  console.log();
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`Total affected: ${result.rows.length}`);
  console.log(`Fixed: ${fixedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);
  console.log(`Listings reactivated: ${listingsReactivated}`);
  if (DRY_RUN) console.log('DRY RUN — no changes made');

  await pool.end();
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
