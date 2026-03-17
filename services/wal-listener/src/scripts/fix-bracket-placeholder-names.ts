#!/usr/bin/env tsx

/**
 * Fix [0xhash].eth Placeholder Names
 *
 * Resolves ~60k ENS names that have the placeholder pattern [64-char-hex].eth.
 * These originated from OpenSea Stream events where OpenSea sent the labelhash as the name.
 *
 * Strategy (matching resolveTokenIdToNameData in ens-resolver.ts):
 * For each [hash].eth name, use the token_id column (not the hex from the name):
 * 1. Convert token_id to hex
 * 2. Try namehash lookup first — domain(id: $namehash) — catches wrapped names
 * 3. Fallback to labelhash lookup — domains(where: { labelhash: $labelhash, parent: "0x93cdeb..." })
 *
 * Usage:
 *   Build first: npm run build
 *   Then run: node dist/wal-listener/src/scripts/fix-bracket-placeholder-names.js [--dry-run] [--limit 100] [--batch-size 50] [--offset 0]
 */

import { getPostgresPool } from '../../../shared/src';

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const ETH_NODE = '0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae';

interface PlaceholderRecord {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
}

interface DomainData {
  id: string;
  name: string;
  labelhash: string;
  owner: string | null;
  expiryDate: string | null;
  registrationDate: string | null;
  createdAt: string | null;
  textRecords: Record<string, string>;
  isWrapped: boolean;
  isExpired: boolean;
}

function hexToDecimal(hex: string): string {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + cleanHex).toString(10);
}

function decimalToHex(decimal: string): string {
  const hex = BigInt(decimal).toString(16).padStart(64, '0');
  return '0x' + hex;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processDomain(domain: any): DomainData {
  // Process text records
  const textRecords: Record<string, string> = {};
  if (domain.resolver?.textChangeds) {
    for (const record of domain.resolver.textChangeds) {
      if (record.key && record.value) {
        textRecords[record.key] = record.value;
      }
    }
  }

  // Determine owner and wrapped status
  const ownerAddr = domain.owner?.id?.toLowerCase();
  const isWrapped = ownerAddr === NAME_WRAPPER_ADDRESS;

  let owner: string | null = null;
  if (domain.registrant?.id) {
    const registrant = domain.registrant.id.toLowerCase();
    if (registrant === NAME_WRAPPER_ADDRESS) {
      owner = domain.wrappedOwner?.id?.toLowerCase() || null;
    } else {
      owner = registrant;
    }
  } else if (isWrapped) {
    owner = domain.wrappedOwner?.id?.toLowerCase() || null;
  } else {
    owner = ownerAddr || null;
  }

  // Check expiry
  let isExpired = false;
  if (domain.expiryDate) {
    const expiryTimestamp = typeof domain.expiryDate === 'string'
      ? parseInt(domain.expiryDate)
      : domain.expiryDate;
    isExpired = expiryTimestamp * 1000 < Date.now();
  }

  return {
    id: domain.id,
    name: domain.name,
    labelhash: domain.labelhash,
    owner,
    expiryDate: domain.registration?.expiryDate || null,
    registrationDate: domain.registration?.registrationDate || domain.createdAt || null,
    createdAt: domain.createdAt || null,
    textRecords,
    isWrapped,
    isExpired,
  };
}

const DOMAIN_FIELDS = `
  id
  name
  labelName
  labelhash
  expiryDate
  createdAt
  owner { id }
  registrant { id }
  wrappedOwner { id }
  registration {
    expiryDate
    registrationDate
  }
  resolver {
    textChangeds {
      key
      value
    }
  }
`;

/**
 * Batch query by namehash (domain IDs) — catches wrapped names
 */
async function queryGraphByIds(tokenIdHexArray: string[]): Promise<Map<string, DomainData>> {
  const query = `
    query GetDomainsByIds($ids: [String!]!) {
      domains(where: { id_in: $ids }) {
        ${DOMAIN_FIELDS}
      }
    }
  `;

  try {
    const response = await fetch(GRAPH_ENS_SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { ids: tokenIdHexArray } }),
    });

    if (!response.ok) {
      console.error(`Graph API error (by ID): ${response.status} ${response.statusText}`);
      return new Map();
    }

    const result: any = await response.json();
    if (result.errors) {
      console.error('GraphQL errors (by ID):', result.errors);
      return new Map();
    }

    const resultsMap = new Map<string, DomainData>();
    if (result.data?.domains) {
      for (const domain of result.data.domains) {
        const data = processDomain(domain);
        resultsMap.set(domain.id.toLowerCase(), data);
      }
    }
    return resultsMap;
  } catch (error: any) {
    console.error(`Error querying Graph by ID: ${error.message}`);
    return new Map();
  }
}

