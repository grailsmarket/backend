import PgBoss from 'pg-boss';
import type { Pool } from 'pg';
import { config, getPostgresPool, CURRENCY_ADDRESSES, isEthRegistryToken, findEnsV2NameByTokenId, getOpenSeaCollectionSlugs, ensNameIdForName } from '../../../shared/src';
import { labelhash, namehash } from 'viem';
import { QUEUE_NAMES } from '../queue';
import { logger } from '../utils/logger';

const OPENSEA_API_KEY = config.opensea.apiKey;
const RECONCILE_LIMIT = 100;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// The 5-minute run only reads the newest pages, so a listing the stream drops is healed only
// while it's among the newest RECONCILE_MAX_PAGES * 100. The full run reads every listing
// (the ens collection had 235 pages in Nov 2026) to catch anything older.
const MAX_PAGES = parseInt(process.env.RECONCILE_MAX_PAGES || '5', 10);
const FULL_SCAN_MAX_PAGES = parseInt(process.env.RECONCILE_FULL_MAX_PAGES || '1000', 10);
const FULL_SCAN_CRON = process.env.RECONCILE_FULL_CRON || '20 */6 * * *';
// The full scan only adds listings created this recently. OpenSea keeps months-old listings
// active (in Nov 2026 ~1,250 v1 ones from May-Sep were never on Grails, many on names since
// expired); adding those is a reviewed backfill (repair-opensea-listings script), not
// something to do automatically with a watcher notification for each.
const FULL_SCAN_MAX_AGE_DAYS = parseInt(process.env.RECONCILE_FULL_MAX_AGE_DAYS || '30', 10);
const PAGE_DELAY_MS = 300;
const MAX_PAGE_RETRIES = 3;

// Seaport orders as we store them carry their parameters; anything else (e.g. an OpenSea
// stream summary) can't be validated or filled
const HAS_SEAPORT_ORDER_SQL = `COALESCE(order_data ? 'protocol_data' OR order_data ? 'parameters', false)`;

// Shapes from the v2 offers/listings endpoints
// (/api/v2/offers/collection/{slug}/all and /api/v2/listings/collection/{slug}/all).
// The legacy /orders/{chain}/seaport/{offers,listings} endpoints were removed
// by OpenSea and return 405.
interface OpenSeaOffer {
  order_hash: string;
  protocol_data: {
    parameters: {
      offerer: string;
      offer: Array<{ itemType: number; token: string; startAmount: string }>;
      endTime: string;
    };
  };
  asset: { identifier: string; contract: string } | null;
  order_created_at: number;
  criteria: unknown | null;
  price: { currency: string; decimals: number; value: string };
  status: string;
}

interface OpenSeaListing {
  order_hash: string;
  protocol_data: {
    parameters: {
      offerer: string;
      endTime: string;
      // The seller's payment comes first; its token is the listing currency
      consideration?: Array<{ token: string }>;
    };
  };
  asset: { identifier: string; contract: string } | null;
  order_created_at: number;
  price: { current: { currency: string; decimals: number; value: string } };
  status: string;
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
  listingsOrderDataRepaired: number;
  pagesFetched: number;
  fullScan: boolean;
  // Per-collection and per-part failures; the parts that worked still ran
  errors: string[];
}

