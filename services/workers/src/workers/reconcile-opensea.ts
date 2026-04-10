import PgBoss from 'pg-boss';
import type { Pool } from 'pg';
import { config, getPostgresPool } from '../../../shared/src';
import { QUEUE_NAMES } from '../queue';
import { logger } from '../utils/logger';

const OPENSEA_API_KEY = config.opensea.apiKey;
const RECONCILE_LIMIT = 100;

interface OpenSeaOffer {
  order_hash: string;
  created_date: string;
  expiration_time: number;
  current_price: string;
  maker: { address: string };
  protocol_data: { parameters: { offer: Array<{ token: string }> } };
  taker_asset_bundle: { assets: Array<{ token_id: string; name: string }> };
  cancelled: boolean;
  finalized: boolean;
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

interface ReconcileResult {
  offersChecked: number;
  offersMissing: number;
  offersInserted: number;
  offersSkippedNoToken: number;
  offersSkippedNoEnsName: number;
  listingsChecked: number;
  listingsMissing: number;
  listingsInserted: number;
  listingsSkippedNoToken: number;
  listingsSkippedNoEnsName: number;
  listingsResolvedViaName: number;
  pagesFetched: number;
}

export async function registerReconcileOpenseaWorker(boss: PgBoss) {
  const pool = getPostgresPool();

  await boss.work(
    QUEUE_NAMES.RECONCILE_OPENSEA,
    { teamSize: 1, teamConcurrency: 1 },
    async () => {
      const startTime = Date.now();
      logger.info('Starting OpenSea reconciliation');

      try {
        const result = await reconcileOpenSea(pool);

        const duration = Date.now() - startTime;
        logger.info({
          ...result,
          durationMs: duration,
        }, 'OpenSea reconciliation completed');

        return result;
      } catch (error: any) {
        logger.error({ error: error.message }, 'OpenSea reconciliation failed');
        throw error;
      }
    }
  );

  await boss.schedule(QUEUE_NAMES.RECONCILE_OPENSEA, '*/5 * * * *', {}, { tz: 'UTC' });

  logger.info('Registered OpenSea reconciliation worker (every 5 minutes)');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const MAX_PAGES = parseInt(process.env.RECONCILE_MAX_PAGES || '5', 10);

async function reconcileOpenSea(pool: Pool): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    offersChecked: 0,
    offersMissing: 0,
    offersInserted: 0,
    offersSkippedNoToken: 0,
    offersSkippedNoEnsName: 0,
    listingsChecked: 0,
    listingsMissing: 0,
    listingsInserted: 0,
    listingsSkippedNoToken: 0,
    listingsSkippedNoEnsName: 0,
    listingsResolvedViaName: 0,
    pagesFetched: 0,
  };

  const offersResult = await reconcileOffers(pool);
  result.offersChecked = offersResult.checked;
  result.offersMissing = offersResult.missing;
  result.offersInserted = offersResult.inserted;
  result.offersSkippedNoToken = offersResult.skippedNoToken;
  result.offersSkippedNoEnsName = offersResult.skippedNoEnsName;

  const listingsResult = await reconcileListings(pool);
  result.listingsChecked = listingsResult.checked;
  result.listingsMissing = listingsResult.missing;
  result.listingsInserted = listingsResult.inserted;
  result.listingsSkippedNoToken = listingsResult.skippedNoToken;
  result.listingsSkippedNoEnsName = listingsResult.skippedNoEnsName;
  result.listingsResolvedViaName = listingsResult.resolvedViaName;
  result.pagesFetched = listingsResult.pagesFetched;

  return result;
}

