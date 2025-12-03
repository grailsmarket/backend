import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

// Configuration
const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const BATCH_SIZE = 100;
const GRAPH_BATCH_SIZE = 20;
const DRY_RUN = process.argv.includes('--dry-run');

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
  registrant?: {
    id: string;
  };
  wrappedOwner?: {
    id: string;
  };
  registration?: {
    expiryDate: string | number;
    registrationDate: string | number;
  };
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
        registrant {
          id
        }
        wrappedOwner {
          id
        }
        registration {
          expiryDate
          registrationDate
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
      console.error(`GraphQL errors for batch:`, response.data.errors);
      return new Map();
    }

    const domains = response.data.data?.domains || [];
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
 * Get correct owner address based on wrapped status
 */
function getCorrectOwner(domain: GraphDomain): string {
  const ownerAddress = domain.owner.id.toLowerCase();
  const isOwnedByWrapper = ownerAddress === NAME_WRAPPER_ADDRESS.toLowerCase();

  // Check if expired
  const expiryTimestamp = typeof domain.expiryDate === 'string'
    ? parseInt(domain.expiryDate)
    : domain.expiryDate;
  const isExpired = expiryTimestamp * 1000 < Date.now();

  if (isOwnedByWrapper && !isExpired) {
    // Wrapped name: use wrappedOwner
    return domain.wrappedOwner?.id.toLowerCase() || domain.registrant?.id.toLowerCase() || ownerAddress;
  } else {
    // Unwrapped name: use registrant
    return domain.registrant?.id.toLowerCase() || ownerAddress;
  }
}

/**
 * Main function to fix owner addresses
 */
async function fixOwnerAddresses() {
  const pool = getPostgresPool();

  console.log('=== ENS Name Data Fix Script ===');
  console.log('Updates: owner_address, expiry_date, registration_date');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (database will be updated)'}\n`);

  if (DRY_RUN) {
    console.log('Running in dry-run mode - no database updates will be performed\n');
  } else {
    console.log('Running in LIVE mode - database will be updated!\n');
  }

  if (START_ID > 0) {
    console.log(`Starting from ID: ${START_ID}\n`);
  }

  console.log('Starting ENS name data fix process...\n');

  // Get total count of non-expired real names
  const countResult = await pool.query(
    `SELECT COUNT(*)
     FROM ens_names
     WHERE name NOT LIKE 'token-%'
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
    const result = await pool.query(
      `SELECT id, name, owner_address, expiry_date, registration_date
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
      const names = subBatch.map(row => row.name);

      console.log(`  Querying Graph for ${names.length} names...`);
      const domainMap = await queryGraphByName(names);

      for (const row of subBatch) {
        const { id, name, owner_address: currentOwner, expiry_date: currentExpiry, registration_date: currentRegistration } = row;

        try {
          console.log(`  Processing ID: ${id}`);
          const domain = domainMap.get(name);

          if (!domain) {
            notFound++;
            console.log(`  [SKIP] ${name} - not found in subgraph`);
            processed++;
            continue;
          }

          // Get correct owner
          const correctOwner = getCorrectOwner(domain);

          // Get correct expiry and registration dates from registration object
          const correctExpiryTimestamp = domain.registration?.expiryDate
            ? (typeof domain.registration.expiryDate === 'string'
                ? parseInt(domain.registration.expiryDate)
                : domain.registration.expiryDate)
            : null;
          const correctExpiry = correctExpiryTimestamp ? new Date(correctExpiryTimestamp * 1000) : null;

          const correctRegistrationTimestamp = domain.registration?.registrationDate
            ? (typeof domain.registration.registrationDate === 'string'
                ? parseInt(domain.registration.registrationDate)
                : domain.registration.registrationDate)
            : null;
          const correctRegistration = correctRegistrationTimestamp ? new Date(correctRegistrationTimestamp * 1000) : null;

          // Check what needs to be updated
          const ownerNeedsUpdate = currentOwner.toLowerCase() !== correctOwner;
          const expiryNeedsUpdate = correctExpiry && (!currentExpiry || new Date(currentExpiry).getTime() !== correctExpiry.getTime());
          const registrationNeedsUpdate = correctRegistration && (!currentRegistration || new Date(currentRegistration).getTime() !== correctRegistration.getTime());

          if (!ownerNeedsUpdate && !expiryNeedsUpdate && !registrationNeedsUpdate) {
            console.log(`  [OK] ${name} - all data correct`);
            processed++;
            continue;
          }

          console.log(`  [UPDATE] ${name}`);
          if (ownerNeedsUpdate) {
            console.log(`    Owner: ${currentOwner} -> ${correctOwner}`);
          }
          if (expiryNeedsUpdate) {
            console.log(`    Expiry: ${currentExpiry ? new Date(currentExpiry).toISOString() : 'null'} -> ${correctExpiry?.toISOString()}`);
          }
          if (registrationNeedsUpdate) {
            console.log(`    Registration: ${currentRegistration ? new Date(currentRegistration).toISOString() : 'null'} -> ${correctRegistration?.toISOString()}`);
          }

          if (!DRY_RUN) {
            await pool.query('BEGIN');
            try {
              await pool.query('SET LOCAL session_replication_role = replica');

              // Build dynamic update query based on what needs updating
              const updates: string[] = [];
              const values: any[] = [];
              let paramIndex = 1;

              if (ownerNeedsUpdate) {
                updates.push(`owner_address = $${paramIndex++}`);
                values.push(correctOwner);
              }
              if (expiryNeedsUpdate && correctExpiry) {
                updates.push(`expiry_date = $${paramIndex++}`);
                values.push(correctExpiry);
              }
              if (registrationNeedsUpdate && correctRegistration) {
                updates.push(`registration_date = $${paramIndex++}`);
                values.push(correctRegistration);
              }
              updates.push('updated_at = NOW()');
              values.push(id);

              await pool.query(
                `UPDATE ens_names SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
                values
              );
              await pool.query('COMMIT');
              console.log(`    Updated ${name}`);
            } catch (txError) {
              await pool.query('ROLLBACK');
              throw txError;
            }
          } else {
            console.log(`    [DRY RUN] Would update ${name}`);
          }

          updated++;
          processed++;

        } catch (error: any) {
          errors++;
          console.error(`  [ERROR] ${name} - ${error.message}`);
          processed++;
        }
      }

      // Rate limit between Graph queries
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    offset += BATCH_SIZE;
    console.log(`\nProgress: ${processed}/${totalNames} (${Math.round((processed/totalNames)*100)}%)`);
    console.log(`Updated: ${updated} | Errors: ${errors} | Not Found: ${notFound}\n`);
  }

  console.log('\n=== ENS Name Data Fix Complete ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Total updated: ${updated}`);
  console.log(`Total errors: ${errors}`);
  console.log(`Not found in subgraph: ${notFound}`);

  await pool.end();
}

fixOwnerAddresses()
  .then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
