#!/usr/bin/env node
/**
 * Import OpenSea Listing Script
 *
 * Fetches listing(s) from OpenSea for a specific ENS name and inserts them
 * into the DB. Unlike the simpler wal-listener import script, this one:
 * - Resolves token IDs via The Graph (handles wrapped/unwrapped names)
 * - Creates the ens_name record if it doesn't exist yet
 * - Computes labelhash from name (doesn't require the name to already be in DB)
 *
 * Usage:
 *   npm run import-listing -- 3232.eth           # Dry run
 *   npm run import-listing -- 3232.eth --fix     # Actually insert
 */

import { Pool } from 'pg';
import { labelhash } from 'viem/ens';
import { config, safeNormalize } from '../../../shared/src';
import { ENSResolver } from '../services/ens-resolver';

const FIX_MODE = process.argv.includes('--fix');
const OPENSEA_API_KEY = config.opensea.apiKey;
const ENS_CONTRACT = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
const MAX_RETRIES = 3;

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

function computeLabelhashTokenId(name: string): string {
  const label = name.replace('.eth', '');
  const hash = labelhash(label);
  return BigInt(hash).toString(10);
}

/**
 * Upsert an ENS name record, matching the logic from opensea-stream.ts
 */
async function upsertEnsName(
  pool: Pool,
  tokenId: string,
  name: string,
  ownerAddress: string,
  expiryDate: Date | null,
  registrationDate: Date | null,
  creationDate: Date | null,
  textRecords: Record<string, string> = {}
): Promise<number> {
  const normalizedOwner = ownerAddress.toLowerCase();

  try {
    const upsertQuery = `
      INSERT INTO ens_names (token_id, name, owner_address, expiry_date, registration_date, creation_date, metadata, created_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $7, $6, NOW(), NOW())
      ON CONFLICT (token_id) DO UPDATE SET
        owner_address = EXCLUDED.owner_address,
        name = CASE
          WHEN ens_names.name LIKE 'token-%' OR ens_names.name LIKE '#%' OR ens_names.name LIKE '[%].eth' THEN EXCLUDED.name
          ELSE ens_names.name
        END,
        expiry_date = COALESCE(EXCLUDED.expiry_date, ens_names.expiry_date),
        registration_date = COALESCE(EXCLUDED.registration_date, ens_names.registration_date),
        creation_date = COALESCE(EXCLUDED.creation_date, ens_names.creation_date),
        metadata = COALESCE(EXCLUDED.metadata, ens_names.metadata),
        updated_at = NOW()
      RETURNING id
    `;

    const result = await pool.query(upsertQuery, [
      tokenId,
      name,
      normalizedOwner,
      expiryDate,
      registrationDate,
      JSON.stringify(textRecords),
      creationDate
    ]);
    return result.rows[0].id;
  } catch (error: any) {
    // Handle unique constraint violation on name (different token_id for same name)
    if (error.code === '23505' && error.constraint === 'ens_names_real_name_unique') {
      console.log(`  ENS name "${name}" exists with different token_id, updating existing record.`);

      const updateQuery = `
        UPDATE ens_names SET
          owner_address = $2,
          expiry_date = COALESCE($3, expiry_date),
          registration_date = COALESCE($4, registration_date),
          creation_date = COALESCE($6, creation_date),
          metadata = COALESCE($5, metadata),
          updated_at = NOW()
        WHERE name = $1
        RETURNING id
      `;

      const updateResult = await pool.query(updateQuery, [
        name,
        normalizedOwner,
        expiryDate,
        registrationDate,
        JSON.stringify(textRecords),
        creationDate
      ]);

      if (updateResult.rows.length > 0) {
        return updateResult.rows[0].id;
      }

      // Fallback: just get the ID
      const existingResult = await pool.query('SELECT id FROM ens_names WHERE name = $1', [name]);
      if (existingResult.rows.length > 0) {
        return existingResult.rows[0].id;
      }
    }

    throw error;
  }
}

