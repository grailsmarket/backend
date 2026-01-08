import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

/**
 * Fix owner addresses, expiry dates, and registration dates for ENS names
 *
 * Owner logic:
 * 1. Check registrant
 * 2. If registrant == NameWrapper address → owner is wrappedOwner
 * 3. If registrant != NameWrapper address → owner is registrant
 * 4. If expired + 90 days grace + 21 days premium (111 days total) → owner is null
 */

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const BATCH_SIZE = 1000;
const GRACE_PERIOD_DAYS = 90;
const PREMIUM_PERIOD_DAYS = 21;
const TOTAL_EXPIRY_BUFFER_MS = (GRACE_PERIOD_DAYS + PREMIUM_PERIOD_DAYS) * 24 * 60 * 60 * 1000; // 111 days in ms
const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

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
  name: string;
  registrant?: { id: string };
  wrappedOwner?: { id: string };
  registration?: {
    expiryDate: string | number;
    registrationDate: string | number;
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
          registrationDate
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

async function fixOwnerAddresses() {
  const pool = getPostgresPool();

  console.log('=== ENS Name Data Fix Script ===');
  console.log('Updates: owner_address, expiry_date, registration_date');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Verbose: ${VERBOSE}\n`);

  if (START_ID > 0) {
    console.log(`Starting from ID: ${START_ID}\n`);
  }

  // Get total count
  const countResult = await pool.query(
    `SELECT COUNT(*) FROM ens_names WHERE name NOT LIKE 'token-%' AND id >= $1`,
    [START_ID]
  );
  const total = parseInt(countResult.rows[0].count);
  console.log(`Total names to process: ${total.toLocaleString()}\n`);

  let processed = 0;
  let ownerUpdated = 0;
  let expiryUpdated = 0;
  let registrationUpdated = 0;
  let skippedNoOwner = 0;
  let notFound = 0;
  let unchanged = 0;
  let offset = 0;
  const startTime = Date.now();

  while (offset < total) {
    const result = await pool.query(
      `SELECT id, name, owner_address, expiry_date, registration_date
       FROM ens_names
       WHERE name NOT LIKE 'token-%'
       AND id >= $1
       ORDER BY id
       LIMIT $2 OFFSET $3`,
      [START_ID, BATCH_SIZE, offset]
    );

    if (result.rows.length === 0) break;

    const names = result.rows.map(r => r.name);
    const domainMap = await queryGraphByName(names);

    for (const row of result.rows) {
      const { id, name, owner_address: currentOwner, expiry_date: currentExpiry, registration_date: currentRegistration } = row;

      const domain = domainMap.get(name);
      if (!domain) {
        notFound++;
        processed++;
        continue;
      }

      // Get correct owner (may be null if expired or can't determine)
      const correctOwner = getCorrectOwner(domain);

      // Get correct dates
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

      // Determine what needs updating
      let ownerNeedsUpdate = false;
      if (correctOwner) {
        ownerNeedsUpdate = currentOwner.toLowerCase() !== correctOwner;
      } else {
        // correctOwner is null - skip owner update but track it
        skippedNoOwner++;
      }

      const expiryNeedsUpdate = correctExpiry &&
        (!currentExpiry || new Date(currentExpiry).getTime() !== correctExpiry.getTime());

      const registrationNeedsUpdate = correctRegistration &&
        (!currentRegistration || new Date(currentRegistration).getTime() !== correctRegistration.getTime());

      if (!ownerNeedsUpdate && !expiryNeedsUpdate && !registrationNeedsUpdate) {
        unchanged++;
        processed++;
        continue;
      }

      // Build update
      const updates: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;

      if (ownerNeedsUpdate && correctOwner) {
        updates.push(`owner_address = $${paramIndex++}`);
        values.push(correctOwner);
      }
      if (expiryNeedsUpdate) {
        updates.push(`expiry_date = $${paramIndex++}`);
        values.push(correctExpiry);
      }
      if (registrationNeedsUpdate) {
        updates.push(`registration_date = $${paramIndex++}`);
        values.push(correctRegistration);
      }

      if (updates.length === 0) {
        unchanged++;
        processed++;
        continue;
      }

      updates.push('updated_at = NOW()');
      values.push(id);

      if (VERBOSE) {
        console.log(`[UPDATE] ${name}`);
        if (ownerNeedsUpdate) console.log(`  Owner: ${currentOwner} -> ${correctOwner}`);
        if (expiryNeedsUpdate) console.log(`  Expiry: ${currentExpiry} -> ${correctExpiry}`);
        if (registrationNeedsUpdate) console.log(`  Registration: ${currentRegistration} -> ${correctRegistration}`);
      }

      if (!DRY_RUN) {
        await pool.query(
          `UPDATE ens_names SET ${updates.join(', ')} WHERE id = $${paramIndex}`,
          values
        );
      }

      if (ownerNeedsUpdate) ownerUpdated++;
      if (expiryNeedsUpdate) expiryUpdated++;
      if (registrationNeedsUpdate) registrationUpdated++;
      processed++;
    }

    offset += BATCH_SIZE;

    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const remaining = (total - processed) / rate;

    console.log(
      `Progress: ${processed.toLocaleString()}/${total.toLocaleString()} (${Math.round((processed/total)*100)}%) | ` +
      `Owner: ${ownerUpdated.toLocaleString()} | Expiry: ${expiryUpdated.toLocaleString()} | Reg: ${registrationUpdated.toLocaleString()} | ` +
      `Unchanged: ${unchanged.toLocaleString()} | Rate: ${Math.round(rate)}/s | ETA: ${Math.round(remaining/60)}m | ID: ${result.rows[result.rows.length - 1].id}`
    );
  }

  console.log('\n=== Complete ===');
  console.log(`Total processed: ${processed.toLocaleString()}`);
  console.log(`Owner updated: ${ownerUpdated.toLocaleString()}`);
  console.log(`Expiry updated: ${expiryUpdated.toLocaleString()}`);
  console.log(`Registration updated: ${registrationUpdated.toLocaleString()}`);
  console.log(`Unchanged: ${unchanged.toLocaleString()}`);
  console.log(`Skipped owner (null/expired): ${skippedNoOwner.toLocaleString()}`);
  console.log(`Not found in Graph: ${notFound.toLocaleString()}`);

  await pool.end();
}

fixOwnerAddresses()
  .then(() => {
    console.log('\nScript completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
