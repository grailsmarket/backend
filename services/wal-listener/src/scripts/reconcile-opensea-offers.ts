#!/usr/bin/env node
/**
 * OpenSea Offer Reconciliation Script
 *
 * Fetches active offers from OpenSea API and compares with our database.
 * Inserts any missing offers that we may have missed due to WebSocket gaps.
 *
 * Uses the v2 offers endpoints (the legacy /orders/{chain}/seaport/offers
 * endpoint was removed and returns 405):
 *   - all offers:  GET /api/v2/offers/collection/ens/all (paginated, item
 *     offers filtered by --days client-side)
 *   - --token-id:  GET /api/v2/offers/collection/ens/nfts/{id}/best — the v2
 *     API only exposes the single BEST offer per NFT (--days is ignored)
 *
 * Usage:
 *   npx tsx src/scripts/reconcile-opensea-offers.ts                    # Check last 21 days (dry run)
 *   npx tsx src/scripts/reconcile-opensea-offers.ts --fix              # Insert missing offers
 *   npx tsx src/scripts/reconcile-opensea-offers.ts --days 7           # Check last 7 days
 *   npx tsx src/scripts/reconcile-opensea-offers.ts --token-id <id>    # Check specific token
 *   npx tsx src/scripts/reconcile-opensea-offers.ts --limit 100        # Per-page limit
 */

import { Pool } from 'pg';
import { config } from '../../../shared/src';

const FIX_MODE = process.argv.includes('--fix');
const OPENSEA_API_KEY = config.opensea.apiKey;
const MAX_RETRIES = 3;

// Parse arguments
function parseArgs(): { tokenId?: string; limit: number; days: number } {
  const args = process.argv.slice(2);
  let tokenId: string | undefined;
  let limit = 50;
  let days = 21;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--token-id' && args[i + 1]) {
      tokenId = args[i + 1];
      i++;
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = parseInt(args[i + 1]);
      i++;
    } else if (args[i] === '--days' && args[i + 1]) {
      days = parseInt(args[i + 1]);
      i++;
    }
  }

  return { tokenId, limit, days };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempt = 1, allow404 = false): Promise<Response | null> {
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
    return fetchWithRetry(url, attempt + 1, allow404);
  }

  if (response.status === 404 && allow404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`OpenSea API error: ${response.status} ${response.statusText}`);
  }

  return response;
}

// Shape returned by the v2 offers endpoints (/offers/collection/{slug}/all
// and /offers/collection/{slug}/nfts/{id}/best). The legacy
// /orders/{chain}/seaport/offers endpoint was removed (returns 405).
interface OpenSeaOffer {
  order_hash: string;
  chain: string;
  protocol_data: {
    parameters: {
      offerer: string;
      offer: Array<{
        itemType: number;
        token: string;
        startAmount: string;
      }>;
      consideration: Array<{
        itemType: number;
        token: string;
        identifierOrCriteria: string;
      }>;
      startTime: string;
      endTime: string;
    };
  };
  protocol_address: string;
  asset: { identifier: string; contract: string } | null;
  order_created_at: number;
  criteria: unknown | null;
  price: { currency: string; decimals: number; value: string };
  status: string;
}

async function fetchOpenSeaOffers(tokenId?: string, limit = 50, listedAfter?: number): Promise<OpenSeaOffer[]> {
  if (!OPENSEA_API_KEY) {
    throw new Error('OPENSEA_API_KEY not configured');
  }

  if (tokenId) {
    // The v2 API only exposes the single best offer per NFT.
    const url = `https://api.opensea.io/api/v2/offers/collection/ens/nfts/${tokenId}/best`;
    console.log('Fetching best offer for token (v2 API only exposes the best offer per NFT)...');
    const response = await fetchWithRetry(url, 1, true);
    if (!response) {
      return [];
    }
    const data = await response.json() as OpenSeaOffer | Record<string, never>;
    return 'order_hash' in data && data.order_hash ? [data as OpenSeaOffer] : [];
  }

  const allOffers: OpenSeaOffer[] = [];
  const baseUrl = 'https://api.opensea.io/api/v2/offers/collection/ens/all';

  let cursor: string | undefined;
  let page = 1;

  do {
    const params = new URLSearchParams({ limit: limit.toString() });
    if (cursor) {
      params.append('next', cursor);
    }

    console.log(`Fetching page ${page}...`);
    const response = await fetchWithRetry(`${baseUrl}?${params}`);
    const data = await response!.json() as { offers?: OpenSeaOffer[]; next?: string };

    if (data.offers) {
      // Keep item offers only (criteria offers are collection/trait-wide and
      // don't map to a single name). Apply the --days window client-side —
      // the v2 endpoint has no listed_after filter.
      const itemOffers = data.offers.filter(
        o => !o.criteria && o.asset?.identifier &&
          (!listedAfter || o.order_created_at >= listedAfter)
      );
      allOffers.push(...itemOffers);
      console.log(`  Got ${data.offers.length} offers, kept ${itemOffers.length} item offers in window (total: ${allOffers.length})`);
    }

    cursor = data.next;
    page++;
    if (cursor) {
      await sleep(300);
    }
  } while (cursor);

  return allOffers;
}

