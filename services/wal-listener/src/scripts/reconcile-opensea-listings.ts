#!/usr/bin/env node
/**
 * OpenSea Listing Reconciliation Script (Reverse Direction)
 *
 * Checks our active OpenSea listings against the OpenSea API and identifies
 * stale listings that are no longer actually listed on OpenSea. This handles
 * cases where we missed cancellation events due to network connectivity issues.
 *
 * The existing reconcile-opensea worker checks the forward direction (finding
 * listings on OpenSea that we're missing). This script checks the reverse
 * direction (finding listings in our DB that OpenSea no longer has).
 *
 * Usage:
 *   npx tsx src/scripts/reconcile-opensea-listings.ts                    # Dry run — check all
 *   npx tsx src/scripts/reconcile-opensea-listings.ts --fix              # Cancel stale listings
 *   npx tsx src/scripts/reconcile-opensea-listings.ts --name agentcoin.eth  # Check specific name
 *   npx tsx src/scripts/reconcile-opensea-listings.ts --limit 100        # Limit DB listings to check
 *   npx tsx src/scripts/reconcile-opensea-listings.ts --batch-size 10    # Token IDs per API request
 */

import { Pool } from 'pg';
import { config } from '../../../shared/src';

const FIX_MODE = process.argv.includes('--fix');
const OPENSEA_API_KEY = config.opensea.apiKey;
const ENS_CONTRACT = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
const DEFAULT_BATCH_SIZE = 20;
const BATCH_DELAY_MS = 300;
const MAX_RETRIES = 3;

// Parse arguments
function parseArgs(): { name?: string; limit?: number; batchSize: number } {
  const args = process.argv.slice(2);
  let name: string | undefined;
  let limit: number | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      name = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--batch-size' && args[i + 1]) {
      batchSize = parseInt(args[i + 1]);
      i++;
    }
  }

  return { name, limit, batchSize };
}

interface DbListing {
  id: number;
  ens_name_id: number;
  seller_address: string;
  price_wei: string;
  order_hash: string;
  created_at: Date;
  expires_at: Date | null;
  name: string;
  token_id: string;
}

interface OpenSeaListing {
  order_hash: string;
  created_date: string;
  expiration_time: number;
  current_price: string;
  maker: { address: string };
  protocol_data: object;
  maker_asset_bundle: { assets: Array<{ token_id: string; name: string }> };
  cancelled: boolean;
  finalized: boolean;
}

interface OpenSeaListingsResponse {
  orders?: OpenSeaListing[];
  next?: string;
}

type StaleReason = 'not_found_on_opensea' | 'order_hash_missing' | 'cancelled' | 'finalized';