async function fetchOpenSeaOffers(maxPages = MAX_PAGES): Promise<OpenSeaOffer[]> {
  if (!OPENSEA_API_KEY) {
    logger.warn('OPENSEA_API_KEY not configured, skipping offer reconciliation');
    return [];
  }

  const allOffers: OpenSeaOffer[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < maxPages; page++) {
    let url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/offers?collection_slug=ens&limit=${RECONCILE_LIMIT}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const response = await fetch(url, {
      headers: {
        'X-API-Key': OPENSEA_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`OpenSea offers API error: ${response.status}`);
    }

    const data = await response.json() as { orders?: OpenSeaOffer[]; next?: string };
    allOffers.push(...(data.orders || []));

    cursor = data.next || null;
    if (!cursor) break;

    // Rate limit between pages
    if (page < maxPages - 1) await sleep(300);
  }

  logger.info({ pages: Math.min(maxPages, allOffers.length > 0 ? Math.ceil(allOffers.length / RECONCILE_LIMIT) : 1), total: allOffers.length }, 'Fetched offers from OpenSea');
  return allOffers;
}

async function fetchOpenSeaListings(maxPages = MAX_PAGES): Promise<{ listings: OpenSeaListing[]; pagesFetched: number }> {
  if (!OPENSEA_API_KEY) {
    logger.warn('OPENSEA_API_KEY not configured, skipping listing reconciliation');
    return { listings: [], pagesFetched: 0 };
  }

  const allListings: OpenSeaListing[] = [];
  let cursor: string | null = null;
  let pagesFetched = 0;

  for (let page = 0; page < maxPages; page++) {
    let url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/listings?collection_slug=ens&limit=${RECONCILE_LIMIT}`;
    if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`;

    const response = await fetch(url, {
      headers: {
        'X-API-Key': OPENSEA_API_KEY,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`OpenSea listings API error: ${response.status}`);
    }

    const data = await response.json() as { orders?: OpenSeaListing[]; next?: string };
    allListings.push(...(data.orders || []));
    pagesFetched++;

    cursor = data.next || null;
    if (!cursor) break;

    // Rate limit between pages
    if (page < maxPages - 1) await sleep(300);
  }

  logger.info({ pages: pagesFetched, total: allListings.length }, 'Fetched listings from OpenSea');
  return { listings: allListings, pagesFetched };
}

async function reconcileOffers(pool: Pool) {
  const osOffers = await fetchOpenSeaOffers();
  const activeOffers = osOffers.filter(o => !o.cancelled && !o.finalized);

  if (activeOffers.length === 0) {
    return { checked: 0, missing: 0, inserted: 0, skippedNoToken: 0, skippedNoEnsName: 0 };
  }

  const orderHashes = activeOffers.map(o => o.order_hash);

  const existingResult = await pool.query(
    `SELECT order_hash FROM offers WHERE order_hash = ANY($1)`,
    [orderHashes]
  );
  const existingHashes = new Set(existingResult.rows.map(r => r.order_hash));

  const missingOffers = activeOffers.filter(o => !existingHashes.has(o.order_hash));

  let inserted = 0;
  let skippedNoToken = 0;
  let skippedNoEnsName = 0;

  for (const offer of missingOffers) {
    try {
      const tokenId = offer.taker_asset_bundle?.assets?.[0]?.token_id;
      if (!tokenId) {
        skippedNoToken++;
        continue;
      }

      // Try direct token_id lookup first
      let ensNameId: number | null = null;
      const ensResult = await pool.query(
        'SELECT id FROM ens_names WHERE token_id = $1',
        [tokenId]
      );

      if (ensResult.rows.length > 0) {
        ensNameId = ensResult.rows[0].id;
      } else {
        // Fallback: try name-based lookup using OpenSea metadata
        const name = offer.taker_asset_bundle?.assets?.[0]?.name;
        if (name) {
          const nameResult = await pool.query(
            'SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)',
            [name]
          );
          if (nameResult.rows.length > 0) {
            ensNameId = nameResult.rows[0].id;
            logger.info({ tokenId, name, ensNameId }, 'Resolved offer via name fallback');
          }
        }
      }

      if (!ensNameId) {
        skippedNoEnsName++;
        logger.debug({ tokenId, orderHash: offer.order_hash }, 'Could not find ens_name for offer, skipping');
        continue;
      }

      const currencyAddress = offer.protocol_data?.parameters?.offer?.[0]?.token ||
        '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';

      await pool.query(
        `INSERT INTO offers (
          ens_name_id, buyer_address, offer_amount_wei, currency_address,
          order_hash, order_data, status, source, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'opensea', $7, $8)
        ON CONFLICT (order_hash, source) DO NOTHING`,
        [
          ensNameId,
          offer.maker.address.toLowerCase(),
          offer.current_price,
          currencyAddress.toLowerCase(),
          offer.order_hash,
          JSON.stringify(offer.protocol_data),
          new Date(offer.expiration_time * 1000),
          new Date(offer.created_date),
        ]
      );
      inserted++;

      logger.info({ orderHash: offer.order_hash, tokenId }, 'Inserted missing offer');
    } catch (error: any) {
      logger.warn({ error: error.message, orderHash: offer.order_hash }, 'Failed to insert offer');
    }
  }

  if (skippedNoEnsName > 0) {
    logger.warn({ skippedNoEnsName }, 'Offers skipped: ens_name not found by token_id or name');
  }

  return { checked: activeOffers.length, missing: missingOffers.length, inserted, skippedNoToken, skippedNoEnsName };
}

async function reconcileListings(pool: Pool) {
  const { listings: osListings, pagesFetched } = await fetchOpenSeaListings();
  const activeListings = osListings.filter(l => !l.cancelled && !l.finalized);

  if (activeListings.length === 0) {
    return { checked: 0, missing: 0, inserted: 0, skippedNoToken: 0, skippedNoEnsName: 0, resolvedViaName: 0, pagesFetched };
  }

  const orderHashes = activeListings.map(l => l.order_hash);

  const existingResult = await pool.query(
    `SELECT order_hash FROM listings WHERE order_hash = ANY($1)`,
    [orderHashes]
  );
  const existingHashes = new Set(existingResult.rows.map(r => r.order_hash));

  const missingListings = activeListings.filter(l => !existingHashes.has(l.order_hash));

  let inserted = 0;
  let skippedNoToken = 0;
  let skippedNoEnsName = 0;
  let resolvedViaName = 0;

  for (const listing of missingListings) {
    try {
      const tokenId = listing.maker_asset_bundle?.assets?.[0]?.token_id;
      if (!tokenId) {
        skippedNoToken++;
        continue;
      }

      // Try direct token_id lookup first
      let ensNameId: number | null = null;
      const ensResult = await pool.query(
        'SELECT id FROM ens_names WHERE token_id = $1',
        [tokenId]
      );

      if (ensResult.rows.length > 0) {
        ensNameId = ensResult.rows[0].id;
      } else {
        // Fallback: try name-based lookup using OpenSea metadata
        const name = listing.maker_asset_bundle?.assets?.[0]?.name;
        if (name) {
          const nameResult = await pool.query(
            'SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)',
            [name]
          );
          if (nameResult.rows.length > 0) {
            ensNameId = nameResult.rows[0].id;
            resolvedViaName++;
            logger.info({ tokenId, name, ensNameId }, 'Resolved listing via name fallback');
          }
        }
      }

      if (!ensNameId) {
        skippedNoEnsName++;
        logger.debug({ tokenId, orderHash: listing.order_hash }, 'Could not find ens_name for listing, skipping');
        continue;
      }

      await pool.query(
        `INSERT INTO listings (
          ens_name_id, seller_address, price_wei, currency_address,
          order_hash, order_data, status, source, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'active', 'opensea', $7, $8)
        ON CONFLICT (order_hash, source) DO NOTHING`,
        [
          ensNameId,
          listing.maker.address.toLowerCase(),
          listing.current_price,
          '0x0000000000000000000000000000000000000000',
          listing.order_hash,
          JSON.stringify(listing.protocol_data),
          new Date(listing.expiration_time * 1000),
          new Date(listing.created_date),
        ]
      );
      inserted++;

      logger.info({ orderHash: listing.order_hash, tokenId }, 'Inserted missing listing');
    } catch (error: any) {
      logger.warn({ error: error.message, orderHash: listing.order_hash }, 'Failed to insert listing');
    }
  }

  if (skippedNoEnsName > 0) {
    logger.warn({ skippedNoEnsName, resolvedViaName }, 'Listings skipped: ens_name not found by token_id or name');
  }

  return { checked: activeListings.length, missing: missingListings.length, inserted, skippedNoToken, skippedNoEnsName, resolvedViaName, pagesFetched };
}
