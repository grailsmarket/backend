#!/usr/bin/env node
/**
 * Import OpenSea Listing Script
 *
 * Fetches listing(s) from the OpenSea API for a specific ENS name and inserts
 * them into the DB. Useful when the reconcile-opensea worker (which only fetches
 * the latest 100 listings) misses a specific name's listing.
 *
 * Usage:
 *   npm run import-opensea-listing -- --name agentcoin.eth           # Dry run
 *   npm run import-opensea-listing:fix -- --name agentcoin.eth       # Actually insert
 */

import { Pool } from 'pg';
import { config } from '../../../shared/src';

const FIX_MODE = process.argv.includes('--fix');
const OPENSEA_API_KEY = config.opensea.apiKey;
const ENS_CONTRACT = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
const MAX_RETRIES = 3;

function parseArgs(): { name?: string } {
  const args = process.argv.slice(2);
  let name: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--name' && args[i + 1]) {
      name = args[i + 1];
      i++;
    }
  }

  return { name };
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

async function fetchOpenSeaListingsForToken(tokenId: string): Promise<OpenSeaListing[]> {
  const allListings: OpenSeaListing[] = [];
  const baseUrl = 'https://api.opensea.io/api/v2/orders/ethereum/seaport/listings';

  const params = new URLSearchParams({
    asset_contract_address: ENS_CONTRACT,
    token_ids: tokenId,
    limit: '50',
  });

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
        token_ids: tokenId,
        limit: '50',
        cursor: data.next,
      });
      url = `${baseUrl}?${nextParams}`;
    } else {
      url = null;
    }
  }

  return allListings;
}

function formatEth(weiStr: string): string {
  try {
    const eth = Number(BigInt(weiStr)) / 1e18;
    return eth.toFixed(4);
  } catch {
    return weiStr;
  }
}

async function importListing(pool: Pool, name: string) {
  console.log('=== Import OpenSea Listing ===\n');
  console.log(`Mode: ${FIX_MODE ? 'FIX (will insert listings)' : 'CHECK ONLY (dry run)'}`);
  console.log(`Name: ${name}\n`);

  // 1. Look up the ENS name in DB
  const ensResult = await pool.query(
    'SELECT id, name, token_id FROM ens_names WHERE name = $1',
    [name]
  );

  if (ensResult.rows.length === 0) {
    console.error(`ENS name "${name}" not found in database.`);
    process.exit(1);
  }

  const ensName = ensResult.rows[0];
  console.log(`Found in DB: id=${ensName.id}, token_id=${ensName.token_id}\n`);

  // 2. Check for existing active listings in our DB
  const existingResult = await pool.query(
    `SELECT id, order_hash, status, source FROM listings
     WHERE ens_name_id = $1 AND source = 'opensea' AND status = 'active'`,
    [ensName.id]
  );

  if (existingResult.rows.length > 0) {
    console.log(`Existing active OpenSea listings in DB: ${existingResult.rows.length}`);
    for (const row of existingResult.rows) {
      console.log(`  id=${row.id} order_hash=${row.order_hash}`);
    }
    console.log('');
  } else {
    console.log('No existing active OpenSea listings in DB.\n');
  }

  const existingHashes = new Set(existingResult.rows.map((r: any) => r.order_hash));

  // 3. Fetch listings from OpenSea API
  console.log('Fetching listings from OpenSea API...');
  const osListings = await fetchOpenSeaListingsForToken(ensName.token_id);
  console.log(`Got ${osListings.length} total listing(s) from OpenSea\n`);

  if (osListings.length === 0) {
    console.log('No listings found on OpenSea for this name.');
    return;
  }

  // 4. Filter to active listings
  const activeListings = osListings.filter(l => !l.cancelled && !l.finalized);
  const skipped = osListings.length - activeListings.length;
  if (skipped > 0) {
    console.log(`Skipped ${skipped} cancelled/finalized listing(s)`);
  }

  if (activeListings.length === 0) {
    console.log('No active listings on OpenSea for this name.');
    return;
  }

  // 5. Skip listings already in our DB
  const newListings = activeListings.filter(l => !existingHashes.has(l.order_hash));

  if (newListings.length === 0) {
    console.log('All active OpenSea listings already exist in our DB. Nothing to import.');
    return;
  }

  console.log(`\n=== Listings to Import: ${newListings.length} ===\n`);

  for (const listing of newListings) {
    const expiresAt = new Date(listing.expiration_time * 1000);
    console.log(`  ${name}`);
    console.log(`    Order Hash: ${listing.order_hash}`);
    console.log(`    Seller:     ${listing.maker.address.toLowerCase()}`);
    console.log(`    Price:      ${formatEth(listing.current_price)} ETH (${listing.current_price} wei)`);
    console.log(`    Expires:    ${expiresAt.toISOString()}`);
    console.log(`    Created:    ${listing.created_date}`);
    console.log('');
  }

  // 6. Insert in fix mode
  if (FIX_MODE) {
    console.log('=== Inserting Listings ===\n');

    let inserted = 0;
    let failed = 0;

    for (const listing of newListings) {
      try {
        const result = await pool.query(
          `INSERT INTO listings (
            ens_name_id, seller_address, price_wei, currency_address,
            order_hash, order_data, status, source, expires_at, created_at
          ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 'opensea', $7, $8)
          ON CONFLICT (order_hash, source) DO NOTHING`,
          [
            ensName.id,
            listing.maker.address.toLowerCase(),
            listing.current_price,
            '0x0000000000000000000000000000000000000000',
            listing.order_hash,
            JSON.stringify(listing.protocol_data),
            new Date(listing.expiration_time * 1000),
            new Date(listing.created_date),
          ]
        );

        if (result.rowCount && result.rowCount > 0) {
          console.log(`  [OK] Inserted ${listing.order_hash.slice(0, 16)}... (${formatEth(listing.current_price)} ETH)`);
          inserted++;
        } else {
          console.log(`  [SKIP] ${listing.order_hash.slice(0, 16)}... already exists (conflict)`);
        }
      } catch (error: any) {
        console.log(`  [ERROR] Failed to insert ${listing.order_hash.slice(0, 16)}...: ${error.message}`);
        failed++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Inserted: ${inserted}`);
    if (failed > 0) console.log(`Failed:   ${failed}`);
  } else {
    console.log('=== To insert listings, run with --fix flag ===\n');
  }
}

async function main() {
  const { name } = parseArgs();

  if (!name) {
    console.error('Error: --name <name> is required (e.g., --name agentcoin.eth)');
    process.exit(1);
  }

  if (!OPENSEA_API_KEY) {
    console.error('Error: config.opensea.apiKey is not configured');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });

  try {
    await pool.query('SELECT 1');
    console.log('Database connected.\n');

    await importListing(pool, name);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
