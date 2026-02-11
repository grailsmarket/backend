#!/usr/bin/env tsx
/**
 * Sync POAP Claim Status with On-Chain Reality
 *
 * This script checks all POAP links in the database against POAP's API
 * to ensure our `claimed` status matches actual on-chain state.
 *
 * Use cases:
 * - User was assigned a link but claimed it to a different wallet
 * - Database got out of sync for any reason
 * - Periodic maintenance to ensure data integrity
 *
 * Usage:
 *   npx tsx src/scripts/sync-poap-status.ts [options]
 *
 * Options:
 *   --dry-run       Preview changes without modifying the database
 *   --all           Check ALL links (including ones already marked claimed)
 *   --verbose       Show detailed logging for each link
 *   --batch-size=N  Number of links per batch (default: 50)
 */

import { getPostgresPool, closeAllConnections, config } from '../../../shared/src';

const pool = getPostgresPool();
const DELAY_MS = 200; // Delay between API calls to avoid rate limiting

interface PoapLink {
  id: number;
  link: string;
  claimed: boolean;
  claimant_id: number | null;
}

interface ClaimQrResponse {
  claimed: boolean;
  event?: {
    id: number;
    name: string;
  };
  beneficiary?: string;
  token_id?: number;
  error?: string;
}

function parseArgs(): { dryRun: boolean; checkAll: boolean; verbose: boolean; batchSize: number } {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const checkAll = args.includes('--all');
  const verbose = args.includes('--verbose');

  let batchSize = 50;
  const batchArg = args.find(arg => arg.startsWith('--batch-size='));
  if (batchArg) {
    const parsed = parseInt(batchArg.split('=')[1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      batchSize = parsed;
    }
  }

  return { dryRun, checkAll, verbose, batchSize };
}

/**
 * Extract the mint secret from a POAP URL
 * Handles formats like:
 * - https://poap.xyz/mint/abc123
 * - https://poap.xyz/mint?secret=abc123
 */
function extractClaimSecret(url: string): string | null {
  try {
    const parsed = new URL(url);

    // Check for /mint/{secret} format
    const pathMatch = parsed.pathname.match(/\/mint\/([^/]+)/);
    if (pathMatch) {
      return pathMatch[1];
    }

    // Check for ?secret= query param
    const secretParam = parsed.searchParams.get('secret');
    if (secretParam) {
      return secretParam;
    }

    // Check for ?qr_hash= query param
    const qrHashParam = parsed.searchParams.get('qr_hash');
    if (qrHashParam) {
      return qrHashParam;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Check if a claim code has been used via POAP API
 */
async function checkClaimStatus(secret: string, verbose: boolean): Promise<ClaimQrResponse | null> {
  try {
    const response = await fetch(
      `https://frontend.poap.tech/actions/claim-qr?qr_hash=${encodeURIComponent(secret)}`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json',
        },
      }
    );

    if (response.status === 404) {
      // 404 means the claim code is no longer available (likely already claimed)
      return { claimed: true };
    }

    if (!response.ok) {
      if (verbose) {
        console.log(`  Warning: POAP API returned ${response.status} for secret ${secret.slice(0, 8)}...`);
      }
      return null;
    }

    return (await response.json()) as ClaimQrResponse;
  } catch (error) {
    if (verbose) {
      console.error(`  Error checking secret ${secret.slice(0, 8)}...:`, error);
    }
    return null;
  }
}

async function syncPoapStatus(): Promise<void> {
  const { dryRun, checkAll, verbose, batchSize } = parseArgs();

  console.log('=== POAP Status Sync ===\n');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes)' : 'LIVE (will update database)'}`);
  console.log(`Scope: ${checkAll ? 'All links' : 'Unclaimed links only'}`);
  console.log(`Batch size: ${batchSize}`);
  console.log(`Verbose: ${verbose}`);
  console.log('');

  if (!config.poap.apiKey) {
    console.error('Error: POAP_API_KEY environment variable not set');
    process.exit(1);
  }

  // Fetch links to check
  const query = checkAll
    ? 'SELECT id, link, claimed, claimant_id FROM poap_links ORDER BY id'
    : 'SELECT id, link, claimed, claimant_id FROM poap_links WHERE claimed = FALSE ORDER BY id';

  const result = await pool.query<PoapLink>(query);
  const links = result.rows;

  console.log(`Found ${links.length} links to check\n`);

  if (links.length === 0) {
    console.log('No links to sync. Done!');
    return;
  }

  let checkedCount = 0;
  let alreadyClaimedOnChain = 0;
  let stillUnclaimed = 0;
  let errorsCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  const linksToUpdate: { id: number; beneficiary: string | null }[] = [];

  for (const poapLink of links) {
    checkedCount++;
    process.stdout.write(`\rChecking: ${checkedCount}/${links.length}`);

    const secret = extractClaimSecret(poapLink.link);
    if (!secret) {
      if (verbose) {
        console.log(`\n  Warning: Could not extract secret from link ID ${poapLink.id}: ${poapLink.link}`);
      }
      errorsCount++;
      continue;
    }

    const status = await checkClaimStatus(secret, verbose);

    if (status === null) {
      // API error - skip this one
      errorsCount++;
    } else if (status.claimed === true || status.claimed === undefined) {
      // 404 returns {claimed: true} from our handler
      // If claimed field is missing, treat as claimed (defensive)
      if (!poapLink.claimed) {
        linksToUpdate.push({ id: poapLink.id, beneficiary: status.beneficiary || null });
        alreadyClaimedOnChain++;
      } else {
        // Already marked as claimed in our DB
        skippedCount++;
      }
    } else {
      // Still unclaimed
      stillUnclaimed++;
    }

    // Delay between API calls
    await new Promise(resolve => setTimeout(resolve, DELAY_MS));
  }

  console.log('\n');

  // Update database
  if (linksToUpdate.length > 0 && !dryRun) {
    console.log(`Updating ${linksToUpdate.length} links in database...\n`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const update of linksToUpdate) {
        await client.query(
          `UPDATE poap_links
           SET claimed = TRUE,
               updated_at = NOW()
           WHERE id = $1`,
          [update.id]
        );
        updatedCount++;

        if (verbose) {
          if (update.beneficiary) {
            console.log(`  Updated: Link ID ${update.id} (claimed by ${update.beneficiary})`);
          } else {
            console.log(`  Updated: Link ID ${update.id} (claim code no longer valid)`);
          }
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Failed to update database:', error);
      throw error;
    } finally {
      client.release();
    }
  } else if (linksToUpdate.length > 0 && dryRun) {
    console.log(`[DRY RUN] Would update ${linksToUpdate.length} links:\n`);
    for (const update of linksToUpdate.slice(0, 10)) {
      if (update.beneficiary) {
        console.log(`  Link ID ${update.id} -> claimed (by ${update.beneficiary})`);
      } else {
        console.log(`  Link ID ${update.id} -> claimed (code no longer valid)`);
      }
    }
    if (linksToUpdate.length > 10) {
      console.log(`  ... and ${linksToUpdate.length - 10} more`);
    }
    console.log('');
  }

  // Summary
  console.log('=== Sync Summary ===');
  console.log(`  Checked: ${checkedCount}`);
  console.log(`  Found claimed on-chain (DB was wrong): ${alreadyClaimedOnChain}`);
  console.log(`  Still unclaimed: ${stillUnclaimed}`);
  console.log(`  Already correct in DB: ${skippedCount}`);
  console.log(`  API errors: ${errorsCount}`);
  console.log(`  Database records updated: ${dryRun ? 0 : updatedCount}`);

  // Show current statistics
  const statsResult = await pool.query(
    `SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE claimed = TRUE) as claimed,
      COUNT(*) FILTER (WHERE claimed = FALSE) as remaining
     FROM poap_links`
  );

  const stats = statsResult.rows[0];
  console.log(`\nCurrent POAP Statistics:`);
  console.log(`   Total links: ${stats.total}`);
  console.log(`   Claimed: ${stats.claimed}`);
  console.log(`   Remaining: ${stats.remaining}\n`);
}

// Run the script
syncPoapStatus()
  .then(async () => {
    console.log('Sync completed successfully');
    await closeAllConnections();
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('Sync failed:', error);
    await closeAllConnections();
    process.exit(1);
  });
