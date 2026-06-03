import PgBoss from 'pg-boss';
import type { Pool } from 'pg';
import { config, getPostgresPool } from '../../../shared/src';
import { QUEUE_NAMES } from '../queue';
import { logger } from '../utils/logger';
import { WETH_ADDRESS } from './types';

/**
 * ENS Vision offer reconciliation.
 *
 * Vision runs a self-hosted Seaport v1.6 orderbook (the same protocol Grails
 * settles on). Their public API exposes:
 *   - GET /v1/activity?eventTypes=OFFER_CREATED  → discovery feed (order hash in `id`)
 *   - GET /v1/orderbook/offers-fulfill?id=<orderHash>  → full signed Seaport order
 *
 * Neither requires an API key. We poll the activity feed, fetch the signed order
 * for each new offer, and store it as a fulfillable offer with source='vision'
 * (order_data shaped { parameters, signature } to match OpenSea/Grails offers).
 */

const ACTIVITY_LIMIT = 50;
const MAX_PAGES = parseInt(process.env.RECONCILE_VISION_MAX_PAGES || '3', 10);
const FULFILL_DELAY_MS = parseInt(process.env.RECONCILE_VISION_DELAY_MS || '250', 10);
const FETCH_TIMEOUT_MS = parseInt(process.env.RECONCILE_VISION_FETCH_TIMEOUT_MS || '15000', 10);

// offer-<0x…64hex>-<uuid>
const ORDER_HASH_RE = /^offer-(0x[0-9a-fA-F]{64})-/;

interface VisionActivity {
  id: string;
  type: string;
  nameTokenId: string; // chainId-contract-tokenId
  from: string | null;
  blockTimestamp: number | null;
  metadata?: {
    offer?: {
      price: string;
      currency: string;
      currencySymbol: string;
      maker: string;
      expiry: number;
      domainName: string;
    };
  };
}

interface VisionFulfillment {
  orderId: string;
  orderData: Record<string, any>; // Seaport OrderComponents
  signature: string;
}

interface ReconcileResult {
  fetched: number;
  alreadyStored: number;
  inserted: number;
  skippedNoHash: number;
  skippedNoEnsName: number;
  skippedNoFulfillment: number;
}

