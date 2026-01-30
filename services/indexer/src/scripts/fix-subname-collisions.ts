/**
 * Script to fix ENS subname collisions where subnames like "9604.holer.eth" were
 * incorrectly resolved to 2LDs like "9604.eth" due to labelhash-first lookup.
 *
 * Usage: npx tsx src/scripts/fix-subname-collisions.ts [--dry-run] [--verbose]
 */

import { namehash, labelhash, normalize } from 'viem/ens';
import { config, getPostgresPool } from '../../../shared/src';

const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401'.toLowerCase();
const ENS_SUBGRAPH_URL = config.theGraph?.ensSubgraphUrl || 'https://ensnode-api-production-500f.up.railway.app/subgraph';

const DRY_RUN = process.argv.includes('--dry-run');
const VERBOSE = process.argv.includes('--verbose');

interface NameRecord {
  id: number;
  token_id: string;
  name: string;
  owner_address: string;
  expiry_date: Date | null;
}

interface GraphDomain {
  id: string;
  name: string | null;
  labelName: string | null;
  labelhash: string;
  owner: { id: string } | null;
  registrant: { id: string } | null;
  wrappedOwner: { id: string } | null;
  registration: {
    expiryDate: string;
    registrationDate: string;
  } | null;
}

interface RelatedDataCounts {
  listings: number;
  offers: number;
  sales: number;
  activity: number;
}

function hexToDecimal(hex: string): string {
  const cleanHex = hex.startsWith('0x') ? hex.slice(2) : hex;
  return BigInt('0x' + cleanHex).toString(10);
}

/**
 * Query The Graph for a domain by its namehash
 */
