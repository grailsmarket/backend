import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

// Configuration
const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401'; // ENS Name Wrapper contract
const BATCH_SIZE = 100; // Process names in batches from DB
const GRAPH_BATCH_SIZE = 20; // Query Graph 20 names at a time
const DRY_RUN = process.argv.includes('--dry-run'); // Pass --dry-run flag to test without updating

// Parse --start-id argument
let START_ID = 0;
const startIdArg = process.argv.find(arg => arg.startsWith('--start-id='));
if (startIdArg) {
  START_ID = parseInt(startIdArg.split('=')[1]);
  if (isNaN(START_ID)) {
    console.error('Invalid --start-id value');
    process.exit(1);
  }
}

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
 * Convert decimal token ID to hex labelhash
 */
function decimalToHex(decimal: string): string {
  const hex = BigInt(decimal).toString(16).padStart(64, '0');
  return '0x' + hex;
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
    console.error(`Error querying subgraph by name:`, error.message);
    return new Map();
  }
}

/**
 * Query The Graph for domains by labelhash
 */
async function queryGraphByLabelhash(labelhashes: string[]): Promise<Map<string, GraphDomain>> {
  const query = `
    query GetDomainsByLabelhash($labelhashes: [String!]!) {
      domains(where: { labelhash_in: $labelhashes, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }, first: 1000) {
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
        variables: { labelhashes }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000 // 30 second timeout
      }
    );

    if (response.data.errors) {
      console.error(`GraphQL errors for labelhash batch:`, response.data.errors);
      return new Map();
    }

    const domains = response.data.data?.domains || [];

    // Create a map of labelhash -> domain for easy lookup
    const domainMap = new Map<string, GraphDomain>();
    for (const domain of domains) {
      domainMap.set(domain.labelhash, domain);
    }

    return domainMap;
  } catch (error: any) {
    console.error(`Error querying subgraph by labelhash:`, error.message);
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

  if (START_ID > 0) {
    console.log(`Starting from ID: ${START_ID}\n`);
  }

  console.log('Starting token ID fix process...\n');

  // Get total count of non-expired real names
  const countResult = await pool.query(
    `SELECT COUNT(*)
     FROM ens_names
     WHERE name NOT LIKE 'token-%'
     AND expiry_date IS NOT NULL
     AND expiry_date > NOW()
     AND id >= $1`,
    [START_ID]
  );
  const totalNames = parseInt(countResult.rows[0].count);
  console.log(`Total non-expired real names to process: ${totalNames}\n`);

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
       WHERE name NOT LIKE 'token-%'
       AND expiry_date IS NOT NULL
       AND expiry_date > NOW()
       AND id >= $1
       ORDER BY id
       LIMIT $2 OFFSET $3`,
      [START_ID, BATCH_SIZE, offset]
    );

    console.log(`Processing batch: ${offset + 1} to ${offset + result.rows.length} of ${totalNames}`);

    // Process this batch in sub-batches for Graph queries
    for (let i = 0; i < result.rows.length; i += GRAPH_BATCH_SIZE) {
      const subBatch = result.rows.slice(i, i + GRAPH_BATCH_SIZE);

      // Separate placeholders from real names
      const realNames = subBatch.filter(row => !row.name.startsWith('token-'));
      const placeholders = subBatch.filter(row => row.name.startsWith('token-'));

      // Create a combined domain map
      const domainMap = new Map<string, { domain: GraphDomain, dbRow: any }>();

      // Query real names by name
      if (realNames.length > 0) {
        console.log(`  Querying Graph for ${realNames.length} real names...`);
        const namesList = realNames.map(row => row.name);
        const nameResults = await queryGraphByName(namesList);

        for (const row of realNames) {
          const domain = nameResults.get(row.name);
          if (domain) {
            domainMap.set(row.name, { domain, dbRow: row });
          }
        }
      }

      // Query placeholders by labelhash (using their token_id)
      if (placeholders.length > 0) {
        console.log(`  Querying Graph for ${placeholders.length} placeholders by labelhash...`);
        const labelhashes = placeholders.map(row => decimalToHex(row.token_id));
        const labelhashResults = await queryGraphByLabelhash(labelhashes);

        for (const row of placeholders) {
          const labelhash = decimalToHex(row.token_id);
          const domain = labelhashResults.get(labelhash);
          if (domain) {
            domainMap.set(row.name, { domain, dbRow: row });
          }
        }
      }

      // Process each name in the sub-batch
      for (const row of subBatch) {
        const { id, name, token_id: currentTokenId } = row;

        try {
          console.log(`  Processing ID: ${id}`);
          const result = domainMap.get(name);

          if (!result) {
            notFound++;
            console.log(`  [SKIP] ${name} - not found in subgraph`);
            processed++;
            continue;
          }

          const domain = result.domain;

          // Calculate correct token ID and name
          const correctTokenId = getCorrectTokenId(domain);
          const correctName = domain.name;
          const isPlaceholder = name.startsWith('token-');

          // Check if token ID or name needs updating
          if (currentTokenId !== correctTokenId || isPlaceholder) {
            const correctOwner = domain.owner.id.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()
              ? domain.wrappedOwner.id
              : domain.owner.id;

            console.log(`  [UPDATE] ${name}${isPlaceholder ? ` -> ${correctName}` : ''}`);
            console.log(`    Current:  ${currentTokenId}`);
            console.log(`    Correct:  ${correctTokenId}`);
            console.log(`    Owner:    ${correctOwner}`);
            console.log(`    Wrapped:  ${domain.owner.id.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()}`);

            // Check if there's a duplicate with the correct name OR correct token_id
            const duplicateCheck = await pool.query(
              'SELECT id, name, token_id FROM ens_names WHERE (name = $1 OR token_id = $2) AND id != $3',
              [correctName, correctTokenId, id]
            );

            if (duplicateCheck.rows.length > 0) {
              const duplicateId = duplicateCheck.rows[0].id;
              const duplicateName = duplicateCheck.rows[0].name;
              const duplicateTokenId = duplicateCheck.rows[0].token_id;
              console.log(`    Found duplicate: ${duplicateName} (id: ${duplicateId}, token_id: ${duplicateTokenId})`);

              // Determine which record to keep based on which is a placeholder
              // If current is placeholder and duplicate is real name, keep duplicate (swap)
              // If current is real name and duplicate is placeholder, keep current
              const shouldSwap = isPlaceholder && !duplicateName.startsWith('token-');
              const keepId = shouldSwap ? duplicateId : id;
              const deleteId = shouldSwap ? id : duplicateId;

              if (shouldSwap) {
                console.log(`    Current is placeholder, will keep duplicate (${duplicateName}) instead`);
              }

              // Update the database (only if not dry run)
              if (!DRY_RUN) {
                // Start transaction and disable triggers to avoid pg_notify payload size errors
                await pool.query('BEGIN');

                try {
                  // Disable triggers for this session to prevent pg_notify errors with large token_ids
                  await pool.query('SET LOCAL session_replication_role = replica');

                  // Update foreign key references from delete record to keep record
                  await pool.query(
                    'UPDATE listings SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [keepId, deleteId]
                  );
                  await pool.query(
                    'UPDATE offers SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [keepId, deleteId]
                  );
                  await pool.query(
                    'UPDATE sales SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [keepId, deleteId]
                  );
                  await pool.query(
                    'UPDATE activity_history SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [keepId, deleteId]
                  );
                  await pool.query(
                    'UPDATE watchlist SET ens_name_id = $1 WHERE ens_name_id = $2',
                    [keepId, deleteId]
                  );

                  // Delete the record we don't want to keep
                  await pool.query('DELETE FROM ens_names WHERE id = $1', [deleteId]);
                  console.log(`    Deleted ${shouldSwap ? 'placeholder' : 'duplicate'}: ${shouldSwap ? name : duplicateName} (id: ${deleteId})`);

                  // Update the record we're keeping with correct token_id, name, and owner
                  await pool.query(
                    'UPDATE ens_names SET token_id = $1, name = $2, owner_address = $3, updated_at = NOW() WHERE id = $4',
                    [correctTokenId, correctName, correctOwner, keepId]
                  );

                  await pool.query('COMMIT');
                  console.log(`    Merged into ${shouldSwap ? duplicateName : name} (id: ${keepId}) with correct data`);
                } catch (txError) {
                  await pool.query('ROLLBACK');
                  throw txError;
                }
              } else {
                console.log(`    [DRY RUN] Would delete ${shouldSwap ? 'placeholder' : 'duplicate'}: ${shouldSwap ? name : duplicateName}`);
                console.log(`    [DRY RUN] Would update ${shouldSwap ? duplicateName : name} with correct token_id, name, and owner`);
              }
            } else {
              // No duplicate - just update token_id, name (if placeholder), and owner
              if (!DRY_RUN) {
                // Use transaction with triggers disabled to avoid pg_notify payload size errors
                await pool.query('BEGIN');
                try {
                  await pool.query('SET LOCAL session_replication_role = replica');
                  await pool.query(
                    'UPDATE ens_names SET token_id = $1, name = $2, owner_address = $3, updated_at = NOW() WHERE id = $4',
                    [correctTokenId, correctName, correctOwner, id]
                  );
                  await pool.query('COMMIT');
                } catch (txError) {
                  await pool.query('ROLLBACK');
                  throw txError;
                }
              } else {
                console.log(`    [DRY RUN] Would update token_id${isPlaceholder ? ', name' : ''}, and owner`);
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