export async function registerReconcileVisionWorker(boss: PgBoss) {
  const pool = getPostgresPool();

  await boss.work(
    QUEUE_NAMES.RECONCILE_VISION,
    { teamSize: 1, teamConcurrency: 1 },
    async () => {
      if (!config.ensvision.enabled) {
        logger.info('ENS Vision reconciliation disabled (ENSVISION_ENABLED=false), skipping');
        return { skipped: true };
      }

      const startTime = Date.now();
      logger.info('Starting ENS Vision reconciliation');

      try {
        const result = await reconcileVision(pool, boss);
        logger.info({ ...result, durationMs: Date.now() - startTime }, 'ENS Vision reconciliation completed');
        return result;
      } catch (error: any) {
        logger.error({ error: error.message }, 'ENS Vision reconciliation failed');
        throw error;
      }
    }
  );

  await boss.schedule(QUEUE_NAMES.RECONCILE_VISION, '*/5 * * * *', {}, { tz: 'UTC' });

  logger.info('Registered ENS Vision reconciliation worker (every 5 minutes)');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * fetch with an abort-based timeout so a hung Vision API response can't block a
 * pg-boss worker slot indefinitely.
 */
async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchVisionActivity(maxPages = MAX_PAGES): Promise<VisionActivity[]> {
  const base = config.ensvision.apiBaseUrl;
  const all: VisionActivity[] = [];

  for (let page = 0; page < maxPages; page++) {
    const offset = page * ACTIVITY_LIMIT;
    const url = `${base}/activity?eventTypes=OFFER_CREATED&limit=${ACTIVITY_LIMIT}` +
      `&sortBy=timestamp&sortOrder=desc&isSubdomain=false&resolve=true&offset=${offset}`;

    const response = await fetchWithTimeout(url);
    if (!response.ok) {
      throw new Error(`Vision activity API error: ${response.status}`);
    }

    const data = await response.json() as { activities?: VisionActivity[] };
    const activities = data.activities || [];
    all.push(...activities);

    // Last page reached when the feed returns fewer than a full page
    if (activities.length < ACTIVITY_LIMIT) break;
    if (page < maxPages - 1) await sleep(300);
  }

  logger.info({ total: all.length }, 'Fetched OFFER_CREATED activity from ENS Vision');
  return all;
}

async function fetchFulfillment(orderHash: string): Promise<VisionFulfillment | null> {
  const url = `${config.ensvision.apiBaseUrl}/orderbook/offers-fulfill?id=${orderHash}`;
  const response = await fetchWithTimeout(url);

  if (!response.ok) {
    logger.warn({ orderHash, status: response.status }, 'Vision offers-fulfill returned non-200, skipping offer');
    return null;
  }

  const data = await response.json() as VisionFulfillment;
  if (!data?.orderData || !data?.signature) {
    logger.warn({ orderHash }, 'Vision offers-fulfill missing orderData/signature, skipping');
    return null;
  }
  return data;
}

async function reconcileVision(pool: Pool, boss: PgBoss): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    fetched: 0,
    alreadyStored: 0,
    inserted: 0,
    skippedNoHash: 0,
    skippedNoEnsName: 0,
    skippedNoFulfillment: 0,
  };

  const activities = (await fetchVisionActivity()).filter(
    a => a.type === 'OFFER_CREATED' && a.metadata?.offer
  );
  result.fetched = activities.length;
  if (activities.length === 0) return result;

  // Map each activity to its order hash up front so we can dedupe in one query
  const withHash = activities
    .map(a => ({ activity: a, orderHash: ORDER_HASH_RE.exec(a.id)?.[1]?.toLowerCase() || null }))
    .filter((x): x is { activity: VisionActivity; orderHash: string } => {
      if (!x.orderHash) result.skippedNoHash++;
      return x.orderHash !== null;
    });

  const existingResult = await pool.query(
    `SELECT order_hash FROM offers WHERE source = 'vision' AND order_hash = ANY($1)`,
    [withHash.map(x => x.orderHash)]
  );
  const existingHashes = new Set(existingResult.rows.map(r => r.order_hash.toLowerCase()));

  const missing = withHash.filter(x => !existingHashes.has(x.orderHash));
  result.alreadyStored = withHash.length - missing.length;

  for (const { activity, orderHash } of missing) {
    try {
      const offer = activity.metadata!.offer!;

      // Resolve ens_name_id: token_id from nameTokenId (chainId-contract-tokenId), fallback to name
      const tokenId = activity.nameTokenId?.split('-')[2];
      let ensNameId: number | null = null;

      if (tokenId) {
        const byToken = await pool.query('SELECT id FROM ens_names WHERE token_id = $1', [tokenId]);
        if (byToken.rows.length > 0) ensNameId = byToken.rows[0].id;
      }
      if (!ensNameId && offer.domainName) {
        const byName = await pool.query('SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)', [offer.domainName]);
        if (byName.rows.length > 0) ensNameId = byName.rows[0].id;
      }
      if (!ensNameId) {
        result.skippedNoEnsName++;
        logger.debug({ orderHash, tokenId, name: offer.domainName }, 'Could not resolve ens_name for Vision offer, skipping');
        continue;
      }

      // Fetch the signed Seaport order
      const fulfillment = await fetchFulfillment(orderHash);
      await sleep(FULFILL_DELAY_MS);
      if (!fulfillment) {
        result.skippedNoFulfillment++;
        continue;
      }

      const params = fulfillment.orderData;
      const buyerAddress = (params.offerer || offer.maker).toLowerCase();
      const currencyAddress = (params.offer?.[0]?.token || offer.currency || WETH_ADDRESS).toLowerCase();
      // Prefer the amount hashed into the signed order — it is the canonical on-chain
      // value the balance validator compares against. `offer.price` from the activity
      // feed is advisory metadata and can diverge from the actual order.
      const offerAmountWei = params.offer?.[0]?.startAmount || offer.price;
      const expiresAt = params.endTime
        ? new Date(Number(params.endTime) * 1000)
        : (offer.expiry ? new Date(offer.expiry * 1000) : null);
      const createdAt = activity.blockTimestamp ? new Date(activity.blockTimestamp * 1000) : new Date();
      const orderData = JSON.stringify({ parameters: params, signature: fulfillment.signature });

      const insertResult = await pool.query(
        `INSERT INTO offers (
          ens_name_id, buyer_address, offer_amount_wei, currency_address,
          order_hash, order_data, status, source, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'vision', $7, $8)
        ON CONFLICT (order_hash, source) DO UPDATE SET
          offer_amount_wei = EXCLUDED.offer_amount_wei,
          expires_at = EXCLUDED.expires_at,
          order_data = EXCLUDED.order_data,
          status = 'pending'
        RETURNING id`,
        [ensNameId, buyerAddress, offerAmountWei, currencyAddress, orderHash, orderData, expiresAt, createdAt]
      );
      result.inserted++;
      logger.info({ orderHash, ensNameId, name: offer.domainName }, 'Inserted Vision offer');

      // Let the new offer compete for the name's highest offer (same as opensea-stream)
      if (insertResult.rows.length > 0 && offerAmountWei) {
        await boss.send(QUEUE_NAMES.UPDATE_HIGHEST_OFFER, {
          ensNameId,
          offerId: insertResult.rows[0].id,
          offerAmountWei,
          currencyAddress,
        });
      }
    } catch (error: any) {
      logger.warn({ error: error.message, orderHash }, 'Failed to insert Vision offer');
    }
  }

  if (result.skippedNoEnsName > 0) {
    logger.warn({ skippedNoEnsName: result.skippedNoEnsName }, 'Vision offers skipped: ens_name not found');
  }

  return result;
}
