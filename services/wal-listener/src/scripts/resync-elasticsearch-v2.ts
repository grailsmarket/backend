#!/usr/bin/env tsx
/**
 * Reliable Elasticsearch Resync Script (v2)
 *
 * Full reindex of all ENS names from PostgreSQL to Elasticsearch.
 * Replaces the older resync scripts with a more reliable approach.
 *
 * Why previous scripts had issues:
 * - complete-resync: OFFSET pagination gets exponentially slower at high offsets,
 *   and 5 concurrent heavy queries (lateral join + group by) overwhelm the DB
 * - fast-resync: Skips listings/offers entirely (incomplete data)
 * - resync: Batch size 100, sequential, same OFFSET problem
 *
 * This script fixes all of that:
 * - Keyset pagination (WHERE id > lastId) - O(1) at any position
 * - Pre-loads listings and offers into memory - no per-batch JOINs
 * - Sequential DB reads (the simple query is fast enough, no need for concurrency)
 * - Full data enrichment: listings, offers, USD pricing, creation_date
 * - Resumable via checkpoint file
 * - Batch retry with exponential backoff
 * - Graceful shutdown on SIGINT/SIGTERM
 *
 * Usage:
 *   npx tsx src/scripts/resync-elasticsearch-v2.ts              # Fresh start
 *   npx tsx src/scripts/resync-elasticsearch-v2.ts --resume      # Resume from checkpoint
 *   npx tsx src/scripts/resync-elasticsearch-v2.ts --from 500000 # Start from specific ID
 */

import { getElasticsearchClient, getPostgresPool, config, closeAllConnections, isEthOrWeth, hasEmoji } from '../../../shared/src';
import * as fs from 'fs';
import * as path from 'path';

const esClient = getElasticsearchClient();
const pool = getPostgresPool();

const BATCH_SIZE = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const CHECKPOINT_INTERVAL = 10; // Save checkpoint every N batches

const CHECKPOINT_FILE = path.join(process.cwd(), 'data', 'resync-checkpoint.json');

// Currency constants
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ETH_DECIMALS = 18;
const USDC_DECIMALS = 6;
const MAX_ES_PRICE_WEI = 1e27;

// --- Types ---

interface ListingData {
  price_wei: string;
  currency_address: string | null;
  status: string;
  created_at: string;
  expires_at: string | null;
}

interface OfferData {
  count: number;
  highest_offer_wei: string | null;
}

interface GoogleMetricsData {
  avgMonthlySearches: number | null;
  avgCpc: number | null;
}

interface Checkpoint {
  lastId: number;
  processed: number;
  startedAt: string;
}

// --- Shared state for graceful shutdown ---

let currentLastId = 0;
let currentProcessed = 0;
let shuttingDown = false;

// --- Utility functions (matching elasticsearch-sync.ts) ---

function safeParsePrice(priceStr: string | null | undefined): number | null {
  if (!priceStr) return null;
  const parsed = parseFloat(priceStr);
  if (Number.isNaN(parsed)) return null;
  if (!Number.isFinite(parsed) || parsed > MAX_ES_PRICE_WEI) return MAX_ES_PRICE_WEI;
  if (parsed < 0) return null;
  return parsed;
}

function generateTags(name: string): string[] {
  const tags: string[] = [];
  const cleanName = name.replace('.eth', '');
  if (cleanName.length <= 3) tags.push('short');
  if (cleanName.length === 4) tags.push('4-letter');
  if (cleanName.length === 5) tags.push('5-letter');
  if (/^\d+$/.test(cleanName)) tags.push('numeric');
  if (/^[a-z]+$/i.test(cleanName)) tags.push('alphabetic');
  if (hasEmoji(cleanName)) tags.push('emoji');
  return tags;
}

function calculateExpirationState(expiryDate: string | null) {
  if (!expiryDate) {
    return { isExpired: false, isGracePeriod: false, isPremiumPeriod: false, daysUntilExpiry: 999999, premiumAmountEth: null };
  }

  const now = new Date();
  const expiry = new Date(expiryDate);
  const daysSinceExpiry = Math.floor((now.getTime() - expiry.getTime()) / (1000 * 60 * 60 * 24));
  const daysUntilExpiry = -daysSinceExpiry;

  if (daysSinceExpiry < 0) {
    return { isExpired: false, isGracePeriod: false, isPremiumPeriod: false, daysUntilExpiry, premiumAmountEth: null };
  }

  if (daysSinceExpiry <= 90) {
    return { isExpired: true, isGracePeriod: true, isPremiumPeriod: false, daysUntilExpiry, premiumAmountEth: null };
  }

  const daysIntoPremium = daysSinceExpiry - 90;
  if (daysIntoPremium <= 21) {
    const initialPremiumUSD = 100000000;
    const ethPriceUSD = 2000;
    const initialPremiumETH = initialPremiumUSD / ethPriceUSD;
    const k = Math.log(10000) / 21;
    const premiumAmountEth = initialPremiumETH * Math.exp(-k * daysIntoPremium);
    return { isExpired: true, isGracePeriod: false, isPremiumPeriod: true, daysUntilExpiry, premiumAmountEth };
  }

  return { isExpired: true, isGracePeriod: false, isPremiumPeriod: false, daysUntilExpiry, premiumAmountEth: null };
}