async function importListing(pool: Pool, name: string) {
  console.log('=== Import OpenSea Listing ===\n');
  console.log(`Mode: ${FIX_MODE ? 'FIX (will insert listings)' : 'CHECK ONLY (dry run)'}`);
  console.log(`Name: ${name}\n`);

  const resolver = new ENSResolver();

  // 1. Compute labelhash token ID from the name
  const labelhashTokenId = computeLabelhashTokenId(name);
  console.log(`Computed labelhash token ID: ${labelhashTokenId}`);

  // 2. Check if name exists in our DB
  const ensResult = await pool.query(
    'SELECT id, name, token_id, owner_address FROM ens_names WHERE LOWER(name) = LOWER($1)',
    [name]
  );

  let dbTokenId: string | null = null;
  if (ensResult.rows.length > 0) {
    const row = ensResult.rows[0];
    dbTokenId = row.token_id;
    console.log(`Found in DB: id=${row.id}, token_id=${row.token_id}, owner=${row.owner_address}`);
    if (dbTokenId !== labelhashTokenId) {
      console.log(`  Note: DB token_id differs from labelhash (likely wrapped name)`);
    }
  } else {
    console.log(`Not found in DB - will create via Graph resolution if --fix`);
  }

  // 3. Resolve via The Graph to get authoritative data
  console.log(`\nResolving via The Graph...`);
  const resolvedData = await resolver.resolveTokenIdToNameData(labelhashTokenId);

  if (resolvedData) {
    console.log(`  Name:           ${resolvedData.name}`);
    console.log(`  Correct TokenId: ${resolvedData.correctTokenId}`);
    console.log(`  Owner:          ${resolvedData.ownerAddress || 'unknown'}`);
    console.log(`  Expiry:         ${resolvedData.expiryDate?.toISOString() || 'none'}`);
    console.log(`  Normalized:     ${resolvedData.isNormalized}`);

    if (!resolvedData.isNormalized) {
      console.error(`\nERROR: Name "${resolvedData.originalName}" is non-normalized. Skipping.`);
      process.exit(1);
    }
  } else {
    console.log(`  WARNING: Could not resolve via The Graph. Will use labelhash token ID.`);
  }

  // Use the correct token ID for OpenSea lookup
  // OpenSea uses the labelhash (Base Registrar) for listings, regardless of wrapped status
  const tokenIdForOpenSea = labelhashTokenId;

  // 4. Check for existing active listings in our DB
  const ensNameId = ensResult.rows.length > 0 ? ensResult.rows[0].id : null;
  if (ensNameId) {
    const existingResult = await pool.query(
      `SELECT id, order_hash, status, source, price_wei FROM listings
       WHERE ens_name_id = $1 AND source = 'opensea'
       ORDER BY created_at DESC`,
      [ensNameId]
    );

    if (existingResult.rows.length > 0) {
      console.log(`\nExisting OpenSea listings in DB:`);
      for (const row of existingResult.rows) {
        console.log(`  id=${row.id} status=${row.status} price=${formatEth(row.price_wei)} ETH hash=${row.order_hash?.slice(0, 16)}...`);
      }
    } else {
      console.log('\nNo existing OpenSea listings in DB.');
    }
  }

  // 5. Fetch listings from OpenSea API
  console.log('\nFetching listings from OpenSea API...');
  const osListings = await fetchOpenSeaListingsForToken(tokenIdForOpenSea);
  console.log(`Got ${osListings.length} total listing(s) from OpenSea`);

  if (osListings.length === 0) {
    console.log('No listings found on OpenSea for this token.');
    return;
  }

  // 6. Filter to active listings
  const activeListings = osListings.filter(l => !l.cancelled && !l.finalized);
  const skipped = osListings.length - activeListings.length;
  if (skipped > 0) {
    console.log(`Skipped ${skipped} cancelled/finalized listing(s)`);
  }

  if (activeListings.length === 0) {
    console.log('No active listings on OpenSea for this name.');
    return;
  }

  // 7. Check which are already in our DB
  const orderHashes = activeListings.map(l => l.order_hash);
  const existingHashes = new Set<string>();
  if (orderHashes.length > 0) {
    const existingResult = await pool.query(
      'SELECT order_hash FROM listings WHERE order_hash = ANY($1)',
      [orderHashes]
    );
    for (const row of existingResult.rows) {
      existingHashes.add(row.order_hash);
    }
  }

  const newListings = activeListings.filter(l => !existingHashes.has(l.order_hash));

  if (newListings.length === 0) {
    console.log('\nAll active OpenSea listings already exist in our DB. Nothing to import.');
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

  // 8. Insert in fix mode
  if (!FIX_MODE) {
    console.log('=== To insert listings, run with --fix flag ===\n');
    return;
  }

  console.log('=== Inserting Listings ===\n');

  // First, ensure the ens_name record exists
  const correctTokenId = resolvedData?.correctTokenId || labelhashTokenId;
  const ownerAddress = resolvedData?.ownerAddress || newListings[0].maker.address.toLowerCase();
  const resolvedName = resolvedData?.name || safeNormalize(name);

  const upsertedEnsNameId = await upsertEnsName(
    pool,
    correctTokenId,
    resolvedName,
    ownerAddress,
    resolvedData?.expiryDate || null,
    resolvedData?.registrationDate || null,
    resolvedData?.creationDate || null,
    resolvedData?.textRecords || {}
  );
  console.log(`ENS name upserted: id=${upsertedEnsNameId}\n`);

  // Cancel any existing active OpenSea listings for this name+seller with different order hashes
  // (matching the stream handler logic)
  for (const listing of newListings) {
    await pool.query(
      `UPDATE listings
       SET status = 'cancelled', updated_at = NOW()
       WHERE ens_name_id = $1
       AND seller_address = $2
       AND status = 'active'
       AND source = 'opensea'
       AND (order_hash IS NULL OR order_hash IS DISTINCT FROM $3)`,
      [upsertedEnsNameId, listing.maker.address.toLowerCase(), listing.order_hash]
    );
  }

  let inserted = 0;
  let failed = 0;

  for (const listing of newListings) {
    try {
      const result = await pool.query(
        `INSERT INTO listings (
          ens_name_id, seller_address, price_wei, currency_address,
          order_hash, order_data, status, source, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 'opensea', $7, $8)
        ON CONFLICT (order_hash, source) DO UPDATE SET
          price_wei = EXCLUDED.price_wei,
          expires_at = EXCLUDED.expires_at,
          status = 'active',
          updated_at = NOW()`,
        [
          upsertedEnsNameId,
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
}

async function main() {
  // Parse name as positional arg (first non-flag arg)
  const args = process.argv.slice(2).filter(a => a !== '--fix');
  const name = args[0];

  if (!name || !name.endsWith('.eth')) {
    console.error('Usage: import-listing <name.eth> [--fix]');
    console.error('  e.g., import-listing 3232.eth --fix');
    process.exit(1);
  }

  if (!OPENSEA_API_KEY) {
    console.error('Error: config.opensea.apiKey is not configured');
    process.exit(1);
  }

  const pool = new Pool({
    connectionString: config.database.url,
    max: 5,
  });

  try {
    await pool.query('SELECT 1');
    console.log('Database connected.\n');

    await importListing(pool, safeNormalize(name));
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
