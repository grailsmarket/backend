import { getPostgresPool } from '../../../shared/src';
import axios from 'axios';

/**
 * Find stale listings where the seller no longer owns the ENS name
 *
 * This script:
 * 1. Fetches active listings where seller_address != owner_address in our DB
 * 2. Queries The Graph for the actual current owner of each name
 * 3. Compares and reports which listings are truly stale (seller lost ownership)
 * 4. Outputs a report with actionable data
 *
 * Usage:
 *   npx ts-node src/scripts/find-stale-listings.ts [--verbose] [--output=json]
 */

const GRAPH_ENS_SUBGRAPH_URL = 'https://ensnode-api-production-500f.up.railway.app/subgraph';
const NAME_WRAPPER_ADDRESS = '0xd4416b13d2b3a9abae7acd5d6c2bbdbe25686401';
const BATCH_SIZE = 100;
const GRACE_PERIOD_DAYS = 90;
const PREMIUM_PERIOD_DAYS = 21;
const TOTAL_EXPIRY_BUFFER_MS = (GRACE_PERIOD_DAYS + PREMIUM_PERIOD_DAYS) * 24 * 60 * 60 * 1000;

const VERBOSE = process.argv.includes('--verbose');
const OUTPUT_JSON = process.argv.includes('--output=json');

interface GraphDomain {
  name: string;
  registrant?: { id: string };
  wrappedOwner?: { id: string };
  registration?: {
    expiryDate: string | number;
    registrationDate: string | number;
  };
}