/**
 * Batch query by labelhash — fallback for unwrapped ERC-721 names
 */
async function queryGraphByLabelhashes(labelhashes: string[]): Promise<Map<string, DomainData>> {
  const query = `
    query GetDomainsByLabelhash($labelhashes: [String!]!) {
      domains(where: { labelhash_in: $labelhashes, parent: "${ETH_NODE}" }) {
        ${DOMAIN_FIELDS}
      }
    }
  `;

  try {
    const response = await fetch(GRAPH_ENS_SUBGRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { labelhashes } }),
    });

    if (!response.ok) {
      console.error(`Graph API error (by labelhash): ${response.status} ${response.statusText}`);
      return new Map();
    }

    const result: any = await response.json();
    if (result.errors) {
      console.error('GraphQL errors (by labelhash):', result.errors);
      return new Map();
    }

    const resultsMap = new Map<string, DomainData>();
    if (result.data?.domains) {
      for (const domain of result.data.domains) {
        const data = processDomain(domain);
        if (domain.labelhash) {
          resultsMap.set(domain.labelhash.toLowerCase(), data);
        }
      }
    }
    return resultsMap;
  } catch (error: any) {
    console.error(`Error querying Graph by labelhash: ${error.message}`);
    return new Map();
  }
}

/**
 * Get the correct token_id for DB storage based on wrapped/expired status
 */
function getCorrectTokenId(domain: DomainData): string {
  if (domain.isWrapped && !domain.isExpired) {
    // Wrapped, non-expired: use domain.id (namehash)
    return hexToDecimal(domain.id);
  }
  // Unwrapped or expired: use labelhash
  return hexToDecimal(domain.labelhash);
}

