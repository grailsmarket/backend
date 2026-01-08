import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

/**
 * Recovery script to fix records with NameWrapper as owner
 *
 * Owner logic:
 * 1. Check registrant
 * 2. If registrant == NameWrapper address → owner is wrappedOwner
 * 3. If registrant != NameWrapper address → owner is registrant
 * 4. If expired + 90 days grace + 21 days premium (111 days total) → owner is null
 */

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const BATCH_SIZE = 100;
const GRACE_PERIOD_DAYS = 90;
const PREMIUM_PERIOD_DAYS = 21;
const TOTAL_EXPIRY_BUFFER_MS = (GRACE_PERIOD_DAYS + PREMIUM_PERIOD_DAYS) * 24 * 60 * 60 * 1000; // 111 days in ms
const DRY_RUN = process.argv.includes('--dry-run');

interface GraphDomain {
  name: string;
  registrant?: { id: string };
  wrappedOwner?: { id: string };
  registration?: {
    expiryDate: string | number;
  };
}

async function queryGraphByName(names: string[]): Promise<Map<string, GraphDomain>> {
  const query = `
    query GetDomains($names: [String!]!) {
      domains(where: { name_in: $names }, first: 1000) {
        name
        registrant { id }
        wrappedOwner { id }
        registration {
          expiryDate
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      GRAPH_ENS_SUBGRAPH_URL,
      { query, variables: { names } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    if (response.data.errors) {
      console.error(`GraphQL errors:`, response.data.errors);
      return new Map();
    }

    const domains = response.data.data?.domains || [];
    const map = new Map<string, GraphDomain>();
    for (const d of domains) {
      map.set(d.name, d);
    }
    return map;
  } catch (error: any) {
    console.error(`Error querying Graph:`, error.message);
    return new Map();
  }
}

/**
 * Get the correct owner based on registrant and expiry
 * Returns null if:
 * - Name is fully expired (past grace + premium period)
 * - Can't determine owner (no registrant)
 */
function getCorrectOwner(domain: GraphDomain): string | null {
  // Check if fully expired (expiry + 111 days)
  if (domain.registration?.expiryDate) {
    const expiryTimestamp = typeof domain.registration.expiryDate === 'string'
      ? parseInt(domain.registration.expiryDate)
      : domain.registration.expiryDate;
    const expiryMs = expiryTimestamp * 1000;
    const fullyExpiredAt = expiryMs + TOTAL_EXPIRY_BUFFER_MS;

    if (Date.now() > fullyExpiredAt) {
      return null; // Fully expired, no owner
    }
  }

  // No registrant = can't determine owner
  if (!domain.registrant?.id) {
    return null;
  }

  const registrant = domain.registrant.id.toLowerCase();

  // If registrant is NameWrapper, owner is wrappedOwner
  if (registrant === NAME_WRAPPER_ADDRESS.toLowerCase()) {
    if (!domain.wrappedOwner?.id) {
      return null; // Wrapped but no wrappedOwner, can't determine
    }
    return domain.wrappedOwner.id.toLowerCase();
  }

  // Otherwise, owner is registrant
  return registrant;
}

async function fixNamewrapperOwners() {
  const pool = getPostgresPool();

  console.log('=== Fix NameWrapper Owner Records ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}\n`);

  // Count affected records
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM ens_names WHERE owner_address = $1`,
    [NAME_WRAPPER_ADDRESS]
  );
  const total = parseInt(countResult.rows[0].count);
  console.log(`Found ${total.toLocaleString()} records to fix\n`);

  let processed = 0;
  let fixed = 0;
  let skipped = 0;
  let notFound = 0;
  let offset = 0;
  const startTime = Date.now();

  while (offset < total) {
    const result = await pool.query(
      `SELECT id, name FROM ens_names
       WHERE owner_address = $1
       ORDER BY id
       LIMIT $2 OFFSET $3`,
      [NAME_WRAPPER_ADDRESS, BATCH_SIZE, offset]
    );

    if (result.rows.length === 0) break;

    const names = result.rows.map(r => r.name);
    const domainMap = await queryGraphByName(names);

    for (const row of result.rows) {
      const { id, name } = row;
      const domain = domainMap.get(name);

      if (!domain) {
        notFound++;
        processed++;
        continue;
      }

      const realOwner = getCorrectOwner(domain);

      if (!realOwner) {
        // Can't determine owner, skip
        skipped++;
        processed++;
        continue;
      }

      if (realOwner === NAME_WRAPPER_ADDRESS.toLowerCase()) {
        // Still NameWrapper, skip (shouldn't happen but safety check)
        skipped++;
        processed++;
        continue;
      }

      // We have a valid owner to set
      if (!DRY_RUN) {
        await pool.query(
          `UPDATE ens_names SET owner_address = $1, updated_at = NOW() WHERE id = $2`,
          [realOwner, id]
        );
      }
      fixed++;
      processed++;
    }

    offset += BATCH_SIZE;

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const remaining = (total - processed) / rate;

    console.log(
      `Progress: ${processed.toLocaleString()}/${total.toLocaleString()} (${Math.round((processed/total)*100)}%) | ` +
      `Fixed: ${fixed.toLocaleString()} | Skipped: ${skipped.toLocaleString()} | Not Found: ${notFound.toLocaleString()} | ` +
      `Rate: ${Math.round(rate)}/s | ETA: ${Math.round(remaining/60)}m`
    );
  }

  console.log('\n=== Complete ===');
  console.log(`Total processed: ${processed.toLocaleString()}`);
  console.log(`Fixed: ${fixed.toLocaleString()}`);
  console.log(`Skipped (no valid owner): ${skipped.toLocaleString()}`);
  console.log(`Not found in Graph: ${notFound.toLocaleString()}`);

  // Verify
  const verifyResult = await pool.query(
    `SELECT COUNT(*) FROM ens_names WHERE owner_address = $1`,
    [NAME_WRAPPER_ADDRESS]
  );
  const remaining = parseInt(verifyResult.rows[0].count);
  console.log(`\nRemaining NameWrapper records: ${remaining.toLocaleString()}`);

  await pool.end();
}

fixNamewrapperOwners()
  .then(() => {
    console.log('\nScript completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
