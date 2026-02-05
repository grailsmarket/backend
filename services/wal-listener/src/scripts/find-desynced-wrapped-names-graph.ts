import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

/**
 * Script to detect wrapped ENS names with out-of-sync expiry dates
 *
 * GRAPH VERSION - Uses The Graph ENS subgraph for reliable data
 *
 * A name is desynced when:
 * - registrant === NameWrapper (name is wrapped)
 * - wrapperExpiry !== registrarExpiry + GRACE_PERIOD
 *
 * Reference: https://github.com/ensdomains/ens-app-v3/pull/1107
 *
 * Usage:
 *   node dist/.../find-desynced-wrapped-names-graph.js [--save] [--limit=N] [--verbose] [--name=example.eth]
 */

const GRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';

// Grace period: 90 days in seconds
const GRACE_PERIOD = 90 * 24 * 60 * 60; // 7,776,000 seconds

// CLI arguments
const DRY_RUN = !process.argv.includes('--save');
const VERBOSE = process.argv.includes('--verbose');

let LIMIT = 0;
const limitArg = process.argv.find(arg => arg.startsWith('--limit='));
if (limitArg) {
  LIMIT = parseInt(limitArg.split('=')[1]);
}

let SPECIFIC_NAME: string | null = null;
const nameArg = process.argv.find(arg => arg.startsWith('--name='));
if (nameArg) {
  SPECIFIC_NAME = nameArg.split('=')[1];
  if (!SPECIFIC_NAME.endsWith('.eth')) {
    SPECIFIC_NAME = SPECIFIC_NAME + '.eth';
  }
}

// Batch settings
const BATCH_SIZE = 100;
const GRAPH_DELAY_MS = 100;

interface GraphDomain {
  name: string;
  registrant: { id: string } | null;
  wrappedOwner: { id: string } | null;
  registration: {
    expiryDate: string;
  } | null;
  wrappedDomain: {
    expiryDate: string;
  } | null;
}

interface DesyncedName {
  name: string;
  registrarExpiry: number;
  wrapperExpiry: number;
  expectedWrapperExpiry: number;
  diffSeconds: number;
  diffDays: number;
  wrapperExpired: boolean; // true if wrapper thinks name is expired NOW
}

/**
 * Query The Graph for domain data by names
 */
