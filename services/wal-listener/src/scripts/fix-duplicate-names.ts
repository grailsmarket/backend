import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

// Configuration
const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const BATCH_SIZE = 20; // Query Graph 20 names at a time
const DRY_RUN = process.argv.includes('--dry-run');

interface GraphDomain {
  id: string;
  name: string;
  labelhash: string;
  expiryDate: string | number;
  owner: {
    id: string;
  };
  wrappedOwner?: {
    id: string;
  };
}

/**
 * Convert 256-bit hex to decimal string
 */
function hexToDecimal(hex: string): string {
  const hexStr = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + hexStr).toString();
}

/**
 * Query The Graph for domains by name
 */
async function queryGraphByName(names: string[]): Promise<Map<string, GraphDomain>> {
  const query = `
    query GetDomains($names: [String!]!) {
      domains(where: { name_in: $names }, first: 1000) {
        id
        name
        labelhash
        expiryDate
        owner {
          id
        }
        wrappedOwner {
          id
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      GRAPH_ENS_SUBGRAPH_URL,
      {
        query,
        variables: { names }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    if (response.data.errors) {
      console.error(`GraphQL errors:`, response.data.errors);
      return new Map();
    }

    const domains = response.data.data?.domains || [];
    const domainMap = new Map<string, GraphDomain>();
    for (const domain of domains) {
      domainMap.set(domain.name, domain);
    }

    return domainMap;
  } catch (error: any) {
    console.error(`Error querying subgraph:`, error.message);
    return new Map();
  }
}

/**
 * Get correct token ID based on owner and expiry
 */
function getCorrectTokenId(domain: GraphDomain): string {
  const ownerAddress = domain.owner.id.toLowerCase();
  const isOwnedByWrapper = ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase();

  // Check if expired
  const expiryTimestamp = typeof domain.expiryDate === 'string'
    ? parseInt(domain.expiryDate)
    : domain.expiryDate;
  const isExpired = expiryTimestamp * 1000 < Date.now();

  if (isOwnedByWrapper && !isExpired) {
    return hexToDecimal(domain.id);
  }

  return hexToDecimal(domain.labelhash);
}

/**
 * Main function to fix duplicate names
 */
async function fixDuplicateNames() {
  const pool = getPostgresPool();

  console.log('=== Duplicate Names Fix Script ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (database will be updated)'}\n`);

  // Find all duplicate names
  const duplicatesResult = await pool.query(`
    SELECT name, array_agg(id ORDER BY id) as ids, array_agg(token_id ORDER BY id) as token_ids
    FROM ens_names
    GROUP BY name
    HAVING COUNT(*) > 1
    ORDER BY name
  `);

  const totalDuplicates = duplicatesResult.rows.length;
  console.log(`Found ${totalDuplicates} duplicate names\n`);

  if (totalDuplicates === 0) {
    console.log('No duplicates found!');
    await pool.end();
    return;
  }

  let processed = 0;
  let merged = 0;
  let errors = 0;
  let notFound = 0;

  // Process in batches
  for (let i = 0; i < duplicatesResult.rows.length; i += BATCH_SIZE) {
    const batch = duplicatesResult.rows.slice(i, i + BATCH_SIZE);
    const names = batch.map(row => row.name);

    console.log(`\nQuerying Graph for batch ${Math.floor(i / BATCH_SIZE) + 1} (${names.length} names)...`);

    const domainMap = await queryGraphByName(names);

    for (const row of batch) {
      const { name, ids, token_ids } = row;

      try {
        const domain = domainMap.get(name);

        if (!domain) {
          notFound++;
          console.log(`[SKIP] ${name} - not found in subgraph`);
          processed++;
          continue;
        }

        const correctTokenId = getCorrectTokenId(domain);
        const correctOwner = domain.owner.id.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()
          ? (domain.wrappedOwner?.id || domain.owner.id)
          : domain.owner.id;

        console.log(`\n[PROCESS] ${name}`);
        console.log(`  Correct token_id: ${correctTokenId}`);
        console.log(`  Correct owner: ${correctOwner}`);
        console.log(`  Found ${ids.length} records with ids: ${ids.join(', ')}`);

        // Find which record has the correct token_id
        let correctRecordId: number | null = null;
        let incorrectRecordIds: number[] = [];

        for (let j = 0; j < ids.length; j++) {
          if (token_ids[j] === correctTokenId) {
            correctRecordId = ids[j];
            console.log(`  ✓ Record ${ids[j]} has correct token_id`);
          } else {
            incorrectRecordIds.push(ids[j]);
            console.log(`  ✗ Record ${ids[j]} has incorrect token_id: ${token_ids[j]}`);
          }
        }

        // If no record has correct token_id, use the one with most activity or newest
        if (!correctRecordId) {
          console.log(`  No record has correct token_id, checking activity...`);

          const activityCheck = await pool.query(`
            SELECT e.id,
                   (SELECT COUNT(*) FROM listings WHERE ens_name_id = e.id) as listing_count,
                   (SELECT COUNT(*) FROM offers WHERE ens_name_id = e.id) as offer_count,
                   (SELECT COUNT(*) FROM sales WHERE ens_name_id = e.id) as sale_count,
                   e.created_at
            FROM ens_names e
            WHERE e.id = ANY($1)
            ORDER BY
              (SELECT COUNT(*) FROM listings WHERE ens_name_id = e.id) +
              (SELECT COUNT(*) FROM offers WHERE ens_name_id = e.id) +
              (SELECT COUNT(*) FROM sales WHERE ens_name_id = e.id) DESC,
              e.created_at DESC
            LIMIT 1
          `, [ids]);

          correctRecordId = activityCheck.rows[0].id;
          incorrectRecordIds = ids.filter((id: number) => id !== correctRecordId);
          console.log(`  Selected record ${correctRecordId} (most activity or newest)`);
        }

        if (incorrectRecordIds.length === 0) {
          console.log(`  No duplicates to merge`);
          processed++;
          continue;
        }

        // Merge duplicates
        if (!DRY_RUN) {
          await pool.query('BEGIN');

          try {
            // Disable triggers
            await pool.query('SET LOCAL session_replication_role = replica');

            // Update foreign keys to point to correct record
            for (const incorrectId of incorrectRecordIds) {
              await pool.query('UPDATE listings SET ens_name_id = $1 WHERE ens_name_id = $2', [correctRecordId, incorrectId]);
              await pool.query('UPDATE offers SET ens_name_id = $1 WHERE ens_name_id = $2', [correctRecordId, incorrectId]);
              await pool.query('UPDATE sales SET ens_name_id = $1 WHERE ens_name_id = $2', [correctRecordId, incorrectId]);
              await pool.query('UPDATE activity_history SET ens_name_id = $1 WHERE ens_name_id = $2', [correctRecordId, incorrectId]);
              await pool.query('UPDATE watchlist SET ens_name_id = $1 WHERE ens_name_id = $2', [correctRecordId, incorrectId]);
            }

            // Delete incorrect records
            await pool.query('DELETE FROM ens_names WHERE id = ANY($1)', [incorrectRecordIds]);
            console.log(`  Deleted ${incorrectRecordIds.length} duplicate record(s): ${incorrectRecordIds.join(', ')}`);

            // Update correct record with correct token_id and owner
            await pool.query(
              'UPDATE ens_names SET token_id = $1, owner_address = $2, updated_at = NOW() WHERE id = $3',
              [correctTokenId, correctOwner, correctRecordId]
            );

            await pool.query('COMMIT');
            console.log(`  ✓ Merged into record ${correctRecordId} with correct data`);
            merged++;
          } catch (txError) {
            await pool.query('ROLLBACK');
            throw txError;
          }
        } else {
          console.log(`  [DRY RUN] Would delete records: ${incorrectRecordIds.join(', ')}`);
          console.log(`  [DRY RUN] Would update record ${correctRecordId} with correct token_id and owner`);
          merged++;
        }

        processed++;

      } catch (error: any) {
        errors++;
        console.error(`[ERROR] ${name} - ${error.message}`);
        processed++;
      }
    }

    // Rate limit
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log('\n=== Duplicate Names Fix Complete ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Total merged: ${merged}`);
  console.log(`Total errors: ${errors}`);
  console.log(`Not found in subgraph: ${notFound}`);

  await pool.end();
}

// Run the script
fixDuplicateNames()
  .then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