async function reconcileOffers(pool: Pool, tokenId?: string, limit = 50, days = 21) {
  console.log('=== OpenSea Offer Reconciliation ===\n');
  console.log(`Mode: ${FIX_MODE ? 'FIX (will insert missing offers)' : 'CHECK ONLY (dry run)'}`);
  console.log(`Looking back: ${days} days\n`);

  // Compute listed_after timestamp
  const listedAfter = Math.floor(Date.now() / 1000) - (days * 86400);

  // Fetch offers from OpenSea
  const osOffers = await fetchOpenSeaOffers(tokenId, limit, listedAfter);
  console.log(`\nFetched ${osOffers.length} offers from OpenSea\n`);

  if (osOffers.length === 0) {
    console.log('No offers found on OpenSea.');
    return;
  }

  // Get order hashes to check against our database
  const orderHashes = osOffers
    .filter(o => o.status === 'ACTIVE')
    .map(o => o.order_hash);

  if (orderHashes.length === 0) {
    console.log('No active offers found.');
    return;
  }

  // Check which offers we already have
  const existingResult = await pool.query(
    `SELECT order_hash FROM offers WHERE order_hash = ANY($1)`,
    [orderHashes]
  );
  const existingHashes = new Set(existingResult.rows.map(r => r.order_hash));

  // Find missing offers
  const missingOffers = osOffers.filter(
    o => o.status === 'ACTIVE' && !existingHashes.has(o.order_hash)
  );

  console.log('=== Results ===\n');
  console.log(`Total offers from OpenSea:    ${osOffers.length}`);
  console.log(`Already in our database:      ${existingHashes.size}`);
  console.log(`MISSING from our database:    ${missingOffers.length}`);

  if (missingOffers.length === 0) {
    console.log('\nNo missing offers. Database is in sync with OpenSea.');
    return;
  }

  console.log('\n=== Missing Offers ===\n');
  for (const offer of missingOffers) {
    const tokenId = offer.asset?.identifier || 'unknown';
    const priceRaw = offer.price.value;
    const priceDisplay = (Number(priceRaw) / 10 ** offer.price.decimals).toString();
    const expiresAt = new Date(Number(offer.protocol_data.parameters.endTime) * 1000).toISOString();

    console.log(`Token ID: ${tokenId}`);
    console.log(`  Order Hash: ${offer.order_hash}`);
    console.log(`  Price: ${priceDisplay} ${offer.price.currency} (${priceRaw} wei)`);
    console.log(`  Maker: ${offer.protocol_data.parameters.offerer}`);
    console.log(`  Expires: ${expiresAt}`);
    console.log('');
  }

  if (FIX_MODE) {
    console.log('=== Inserting Missing Offers ===\n');

    let inserted = 0;
    let failed = 0;

    for (const offer of missingOffers) {
      try {
        const tokenId = offer.asset?.identifier;
        if (!tokenId) {
          console.log(`  [SKIP] No token_id found in offer ${offer.order_hash}`);
          continue;
        }

        // Look up ens_name_id by token_id
        const ensNameResult = await pool.query(
          'SELECT id, name FROM ens_names WHERE token_id = $1',
          [tokenId]
        );

        if (ensNameResult.rows.length === 0) {
          console.log(`  [SKIP] ENS name not found for token ${tokenId}`);
          failed++;
          continue;
        }

        const ensNameId: number = ensNameResult.rows[0].id;
        const ensName: string = ensNameResult.rows[0].name;

        // Get currency from the offer
        const currencyAddress = offer.protocol_data?.parameters?.offer?.[0]?.token ||
          '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'; // Default to WETH

        // Insert the offer
        await pool.query(
          `INSERT INTO offers (
            ens_name_id,
            buyer_address,
            offer_amount_wei,
            currency_address,
            order_hash,
            order_data,
            status,
            source,
            expires_at,
            created_at
          )
          VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'opensea', $7, $8)
          ON CONFLICT (order_hash, source) DO NOTHING`,
          [
            ensNameId,
            offer.protocol_data.parameters.offerer.toLowerCase(),
            offer.price.value,
            currencyAddress.toLowerCase(),
            offer.order_hash,
            JSON.stringify(offer.protocol_data),
            new Date(Number(offer.protocol_data.parameters.endTime) * 1000),
            new Date(offer.order_created_at * 1000),
          ]
        );

        console.log(`  [OK] Inserted offer for ${ensName} (${offer.order_hash.slice(0, 10)}...)`);
        inserted++;
      } catch (error: any) {
        console.log(`  [ERROR] Failed to insert offer ${offer.order_hash}: ${error.message}`);
        failed++;
      }
    }

    console.log(`\n=== Summary ===`);
    console.log(`Inserted: ${inserted}`);
    console.log(`Failed:   ${failed}`);
  } else {
    console.log('=== To insert missing offers, run with --fix flag ===');
    console.log('npx tsx src/scripts/reconcile-opensea-offers.ts --fix\n');
  }
}

async function main() {
  const { tokenId, limit, days } = parseArgs();

  console.log(`Token ID filter: ${tokenId || 'none (all offers)'}`);
  console.log(`Limit: ${limit}`);
  console.log(`Days: ${days}`);
  console.log('');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 5,
  });

  try {
    await pool.query('SELECT 1');
    console.log('Database connected.\n');

    await reconcileOffers(pool, tokenId, limit, days);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

main();
