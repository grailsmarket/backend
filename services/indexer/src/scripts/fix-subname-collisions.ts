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

interface RelatedRecord {
  id: number;
  ens_name_id: number;
  order_data: any;
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
 * Batch query The Graph for multiple domains by namehash
 */
async function queryGraphByNamehashBatch(names: string[]): Promise<Map<string, GraphDomain>> {
  const results = new Map<string, GraphDomain>();
  if (names.length === 0) return results;

  const namehashes = names.map(name => {
    const hash = namehash(name);
    const hexString = BigInt(hash).toString(16).padStart(64, '0');
    return '0x' + hexString;
  });

  const query = `
    query GetDomainsByNamehash($namehashes: [String!]!) {
      domains(where: { id_in: $namehashes }) {
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
        variables: { namehashes }
      }),
    });

    if (!response.ok) {
      return results;
    }

    const data = await response.json() as { data?: { domains?: GraphDomain[] } };
    const domains = data.data?.domains || [];

    for (const domain of domains) {
      if (domain.name) {
        results.set(domain.name.toLowerCase(), domain);
      }
    }
  } catch {
    // ignore
  }

  return results;
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
      return domain.wrappedOwner?.id?.toLowerCase() || null;
    } else {
      return registrant;
    }
  }

  if (domain.wrappedOwner?.id) {
    return domain.wrappedOwner.id.toLowerCase();
  }

  return null;
}

/**
 * Get correct token_id using same logic as ens-resolver
 */
function getCorrectTokenId(domain: GraphDomain, inputTokenId: string, isSubname: boolean): string {
  if (isSubname) {
    return hexToDecimal(domain.id);
  }

  const ownerAddr = domain.owner?.id?.toLowerCase();
  const isOwnedByWrapper = ownerAddr === NAME_WRAPPER_ADDRESS;

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
    return hexToDecimal(domain.id);
  } else {
    return inputTokenId;
  }
}

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

/**
 * Extract token_id from order_data (OpenSea payload)
 */
function extractTokenIdFromOrderData(orderData: any): string | null {
  try {
    // OpenSea order_data has item.nft_id like "ethereum/0x.../tokenId"
    const nftId = orderData?.item?.nft_id || orderData?.payload?.item?.nft_id;
    if (nftId) {
      const tokenId = nftId.split('/').pop();
      if (tokenId) return tokenId;
    }

    // Also check protocol_data for Seaport orders
    const offerItem = orderData?.protocol_data?.parameters?.offer?.[0];
    if (offerItem?.identifierOrCriteria) {
      return offerItem.identifierOrCriteria;
    }
  } catch {
    // ignore
  }
  return null;
}

/**
 * Determine which name a token_id belongs to by checking if it matches namehash or labelhash
 */
function determineNameForTokenId(tokenId: string, subnameName: string, twoLDName: string): string | null {
  const subnameNamehash = computeNamehashTokenId(subnameName);
  const twoLDLabelhash = computeLabelhashTokenId(twoLDName);
  const twoLDNamehash = computeNamehashTokenId(twoLDName);

  if (tokenId === subnameNamehash) {
    return subnameName;
  }
  if (tokenId === twoLDLabelhash || tokenId === twoLDNamehash) {
    return twoLDName;
  }
  return null;
}

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

  // Build map of potential 2LD collisions (first label -> subname records)
  const twoLDToSubnames = new Map<string, NameRecord[]>();
  for (const record of subnames) {
    const parts = record.name.split('.');
    if (parts.length > 2) {
      const twoLD = `${parts[0]}.eth`;
      if (!twoLDToSubnames.has(twoLD)) {
        twoLDToSubnames.set(twoLD, []);
      }
      twoLDToSubnames.get(twoLD)!.push(record);
    }
  }

  let correctCount = 0;
  let mismatchCount = 0;
  let notFoundCount = 0;
  let fixedCount = 0;
  let relatedDataFixedCount = 0;
  const affectedWithRelatedData: Array<{ name: string; id: number; counts: RelatedDataCounts }> = [];

  // Process subnames
  console.log('Processing subnames...');
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

    const graphDomain = await queryGraphByNamehash(normalizedName);

    if (!graphDomain) {
      notFoundCount++;
      if (VERBOSE) console.log(`  NOT FOUND`);
      continue;
    }

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

      const relatedCounts = await getRelatedDataCounts(pool, id);
      const hasRelatedData = relatedCounts.listings > 0 || relatedCounts.offers > 0 ||
                             relatedCounts.sales > 0 || relatedCounts.activity > 0;

      if (hasRelatedData) {
        console.log(`    RELATED DATA: ${relatedCounts.listings} listings, ${relatedCounts.offers} offers, ${relatedCounts.sales} sales, ${relatedCounts.activity} activity`);
        affectedWithRelatedData.push({ name, id, counts: relatedCounts });
      }

      if (!DRY_RUN) {
        const newOwner = graphOwner || owner_address;

        // Check if a record with the correct token_id already exists
        const existingWithTokenId = await pool.query(
          `SELECT id, name FROM ens_names WHERE token_id = $1 AND id != $2`,
          [correctTokenId, id]
        );

        if (existingWithTokenId.rows.length > 0) {
          // Record with correct token_id exists - merge data to it and delete this duplicate
          const correctRecord = existingWithTokenId.rows[0];
          console.log(`    DUPLICATE: Correct record exists (id=${correctRecord.id}, name=${correctRecord.name})`);
          console.log(`    Moving related data from id=${id} to id=${correctRecord.id} and deleting duplicate...`);

          // Move related data to the correct record
          await pool.query(`UPDATE listings SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, id]);
          await pool.query(`UPDATE offers SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, id]);
          await pool.query(`UPDATE sales SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, id]);
          await pool.query(`UPDATE activity_history SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, id]);
          await pool.query(`UPDATE transactions SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, id]);

          // Delete the duplicate record
          await pool.query(`DELETE FROM ens_names WHERE id = $1`, [id]);
          console.log(`    MERGED & DELETED duplicate`);
        } else {
          // No duplicate - safe to update
          await pool.query(
            `UPDATE ens_names SET token_id = $1, owner_address = $2, expiry_date = $3, updated_at = NOW() WHERE id = $4`,
            [correctTokenId, newOwner.toLowerCase(), graphExpiry, id]
          );
          console.log(`    FIXED`);
        }
        fixedCount++;
      }
    } else {
      correctCount++;
    }

    if (i % 10 === 0) {
      await new Promise(r => setTimeout(r, 50));
    }
  }

  // Check for 2LD collisions - batch query
  console.log();
  console.log('Checking 2LD collisions (batched)...');

  const potential2LDs = Array.from(twoLDToSubnames.keys());
  console.log(`  ${potential2LDs.length} potential 2LDs to check`);

  // Batch query DB for all potential 2LDs
  const twoLDRecordsResult = await pool.query<NameRecord>(
    `SELECT id, token_id, name, owner_address, expiry_date
     FROM ens_names
     WHERE name = ANY($1)`,
    [potential2LDs]
  );

  const twoLDRecords = new Map<string, NameRecord>();
  for (const row of twoLDRecordsResult.rows) {
    twoLDRecords.set(row.name, row);
  }

  console.log(`  ${twoLDRecords.size} 2LDs exist in database`);

  // Batch query Graph for existing 2LDs
  const existingTwoLDs = Array.from(twoLDRecords.keys());
  const BATCH_SIZE = 100;
  const graphResults = new Map<string, GraphDomain>();

  for (let i = 0; i < existingTwoLDs.length; i += BATCH_SIZE) {
    const batch = existingTwoLDs.slice(i, i + BATCH_SIZE);
    console.log(`  Querying Graph batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(existingTwoLDs.length / BATCH_SIZE)}...`);
    const batchResults = await queryGraphByNamehashBatch(batch);
    for (const [name, domain] of batchResults) {
      graphResults.set(name, domain);
    }
    await new Promise(r => setTimeout(r, 100));
  }

  let twoLDMismatchCount = 0;

  for (const [twoLDName, dbRecord] of twoLDRecords) {
    const graphDomain = graphResults.get(twoLDName.toLowerCase());
    if (!graphDomain) continue;

    const correctTokenId = getCorrectTokenId(graphDomain, dbRecord.token_id, false);

    if (dbRecord.token_id !== correctTokenId) {
      console.log(`  2LD COLLISION: ${twoLDName}`);
      console.log(`    token_id: ${dbRecord.token_id} -> ${correctTokenId}`);
      twoLDMismatchCount++;

      if (!DRY_RUN) {
        // Check if a record with the correct token_id already exists
        const existingWithTokenId = await pool.query(
          `SELECT id, name FROM ens_names WHERE token_id = $1 AND id != $2`,
          [correctTokenId, dbRecord.id]
        );

        if (existingWithTokenId.rows.length > 0) {
          const correctRecord = existingWithTokenId.rows[0];
          console.log(`    DUPLICATE: Correct record exists (id=${correctRecord.id}, name=${correctRecord.name})`);
          console.log(`    Moving related data and deleting duplicate...`);

          await pool.query(`UPDATE listings SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, dbRecord.id]);
          await pool.query(`UPDATE offers SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, dbRecord.id]);
          await pool.query(`UPDATE sales SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, dbRecord.id]);
          await pool.query(`UPDATE activity_history SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, dbRecord.id]);
          await pool.query(`UPDATE transactions SET ens_name_id = $1 WHERE ens_name_id = $2`, [correctRecord.id, dbRecord.id]);

          await pool.query(`DELETE FROM ens_names WHERE id = $1`, [dbRecord.id]);
          console.log(`    MERGED & DELETED duplicate`);
        } else {
          await pool.query(
            `UPDATE ens_names SET token_id = $1, updated_at = NOW() WHERE id = $2`,
            [correctTokenId, dbRecord.id]
          );
          console.log(`    FIXED`);
        }
      }
    }
  }

  // Fix related data - examine order_data to determine correct ownership
  console.log();
  console.log('Analyzing related data for affected records...');

  for (const affected of affectedWithRelatedData) {
    const parts = affected.name.split('.');
    if (parts.length <= 2) continue;

    const twoLDName = `${parts[0]}.eth`;
    const twoLDRecord = twoLDRecords.get(twoLDName);
    if (!twoLDRecord) continue;

    console.log(`  Checking related data for ${affected.name} vs ${twoLDName}...`);

    // Check listings
    const listings = await pool.query<RelatedRecord>(
      `SELECT id, ens_name_id, order_data FROM listings WHERE ens_name_id = $1`,
      [affected.id]
    );

    for (const listing of listings.rows) {
      const tokenIdFromOrder = extractTokenIdFromOrderData(listing.order_data);
      if (tokenIdFromOrder) {
        const correctName = determineNameForTokenId(tokenIdFromOrder, affected.name, twoLDName);
        if (correctName === twoLDName) {
          console.log(`    LISTING ${listing.id}: belongs to ${twoLDName} (token ${tokenIdFromOrder})`);
          if (!DRY_RUN) {
            await pool.query(
              `UPDATE listings SET ens_name_id = $1, updated_at = NOW() WHERE id = $2`,
              [twoLDRecord.id, listing.id]
            );
            relatedDataFixedCount++;
          }
        }
      }
    }

    // Check offers
    const offers = await pool.query<RelatedRecord>(
      `SELECT id, ens_name_id, order_data FROM offers WHERE ens_name_id = $1`,
      [affected.id]
    );

    for (const offer of offers.rows) {
      const tokenIdFromOrder = extractTokenIdFromOrderData(offer.order_data);
      if (tokenIdFromOrder) {
        const correctName = determineNameForTokenId(tokenIdFromOrder, affected.name, twoLDName);
        if (correctName === twoLDName) {
          console.log(`    OFFER ${offer.id}: belongs to ${twoLDName} (token ${tokenIdFromOrder})`);
          if (!DRY_RUN) {
            await pool.query(
              `UPDATE offers SET ens_name_id = $1, updated_at = NOW() WHERE id = $2`,
              [twoLDRecord.id, offer.id]
            );
            relatedDataFixedCount++;
          }
        }
      }
    }

    // Check sales
    const sales = await pool.query<RelatedRecord>(
      `SELECT id, ens_name_id, order_data FROM sales WHERE ens_name_id = $1`,
      [affected.id]
    );

    for (const sale of sales.rows) {
      const tokenIdFromOrder = extractTokenIdFromOrderData(sale.order_data);
      if (tokenIdFromOrder) {
        const correctName = determineNameForTokenId(tokenIdFromOrder, affected.name, twoLDName);
        if (correctName === twoLDName) {
          console.log(`    SALE ${sale.id}: belongs to ${twoLDName} (token ${tokenIdFromOrder})`);
          if (!DRY_RUN) {
            await pool.query(
              `UPDATE sales SET ens_name_id = $1, updated_at = NOW() WHERE id = $2`,
              [twoLDRecord.id, sale.id]
            );
            relatedDataFixedCount++;
          }
        }
      }
    }
  }

  // Summary
  console.log();
  console.log('='.repeat(70));
  console.log('Summary');
  console.log('='.repeat(70));
  console.log(`Subnames: ${subnames.length} checked, ${correctCount} correct, ${mismatchCount} mismatched, ${notFoundCount} not found`);
  console.log(`2LD collisions: ${twoLDMismatchCount}`);
  console.log(`Records with related data: ${affectedWithRelatedData.length}`);
  if (!DRY_RUN) {
    console.log(`ENS names fixed: ${fixedCount}`);
    console.log(`Related data records reassigned: ${relatedDataFixedCount}`);
  }
  if (DRY_RUN) console.log('DRY RUN - no changes made');

  await pool.end();
}

main().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});
