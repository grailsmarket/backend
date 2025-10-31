#!/usr/bin/env tsx
/**
 * Import Missing ENS Names for Clubs
 *
 * This script ensures all ENS names that should belong to clubs actually exist in the ens_names table.
 * It will create placeholder records for any missing names with minimal data.
 *
 * Usage:
 *   npx tsx src/scripts/import-missing-club-names.ts --club <club-name>
 *   npx tsx src/scripts/import-missing-club-names.ts --all
 *   npx tsx src/scripts/import-missing-club-names.ts --pattern <pattern>
 *
 * Examples:
 *   npx tsx src/scripts/import-missing-club-names.ts --pattern 3-digits
 *   npx tsx src/scripts/import-missing-club-names.ts --pattern 4-digits
 *   npx tsx src/scripts/import-missing-club-names.ts --club 999
 *   npx tsx src/scripts/import-missing-club-names.ts --all
 */

import { getPostgresPool, closeAllConnections, config } from '../../../shared/src';
import { keccak256, toHex, namehash } from 'viem';

const pool = getPostgresPool();

// The Graph ENS Subgraph URL
const GRAPH_ENS_URL = 'https://api.thegraph.com/subgraphs/name/ensdomains/ens';

function generateNamesFromPattern(pattern: string): string[] {
  switch (pattern) {
    case '3-digits':
    case '3-digit':
    case '1k':
      // Generate 000.eth through 999.eth
      const threeDigitNames: string[] = [];
      for (let i = 0; i <= 999; i++) {
        const paddedNumber = i.toString().padStart(3, '0');
        threeDigitNames.push(`${paddedNumber}.eth`);
      }
      return threeDigitNames;

    case '4-digits':
    case '4-digit':
    case '10k':
      // Generate 0000.eth through 9999.eth
      const fourDigitNames: string[] = [];
      for (let i = 0; i <= 9999; i++) {
        const paddedNumber = i.toString().padStart(4, '0');
        fourDigitNames.push(`${paddedNumber}.eth`);
      }
      return fourDigitNames;

    default:
      throw new Error(`Unknown pattern: ${pattern}. Supported patterns: 3-digits, 4-digits`);
  }
}

async function getClubMembers(clubName: string): Promise<string[]> {
  const result = await pool.query(
    'SELECT ens_name FROM club_memberships WHERE club_name = $1',
    [clubName]
  );
  return result.rows.map(row => row.ens_name);
}

async function getMissingNames(names: string[]): Promise<string[]> {
  if (names.length === 0) return [];

  const result = await pool.query(
    'SELECT name FROM ens_names WHERE name = ANY($1)',
    [names]
  );

  const existingNames = new Set(result.rows.map(row => row.name));
  return names.filter(name => !existingNames.has(name));
}

function calculateTokenId(ensName: string): string {
  // Remove .eth suffix to get just the label
  const label = ensName.replace('.eth', '');
  // For ENS Registrar, the token ID is the keccak256 hash of the LABEL (not the full namehash)
  // This is the labelhash
  const labelHash = keccak256(toHex(label));
  // Convert to decimal string (BigInt)
  return BigInt(labelHash).toString();
}

interface GraphQLResponse {
  data?: {
    domain?: {
      id: string;
      name: string;
      owner?: {
        id: string;
      };
      registrant?: {
        id: string;
      };
    };
  };
  errors?: Array<{ message: string }>;
}

async function fetchOwnerFromGraph(name: string): Promise<string | null> {
  try {
    // The Graph uses namehash as the domain ID
    const nodeId = namehash(name);

    const query = `
      query GetDomain($id: String!) {
        domain(id: $id) {
          id
          name
          owner {
            id
          }
          registrant {
            id
          }
        }
      }
    `;

    const response = await fetch(GRAPH_ENS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        variables: { id: nodeId },
      }),
    });

    const result = await response.json() as GraphQLResponse;

    if (result.errors) {
      console.log(`    Graph error for ${name}: ${JSON.stringify(result.errors)}`);
      return null;
    }

    if (!result.data?.domain) {
      // Domain not found in subgraph
      return null;
    }

    // Return the owner from the domain
    return result.data.domain.owner?.id || null;
  } catch (error: any) {
    console.log(`    Error fetching from Graph for ${name}: ${error.message}`);
    return null;
  }
}