function calculateSaleHistoryState(lastSaleDate: string | null) {
  if (!lastSaleDate) {
    return { lastSaleDate: null, hasSales: false, daysSinceLastSale: null };
  }
  const now = new Date();
  const saleDate = new Date(lastSaleDate);
  const daysSinceLastSale = Math.floor((now.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24));
  return { lastSaleDate, hasSales: true, daysSinceLastSale };
}

function calculatePriceUsd(priceWei: string | null, currencyAddress: string | null, ethPriceUsd: number): number | null {
  if (!priceWei) return null;
  const normalizedCurrency = (currencyAddress || '').toLowerCase();
  const priceNum = safeParsePrice(priceWei);
  if (priceNum === null) return null;

  if (isEthOrWeth(normalizedCurrency) || normalizedCurrency === '' || normalizedCurrency === '0x0000000000000000000000000000000000000000') {
    return (priceNum / Math.pow(10, ETH_DECIMALS)) * ethPriceUsd;
  } else if (normalizedCurrency === USDC_ADDRESS) {
    return priceNum / Math.pow(10, USDC_DECIMALS);
  }
  return null;
}

// --- Pre-loading ---

async function loadActiveListings(): Promise<Map<number, ListingData>> {
  console.log('Loading active listings...');
  const result = await pool.query(`
    SELECT DISTINCT ON (ens_name_id)
      ens_name_id, price_wei, currency_address, status, created_at, expires_at
    FROM listings
    WHERE status = 'active'
    ORDER BY ens_name_id, created_at DESC
  `);

  const map = new Map<number, ListingData>();
  for (const row of result.rows) {
    map.set(row.ens_name_id, {
      price_wei: row.price_wei,
      currency_address: row.currency_address,
      status: row.status,
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
  }
  console.log(`  ${map.size.toLocaleString()} active listings loaded`);
  return map;
}

async function loadOfferAggregates(): Promise<Map<number, OfferData>> {
  console.log('Loading offer aggregates...');
  const result = await pool.query(`
    SELECT
      ens_name_id,
      COUNT(*)::int as offer_count,
      MAX(offer_amount_wei::numeric)::text as highest_offer_wei
    FROM offers
    WHERE status = 'pending'
    GROUP BY ens_name_id
  `);

  const map = new Map<number, OfferData>();
  for (const row of result.rows) {
    map.set(row.ens_name_id, {
      count: row.offer_count,
      highest_offer_wei: row.highest_offer_wei,
    });
  }
  console.log(`  Offer data for ${map.size.toLocaleString()} names loaded`);
  return map;
}

async function loadGoogleMetrics(): Promise<Map<string, GoogleMetricsData>> {
  console.log('Loading google metrics...');
  const result = await pool.query(`
    SELECT name,
      (metrics->>'avgMonthlySearches')::integer as avg_monthly_searches,
      (metrics->>'avgCpc')::float as avg_cpc
    FROM google_metrics
    WHERE status = 'success' AND expires_at > NOW()
  `);
  const map = new Map<string, GoogleMetricsData>();
  for (const row of result.rows) {
    map.set(row.name, {
      avgMonthlySearches: row.avg_monthly_searches,
      avgCpc: row.avg_cpc,
    });
  }
  console.log(`  ${map.size.toLocaleString()} google metrics loaded`);
  return map;
}

async function getEthPriceUsd(): Promise<number> {
  try {
    const result = await pool.query(`
      SELECT price FROM latest_prices
      WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
    `);
    if (result.rows.length > 0) return parseFloat(result.rows[0].price);
  } catch {
    console.warn('Failed to fetch ETH price, using fallback');
  }
  return 3000;
}

// --- Checkpoint ---

function saveCheckpoint(checkpoint: Checkpoint) {
  const dir = path.dirname(CHECKPOINT_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify(checkpoint, null, 2));
}

function loadCheckpoint(): Checkpoint | null {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
    }
  } catch {}
  return null;
}

function clearCheckpoint() {
  try { if (fs.existsSync(CHECKPOINT_FILE)) fs.unlinkSync(CHECKPOINT_FILE); } catch {}
}

// --- Enrichment ---