async function queryGraphByNamehash(nameToQuery: string): Promise<GraphDomain | null> {
  const hash = namehash(nameToQuery);
  const hexString = BigInt(hash).toString(16).padStart(64, '0');
  const namehashHex = '0x' + hexString;

  const query = `
    query GetDomainByNamehash($namehash: String!) {
      domain(id: $namehash) {
        id
        name
        labelName
        labelhash
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

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.theGraph?.apiKey) {
    headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
  }

  try {
    const response = await fetch(ENS_SUBGRAPH_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: { namehash: namehashHex }
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json() as { data?: { domain?: GraphDomain } };
    return data.data?.domain || null;
  } catch {
    return null;
  }
}

/**
 * Get owner from Graph domain using same logic as ens-resolver:
 * - If registrant === NAME_WRAPPER_ADDRESS → use wrappedOwner
 * - If registrant !== NAME_WRAPPER_ADDRESS → use registrant
 * - If no registrant (subnames) → use wrappedOwner
 */
function getOwnerFromGraphDomain(domain: GraphDomain): string | null {
  if (domain.registrant?.id) {
    const registrant = domain.registrant.id.toLowerCase();
    if (registrant === NAME_WRAPPER_ADDRESS) {
      // Wrapped name: use wrappedOwner
      return domain.wrappedOwner?.id?.toLowerCase() || null;
    } else {
      // Unwrapped name: use registrant
      return registrant;
    }
  }

  // No registrant (subnames don't have registrant) - use wrappedOwner
  if (domain.wrappedOwner?.id) {
    return domain.wrappedOwner.id.toLowerCase();
  }

  return null;
}

/**
 * Get correct token_id using same logic as ens-resolver:
 * - If owner === NAME_WRAPPER_ADDRESS and not expired → use namehash (domain.id)
 * - Otherwise → use labelhash
 *
 * For subnames: always use namehash (they can't be in Base Registrar)
 */
function getCorrectTokenId(domain: GraphDomain, inputTokenId: string, isSubname: boolean): string {
  // Subnames always use namehash
  if (isSubname) {
    return hexToDecimal(domain.id);
  }

  const ownerAddr = domain.owner?.id?.toLowerCase();
  const isOwnedByWrapper = ownerAddr === NAME_WRAPPER_ADDRESS;

  // Check if expired using registration.expiryDate
  let isExpired = false;
  if (domain.registration?.expiryDate) {
    try {
      const expiryTimestamp = parseInt(domain.registration.expiryDate);
      isExpired = expiryTimestamp * 1000 < Date.now();
    } catch {
      // ignore
    }
  }

  if (isOwnedByWrapper && !isExpired) {
    // Wrapped, non-expired: use domain.id (namehash)
    return hexToDecimal(domain.id);
  } else {
    // Unwrapped or expired: use labelhash (input tokenId)
    return inputTokenId;
  }
}

/**
 * Get expiry date from Graph domain
 */
function getExpiryDate(domain: GraphDomain): Date | null {
  if (domain.registration?.expiryDate) {
    try {
      return new Date(parseInt(domain.registration.expiryDate) * 1000);
    } catch {
      return null;
    }
  }
  return null;
}

function computeNamehashTokenId(name: string): string {
  const hash = namehash(name);
  return BigInt(hash).toString(10);
}

function computeLabelhashTokenId(name: string): string | null {
  if (!name.endsWith('.eth')) return null;
  const parts = name.split('.');
  if (parts.length !== 2) return null;

  const label = parts[0];
  const hash = labelhash(label);
  return BigInt(hash).toString(10);
}

function isSubname(name: string): boolean {
  const dotCount = (name.match(/\./g) || []).length;
  return dotCount > 1;
}

/**
 * Check for related data that might be affected by the collision
 */
async function getRelatedDataCounts(pool: any, ensNameId: number): Promise<RelatedDataCounts> {
  const [listings, offers, sales, activity] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM listings WHERE ens_name_id = $1', [ensNameId]),
    pool.query('SELECT COUNT(*) FROM offers WHERE ens_name_id = $1', [ensNameId]),
    pool.query('SELECT COUNT(*) FROM sales WHERE ens_name_id = $1', [ensNameId]),
    pool.query('SELECT COUNT(*) FROM activity_history WHERE ens_name_id = $1', [ensNameId]),
  ]);

  return {
    listings: parseInt(listings.rows[0].count),
    offers: parseInt(offers.rows[0].count),
    sales: parseInt(sales.rows[0].count),
    activity: parseInt(activity.rows[0].count),
  };
}

async function main() {
  const pool = getPostgresPool();

  console.log('='.repeat(70));
  console.log('ENS Subname Collision Fix Script');
  console.log('='.repeat(70));
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'LIVE'}`);
  console.log('='.repeat(70));
  console.log();

  // Find all subnames
  console.log('Finding subnames...');

  const result = await pool.query<NameRecord>(`
    SELECT id, token_id, name, owner_address, expiry_date
    FROM ens_names
    WHERE name LIKE '%.%.eth'
      AND name NOT LIKE 'token-%'
      AND (LENGTH(name) - LENGTH(REPLACE(name, '.', ''))) > 1
    ORDER BY name
  `);

  const subnames = result.rows;
  console.log(`Found ${subnames.length} subnames`);
  console.log();

  let correctCount = 0;
  let mismatchCount = 0;
  let notFoundCount = 0;
  let fixedCount = 0;
  const affectedWithRelatedData: Array<{ name: string; id: number; counts: RelatedDataCounts }> = [];

  for (let i = 0; i < subnames.length; i++) {
    const record = subnames[i];
    const { id, token_id, name, owner_address, expiry_date } = record;

    if (VERBOSE || i % 100 === 0) {
      console.log(`[${i + 1}/${subnames.length}] ${name}`);
    }

    let normalizedName: string;
    try {
      normalizedName = normalize(name);
    } catch {
      continue;
    }

    // Query Graph by namehash
    const graphDomain = await queryGraphByNamehash(normalizedName);

    if (!graphDomain) {
      notFoundCount++;
      if (VERBOSE) console.log(`  NOT FOUND`);
      continue;
    }

    // Get correct values using resolver logic
    const correctTokenId = getCorrectTokenId(graphDomain, token_id, true);
    const graphOwner = getOwnerFromGraphDomain(graphDomain);
    const graphExpiry = getExpiryDate(graphDomain);

    const issues: string[] = [];

    if (token_id !== correctTokenId) {
      issues.push(`token_id: ${token_id} -> ${correctTokenId}`);
    }

    if (graphOwner && owner_address.toLowerCase() !== graphOwner.toLowerCase()) {
      issues.push(`owner: ${owner_address} -> ${graphOwner}`);
    }

    // Check expiry date (allow 1 day tolerance for timestamp differences)
    if (graphExpiry) {
      const dbExpiryTime = expiry_date ? expiry_date.getTime() : 0;
      const graphExpiryTime = graphExpiry.getTime();
      const dayInMs = 24 * 60 * 60 * 1000;
      if (Math.abs(dbExpiryTime - graphExpiryTime) > dayInMs) {
        issues.push(`expiry: ${expiry_date?.toISOString() || 'null'} -> ${graphExpiry.toISOString()}`);
      }
    }

    if (issues.length > 0) {
      mismatchCount++;
      console.log(`  MISMATCH: ${name}`);
      issues.forEach(iss => console.log(`    ${iss}`));

      // Check for related data that might be affected
      const relatedCounts = await getRelatedDataCounts(pool, id);
      const hasRelatedData = relatedCounts.listings > 0 || relatedCounts.offers > 0 ||
                             relatedCounts.sales > 0 || relatedCounts.activity > 0;

      if (hasRelatedData) {
        console.log(`    RELATED DATA: ${relatedCounts.listings} listings, ${relatedCounts.offers} offers, ${relatedCounts.sales} sales, ${relatedCounts.activity} activity`);
        affectedWithRelatedData.push({ name, id, counts: relatedCounts });
      }

      if (!DRY_RUN) {
        const newOwner = graphOwner || owner_address;
        await pool.query(
          `UPDATE ens_names SET token_id = $1, owner_address = $2, expiry_date = $3, updated_at = NOW() WHERE id = $4`,
          [correctTokenId, newOwner.toLowerCase(), graphExpiry, id]
        );
        console.log(`    FIXED`);
        fixedCount++;
      }
    } else {
      correctCount++;
    }

    if (i % 10 === 0) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // Check for 2LD collisions
  console.log();
  console.log('Checking 2LD collisions...');

  const potentialCollisions = new Set<string>();
  for (const record of subnames) {
    const parts = record.name.split('.');
    if (parts.length > 2) {
      potentialCollisions.add(`${parts[0]}.eth`);
    }
  }

  let twoLDMismatchCount = 0;

  for (const twoLDName of potentialCollisions) {
    const res = await pool.query<NameRecord>(
      'SELECT id, token_id, name FROM ens_names WHERE name = $1',
      [twoLDName]
    );

    if (res.rows.length === 0) continue;

    const dbRecord = res.rows[0];

    // Query Graph for this 2LD
    const graphDomain = await queryGraphByNamehash(twoLDName);
    if (!graphDomain) continue;

    // Get correct token_id using resolver logic (not a subname)
    const correctTokenId = getCorrectTokenId(graphDomain, dbRecord.token_id, false);

    // Also compute labelhash for comparison
    const labelhashTokenId = computeLabelhashTokenId(twoLDName);

    if (dbRecord.token_id !== correctTokenId) {
      console.log(`  2LD COLLISION: ${twoLDName}`);
      console.log(`    token_id: ${dbRecord.token_id}`);
      console.log(`    correct:  ${correctTokenId}`);
      twoLDMismatchCount++;

      if (!DRY_RUN) {
        await pool.query(
          `UPDATE ens_names SET token_id = $1, updated_at = NOW() WHERE id = $2`,
          [correctTokenId, dbRecord.id]
        );
        console.log(`    FIXED`);
      }
    }

    await new Promise(r => setTimeout(r, 50));
  }

  console.log();
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`Subnames: ${subnames.length} checked, ${correctCount} correct, ${mismatchCount} mismatched, ${notFoundCount} not found`);
  console.log(`2LD collisions: ${twoLDMismatchCount}`);
  if (!DRY_RUN) console.log(`Fixed: ${fixedCount}`);

  if (affectedWithRelatedData.length > 0) {
    console.log();
    console.log('='.repeat(70));
    console.log(`WARNING: ${affectedWithRelatedData.length} affected records have related data that may need review:`);
    console.log('='.repeat(70));
    for (const item of affectedWithRelatedData) {
      console.log(`  ${item.name} (id=${item.id}): ${item.counts.listings}L ${item.counts.offers}O ${item.counts.sales}S ${item.counts.activity}A`);
    }
    console.log();
    console.log('Related data (listings/offers/sales/activity) may be pointing to the wrong name.');
    console.log('Review order_data in these records to determine which name they actually belong to.');
  }
  if (DRY_RUN) console.log('DRY RUN - no changes made');

  await pool.end();
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