interface StaleListing {
  listingId: number;
  ensNameId: number;
  name: string;
  sellerAddress: string;
  dbOwnerAddress: string;
  graphOwnerAddress: string | null;
  isExpired: boolean;
  hasSaleRecord: boolean;
  orderHash: string | null;
  createdAt: Date;
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
 * Returns { owner, isExpired }
 */
function getCorrectOwner(domain: GraphDomain): { owner: string | null; isExpired: boolean } {
  // Check if fully expired (expiry + 111 days)
  let isExpired = false;
  if (domain.registration?.expiryDate) {
    const expiryTimestamp = typeof domain.registration.expiryDate === 'string'
      ? parseInt(domain.registration.expiryDate)
      : domain.registration.expiryDate;
    const expiryMs = expiryTimestamp * 1000;
    const fullyExpiredAt = expiryMs + TOTAL_EXPIRY_BUFFER_MS;

    if (Date.now() > fullyExpiredAt) {
      isExpired = true;
      return { owner: null, isExpired };
    }
  }

  // No registrant = can't determine owner
  if (!domain.registrant?.id) {
    return { owner: null, isExpired };
  }

  const registrant = domain.registrant.id.toLowerCase();

  // If registrant is NameWrapper, owner is wrappedOwner
  if (registrant === NAME_WRAPPER_ADDRESS.toLowerCase()) {
    if (!domain.wrappedOwner?.id) {
      return { owner: null, isExpired };
    }
    return { owner: domain.wrappedOwner.id.toLowerCase(), isExpired };
  }

  // Otherwise, owner is registrant
  return { owner: registrant, isExpired };
}

async function findStaleListings() {
  const pool = getPostgresPool();

  if (!OUTPUT_JSON) {
    console.log('=== Find Stale Listings Script ===');
    console.log('Checking active listings where seller may no longer own the name\n');
  }

  // Get listings where seller != db owner (potential issues)
  const suspectResult = await pool.query(`
    SELECT
      l.id as listing_id,
      l.ens_name_id,
      l.seller_address,
      l.order_hash,
      l.created_at,
      en.name,
      en.owner_address as db_owner_address
    FROM listings l
    JOIN ens_names en ON en.id = l.ens_name_id
    WHERE l.status = 'active'
    AND l.seller_address != en.owner_address
    AND en.name NOT LIKE 'token-%'
    ORDER BY l.created_at DESC
  `);

  const suspectListings = suspectResult.rows;

  if (!OUTPUT_JSON) {
    console.log(`Found ${suspectListings.length} listings where seller != DB owner\n`);
  }

  if (suspectListings.length === 0) {
    if (!OUTPUT_JSON) {
      console.log('No suspect listings found!');
    } else {
      console.log(JSON.stringify({ staleListings: [], summary: { total: 0 } }));
    }
    await pool.end();
    return;
  }

  // Check for existing sale records
  const listingIds = suspectListings.map(l => l.listing_id);
  const salesResult = await pool.query(`
    SELECT DISTINCT listing_id FROM sales WHERE listing_id = ANY($1)
  `, [listingIds]);
  const listingsWithSales = new Set(salesResult.rows.map(r => r.listing_id));

  // Process in batches, querying The Graph for actual owners
  const staleListings: StaleListing[] = [];
  let processed = 0;
  const startTime = Date.now();

  for (let i = 0; i < suspectListings.length; i += BATCH_SIZE) {
    const batch = suspectListings.slice(i, i + BATCH_SIZE);
    const names = batch.map(l => l.name);

    const domainMap = await queryGraphByName(names);

    for (const listing of batch) {
      const domain = domainMap.get(listing.name);

      if (!domain) {
        // Name not found in Graph - might be expired or invalid
        staleListings.push({
          listingId: listing.listing_id,
          ensNameId: listing.ens_name_id,
          name: listing.name,
          sellerAddress: listing.seller_address.toLowerCase(),
          dbOwnerAddress: listing.db_owner_address.toLowerCase(),
          graphOwnerAddress: null,
          isExpired: true, // Assume expired if not found
          hasSaleRecord: listingsWithSales.has(listing.listing_id),
          orderHash: listing.order_hash,
          createdAt: listing.created_at,
        });
        continue;
      }

      const { owner: graphOwner, isExpired } = getCorrectOwner(domain);

      // Check if seller matches Graph owner
      const sellerAddress = listing.seller_address.toLowerCase();
      const sellerOwnsName = graphOwner && graphOwner === sellerAddress;

      if (!sellerOwnsName) {
        staleListings.push({
          listingId: listing.listing_id,
          ensNameId: listing.ens_name_id,
          name: listing.name,
          sellerAddress: sellerAddress,
          dbOwnerAddress: listing.db_owner_address.toLowerCase(),
          graphOwnerAddress: graphOwner,
          isExpired: isExpired,
          hasSaleRecord: listingsWithSales.has(listing.listing_id),
          orderHash: listing.order_hash,
          createdAt: listing.created_at,
        });

        if (VERBOSE && !OUTPUT_JSON) {
          console.log(`[STALE] ${listing.name}`);
          console.log(`  Listing ID: ${listing.listing_id}`);
          console.log(`  Seller: ${sellerAddress}`);
          console.log(`  DB Owner: ${listing.db_owner_address.toLowerCase()}`);
          console.log(`  Graph Owner: ${graphOwner || 'null (expired)'}`);
          console.log(`  Has Sale Record: ${listingsWithSales.has(listing.listing_id)}`);
          console.log(`  Order Hash: ${listing.order_hash || 'none'}`);
          console.log('');
        }
      }

      processed++;
    }

    if (!OUTPUT_JSON) {
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = processed / elapsed;
      console.log(
        `Progress: ${processed}/${suspectListings.length} | ` +
        `Stale: ${staleListings.length} | ` +
        `Rate: ${Math.round(rate)}/s`
      );
    }
  }

  // Generate summary
  const summary = {
    totalSuspect: suspectListings.length,
    totalStale: staleListings.length,
    withSaleRecord: staleListings.filter(l => l.hasSaleRecord).length,
    withoutSaleRecord: staleListings.filter(l => !l.hasSaleRecord).length,
    expired: staleListings.filter(l => l.isExpired).length,
    ownerChanged: staleListings.filter(l => !l.isExpired && l.graphOwnerAddress).length,
  };

  if (OUTPUT_JSON) {
    console.log(JSON.stringify({ staleListings, summary }, null, 2));
  } else {
    console.log('\n=== Summary ===');
    console.log(`Total suspect listings (seller != DB owner): ${summary.totalSuspect}`);
    console.log(`Confirmed stale (seller != Graph owner): ${summary.totalStale}`);
    console.log(`  - With existing sale record: ${summary.withSaleRecord}`);
    console.log(`  - Without sale record (need recovery): ${summary.withoutSaleRecord}`);
    console.log(`  - Name expired: ${summary.expired}`);
    console.log(`  - Owner changed (not expired): ${summary.ownerChanged}`);

    if (summary.withoutSaleRecord > 0) {
      console.log('\n=== Listings needing sale recovery ===');
      const needRecovery = staleListings.filter(l => !l.hasSaleRecord && !l.isExpired);
      for (const listing of needRecovery.slice(0, 20)) {
        console.log(`  ${listing.name} (ID: ${listing.listingId}) - seller: ${listing.sellerAddress.slice(0, 10)}... -> owner: ${listing.graphOwnerAddress?.slice(0, 10)}...`);
      }
      if (needRecovery.length > 20) {
        console.log(`  ... and ${needRecovery.length - 20} more`);
      }
    }
  }

  await pool.end();
}

findStaleListings()
  .then(() => {
    if (!OUTPUT_JSON) {
      console.log('\nScript completed');
    }
    process.exit(0);
  })
  .catch((error) => {
    console.error('\nScript failed:', error);
    process.exit(1);
  });