export async function registerReconcileOpenseaWorker(boss: PgBoss) {
  const pool = getPostgresPool();

  const handler = (fullScan: boolean) => async () => {
    const startTime = Date.now();
    logger.info({ fullScan }, 'Starting OpenSea reconciliation');

    const result = await reconcileOpenSea(pool, fullScan);
    const durationMs = Date.now() - startTime;

    if (result.errors.length > 0) {
      // Logged as an error but not thrown while some part worked, so one bad collection
      // can't stop the others from being reconciled
      logger.error({ ...result, durationMs }, 'OpenSea reconciliation completed with errors');
    } else {
      logger.info({ ...result, durationMs }, 'OpenSea reconciliation completed');
    }
    return result;
  };

  await boss.work(QUEUE_NAMES.RECONCILE_OPENSEA, { teamSize: 1, teamConcurrency: 1 }, handler(false));
  await boss.work(QUEUE_NAMES.RECONCILE_OPENSEA_FULL, { teamSize: 1, teamConcurrency: 1 }, handler(true));

  await boss.schedule(QUEUE_NAMES.RECONCILE_OPENSEA, '*/5 * * * *', {}, { tz: 'UTC' });
  await boss.schedule(QUEUE_NAMES.RECONCILE_OPENSEA_FULL, FULL_SCAN_CRON, {}, { tz: 'UTC' });

  logger.info(`Registered OpenSea reconciliation worker (newest listings and offers every 5 minutes; all listings on "${FULL_SCAN_CRON}")`);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Fetch an asset's name from the OpenSea NFT metadata endpoint. The v2 order
 * endpoints no longer include asset names, so this is the name source for the
 * fallback below. Failures return null — a metadata hiccup shouldn't fail the
 * whole reconcile job.
 */
async function fetchOpenSeaAssetName(contract: string, identifier: string): Promise<string | null> {
  if (!OPENSEA_API_KEY) return null;

  try {
    const response = await fetch(
      `${config.opensea.apiBaseUrl}/chain/${config.opensea.chainSlug}/contract/${contract}/nfts/${identifier}`,
      {
        headers: {
          'X-API-Key': OPENSEA_API_KEY,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!response.ok) {
      logger.warn({ contract, identifier, status: response.status }, 'OpenSea NFT metadata fetch failed');
      return null;
    }

    const data = await response.json() as { nft?: { name?: string } };
    return data.nft?.name || null;
  } catch (error: any) {
    logger.warn({ contract, identifier, error: error.message }, 'OpenSea NFT metadata fetch failed');
    return null;
  }
}

/**
 * Whether tokenId is one of the name's v1 token IDs: the registrar's labelhash of the
 * .eth label, or the NameWrapper's namehash. Hashes the name as stored (no
 * normalization), since a non-normalized name is its own token.
 */
function isV1TokenOfName(name: string, tokenId: string): boolean {
  let id: bigint;
  try {
    id = BigInt(tokenId);
  } catch {
    return false;
  }
  const label = name.endsWith('.eth') && name.split('.').length === 2 ? name.slice(0, -4) : null;
  if (label && BigInt(labelhash(label)) === id) return true;
  return BigInt(namehash(name)) === id;
}

/**
 * Resolve an OpenSea asset to an ens_names row. Tries the exact token_id
 * first; on a miss — e.g. the order carries the identity from before a
 * wrapping-state change (registrar labelhash vs wrapper namehash) while
 * ens_names stores the other — falls back to fetching the asset name from
 * OpenSea's NFT metadata endpoint and matching by name.
 */
async function resolveEnsNameId(
  pool: Pool,
  asset: { identifier: string; contract: string }
): Promise<number | null> {
  if (isEthRegistryToken(asset.contract)) {
    // ENSv2: only the name's current token ID can trade; a superseded ID (roles changed,
    // re-registered) can never fill, so don't attach its order
    const v2 = await findEnsV2NameByTokenId(asset.identifier);
    if (!v2) return null;
    if (v2.token_id !== asset.identifier) {
      logger.info(
        { tokenId: asset.identifier, currentTokenId: v2.token_id, name: v2.name },
        'Skipping OpenSea order on a superseded ENSv2 token ID'
      );
      return null;
    }
    return v2.id;
  }

  const byToken = await pool.query(
    'SELECT id FROM ens_names WHERE token_id = $1',
    [asset.identifier]
  );
  if (byToken.rows.length > 0) {
    return byToken.rows[0].id;
  }

  const name = await fetchOpenSeaAssetName(asset.contract, asset.identifier);
  if (!name) {
    return null;
  }

  // Keep OpenSea's spelling: normalizing would turn "Jesse.eth" (its own token) into
  // "jesse.eth", a different token, and attach the order to the wrong name.
  const byName = await pool.query(
    `SELECT id, name, ens_version FROM ens_names WHERE id = ${ensNameIdForName('$1')}`,
    [name]
  );
  if (byName.rows.length > 0 && !isV1TokenOfName(byName.rows[0].name, asset.identifier)) {
    // The fallback is only for the registrar/wrapper ID mismatch, so the matched row
    // must be the same name under its other v1 token ID.
    logger.warn(
      { tokenId: asset.identifier, contract: asset.contract, name, matched: byName.rows[0].name },
      'Name fallback matched a row whose token IDs differ from the order; skipping'
    );
    return null;
  }
  if (byName.rows.length > 0 && byName.rows[0].ens_version === 2 && !isEthRegistryToken(asset.contract)) {
    // The order is on the v1 token of a name that has moved to ENSv2: that token is in the
    // Graveyard and the order can never fill, so don't attach it to the v2 name.
    logger.info(
      { tokenId: asset.identifier, contract: asset.contract, name },
      'Skipping OpenSea order on the v1 token of an ENSv2 name'
    );
    return null;
  }
  if (byName.rows.length > 0) {
    logger.info(
      { tokenId: asset.identifier, name, ensNameId: byName.rows[0].id },
      'Resolved order via name fallback'
    );
    return byName.rows[0].id;
  }

  return null;
}

async function reconcileOpenSea(pool: Pool, fullScan: boolean): Promise<ReconcileResult> {
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
    listingsOrderDataRepaired: 0,
    pagesFetched: 0,
    fullScan,
    errors: [],
  };

  if (!OPENSEA_API_KEY) {
    logger.warn('OPENSEA_API_KEY not configured, skipping OpenSea reconciliation');
    return result;
  }

  // Offers and listings run independently so a failure in one doesn't skip the other. The
  // full scan is listings only: offers are far more numerous and have no backlog problem.
  const partsSucceeded: boolean[] = [];

  if (!fullScan) {
    try {
      const offersResult = await reconcileOffers(pool, MAX_PAGES);
      result.offersChecked = offersResult.checked;
      result.offersMissing = offersResult.missing;
      result.offersInserted = offersResult.inserted;
      result.offersSkippedNoToken = offersResult.skippedNoToken;
      result.offersSkippedNoEnsName = offersResult.skippedNoEnsName;
      result.pagesFetched += offersResult.pagesFetched;
      result.errors.push(...offersResult.errors);
      partsSucceeded.push(offersResult.collectionsFetched > 0);
    } catch (error: any) {
      result.errors.push(`offers: ${error.message}`);
      partsSucceeded.push(false);
    }
  }

  try {
    const listingsResult = fullScan
      ? await reconcileListings(pool, FULL_SCAN_MAX_PAGES, FULL_SCAN_MAX_AGE_DAYS)
      : await reconcileListings(pool, MAX_PAGES);
    result.listingsChecked = listingsResult.checked;
    result.listingsMissing = listingsResult.missing;
    result.listingsInserted = listingsResult.inserted;
    result.listingsSkippedNoToken = listingsResult.skippedNoToken;
    result.listingsSkippedNoEnsName = listingsResult.skippedNoEnsName;
    result.listingsOrderDataRepaired = listingsResult.orderDataRepaired;
    result.pagesFetched += listingsResult.pagesFetched;
    result.errors.push(...listingsResult.errors);
    partsSucceeded.push(listingsResult.collectionsFetched > 0);
  } catch (error: any) {
    result.errors.push(`listings: ${error.message}`);
    partsSucceeded.push(false);
  }

  if (!partsSucceeded.some(Boolean)) {
    // Nothing could be read at all (bad key, OpenSea down): fail the job so it shows as failed
    throw new Error(`OpenSea reconciliation failed: ${result.errors.join('; ')}`);
  }
  return result;
}

async function fetchOpenSeaPage(url: string, kind: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      headers: {
        'X-API-Key': OPENSEA_API_KEY!,
        'Content-Type': 'application/json',
      },
    });
    if (response.ok) {
      return response.json();
    }
    // OpenSea's error body says what's wrong, e.g. "Collection with slug X not found or inactive"
    const body = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    if ((response.status === 429 || response.status >= 500) && attempt < MAX_PAGE_RETRIES) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`OpenSea ${kind} API error: ${response.status} ${body}`);
  }
}

