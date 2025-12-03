import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

// Configuration
const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401'; // ENS Name Wrapper contract
const BATCH_SIZE = 100; // Process names in batches from DB
const GRAPH_BATCH_SIZE = 20; // Query Graph 20 names at a time
const DRY_RUN = process.argv.includes('--dry-run'); // Pass --dry-run flag to test without updating

interface GraphDomain {
  id: string;
  name: string;
  labelhash: string;
  expiryDate: string | number;
  owner: {
    id: string;
  };
  wrappedOwner: {
    id: string;
  };
}

/**
 * Convert 256-bit hex to decimal string
 */
function hexToDecimal(hex: string): string {
  // Remove 0x prefix
  const hexStr = hex.startsWith('0x') ? hex.slice(2) : hex;

  // Pad to 64 characters (256 bits)
  const paddedHex = hexStr.padStart(64, '0');

  // Process each hex digit and calculate decimal value
  let result = BigInt(0);

  for (let i = 0; i < paddedHex.length; i++) {
    const digit = paddedHex[i];
    const value = parseInt(digit, 16);
    result = result * BigInt(16) + BigInt(value);
  }

  return result.toString();
}

/**
 * Query The Graph for multiple domains at once (batch query)
 */
async function queryGraphForDomains(names: string[]): Promise<Map<string, GraphDomain>> {
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
        timeout: 30000 // 30 second timeout
      }
    );

    if (response.data.errors) {
      console.error(`GraphQL errors for batch:`, response.data.errors);
      return new Map();
    }

    const domains = response.data.data?.domains || [];

    // Create a map of name -> domain for easy lookup
    const domainMap = new Map<string, GraphDomain>();
    for (const domain of domains) {
      domainMap.set(domain.name, domain);
    }

    return domainMap;
  } catch (error: any) {
    console.error(`Error querying subgraph for batch:`, error.message);
    return new Map();
  }
}

/**
 * Get correct token ID based on owner and expiry
 */
function getCorrectTokenId(domain: GraphDomain): string {
  const ownerAddress = domain.owner.id.toLowerCase();
  const isOwnedByWrapper = ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase();

  // Check if expired (expiryDate is in unix timestamp seconds)
  const expiryTimestamp = typeof domain.expiryDate === 'string'
    ? parseInt(domain.expiryDate)
    : domain.expiryDate;
  const isExpired = expiryTimestamp * 1000 < Date.now();

  // Logic:
  // - If owner is wrapper AND not expired: use domain.id
  // - If owner is wrapper AND expired: use labelhash
  // - If owner is not wrapper: use labelhash

  if (isOwnedByWrapper && !isExpired) {
    return hexToDecimal(domain.id);
  }

  return hexToDecimal(domain.labelhash);
}

/**
 * Main function to fix token IDs
 */
