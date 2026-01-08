/**
 * Script to fix ENS name ownership that was incorrectly set due to non-normalized
 * name registration attacks (e.g., "Vitalik.eth" impersonating "vitalik.eth").
 *
 * This script:
 * 1. Finds all names owned by the specified attacker address
 * 2. For each name, queries The Graph to get the correct owner of the normalized name
 * 3. Updates ownership if it differs from the attacker
 *
 * Usage: npx tsx src/scripts/fix-attacker-names.ts [--dry-run]
 */

import { labelhash, namehash, normalize } from 'viem/ens';
import { config, getPostgresPool } from '../../../shared/src';
import { logger } from '../utils/logger';

const ATTACKER_ADDRESS = '0x43e47385f6b3f8bdbe02c210bf5c74b6c34ff441'.toLowerCase();
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401'.toLowerCase();
const ENS_SUBGRAPH_URL = config.theGraph?.ensSubgraphUrl || 'https://ensnode-api-production-500f.up.railway.app/subgraph';

const DRY_RUN = process.argv.includes('--dry-run');

interface NameRecord {
  id: number;
  token_id: string;
  name: string;
  owner_address: string;
}

interface GraphDomain {
  id: string;
  name: string;
  labelName: string;
  labelhash: string;
  owner: { id: string } | null;
  registrant: { id: string } | null;
  wrappedOwner: { id: string } | null;
}

async function queryGraphForName(name: string): Promise<{ owner: string; tokenId: string } | null> {
  if (!name.endsWith('.eth')) {
    return null;
  }

  const label = name.replace('.eth', '');
  const hash = labelhash(label);
  const hexString = BigInt(hash).toString(16).padStart(64, '0');
  const labelhashHex = '0x' + hexString;

  const query = `
    query GetENSNameByLabelhash($labelhash: String!) {
      domains(where: { labelhash: $labelhash, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }) {
        id
        name
        labelName
        labelhash
        owner {
          id
        }
        registrant {
          id
        }
        wrappedOwner {
          id
        }
      }
    }
  `;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.theGraph?.apiKey) {
    headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
  }

  const response = await fetch(ENS_SUBGRAPH_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      query,
      variables: { labelhash: labelhashHex }
    }),
  });

  if (!response.ok) {
    logger.error(`Graph API error for ${name}: ${response.status}`);
    return null;
  }

  const data = await response.json() as { data?: { domains?: GraphDomain[] } };
  const domains = data.data?.domains || [];

  if (domains.length === 0) {
    return null;
  }

  const domain = domains[0];

  // Determine the correct owner
  let owner: string | null = null;

  if (domain.registrant?.id) {
    const registrant = domain.registrant.id.toLowerCase();
    if (registrant === NAME_WRAPPER_ADDRESS) {
      // Wrapped name - use wrappedOwner
      owner = domain.wrappedOwner?.id?.toLowerCase() || null;
    } else {
      // Unwrapped - use registrant
      owner = registrant;
    }
  }

  if (!owner) {
    owner = domain.owner?.id?.toLowerCase() || null;
  }

  // Calculate the correct token_id (labelhash for the normalized name)
  const tokenId = BigInt(hash).toString(10);

  return owner ? { owner, tokenId } : null;
}

async function main() {
  const pool = getPostgresPool();

  console.log('='.repeat(60));
  console.log('ENS Name Ownership Fix Script');
  console.log('='.repeat(60));
  console.log(`Attacker address: ${ATTACKER_ADDRESS}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (will update database)'}`);
  console.log('='.repeat(60));
  console.log();

  // Step 1: Find all names owned by the attacker
  const result = await pool.query<NameRecord>(
    'SELECT id, token_id, name, owner_address FROM ens_names WHERE owner_address = $1',
    [ATTACKER_ADDRESS]
  );

  const attackerNames = result.rows;
  console.log(`Found ${attackerNames.length} names owned by attacker`);
  console.log();

  if (attackerNames.length === 0) {
    console.log('No names to fix. Exiting.');
    await pool.end();
    return;
  }

  // Step 2: For each name, check the real owner
  let fixedCount = 0;
  let skippedCount = 0;
  let errorCount = 0;

  for (const nameRecord of attackerNames) {
    const { id, token_id, name, owner_address } = nameRecord;

    // Skip placeholder names
    if (name.startsWith('token-') || name.startsWith('#')) {
      console.log(`SKIP: ${name} (placeholder)`);
      skippedCount++;
      continue;
    }

    // Normalize the name to query The Graph correctly
    let normalizedName: string;
    try {
      normalizedName = normalize(name);
    } catch {
      console.log(`SKIP: ${name} (failed to normalize)`);
      skippedCount++;
      continue;
    }

    // Query The Graph for the real owner
    const graphResult = await queryGraphForName(normalizedName);

    if (!graphResult) {
      console.log(`ERROR: ${name} - could not query The Graph`);
      errorCount++;
      continue;
    }

    const { owner: realOwner, tokenId: correctTokenId } = graphResult;

    // Check if the real owner is different from the attacker
    if (realOwner === ATTACKER_ADDRESS) {
      // The attacker actually owns this name legitimately
      console.log(`OK: ${name} - attacker legitimately owns this`);
      skippedCount++;
      continue;
    }

    // The real owner is different - this name was incorrectly attributed to the attacker
    console.log(`FIX: ${name}`);
    console.log(`     Current owner: ${owner_address}`);
    console.log(`     Real owner:    ${realOwner}`);
    console.log(`     Current token: ${token_id}`);
    console.log(`     Correct token: ${correctTokenId}`);

    if (!DRY_RUN) {
      try {
        // Update the ownership and token_id
        await pool.query(
          `UPDATE ens_names
           SET owner_address = $1, token_id = $2, updated_at = NOW()
           WHERE id = $3`,
          [realOwner, correctTokenId, id]
        );
        console.log(`     => UPDATED`);
        fixedCount++;
      } catch (err: any) {
        console.log(`     => ERROR: ${err.message}`);
        errorCount++;
      }
    } else {
      console.log(`     => Would update (dry run)`);
      fixedCount++;
    }

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  console.log();
  console.log('='.repeat(60));
  console.log('Summary');
  console.log('='.repeat(60));
  console.log(`Total names checked: ${attackerNames.length}`);
  console.log(`Fixed: ${fixedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Errors: ${errorCount}`);

  if (DRY_RUN) {
    console.log();
    console.log('This was a DRY RUN. To apply changes, run without --dry-run');
  }

  await pool.end();
}

main().catch(err => {
  console.error('Script failed:', err);
  process.exit(1);
});