/**
 * Read up to maxPages of offers or listings from every collection we follow. A collection
 * that fails (e.g. a slug OpenSea retired, which returns 404) is reported in `errors` and
 * skipped; the others are still read, and pages read before a failure are kept.
 */
async function fetchFromCollections<T>(
  kind: 'offers' | 'listings',
  maxPages: number
): Promise<{ items: T[]; pagesFetched: number; collectionsFetched: number; errors: string[] }> {
  const items: T[] = [];
  const errors: string[] = [];
  let pagesFetched = 0;
  let collectionsFetched = 0;

  for (const slug of getOpenSeaCollectionSlugs()) {
    let cursor: string | null = null;
    try {
      for (let page = 0; page < maxPages; page++) {
        let url = `${config.opensea.apiBaseUrl}/${kind}/collection/${slug}/all?limit=${RECONCILE_LIMIT}`;
        if (cursor) url += `&next=${encodeURIComponent(cursor)}`;

        const data = await fetchOpenSeaPage(url, kind) as { offers?: T[]; listings?: T[]; next?: string };
        items.push(...(data[kind] || []));
        pagesFetched++;

        cursor = data.next || null;
        if (!cursor) break;
        await sleep(PAGE_DELAY_MS);
      }
      collectionsFetched++;
    } catch (error: any) {
      errors.push(`${kind} from collection "${slug}": ${error.message}`);
      logger.error({ slug, kind, error: error.message }, 'Failed to read an OpenSea collection');
    }
  }

  logger.info({ kind, pages: pagesFetched, total: items.length, maxPages }, `Fetched ${kind} from OpenSea`);
  return { items, pagesFetched, collectionsFetched, errors };
}