async function queryGraphByNames(names: string[]): Promise<Map<string, GraphDomain>> {
  const query = `
    query GetDomains($names: [String!]!) {
      domains(where: { name_in: $names }, first: 1000) {
        name
        registrant { id }
        wrappedOwner { id }
        registration {
          expiryDate
        }
        wrappedDomain {
          expiryDate
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      GRAPH_URL,
      { query, variables: { names } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    if (response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
      return new Map();
    }

    const domains = response.data.data?.domains || [];
    const map = new Map<string, GraphDomain>();
    for (const d of domains) {
      map.set(d.name, d);
    }
    return map;
  } catch (error: any) {
    console.error('Error querying Graph:', error.message);
    return new Map();
  }
}

/**
 * Check a specific name for desync status using The Graph
 */
async function checkSpecificName(name: string) {
  console.log(`Checking: ${name}\n`);

  const domainMap = await queryGraphByNames([name]);
  const domain = domainMap.get(name);

  if (!domain) {
    console.log('Name not found in The Graph');
    return;
  }

  console.log('=== Graph Data ===');
  console.log(`Registrant: ${domain.registrant?.id || 'null'}`);
  console.log(`Wrapped Owner: ${domain.wrappedOwner?.id || 'null'}`);

  const isWrapped = domain.registrant?.id?.toLowerCase() === NAME_WRAPPER;
  console.log(`Is Wrapped: ${isWrapped}`);

  if (!isWrapped) {
    console.log('\nName is NOT wrapped - desync check not applicable.');
    return;
  }

  if (!domain.registration?.expiryDate || !domain.wrappedDomain?.expiryDate) {
    console.log('\nMissing expiry data in Graph');
    return;
  }

  const registrarExpiry = parseInt(domain.registration.expiryDate);
  const wrapperExpiry = parseInt(domain.wrappedDomain.expiryDate);
  const expectedWrapperExpiry = registrarExpiry + GRACE_PERIOD;

  console.log('');
  console.log('=== Expiry Comparison ===');
  console.log(`Registrar expiry:        ${new Date(registrarExpiry * 1000).toISOString()} (${registrarExpiry})`);
  console.log(`Wrapper expiry:          ${new Date(wrapperExpiry * 1000).toISOString()} (${wrapperExpiry})`);
  console.log(`Expected wrapper expiry: ${new Date(expectedWrapperExpiry * 1000).toISOString()} (${expectedWrapperExpiry})`);
  console.log(`Grace period:            ${GRACE_PERIOD / 86400} days (${GRACE_PERIOD} seconds)`);
  console.log('');

  const diff = expectedWrapperExpiry - wrapperExpiry;
  const diffDays = diff / 86400;
  const now = Math.floor(Date.now() / 1000);
  const wrapperExpired = wrapperExpiry < now;
  const registrarExpired = registrarExpiry < now;

  console.log(`Actual diff (wrapper - registrar): ${(wrapperExpiry - registrarExpiry) / 86400} days`);
  console.log(`Expected diff: 90 days`);
  console.log(`Desync amount: ${diffDays.toFixed(2)} days`);
  console.log('');
  console.log(`Wrapper expired: ${wrapperExpired} (${wrapperExpired ? 'YES - purchases will fail!' : 'No'})`);
  console.log(`Registrar expired: ${registrarExpired}`);
  console.log('');

  if (diff > 0) {
    const severity = wrapperExpired ? '🚨 CRITICAL' : '⚠️  WARNING';
    console.log(`${severity}: NAME IS DESYNCED!`);
    console.log(`   Wrapper expiry is ${diffDays.toFixed(2)} days behind expected.`);
    if (wrapperExpired && !registrarExpired) {
      console.log('');
      console.log('   🚨 PURCHASES WILL FAIL: Wrapper thinks name is expired,');
      console.log('      but registrar says it is still valid!');
    }
    console.log('');
    console.log('This name was likely renewed through the old ETHRegistrarController');
    console.log('instead of the NameWrapper-aware controller.');
  } else if (diff < 0) {
    console.log(`ℹ️  Wrapper expiry is ${Math.abs(diffDays).toFixed(2)} days AHEAD of expected (unusual).`);
  } else {
    console.log(`✅ Name is properly synced.`);
  }
}

/**
 * Query The Graph for all wrapped .eth names with pagination
 */
async function queryAllWrappedDomains(afterId: string = ''): Promise<GraphDomain[]> {
  const query = `
    query GetWrappedDomains($afterId: ID!) {
      domains(
        where: {
          name_ends_with: ".eth"
          name_not_contains: "."
          registrant: "${NAME_WRAPPER}"
          registration_not: null
          wrappedDomain_not: null
        }
        first: 1000
        orderBy: id
        where: { id_gt: $afterId }
      ) {
        id
        name
        registrant { id }
        wrappedOwner { id }
        registration {
          expiryDate
        }
        wrappedDomain {
          expiryDate
        }
      }
    }
  `;

  // Alternative query that's more reliable
  const altQuery = `
    query GetWrappedDomains($skip: Int!) {
      domains(
        where: {
          registrant: "${NAME_WRAPPER}"
          registration_not: null
          wrappedDomain_not: null
        }
        first: 1000
        skip: $skip
        orderBy: createdAt
        orderDirection: desc
      ) {
        name
        registrant { id }
        wrappedOwner { id }
        registration {
          expiryDate
        }
        wrappedDomain {
          expiryDate
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      GRAPH_URL,
      { query: altQuery, variables: { skip: 0 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 60000 }
    );

    if (response.data.errors) {
      console.error('GraphQL errors:', response.data.errors);
      return [];
    }

    return response.data.data?.domains || [];
  } catch (error: any) {
    console.error('Error querying Graph:', error.message);
    return [];
  }
}

async function main() {
  const pool = getPostgresPool();

  console.log('=== Find Desynced Wrapped ENS Names (Graph Version) ===');
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN (use --save to persist)' : 'SAVING RESULTS'}`);
  console.log(`Graph URL: ${GRAPH_URL}`);
  if (LIMIT > 0) console.log(`Limit: ${LIMIT}`);
  if (SPECIFIC_NAME) console.log(`Checking specific name: ${SPECIFIC_NAME}`);
  console.log('');

  // If checking a specific name, do that directly
  if (SPECIFIC_NAME) {
    await checkSpecificName(SPECIFIC_NAME);
    await pool.end();
    return;
  }

  // Get .eth names from database to check
  const countQuery = `
    SELECT COUNT(*) FROM ens_names
    WHERE name LIKE '%.eth'
    AND name NOT LIKE '%.%.eth'
    AND expiry_date > NOW() - INTERVAL '111 days'
  `;
  const countResult = await pool.query(countQuery);
  const totalInDb = parseInt(countResult.rows[0].count);
  const total = LIMIT > 0 ? Math.min(totalInDb, LIMIT) : totalInDb;

  console.log(`Total .eth names in database: ${totalInDb.toLocaleString()}`);
  console.log(`Names to check: ${total.toLocaleString()}${LIMIT > 0 ? ` (limited)` : ''}\n`);

  const allDesynced: DesyncedName[] = [];
  let processed = 0;
  let wrapped = 0;
  let unwrapped = 0;
  let notFound = 0;
  let offset = 0;
  const startTime = Date.now();

  while (processed < total) {
    const remainingToProcess = total - processed;
    const batchLimit = Math.min(BATCH_SIZE, remainingToProcess);

    // Fetch names from database
    const result = await pool.query(
      `SELECT name FROM ens_names
       WHERE name LIKE '%.eth'
       AND name NOT LIKE '%.%.eth'
       AND expiry_date > NOW() - INTERVAL '111 days'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [batchLimit, offset]
    );

    if (result.rows.length === 0) break;

    const names = result.rows.map((r: any) => r.name);

    // Query The Graph for these names
    const domainMap = await queryGraphByNames(names);

    // Process results
    for (const name of names) {
      const domain = domainMap.get(name);

      if (!domain) {
        notFound++;
        processed++;
        continue;
      }

      // Check if wrapped (registrant is NameWrapper)
      const isWrapped = domain.registrant?.id?.toLowerCase() === NAME_WRAPPER;

      if (!isWrapped) {
        unwrapped++;
        processed++;
        continue;
      }

      wrapped++;

      // Check for missing expiry data
      if (!domain.registration?.expiryDate || !domain.wrappedDomain?.expiryDate) {
        if (VERBOSE) {
          console.log(`  [SKIP] ${name}: missing expiry data`);
        }
        processed++;
        continue;
      }

      const registrarExpiry = parseInt(domain.registration.expiryDate);
      const wrapperExpiry = parseInt(domain.wrappedDomain.expiryDate);
      const expectedWrapperExpiry = registrarExpiry + GRACE_PERIOD;

      // Check for desync (wrapper expiry < expected)
      const diff = expectedWrapperExpiry - wrapperExpiry;
      const now = Math.floor(Date.now() / 1000);
      const wrapperExpired = wrapperExpiry < now;

      if (diff > 0) {
        const diffDays = diff / 86400;

        allDesynced.push({
          name,
          registrarExpiry,
          wrapperExpiry,
          expectedWrapperExpiry,
          diffSeconds: diff,
          diffDays,
          wrapperExpired,
        });

        const severity = wrapperExpired ? '🚨 CRITICAL' : '⚠️  WARNING';
        console.log(`\n${severity}: ${name} (diff: ${diffDays.toFixed(2)} days${wrapperExpired ? ', WRAPPER EXPIRED!' : ''})`);
      }

      processed++;
    }

    offset += batchLimit;

    // Progress update
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = processed / elapsed;
    const eta = (total - processed) / rate;

    process.stdout.write(
      `\rProgress: ${processed.toLocaleString()}/${total.toLocaleString()} (${Math.round((processed / total) * 100)}%) | ` +
      `Wrapped: ${wrapped.toLocaleString()} | Unwrapped: ${unwrapped.toLocaleString()} | ` +
      `Desynced: ${allDesynced.length} | Not Found: ${notFound} | ` +
      `Rate: ${Math.round(rate)}/s | ETA: ${Math.round(eta)}s    `
    );

    // Small delay to avoid rate limiting
    await new Promise(resolve => setTimeout(resolve, GRAPH_DELAY_MS));
  }

  const totalTime = (Date.now() - startTime) / 1000;

  const criticalCount = allDesynced.filter(d => d.wrapperExpired).length;
  const warningCount = allDesynced.filter(d => !d.wrapperExpired).length;

  console.log('\n\n=== Results ===');
  console.log(`Total processed: ${processed.toLocaleString()}`);
  console.log(`Wrapped names: ${wrapped.toLocaleString()}`);
  console.log(`Unwrapped names: ${unwrapped.toLocaleString()}`);
  console.log(`Not found in Graph: ${notFound.toLocaleString()}`);
  console.log(`Desynced names found: ${allDesynced.length}`);
  console.log(`  🚨 Critical (wrapper expired): ${criticalCount}`);
  console.log(`  ⚠️  Warning (wrapper not yet expired): ${warningCount}`);
  console.log(`Total time: ${Math.round(totalTime)}s (${Math.round(processed / totalTime)}/s)`);

  if (allDesynced.length > 0) {
    // Sort: critical first (wrapper expired), then by diff (largest first)
    allDesynced.sort((a, b) => {
      if (a.wrapperExpired !== b.wrapperExpired) {
        return a.wrapperExpired ? -1 : 1;
      }
      return b.diffSeconds - a.diffSeconds;
    });

    if (criticalCount > 0) {
      console.log('\n=== 🚨 CRITICAL: Wrapper Already Expired (purchases will fail) ===');
      for (const d of allDesynced.filter(x => x.wrapperExpired)) {
        console.log(`  ${d.name} - diff: ${d.diffDays.toFixed(2)} days`);
      }
    }

    if (warningCount > 0) {
      console.log('\n=== ⚠️  WARNING: Desynced but not yet expired ===');
      for (const d of allDesynced.filter(x => !x.wrapperExpired)) {
        console.log(`  ${d.name} - diff: ${d.diffDays.toFixed(2)} days`);
      }
    }

    // Save to file
    if (!DRY_RUN) {
      const fs = await import('fs');

      // CSV output
      const csvHeader = 'name,severity,diff_days,wrapper_expired,registrar_expiry,wrapper_expiry,expected_wrapper_expiry,diff_seconds';
      const csvRows = allDesynced.map(d => [
        d.name,
        d.wrapperExpired ? 'critical' : 'warning',
        d.diffDays.toFixed(2),
        d.wrapperExpired ? 'true' : 'false',
        new Date(d.registrarExpiry * 1000).toISOString(),
        new Date(d.wrapperExpiry * 1000).toISOString(),
        new Date(d.expectedWrapperExpiry * 1000).toISOString(),
        d.diffSeconds,
      ].join(','));

      const csvContent = [csvHeader, ...csvRows].join('\n');
      const csvPath = 'desynced-names-graph.csv';
      fs.writeFileSync(csvPath, csvContent);
      console.log(`\nResults saved to ${csvPath}`);
      console.log(`  Total: ${allDesynced.length} | Critical: ${criticalCount} | Warning: ${warningCount}`);
    } else {
      console.log('\n[DRY RUN] Run with --save to persist results to desynced-names-graph.csv');
    }
  }

  await pool.end();
}

main()
  .then(() => {
    console.log('\nScript completed');
    process.exit(0);
  })
  .catch((err) => {
    console.error('\nScript failed:', err);
    process.exit(1);
  });