function enrichRow(
  row: any,
  listings: Map<number, ListingData>,
  offers: Map<number, OfferData>,
  googleMetrics: Map<string, GoogleMetricsData>,
  ethPriceUsd: number,
) {
  const name = row.name || '';
  const listing = listings.get(row.id);
  const offerData = offers.get(row.id);
  const labelName = (row.label_name || name.replace('.eth', '') || '');
  const gm = googleMetrics.get(labelName);

  const listingPrice = listing?.price_wei || null;
  const listingCurrency = listing?.currency_address || null;
  const listingStatus = listing ? listing.status : 'unlisted';
  const listingCreatedAt = listing?.created_at || null;
  const listingExpiresAt = listing?.expires_at || null;

  const expirationState = calculateExpirationState(row.expiry_date);
  const saleHistoryState = calculateSaleHistoryState(row.last_sale_date);
  const priceUsd = calculatePriceUsd(listingPrice, listingCurrency, ethPriceUsd);

  return {
    name,
    token_id: row.token_id,
    owner: row.owner_address,
    price: safeParsePrice(listingPrice),
    price_usd: priceUsd,
    currency_address: listingCurrency,
    expiry_date: row.expiry_date,
    registration_date: row.registration_date,
    creation_date: row.creation_date,
    character_count: name.replace('.eth', '').length,
    has_numbers: /\d/.test(name),
    has_emoji: hasEmoji(name),
    status: listingStatus,
    tags: generateTags(name),
    clubs: row.clubs || [],
    last_sale_price: safeParsePrice(row.last_sale_price),
    last_sale_currency: row.last_sale_currency,
    last_sale_price_usd: calculatePriceUsd(row.last_sale_price, row.last_sale_currency, ethPriceUsd),
    listing_created_at: listingCreatedAt,
    listing_expires_at: listingExpiresAt,
    active_offers_count: offerData?.count || 0,
    highest_offer: safeParsePrice(offerData?.highest_offer_wei),
    is_expired: expirationState.isExpired,
    is_grace_period: expirationState.isGracePeriod,
    is_premium_period: expirationState.isPremiumPeriod,
    days_until_expiry: expirationState.daysUntilExpiry,
    premium_amount_eth: expirationState.premiumAmountEth,
    last_sale_date: saleHistoryState.lastSaleDate,
    has_sales: saleHistoryState.hasSales,
    days_since_last_sale: saleHistoryState.daysSinceLastSale,
    google_monthly_searches: gm?.avgMonthlySearches || null,
    google_avg_cpc: gm?.avgCpc || null,
  };
}

// --- ES bulk with retry ---