async function importMissingNames(names: string[], clubName?: string) {
  console.log(`\nImporting ${names.length} missing ENS names...`);
  console.log('Fetching ownership data from The Graph ENS subgraph...\n');

  let imported = 0;
  let errors = 0;
  let skipped = 0;

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    // Normalize name to lowercase for ENS (ENS is case-insensitive)
    const normalizedName = name.toLowerCase();

    try {
      const tokenId = calculateTokenId(normalizedName);
      const labelName = normalizedName.replace('.eth', '');

      // Fetch owner from The Graph (use normalized name)
      const ownerAddress = await fetchOwnerFromGraph(normalizedName);

      console.log(`DEBUG: ${name} -> ${normalizedName} - ownerAddress = ${ownerAddress}, type = ${typeof ownerAddress}, truthy = ${!!ownerAddress}`);

      if (!ownerAddress) {
        console.log(`  ⊘ ${name} - Not registered (skipping)`);
        skipped++;
        continue;
      }

      console.log(`  → ${name} - Passed owner check, proceeding with import...`);

      try {
        // First check if a record with this token_id already exists (placeholder with wrong name)
        const existingCheck = await pool.query(
          'SELECT id, name FROM ens_names WHERE token_id = $1',
          [tokenId]
        );

        if (existingCheck.rows.length > 0) {
          // Record exists with this token_id but wrong name - UPDATE it
          const existingName = existingCheck.rows[0].name;
          console.log(`     Found existing record with name '${existingName}' - updating to '${normalizedName}'`);

          const result = await pool.query(
            `UPDATE ens_names SET
              name = $1,
              owner_address = $2,
              has_numbers = $3,
              has_emoji = $4,
              clubs = (SELECT COALESCE(array_agg(club_name), ARRAY[]::TEXT[])
                       FROM club_memberships
                       WHERE LOWER(ens_name) = LOWER($5)),
              updated_at = NOW()
            WHERE token_id = $6
            RETURNING id`,
            [
              normalizedName,
              ownerAddress.toLowerCase(),
              /\d/.test(labelName),
              /\p{Emoji}/u.test(labelName),
              normalizedName,
              tokenId,
            ]
          );

          if (result.rowCount && result.rowCount > 0) {
            imported++;
            console.log(`  ✓ ${name} - Updated from '${existingName}' to '${normalizedName}' - Owner: ${ownerAddress.slice(0, 8)}...`);
          }
        } else {
          // No existing record - INSERT new one
          const result = await pool.query(
            `INSERT INTO ens_names (
              token_id,
              name,
              owner_address,
              has_numbers,
              has_emoji,
              clubs,
              created_at,
              updated_at
            ) VALUES (
              $1, $2, $3, $4, $5,
              (SELECT COALESCE(array_agg(club_name), ARRAY[]::TEXT[])
               FROM club_memberships
               WHERE LOWER(ens_name) = LOWER($6)),
              NOW(), NOW()
            )
            RETURNING id`,
            [
              tokenId,
              normalizedName,
              ownerAddress.toLowerCase(),
              /\d/.test(labelName),
              /\p{Emoji}/u.test(labelName),
              normalizedName,
            ]
          );

          if (result.rowCount && result.rowCount > 0) {
            imported++;
            console.log(`  ✓ ${name} - Inserted as '${normalizedName}' - Owner: ${ownerAddress.slice(0, 8)}...`);
          }
        }

        // Add delay to avoid rate limiting The Graph
        if ((i + 1) % 5 === 0) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (insertError: any) {
        console.error(`     ✗ ERROR for ${name}: ${insertError.message}`);
        throw insertError; // Re-throw to be caught by outer catch
      }
    } catch (error: any) {
      // Check if it's a duplicate key error (name already exists)
      if (error.message && error.message.includes('duplicate key')) {
        // Skip, name already exists
        skipped++;
        continue;
      }
      errors++;
      console.error(`  ✗ Failed to import ${name}: ${error.message}`);
    }
  }

  console.log(`\nSummary:`);
  console.log(`  Imported: ${imported}`);
  console.log(`  Skipped (not registered): ${skipped}`);
  console.log(`  Errors: ${errors}`);
  console.log(`  Total processed: ${names.length}`);
}

async function main() {
  const args = process.argv.slice(2);

  try {
    // Test database connection
    console.log('Testing database connection...');
    const testResult = await pool.query('SELECT NOW() as current_time');
    console.log('✓ Database connected. Current time:', testResult.rows[0].current_time);
    console.log('');

    let namesToCheck: string[] = [];
    let description = '';

    if (args.includes('--pattern')) {
      const patternIndex = args.indexOf('--pattern');
      const pattern = args[patternIndex + 1];

      if (!pattern) {
        console.error('Usage: --pattern <pattern>');
        console.error('Supported patterns: 3-digits, 4-digits');
        process.exit(1);
      }

      namesToCheck = generateNamesFromPattern(pattern);
      description = `pattern: ${pattern}`;
    } else if (args.includes('--club')) {
      const clubIndex = args.indexOf('--club');
      const clubName = args[clubIndex + 1];

      if (!clubName) {
        console.error('Usage: --club <club-name>');
        process.exit(1);
      }

      namesToCheck = await getClubMembers(clubName);
      description = `club: ${clubName}`;
    } else if (args.includes('--all')) {
      // Get all club memberships
      const result = await pool.query(
        'SELECT DISTINCT ens_name FROM club_memberships'
      );
      namesToCheck = result.rows.map(row => row.ens_name);
      description = 'all clubs';
    } else {
      console.error('Usage:');
      console.error('  --pattern <pattern>  Import names from pattern (3-digits, 4-digits)');
      console.error('  --club <club-name>   Import names from specific club');
      console.error('  --all                Import all names from all clubs');
      process.exit(1);
    }

    console.log(`Checking ${namesToCheck.length} names from ${description}...`);

    const missingNames = await getMissingNames(namesToCheck);

    if (missingNames.length === 0) {
      console.log('\n✓ All names already exist in ens_names table. No import needed.');
    } else {
      console.log(`\nFound ${missingNames.length} missing names that need to be imported.`);
      console.log('Missing names:', missingNames.slice(0, 10).join(', '), missingNames.length > 10 ? '...' : '');

      await importMissingNames(missingNames);

      console.log('\n✓ Import complete!');
      console.log('⚠️  Don\'t forget to:');
      console.log('  1. Run club triggers to sync clubs array: UPDATE ens_names SET updated_at = NOW() WHERE name = ANY($1)');
      console.log('  2. Resync to Elasticsearch: npx tsx src/scripts/resync-elasticsearch.ts');
    }

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

main();
