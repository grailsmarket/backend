import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

// Configuration
const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const BATCH_SIZE = 100;
const GRAPH_BATCH_SIZE = 20;
const DRY_RUN = process.argv.includes('--dry-run');

interface GraphDomain {
  id: string;
  name: string;
  labelhash: string;
  owner: {
    id: string;
  };
  wrappedOwner?: {
    id: string;
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
 * Main function to fix Name Wrapper owners
 */
async function fixNameWrapperOwners() {
  const pool = getPostgresPool();

  console.log('=== Name Wrapper Owner Fix Script ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (no changes will be made)' : 'LIVE (database will be updated)'}\n`);

  // Get count of names with Name Wrapper as owner
  const countResult = await pool.query(
    `SELECT COUNT(*)
     FROM ens_names
     WHERE owner_address = $1`,
    [NAME_WRAPPER_ADDRESS.toLowerCase()]
  );
  const totalNames = parseInt(countResult.rows[0].count);
  console.log(`Total names with Name Wrapper as owner: ${totalNames}\n`);

  let processed = 0;
  let updated = 0;
  let errors = 0;
  let notFound = 0;
  let offset = 0;

  while (offset < totalNames) {
    const result = await pool.query(
      `SELECT id, name, owner_address
       FROM ens_names
       WHERE owner_address = $1
       ORDER BY id
       LIMIT $2 OFFSET $3`,
      [NAME_WRAPPER_ADDRESS.toLowerCase(), BATCH_SIZE, offset]
    );

    console.log(`Processing batch: ${offset + 1} to ${offset + result.rows.length} of ${totalNames}`);

    for (let i = 0; i < result.rows.length; i += GRAPH_BATCH_SIZE) {
      const subBatch = result.rows.slice(i, i + GRAPH_BATCH_SIZE);
      const names = subBatch.map(row => row.name).filter(name => !name.startsWith('token-'));

      if (names.length === 0) {
        processed += subBatch.length;
        console.log(`  Skipped ${subBatch.length} placeholder names`);
        continue;
      }

      console.log(`  Querying Graph for ${names.length} names...`);
      const domainMap = await queryGraphByName(names);

      for (const row of subBatch) {
        const { id, name, owner_address } = row;

        // Skip placeholders
        if (name.startsWith('token-')) {
          processed++;
          continue;
        }

        try {
          const domain = domainMap.get(name);

          if (!domain) {
            notFound++;
            console.log(`  [SKIP] ${name} - not found in subgraph`);
            processed++;
            continue;
          }

          // Get the correct owner (wrappedOwner if available)
          const correctOwner = domain.wrappedOwner?.id || domain.owner.id;

          if (correctOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()) {
            console.log(`  [SKIP] ${name} - wrappedOwner is still Name Wrapper (likely expired wrapped name)`);
            processed++;
            continue;
          }

          if (correctOwner.toLowerCase() === owner_address.toLowerCase()) {
            console.log(`  [OK] ${name} - owner already correct`);
            processed++;
            continue;
          }

          console.log(`  [UPDATE] ${name}`);
          console.log(`    Current owner: ${owner_address}`);
          console.log(`    Correct owner: ${correctOwner}`);

          if (!DRY_RUN) {
            await pool.query('BEGIN');
            try {
              await pool.query('SET LOCAL session_replication_role = replica');
              await pool.query(
                'UPDATE ens_names SET owner_address = $1, updated_at = NOW() WHERE id = $2',
                [correctOwner.toLowerCase(), id]
              );
              await pool.query('COMMIT');
            } catch (txError) {
              await pool.query('ROLLBACK');
              throw txError;
            }
          } else {
            console.log(`    [DRY RUN] Would update owner`);
          }

          updated++;
          processed++;

        } catch (error: any) {
          errors++;
          console.error(`  [ERROR] ${name} - ${error.message}`);
          processed++;
        }
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    offset += BATCH_SIZE;
    console.log(`\nProgress: ${processed}/${totalNames} (${Math.round((processed/totalNames)*100)}%)`);
    console.log(`Updated: ${updated} | Errors: ${errors} | Not Found: ${notFound}\n`);
  }

  console.log('\n=== Name Wrapper Owner Fix Complete ===');
  console.log(`Total processed: ${processed}`);
  console.log(`Total updated: ${updated}`);
  console.log(`Total errors: ${errors}`);
  console.log(`Not found in subgraph: ${notFound}`);

  await pool.end();
}

fixNameWrapperOwners()
  .then(() => {
    console.log('\nScript completed successfully');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