async function indexBatch(bulkBody: any[]): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await esClient.bulk({
        body: bulkBody,
        timeout: '120s',
        refresh: false,
      });

      if (response.errors) {
        const errors = response.items?.filter((item: any) => item.index?.error);
        console.warn(`  Batch had ${errors?.length || 0} ES errors. First: ${JSON.stringify(errors?.[0]?.index?.error)}`);
      }
      return;
    } catch (error: any) {
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
        console.warn(`  ES bulk failed (attempt ${attempt}/${MAX_RETRIES}), retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  throw lastError;
}

// --- Main ---

async function main() {
  console.log('\n========================================');
  console.log('Elasticsearch Resync v2');
  console.log('========================================\n');

  const args = process.argv.slice(2);
  const shouldResume = args.includes('--resume');
  const fromIndex = args.indexOf('--from');
  let startFromId = 0;
  let resumedProcessed = 0;

  if (shouldResume) {
    const checkpoint = loadCheckpoint();
    if (checkpoint) {
      startFromId = checkpoint.lastId;
      resumedProcessed = checkpoint.processed;
      console.log(`Resuming from checkpoint: id > ${startFromId} (${resumedProcessed.toLocaleString()} already done)\n`);
    } else {
      console.log('No checkpoint found, starting from beginning\n');
    }
  } else if (fromIndex !== -1 && args[fromIndex + 1]) {
    startFromId = parseInt(args[fromIndex + 1]);
    console.log(`Starting from id > ${startFromId}\n`);
  }

  currentLastId = startFromId;
  currentProcessed = resumedProcessed;
  const startTime = Date.now();

  // Graceful shutdown handler
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log('\n\nShutting down gracefully...');
    saveCheckpoint({ lastId: currentLastId, processed: currentProcessed, startedAt: new Date(startTime).toISOString() });
    console.log(`Checkpoint saved (last_id: ${currentLastId}, processed: ${currentProcessed.toLocaleString()})`);
    console.log('Run with --resume to continue.\n');

    // Restore index settings before exit
    try {
      await esClient.indices.putSettings({
        index: config.elasticsearch.index,
        body: { index: { refresh_interval: '1s', number_of_replicas: 1 } },
      });
      await esClient.indices.refresh({ index: config.elasticsearch.index });
    } catch {}

    await closeAllConnections();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    // Test ES connection
    await esClient.ping();
    console.log('Connected to Elasticsearch');

    // Get counts
    const countResult = await pool.query('SELECT COUNT(*) as total FROM ens_names');
    const totalRows = parseInt(countResult.rows[0].total);
    const remainingResult = await pool.query('SELECT COUNT(*) as total FROM ens_names WHERE id > $1', [startFromId]);
    const remainingRows = parseInt(remainingResult.rows[0].total);

    console.log(`Total ENS names: ${totalRows.toLocaleString()}`);
    if (startFromId > 0) {
      console.log(`Remaining: ${remainingRows.toLocaleString()}`);
    }

    // Phase 1: Pre-load auxiliary data
    console.log('\n--- Pre-loading auxiliary data ---');
    const [listings, offers, googleMetrics, ethPriceUsd] = await Promise.all([
      loadActiveListings(),
      loadOfferAggregates(),
      loadGoogleMetrics(),
      getEthPriceUsd(),
    ]);
    console.log(`ETH price: $${ethPriceUsd.toFixed(2)}`);

    // Optimize ES for bulk import
    console.log('\nDisabling refresh for bulk import...');
    await esClient.indices.putSettings({
      index: config.elasticsearch.index,
      body: { index: { refresh_interval: '-1', number_of_replicas: 0 } },
    }).catch(() => console.log('  Could not adjust settings (index might not exist yet)'));

    // Phase 2: Stream and index
    console.log(`\n--- Indexing (batch size: ${BATCH_SIZE.toLocaleString()}) ---\n`);

    let batchCount = 0;
    const totalToProcess = remainingRows;

    while (!shuttingDown) {
      const result = await pool.query(
        'SELECT * FROM ens_names WHERE id > $1 ORDER BY id ASC LIMIT $2',
        [currentLastId, BATCH_SIZE],
      );

      if (result.rows.length === 0) break;

      // Build ES bulk body
      const bulkBody: any[] = [];
      for (const row of result.rows) {
        const doc = enrichRow(row, listings, offers, googleMetrics, ethPriceUsd);
        bulkBody.push({ index: { _index: config.elasticsearch.index, _id: row.id.toString() } });
        bulkBody.push(doc);
      }

      await indexBatch(bulkBody);

      // Update position
      currentLastId = result.rows[result.rows.length - 1].id;
      currentProcessed += result.rows.length;
      batchCount++;

      // Progress with ETA
      const elapsed = (Date.now() - startTime) / 1000;
      const processedThisRun = currentProcessed - resumedProcessed;
      const rate = processedThisRun / elapsed;
      const remaining = totalToProcess - processedThisRun;
      const etaSeconds = rate > 0 ? remaining / rate : 0;
      const etaMin = Math.floor(etaSeconds / 60);
      const etaSec = Math.floor(etaSeconds % 60);
      const pct = ((processedThisRun / totalToProcess) * 100).toFixed(1);

      console.log(
        `[${pct}%] ${currentProcessed.toLocaleString()} indexed | ` +
        `${Math.round(rate).toLocaleString()} docs/s | ` +
        `ETA ${etaMin}m${etaSec}s`
      );

      // Periodic checkpoint
      if (batchCount % CHECKPOINT_INTERVAL === 0) {
        saveCheckpoint({ lastId: currentLastId, processed: currentProcessed, startedAt: new Date(startTime).toISOString() });
      }
    }

    if (shuttingDown) return;

    // Restore ES settings
    console.log('\nRestoring index settings and refreshing...');
    await esClient.indices.putSettings({
      index: config.elasticsearch.index,
      body: { index: { refresh_interval: '1s', number_of_replicas: 1 } },
    });
    await esClient.indices.refresh({ index: config.elasticsearch.index });

    clearCheckpoint();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const processedThisRun = currentProcessed - resumedProcessed;
    const avgRate = Math.round(processedThisRun / parseFloat(duration));

    console.log('\n========================================');
    console.log('RESYNC COMPLETE');
    console.log('========================================');
    console.log(`Total indexed:  ${currentProcessed.toLocaleString()}`);
    console.log(`Time elapsed:   ${duration}s`);
    console.log(`Average rate:   ${avgRate.toLocaleString()} docs/sec`);
    console.log('========================================\n');

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    saveCheckpoint({ lastId: currentLastId, processed: currentProcessed, startedAt: new Date(startTime).toISOString() });
    console.error('\nResync failed:', error);
    console.error(`Checkpoint saved (last_id: ${currentLastId}, processed: ${currentProcessed.toLocaleString()})`);
    console.error('Run with --resume to continue from where it left off.\n');
    await closeAllConnections();
    process.exit(1);
  }
}

main();