async function fixBracketPlaceholderNames(options: {
  dryRun?: boolean;
  limit?: number;
  batchSize?: number;
  offset?: number;
}) {
  const pool = getPostgresPool();
  const dryRun = options.dryRun ?? false;
  const limit = options.limit ?? 1000;
  const batchSize = options.batchSize ?? 50;
  const offset = options.offset ?? 0;

  try {
    console.log('\n=== Fix [hash].eth Bracket Placeholder Names ===\n');
    console.log(`Dry run: ${dryRun ? 'YES' : 'NO'}`);
    console.log(`Offset: ${offset}`);
    console.log(`Limit: ${limit}`);
    console.log(`Batch size: ${batchSize}\n`);

    // Count total
    const countResult = await pool.query(
      `SELECT COUNT(*) FROM ens_names WHERE name ~ '^\\[[0-9a-fA-F]{64}\\]\\.eth$'`
    );
    console.log(`Total [hash].eth placeholders in DB: ${countResult.rows[0].count}\n`);

    // Fetch batch
    const query = `
      SELECT id, name, token_id, owner_address
      FROM ens_names
      WHERE name ~ '^\\[[0-9a-fA-F]{64}\\]\\.eth$'
      ORDER BY id
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query(query, [limit, offset]);
    const placeholders: PlaceholderRecord[] = result.rows;

    console.log(`Fetched ${placeholders.length} placeholder records to process\n`);

    if (placeholders.length === 0) {
      console.log('No placeholders to process!');
      await pool.end();
      return;
    }

    // Show examples
    console.log('Sample placeholders:');
    placeholders.slice(0, 5).forEach((p) => {
      console.log(`  ID ${p.id}: ${p.name} (token: ${p.token_id.substring(0, 20)}...)`);
    });
    console.log('');

    let processed = 0;
    let recovered = 0;
    let merged = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < placeholders.length; i += batchSize) {
      const batch = placeholders.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      console.log(`\nBatch ${batchNum} (records ${i + 1}-${Math.min(i + batchSize, placeholders.length)})...`);

      // Convert all token_ids to hex for batch lookup
      const tokenIdHexMap = new Map<string, PlaceholderRecord>();
      const tokenIdHexArray: string[] = [];

      for (const placeholder of batch) {
        let tokenIdHex: string;
        if (placeholder.token_id.startsWith('0x')) {
          tokenIdHex = placeholder.token_id.toLowerCase();
        } else {
          tokenIdHex = decimalToHex(placeholder.token_id);
        }
        tokenIdHexMap.set(tokenIdHex, placeholder);
        tokenIdHexArray.push(tokenIdHex);
      }

      // Step 1: Try namehash lookup (catches wrapped names)
      const byIdResults = await queryGraphByIds(tokenIdHexArray);

      // Step 2: Collect unresolved and try labelhash fallback
      const unresolvedHexes: string[] = [];
      for (const hex of tokenIdHexArray) {
        if (!byIdResults.has(hex)) {
          unresolvedHexes.push(hex);
        }
      }

      let byLabelhashResults = new Map<string, DomainData>();
      if (unresolvedHexes.length > 0) {
        console.log(`  ${byIdResults.size} resolved by ID, ${unresolvedHexes.length} falling back to labelhash...`);
        byLabelhashResults = await queryGraphByLabelhashes(unresolvedHexes);
      } else {
        console.log(`  All ${byIdResults.size} resolved by ID`);
      }

      // Step 3: Process each placeholder
      for (const [tokenIdHex, placeholder] of tokenIdHexMap.entries()) {
        processed++;

        // Try ID result first, then labelhash result
        const domainData = byIdResults.get(tokenIdHex) || byLabelhashResults.get(tokenIdHex);

        if (!domainData || !domainData.name) {
          console.log(`  ⚠️  ${placeholder.name.substring(0, 20)}... - Not found in Graph (token: ${tokenIdHex.substring(0, 14)}...)`);
          skipped++;
          continue;
        }

        // The Graph returns [hash].eth when the label preimage is unknown — treat as unresolved
        if (/^\[[0-9a-fA-F]{64}\]\.eth$/.test(domainData.name)) {
          console.log(`  ⚠️  ${placeholder.name.substring(0, 20)}... - Graph returned unknown label (no preimage)`);
          skipped++;
          continue;
        }

        // Skip names that are too long for varchar(255)
        if (domainData.name.length > 255) {
          console.log(`  ⚠️  Name too long (${domainData.name.length} chars), skipping`);
          skipped++;
          continue;
        }

        const correctTokenId = getCorrectTokenId(domainData);
        const expiryDate = domainData.expiryDate ? new Date(parseInt(domainData.expiryDate) * 1000) : null;
        const registrationDate = domainData.registrationDate ? new Date(parseInt(domainData.registrationDate) * 1000) : null;

        console.log(`  ✅ ${placeholder.name.substring(0, 20)}... → ${domainData.name}`);

        if (dryRun) {
          recovered++;
          continue;
        }

        try {
          // Check for duplicates (existing record with same resolved name or token_id)
          const duplicateCheck = await pool.query(
            'SELECT id, name, token_id FROM ens_names WHERE (name = $1 OR token_id = $2) AND id != $3',
            [domainData.name, correctTokenId, placeholder.id]
          );

          if (duplicateCheck.rows.length > 0) {
            const dup = duplicateCheck.rows[0];
            console.log(`     Duplicate found: id=${dup.id}, name=${dup.name}`);

            // Current is placeholder, keep whichever has the real name (or the duplicate if it's real)
            const dupIsPlaceholder = dup.name.startsWith('token-') || dup.name.startsWith('#') || /^\[[0-9a-fA-F]{64}\]\.eth$/.test(dup.name);
            const keepId = dupIsPlaceholder ? placeholder.id : dup.id;
            const deleteId = dupIsPlaceholder ? dup.id : placeholder.id;

            console.log(`     Merging: keep id=${keepId}, delete id=${deleteId}`);

            await pool.query('BEGIN');
            try {
              await pool.query('SET LOCAL session_replication_role = replica');

              // Move FK references from deleted record to kept record
              await pool.query('UPDATE listings SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);
              await pool.query('UPDATE offers SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);
              await pool.query('UPDATE sales SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);
              await pool.query('UPDATE activity_history SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);
              await pool.query('UPDATE watchlist SET ens_name_id = $1 WHERE ens_name_id = $2', [keepId, deleteId]);

              // Delete the unwanted record
              await pool.query('DELETE FROM ens_names WHERE id = $1', [deleteId]);

              // Update the kept record with correct data
              await pool.query(
                `UPDATE ens_names SET
                  name = $1,
                  token_id = $2,
                  owner_address = COALESCE($3, owner_address),
                  expiry_date = COALESCE($4, expiry_date),
                  registration_date = COALESCE($5, registration_date),
                  metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
                  updated_at = NOW()
                WHERE id = $7`,
                [
                  domainData.name,
                  correctTokenId,
                  domainData.owner,
                  expiryDate,
                  registrationDate,
                  JSON.stringify({ text_records: domainData.textRecords }),
                  keepId,
                ]
              );

              await pool.query('COMMIT');
              console.log(`     ✓ Merged, kept id=${keepId}`);
            } catch (txError) {
              await pool.query('ROLLBACK');
              throw txError;
            }
            merged++;
          } else {
            // No duplicate — simple update
            await pool.query('BEGIN');
            try {
              await pool.query('SET LOCAL session_replication_role = replica');
              await pool.query(
                `UPDATE ens_names SET
                  name = $1,
                  token_id = $2,
                  owner_address = COALESCE($3, owner_address),
                  expiry_date = COALESCE($4, expiry_date),
                  registration_date = COALESCE($5, registration_date),
                  metadata = COALESCE(metadata, '{}'::jsonb) || $6::jsonb,
                  updated_at = NOW()
                WHERE id = $7`,
                [
                  domainData.name,
                  correctTokenId,
                  domainData.owner,
                  expiryDate,
                  registrationDate,
                  JSON.stringify({ text_records: domainData.textRecords }),
                  placeholder.id,
                ]
              );
              await pool.query('COMMIT');
            } catch (txError) {
              await pool.query('ROLLBACK');
              throw txError;
            }
            recovered++;
          }
        } catch (updateError: any) {
          console.error(`     ❌ Failed to update: ${updateError.message}`);
          failed++;
        }
      }

      // Rate limit between batches
      await sleep(200);
    }

    // Summary
    console.log('\n\n=== Recovery Summary ===\n');
    console.log(`Total processed: ${processed}`);
    console.log(`Successfully recovered: ${recovered}`);
    console.log(`Merged with duplicates: ${merged}`);
    console.log(`Failed to update: ${failed}`);
    console.log(`Not found in Graph: ${skipped}`);
    if (processed > 0) {
      console.log(`Success rate: ${(((recovered + merged) / processed) * 100).toFixed(2)}%`);
    }
    console.log('');

    if (dryRun) {
      console.log('⚠️  DRY RUN - No changes were made to the database');
      console.log('Run without --dry-run to apply updates\n');
    } else {
      console.log('✅ Database has been updated!\n');

      // Post-run count
      const postCount = await pool.query(
        `SELECT COUNT(*) FROM ens_names WHERE name ~ '^\\[[0-9a-fA-F]{64}\\]\\.eth$'`
      );
      console.log(`Remaining [hash].eth placeholders: ${postCount.rows[0].count}\n`);
    }

    // Export results
    const fs = require('fs');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outputFile = `bracket-placeholder-recovery-${timestamp}.json`;

    const results = {
      timestamp: new Date().toISOString(),
      dry_run: dryRun,
      summary: {
        total: processed,
        recovered,
        merged,
        failed,
        skipped,
      },
    };

    fs.writeFileSync(outputFile, JSON.stringify(results, null, 2));
    console.log(`Results exported to: ${outputFile}\n`);
  } catch (error: any) {
    console.error('\n❌ Error:', error.message);
    console.error(error.stack);
  } finally {
    await pool.end();
  }
}

// Parse CLI arguments
const args = process.argv.slice(2);
const options: { dryRun?: boolean; limit?: number; batchSize?: number; offset?: number } = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--dry-run') {
    options.dryRun = true;
  } else if (args[i] === '--limit' && args[i + 1]) {
    options.limit = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--batch-size' && args[i + 1]) {
    options.batchSize = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === '--offset' && args[i + 1]) {
    options.offset = parseInt(args[i + 1], 10);
    i++;
  }
}

fixBracketPlaceholderNames(options).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