interface StaleListing {
  listing: DbListing;
  reason: StaleReason;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempt = 1): Promise<Response> {
  const response = await fetch(url, {
    headers: {
      'X-API-Key': OPENSEA_API_KEY!,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 429 && attempt <= MAX_RETRIES) {
    const delay = Math.pow(2, attempt) * 1000;
    console.log(`  Rate limited (429), retrying in ${delay}ms (attempt ${attempt}/${MAX_RETRIES})...`);
    await sleep(delay);
    return fetchWithRetry(url, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`OpenSea API error: ${response.status} ${response.statusText}`);
  }

  return response;
}

async function fetchOpenSeaListingsForTokenIds(tokenIds: string[]): Promise<OpenSeaListing[]> {
  const allListings: OpenSeaListing[] = [];
  const baseUrl = 'https://api.opensea.io/api/v2/orders/ethereum/seaport/listings';

  const params = new URLSearchParams({
    asset_contract_address: ENS_CONTRACT,
    limit: '50',
  });
  for (const id of tokenIds) {
    params.append('token_ids', id);
  }

  let url: string | null = `${baseUrl}?${params}`;

  while (url) {
    const response = await fetchWithRetry(url);
    const data = await response.json() as OpenSeaListingsResponse;

    if (data.orders) {
      allListings.push(...data.orders);
    }

    if (data.next) {
      const nextParams = new URLSearchParams({
        asset_contract_address: ENS_CONTRACT,
        limit: '50',
        cursor: data.next,
      });
      for (const id of tokenIds) {
        nextParams.append('token_ids', id);
      }
      url = `${baseUrl}?${nextParams}`;
    } else {
      url = null;
    }
  }

  return allListings;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function formatEth(weiStr: string): string {
  try {
    const eth = Number(BigInt(weiStr)) / 1e18;
    return eth.toFixed(4);
  } catch {
    return weiStr;
  }
}

async function reconcileListings(pool: Pool, name?: string, limit?: number, batchSize = DEFAULT_BATCH_SIZE) {
  console.log('=== OpenSea Listing Reconciliation (Reverse) ===\n');
  console.log(`Mode: ${FIX_MODE ? 'FIX (will cancel stale listings)' : 'CHECK ONLY (dry run)'}`);
  if (name) console.log(`Name filter: ${name}`);
  if (limit) console.log(`Limit: ${limit}`);
  console.log(`Batch size: ${batchSize}`);
  console.log('');

  // Query DB for all active OpenSea listings
  let query = `
    SELECT l.id, l.ens_name_id, l.seller_address, l.price_wei, l.order_hash,
           l.created_at, l.expires_at, en.name, en.token_id
    FROM listings l
    JOIN ens_names en ON en.id = l.ens_name_id
    WHERE l.source = 'opensea' AND l.status = 'active'
  `;
  const params: any[] = [];

  if (name) {
    params.push(name);
    query += ` AND en.name = $${params.length}`;
  }

  query += ` ORDER BY l.created_at DESC`;

  if (limit) {
    params.push(limit);
    query += ` LIMIT $${params.length}`;
  }

  const result = await pool.query(query, params);
  const dbListings: DbListing[] = result.rows;

  console.log(`Found ${dbListings.length} active OpenSea listings in our database\n`);

  if (dbListings.length === 0) {
    console.log('No active OpenSea listings to check.');
    return;
  }

  // Skip listings with null order_hash (legacy data, can't verify)
  const verifiable = dbListings.filter(l => l.order_hash);
  const skippedNull = dbListings.length - verifiable.length;
  if (skippedNull > 0) {
    console.log(`Skipping ${skippedNull} listings with null order_hash (legacy data)\n`);
  }

  if (verifiable.length === 0) {
    console.log('No verifiable listings (all have null order_hash).');
    return;
  }

  // Group listings by token_id
  const listingsByTokenId = new Map<string, DbListing[]>();
  for (const listing of verifiable) {
    const existing = listingsByTokenId.get(listing.token_id) || [];
    existing.push(listing);
    listingsByTokenId.set(listing.token_id, existing);
  }

  const uniqueTokenIds = Array.from(listingsByTokenId.keys());
  console.log(`Unique token IDs to check: ${uniqueTokenIds.length}`);

  // Chunk token IDs into batches and fetch from OpenSea
  const batches = chunk(uniqueTokenIds, batchSize);
  console.log(`API batches: ${batches.length}\n`);

  // Collect all OpenSea listings indexed by order_hash and token_id
  const osListingsByOrderHash = new Map<string, OpenSeaListing>();
  const osListingsByTokenId = new Map<string, OpenSeaListing[]>();

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Fetching batch ${i + 1}/${batches.length} (${batch.length} token IDs)...`);

    try {
      const osListings = await fetchOpenSeaListingsForTokenIds(batch);
      console.log(`  Got ${osListings.length} listings from OpenSea`);

      for (const osListing of osListings) {
        osListingsByOrderHash.set(osListing.order_hash, osListing);

        const tokenId = osListing.maker_asset_bundle?.assets?.[0]?.token_id;
        if (tokenId) {
          const existing = osListingsByTokenId.get(tokenId) || [];
          existing.push(osListing);
          osListingsByTokenId.set(tokenId, existing);
        }
      }
    } catch (error: any) {
      console.log(`  ERROR: ${error.message}`);
    }

    if (i < batches.length - 1) {
      await sleep(BATCH_DELAY_MS);
    }
  }

  console.log('');

  // Compare each DB listing against OpenSea data
  const staleListings: StaleListing[] = [];

  for (const listing of verifiable) {
    const osListing = osListingsByOrderHash.get(listing.order_hash);

    if (osListing) {
      // Found on OpenSea — check status
      if (osListing.cancelled) {
        staleListings.push({ listing, reason: 'cancelled' });
      } else if (osListing.finalized) {
        staleListings.push({ listing, reason: 'finalized' });
      }
      // else: still active on OpenSea, all good
    } else {
      // Order hash not found — check if any listings exist for this token_id
      const tokenListings = osListingsByTokenId.get(listing.token_id);
      if (!tokenListings || tokenListings.length === 0) {
        staleListings.push({ listing, reason: 'not_found_on_opensea' });
      } else {
        staleListings.push({ listing, reason: 'order_hash_missing' });
      }
    }
  }

  // Print results
  console.log('=== Results ===\n');
  console.log(`Total DB listings checked:  ${verifiable.length}`);
  console.log(`Still active on OpenSea:    ${verifiable.length - staleListings.length}`);
  console.log(`STALE (need cancellation):  ${staleListings.length}`);

  if (staleListings.length === 0) {
    console.log('\nAll listings are in sync with OpenSea.');
    return;
  }

  // Count by reason
  const reasonCounts = new Map<StaleReason, number>();
  for (const s of staleListings) {
    reasonCounts.set(s.reason, (reasonCounts.get(s.reason) || 0) + 1);
  }
  console.log('\nStale reasons:');
  for (const [reason, count] of reasonCounts) {
    console.log(`  ${reason}: ${count}`);
  }

  console.log('\n=== Stale Listings ===\n');
  for (const { listing, reason } of staleListings) {
    console.log(`${listing.name}`);
    console.log(`  Listing ID:  ${listing.id}`);
    console.log(`  Order Hash:  ${listing.order_hash}`);
    console.log(`  Seller:      ${listing.seller_address}`);
    console.log(`  Price:       ${formatEth(listing.price_wei)} ETH`);
    console.log(`  Reason:      ${reason}`);
    console.log(`  Created:     ${listing.created_at.toISOString()}`);
    console.log('');
  }

  if (FIX_MODE) {
    console.log('=== Cancelling Stale Listings ===\n');

    let cancelled = 0;
    let failed = 0;

    for (const { listing, reason } of staleListings) {
      try {
        const updateResult = await pool.query(
          `UPDATE listings SET status = 'cancelled', updated_at = NOW() WHERE id = $1 AND status = 'active'`,
          [listing.id]
        );

        if (updateResult.rowCount && updateResult.rowCount > 0) {
          console.log(`  [OK] Cancelled ${listing.name} (${listing.order_hash.slice(0, 10)}...) — ${reason}`);
          cancelled++;
        } else {
          console.log(`  [SKIP] ${listing.name} already cancelled or status changed`);
        }
      } catch (error: any) {
        console.log(`  [ERROR] Failed to cancel listing ${listing.id}: ${error.message}`);
        failed++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Cancelled: ${cancelled}`);
    console.log(`Failed:    ${failed}`);
  } else {
    console.log('=== To cancel stale listings, run with --fix flag ===');
    console.log('npx tsx src/scripts/reconcile-opensea-listings.ts --fix\n');
  }
}

async function main() {
  const { name, limit, batchSize } = parseArgs();

  if (!OPENSEA_API_KEY) {
    console.error('Error: config.opensea.apiKey is not configured');
    process.exit(1);
  }

  console.log(`Name filter: ${name || 'none (all listings)'}`);
  if (limit) console.log(`Limit: ${limit}`);
  console.log(`Batch size: ${batchSize}`);
  console.log('');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });

  try {
    await pool.query('SELECT 1');
    console.log('Database connected.\n');

    await reconcileListings(pool, name, limit, batchSize);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