async function reconcileOffers(pool: Pool, maxPages: number) {
  const { items, pagesFetched, collectionsFetched, errors } = await fetchFromCollections<OpenSeaOffer>('offers', maxPages);
  // Item offers only: criteria offers are collection/trait-wide and don't map to one ens_name
  const activeOffers = items.filter(o => o.status === 'ACTIVE' && !o.criteria && o.asset?.identifier);
  const fetchInfo = { pagesFetched, collectionsFetched, errors };

  if (activeOffers.length === 0) {
    return { checked: 0, missing: 0, inserted: 0, skippedNoToken: 0, skippedNoEnsName: 0, ...fetchInfo };
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
      const tokenId = offer.asset?.identifier;
      if (!tokenId) {
        skippedNoToken++;
        continue;
      }

      const ensNameId = await resolveEnsNameId(pool, offer.asset!);
      if (!ensNameId) {
        skippedNoEnsName++;
        logger.debug({ tokenId, orderHash: offer.order_hash }, 'Could not find ens_name for offer, skipping');
        continue;
      }

      const currencyAddress = offer.protocol_data?.parameters?.offer?.[0]?.token ||
        CURRENCY_ADDRESSES.WETH;

      await pool.query(
        `INSERT INTO offers (
          ens_name_id, buyer_address, offer_amount_wei, currency_address,
          order_hash, order_data, status, source, expires_at, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', 'opensea', $7, $8)
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
      inserted++;

      logger.info({ orderHash: offer.order_hash, tokenId }, 'Inserted missing offer');
    } catch (error: any) {
      logger.warn({ error: error.message, orderHash: offer.order_hash }, 'Failed to insert offer');
    }
  }

  if (skippedNoEnsName > 0) {
    logger.warn({ skippedNoEnsName }, 'Offers skipped: ens_name not found by token_id or name');
  }

  return { checked: activeOffers.length, missing: missingOffers.length, inserted, skippedNoToken, skippedNoEnsName, ...fetchInfo };
}

async function reconcileListings(pool: Pool, maxPages: number, maxAgeDays?: number) {
  const { items, pagesFetched, collectionsFetched, errors } = await fetchFromCollections<OpenSeaListing>('listings', maxPages);
  const activeListings = items.filter(l => l.status === 'ACTIVE' && l.asset?.identifier);
  const fetchInfo = { pagesFetched, collectionsFetched, errors };

  if (activeListings.length === 0) {
    return { checked: 0, missing: 0, inserted: 0, skippedNoToken: 0, skippedNoEnsName: 0, orderDataRepaired: 0, ...fetchInfo };
  }

  const orderHashes = activeListings.map(l => l.order_hash);

  const existingResult = await pool.query(
    `SELECT order_hash, source, status, ${HAS_SEAPORT_ORDER_SQL} AS has_order FROM listings WHERE order_hash = ANY($1)`,
    [orderHashes]
  );
  const existingHashes = new Set(existingResult.rows.map(r => r.order_hash));

  // Rows whose stored order_data isn't a Seaport order can't be validated or bought. OpenSea
  // still has the order, so store it (and un-hide rows the validator hid for this reason).
  const needsOrderData = new Set(
    existingResult.rows
      .filter(r => r.source === 'opensea' && !r.has_order && (r.status === 'active' || r.status === 'unfunded'))
      .map(r => r.order_hash)
  );
  let orderDataRepaired = 0;
  for (const listing of activeListings.filter(l => needsOrderData.has(l.order_hash))) {
    try {
      const updated = await pool.query(
        `UPDATE listings
         SET order_data = $2,
             status = CASE WHEN status = 'unfunded' AND unfunded_reason = 'missing_order_data' THEN 'active' ELSE status END,
             unfunded_at = CASE WHEN unfunded_reason = 'missing_order_data' THEN NULL ELSE unfunded_at END,
             unfunded_reason = CASE WHEN unfunded_reason = 'missing_order_data' THEN NULL ELSE unfunded_reason END,
             updated_at = NOW()
         WHERE order_hash = $1 AND source = 'opensea' AND status IN ('active', 'unfunded')
           AND NOT ${HAS_SEAPORT_ORDER_SQL}
         RETURNING id`,
        [listing.order_hash, JSON.stringify(listing.protocol_data)]
      );
      orderDataRepaired += updated.rows.length;
      if (updated.rows.length > 0) {
        logger.info({ orderHash: listing.order_hash }, 'Stored the missing Seaport order for a listing');
      }
    } catch (error: any) {
      logger.warn({ error: error.message, orderHash: listing.order_hash }, 'Failed to store order data for listing');
    }
  }

  const createdAfter = maxAgeDays ? Date.now() / 1000 - maxAgeDays * 86400 : 0;
  const missingListings = activeListings.filter(
    l => !existingHashes.has(l.order_hash) && l.order_created_at >= createdAfter
  );

  let inserted = 0;
  let skippedNoToken = 0;
  let skippedNoEnsName = 0;

  for (const listing of missingListings) {
    try {
      const tokenId = listing.asset?.identifier;
      if (!tokenId) {
        skippedNoToken++;
        continue;
      }

      const ensNameId = await resolveEnsNameId(pool, listing.asset!);
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
          listing.protocol_data.parameters.offerer.toLowerCase(),
          listing.price.current.value,
          (listing.protocol_data.parameters.consideration?.[0]?.token || ZERO_ADDRESS).toLowerCase(),
          listing.order_hash,
          JSON.stringify(listing.protocol_data),
          new Date(Number(listing.protocol_data.parameters.endTime) * 1000),
          new Date(listing.order_created_at * 1000),
        ]
      );
      inserted++;

      logger.info({ orderHash: listing.order_hash, tokenId }, 'Inserted missing listing');
    } catch (error: any) {
      logger.warn({ error: error.message, orderHash: listing.order_hash }, 'Failed to insert listing');
    }
  }

  if (skippedNoEnsName > 0) {
    logger.warn({ skippedNoEnsName }, 'Listings skipped: ens_name not found by token_id or name');
  }

  return { checked: activeListings.length, missing: missingListings.length, inserted, skippedNoToken, skippedNoEnsName, orderDataRepaired, ...fetchInfo };
}