async function fixTokenIds() {
  const pool = getPostgresPool();

  console.log('=== Token ID Fix Script ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (database will be updated)'}\n`);

  if (DRY_RUN) {
    console.log('🔍 Running in dry-run mode - no database updates will be performed\n');
  } else {
    console.log('⚠️  Running in LIVE mode - database will be updated!\n');
  }

  console.log('Starting token ID fix process...\n');

  // Get total count
  const countResult = await pool.query(
    `SELECT COUNT(*) 
     FROM ens_names    
     WHERE owner_address = $1`,
    [NAME_WRAPPER_ADDRESS.toLowerCase()]
  );
  const totalNames = parseInt(countResult.rows[0].count);
  console.log(`Total names to process: ${totalNames}\n`);

  let processed = 0;
  let updated = 0;
  let errors = 0;
  let notFound = 0;
  let offset = 0;

  while (offset < totalNames) {
    // Fetch batch of names
    const result = await pool.query(
      `SELECT id, name, token_id
       FROM ens_names
       WHERE owner_address = $1
       ORDER BY id
       LIMIT $2 OFFSET $3`,
      [NAME_WRAPPER_ADDRESS.toLowerCase(), BATCH_SIZE, offset]
    );

    console.log(`Processing batch: ${offset + 1} to ${offset + result.rows.length} of ${totalNames}`);

    // Process this batch in sub-batches for Graph queries
    for (let i = 0; i < result.rows.length; i += GRAPH_BATCH_SIZE) {
      const subBatch = result.rows.slice(i, i + GRAPH_BATCH_SIZE);
      const names = subBatch.map(row => row.name);

      console.log(`  Querying Graph for ${names.length} names...`);

      // Query The Graph for this sub-batch
      const domainMap = await queryGraphForDomains(names);

      // Process each name in the sub-batch
      for (const row of subBatch) {
        const { id, name, token_id: currentTokenId } = row;

        try {
          const domain = domainMap.get(name);

          if (!domain) {
            notFound++;
            console.log(`  [SKIP] ${name} - not found in subgraph`);
            processed++;
            continue;
          }

          // Calculate correct token ID
          const correctTokenId = getCorrectTokenId(domain);

          // Check if token ID needs updating
          if (currentTokenId !== correctTokenId) {
            const correctOwner = domain.owner.id.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()
              ? domain.wrappedOwner.id
              : domain.owner.id;

            console.log(`  [UPDATE] ${name}`);
            console.log(`    Current:  ${currentTokenId}`);
            console.log(`    Correct:  ${correctTokenId}`);
            console.log(`    Owner:    ${correctOwner}`);
            console.log(`    Wrapped:  ${domain.owner.id.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()}`);

            // Check if there's a placeholder name with the correct token_id
            const placeholderCheck = await pool.query(
              'SELECT id, name FROM ens_names WHERE token_id = $1 AND name LIKE $2',
              [correctTokenId, 'token-%']
            );

            if (placeholderCheck.rows.length > 0) {
              const placeholderId = placeholderCheck.rows[0].id;
              const placeholderName = placeholderCheck.rows[0].name;
              console.log(`    Found placeholder: ${placeholderName} (id: ${placeholderId}) with correct token_id`);

              // Update the database (only if not dry run)
              if (!DRY_RUN) {
                // Start transaction
                await pool.query('BEGIN');

                try {
                  // Update foreign key references from placeholder to the real record
                  await pool.query(
                    'UPDATE listings SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [id, placeholderId]
                  );
                  await pool.query(
                    'UPDATE offers SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [id, placeholderId]
                  );
                  await pool.query(
                    'UPDATE sales SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [id, placeholderId]
                  );
                  await pool.query(
                    'UPDATE activity_history SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [id, placeholderId]
                  );
                  await pool.query(
                    'UPDATE watchlist SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [id, placeholderId]
                  );

                  // Delete the placeholder record
                  await pool.query('DELETE FROM ens_names WHERE id = $1', [placeholderId]);
                  console.log(`    Deleted placeholder: ${placeholderName}`);

                  // Update the real record with correct token_id and owner
                  await pool.query(
                    'UPDATE ens_names SET token_id = $1, owner_address = $2, updated_at = NOW() WHERE id = $3',
                    [correctTokenId, correctOwner, id]
                  );

                  await pool.query('COMMIT');
                  console.log(`    Merged placeholder into ${name} with correct token_id`);
                } catch (txError) {
                  await pool.query('ROLLBACK');
                  throw txError;
                }
              } else {
                console.log(`    [DRY RUN] Would merge placeholder ${placeholderName} into ${name}`);
                console.log(`    [DRY RUN] Would update token_id and owner`);
              }
            } else {
              // No placeholder - just update token_id and owner
              if (!DRY_RUN) {
                await pool.query(
                  'UPDATE ens_names SET token_id = $1, owner_address = $2, updated_at = NOW() WHERE id = $3',
                  [correctTokenId, correctOwner, id]
                );
              } else {
                console.log(`    [DRY RUN] Would update token_id and owner`);
              }
            }

            updated++;
          } else {
            console.log(`  [OK] ${name} - token ID correct`);
          }

          processed++;

        } catch (error: any) {
          errors++;
          console.error(`  [ERROR] ${name} - ${error.message}`);
          processed++;
        }
      }

      // Rate limit: small delay between Graph batch queries
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    offset += BATCH_SIZE;

    // Progress update
    console.log(`\nProgress: ${processed}/${totalNames} (${Math.round((processed/totalNames)*100)}%)`);
    console.log(`Updated: ${updated} | Errors: ${errors} | Not Found: ${notFound}\n`);
  }

  console.log('\n=== Token ID Fix Complete ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Total updated: ${updated}`);
  console.log(`Total errors: ${errors}`);
  console.log(`Not found in subgraph: ${notFound}`);

  await pool.end();
}

// Run the script
fixTokenIds()
  .then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
