import PgBoss from 'pg-boss';
import { Pool } from 'pg';
import { config, getPostgresPool } from '../../../shared/src';
import { QUEUE_NAMES } from '../queue';
import { logger } from '../utils/logger';

const ENS_CONTRACT = '0x57f1887a8bf19b14fc0df6fd9b2acc9af147ea85';
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
  listingsChecked: number;
  listingsMissing: number;
  listingsInserted: number;
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

async function reconcileOpenSea(pool: Pool): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    offersChecked: 0,
    offersMissing: 0,
    offersInserted: 0,
    listingsChecked: 0,
    listingsMissing: 0,
    listingsInserted: 0,
  };

  const offersResult = await reconcileOffers(pool);
  result.offersChecked = offersResult.checked;
  result.offersMissing = offersResult.missing;
  result.offersInserted = offersResult.inserted;

  const listingsResult = await reconcileListings(pool);
  result.listingsChecked = listingsResult.checked;
  result.listingsMissing = listingsResult.missing;
  result.listingsInserted = listingsResult.inserted;

  return result;
}

async function fetchOpenSeaOffers(): Promise<OpenSeaOffer[]> {
  if (!OPENSEA_API_KEY) {
    logger.warn('OPENSEA_API_KEY not configured, skipping offer reconciliation');
    return [];
  }

  const url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/offers?asset_contract_address=${ENS_CONTRACT}&limit=${RECONCILE_LIMIT}`;

  const response = await fetch(url, {
    headers: {
      'X-API-Key': OPENSEA_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`OpenSea offers API error: ${response.status}`);
  }

  const data = await response.json() as { orders?: OpenSeaOffer[] };
  return data.orders || [];
}

async function fetchOpenSeaListings(): Promise<OpenSeaListing[]> {
  if (!OPENSEA_API_KEY) {
    logger.warn('OPENSEA_API_KEY not configured, skipping listing reconciliation');
    return [];
  }

  const url = `https://api.opensea.io/api/v2/orders/ethereum/seaport/listings?asset_contract_address=${ENS_CONTRACT}&limit=${RECONCILE_LIMIT}`;

  const response = await fetch(url, {
    headers: {
      'X-API-Key': OPENSEA_API_KEY,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`OpenSea listings API error: ${response.status}`);
  }

  const data = await response.json() as { orders?: OpenSeaListing[] };
  return data.orders || [];
}

async function reconcileOffers(pool: Pool) {
  const osOffers = await fetchOpenSeaOffers();
  const activeOffers = osOffers.filter(o => !o.cancelled && !o.finalized);

  if (activeOffers.length === 0) {
    return { checked: 0, missing: 0, inserted: 0 };
  }

  const orderHashes = activeOffers.map(o => o.order_hash);

  const existingResult = await pool.query(
    `SELECT order_hash FROM offers WHERE order_hash = ANY($1)`,
    [orderHashes]
  );
  const existingHashes = new Set(existingResult.rows.map(r => r.order_hash));

  const missingOffers = activeOffers.filter(o => !existingHashes.has(o.order_hash));

  let inserted = 0;
  for (const offer of missingOffers) {
    try {
      const tokenId = offer.taker_asset_bundle?.assets?.[0]?.token_id;
      if (!tokenId) continue;

      const ensResult = await pool.query(
        'SELECT id FROM ens_names WHERE token_id = $1',
        [tokenId]
      );
      if (ensResult.rows.length === 0) continue;

      const ensNameId = ensResult.rows[0].id;
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

  return { checked: activeOffers.length, missing: missingOffers.length, inserted };
}

async function reconcileListings(pool: Pool) {
  const osListings = await fetchOpenSeaListings();
  const activeListings = osListings.filter(l => !l.cancelled && !l.finalized);

  if (activeListings.length === 0) {
    return { checked: 0, missing: 0, inserted: 0 };
  }

  const orderHashes = activeListings.map(l => l.order_hash);

  const existingResult = await pool.query(
    `SELECT order_hash FROM listings WHERE order_hash = ANY($1)`,
    [orderHashes]
  );
  const existingHashes = new Set(existingResult.rows.map(r => r.order_hash));

  const missingListings = activeListings.filter(l => !existingHashes.has(l.order_hash));

  let inserted = 0;
  for (const listing of missingListings) {
    try {
      const tokenId = listing.maker_asset_bundle?.assets?.[0]?.token_id;
      if (!tokenId) continue;

      const ensResult = await pool.query(
        'SELECT id FROM ens_names WHERE token_id = $1',
        [tokenId]
      );
      if (ensResult.rows.length === 0) continue;

      const ensNameId = ensResult.rows[0].id;

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

  return { checked: activeListings.length, missing: missingListings.length, inserted };
}
