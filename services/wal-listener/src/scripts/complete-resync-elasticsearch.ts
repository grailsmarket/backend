/**
 * COMPLETE Elasticsearch Resync Script
 *
 * Full reindex with all data properly calculated:
 * - Listing price and status from listings table
 * - Active offers count from offers table
 * - Highest offer from offers table
 * - All expiration calculations (is_expired, is_grace_period, is_premium_period, etc.)
 * - Sale history calculations (has_sales, days_since_last_sale)
 *
 * Optimizations while maintaining correctness:
 * - Parallel batch processing
 * - Refresh disabled during indexing
 * - Efficient SQL with proper JOINs
 *
 * Usage:
 *   npm run build && node dist/wal-listener/src/scripts/complete-resync-elasticsearch.js
 */

import { getElasticsearchClient, getPostgresPool, config, closeAllConnections, isEthOrWeth, hasEmoji } from '../../../shared/src';

const esClient = getElasticsearchClient();
const pool = getPostgresPool();

const BATCH_SIZE = 500;
const CONCURRENT_BATCHES = 5;

// Currency constants for price conversion
const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const ETH_DECIMALS = 18;
const USDC_DECIMALS = 6;

// ETH price cache
let cachedEthPrice: number | null = null;
let ethPriceCacheTime: number = 0;
const ETH_PRICE_CACHE_TTL = 300000; // 5 minute cache

interface ENSNameRow {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
  expiry_date: string | null;
  registration_date: string | null;
  clubs: string[] | null;
  last_sale_date: string | null;
  last_sale_price: string | null;
  last_sale_currency: string | null;
  last_sale_price_usd: number | null;
  listing_price: string | null;
  listing_currency_address: string | null;
  listing_status: string | null;
  listing_created_at: string | null;
  active_offers_count: number;
  highest_offer_wei: string | null;
}

function generateTags(name: string): string[] {
  const tags: string[] = [];
  const cleanName = name.replace('.eth', '');

  if (cleanName.length <= 3) tags.push('short');
  if (cleanName.length === 4) tags.push('4-letter');
  if (cleanName.length === 5) tags.push('5-letter');
  if (/^\d+$/.test(cleanName)) tags.push('numeric');
  if (/^[a-z]+$/i.test(cleanName)) tags.push('alphabetic');
  if (hasEmoji(cleanName)) {
    tags.push('emoji');
  }

  return tags;
}

function calculateExpirationState(expiryDate: string | null) {
  if (!expiryDate) {
    return {
      isExpired: false,
      isGracePeriod: false,
      isPremiumPeriod: false,
      daysUntilExpiry: 999999,
      premiumAmountEth: null,
    };
  }

  const now = new Date();
  const expiry = new Date(expiryDate);
  const daysSinceExpiry = Math.floor((now.getTime() - expiry.getTime()) / (1000 * 60 * 60 * 24));
  const daysUntilExpiry = -daysSinceExpiry;

  if (daysSinceExpiry < 0) {
    return {
      isExpired: false,
      isGracePeriod: false,
      isPremiumPeriod: false,
      daysUntilExpiry,
      premiumAmountEth: null,
    };
  }

  if (daysSinceExpiry <= 90) {
    return {
      isExpired: true,
      isGracePeriod: true,
      isPremiumPeriod: false,
      daysUntilExpiry,
      premiumAmountEth: null,
    };
  }

  const daysIntoPremium = daysSinceExpiry - 90;
  if (daysIntoPremium <= 21) {
    const initialPremiumUSD = 100000000;
    const ethPriceUSD = 2000;
    const initialPremiumETH = initialPremiumUSD / ethPriceUSD;
    const k = Math.log(10000) / 21;
    const premiumAmountEth = initialPremiumETH * Math.exp(-k * daysIntoPremium);

    return {
      isExpired: true,
      isGracePeriod: false,
      isPremiumPeriod: true,
      daysUntilExpiry,
      premiumAmountEth,
    };
  }

  return {
    isExpired: true,
    isGracePeriod: false,
    isPremiumPeriod: false,
    daysUntilExpiry,
    premiumAmountEth: null,
  };
}

function calculateSaleHistoryState(lastSaleDate: string | null) {
  if (!lastSaleDate) {
    return {
      lastSaleDate: null,
      hasSales: false,
      daysSinceLastSale: null,
    };
  }

  const now = new Date();
  const saleDate = new Date(lastSaleDate);
  const daysSinceLastSale = Math.floor((now.getTime() - saleDate.getTime()) / (1000 * 60 * 60 * 24));

  return {
    lastSaleDate,
    hasSales: true,
    daysSinceLastSale,
  };
}

/**
 * Get current ETH price in USD with caching
 */
async function getEthPriceUsd(): Promise<number> {
  const now = Date.now();

  // Return cached price if still valid
  if (cachedEthPrice !== null && (now - ethPriceCacheTime) < ETH_PRICE_CACHE_TTL) {
    return cachedEthPrice;
  }

  try {
    const result = await pool.query(`
      SELECT price FROM latest_prices
      WHERE token_symbol = 'ETH' AND quote_currency = 'USD'
    `);

    if (result.rows.length > 0) {
      cachedEthPrice = parseFloat(result.rows[0].price);
      ethPriceCacheTime = now;
      return cachedEthPrice;
    }
  } catch (error) {
    console.warn('Failed to fetch ETH price from database, using fallback');
  }

  // Fallback price if database query fails
  const fallbackPrice = 3000;
  cachedEthPrice = fallbackPrice;
  ethPriceCacheTime = now;
  return fallbackPrice;
}

/**
 * Calculate USD price from wei amount and currency address
 */
function calculatePriceUsd(priceWei: string | null, currencyAddress: string | null, ethPriceUsd: number): number | null {
  if (!priceWei) return null;

  const normalizedCurrency = (currencyAddress || '').toLowerCase();
  const priceNum = parseFloat(priceWei);

  if (isEthOrWeth(normalizedCurrency) || normalizedCurrency === '' || normalizedCurrency === '0x0000000000000000000000000000000000000000') {
    // ETH or WETH: convert from wei (18 decimals) to ETH, then to USD
    const priceInEth = priceNum / Math.pow(10, ETH_DECIMALS);
    return priceInEth * ethPriceUsd;
  } else if (normalizedCurrency === USDC_ADDRESS) {
    // USDC: convert from smallest unit (6 decimals) to USD (1:1)
    return priceNum / Math.pow(10, USDC_DECIMALS);
  }

  // Unknown currency - can't convert
  return null;
}

function enrichENSNameData(data: ENSNameRow, ethPriceUsd: number) {
  const name = data.name || '';
  const expirationState = calculateExpirationState(data.expiry_date);
  const saleHistoryState = calculateSaleHistoryState(data.last_sale_date);
  const priceUsd = calculatePriceUsd(data.listing_price, data.listing_currency_address, ethPriceUsd);

  return {
    name,
    token_id: data.token_id,
    owner: data.owner_address,
    price: data.listing_price ? parseFloat(data.listing_price) : null,
    price_usd: priceUsd,
    currency_address: data.listing_currency_address || null,
    expiry_date: data.expiry_date,
    registration_date: data.registration_date,
    character_count: name.replace('.eth', '').length,
    has_numbers: /\d/.test(name),
    has_emoji: hasEmoji(name),
    status: data.listing_status || 'unlisted',
    tags: generateTags(name),
    clubs: data.clubs || [],
    last_sale_price: data.last_sale_price ? parseFloat(data.last_sale_price) : null,
    last_sale_currency: data.last_sale_currency,
    last_sale_price_usd: data.last_sale_price_usd,
    listing_created_at: data.listing_created_at,
    active_offers_count: data.active_offers_count || 0,
    highest_offer: data.highest_offer_wei ? parseFloat(data.highest_offer_wei) : null,
    is_expired: expirationState.isExpired,
    is_grace_period: expirationState.isGracePeriod,
    is_premium_period: expirationState.isPremiumPeriod,
    days_until_expiry: expirationState.daysUntilExpiry,
    premium_amount_eth: expirationState.premiumAmountEth,
    last_sale_date: saleHistoryState.lastSaleDate,
    has_sales: saleHistoryState.hasSales,
    days_since_last_sale: saleHistoryState.daysSinceLastSale,
  };
}

async function processBatch(offset: number, batchSize: number, totalRows: number, ethPriceUsd: number): Promise<number> {
  // Complete query with all JOINs for listings and offers
  const query = `
    SELECT
      en.id,
      en.name,
      en.token_id,
      en.owner_address,
      en.expiry_date,
      en.registration_date,
      en.clubs,
      en.last_sale_date,
      en.last_sale_price,
      en.last_sale_currency,
      en.last_sale_price_usd,
      l.price_wei as listing_price,
      l.currency_address as listing_currency_address,
      l.status as listing_status,
      l.created_at as listing_created_at,
      COUNT(DISTINCT o.id) FILTER (WHERE o.status = 'pending') as active_offers_count,
      MAX(o.offer_amount_wei::numeric) FILTER (WHERE o.status = 'pending') as highest_offer_wei
    FROM ens_names en
    LEFT JOIN LATERAL (
      SELECT price_wei, currency_address, status, created_at
      FROM listings
      WHERE listings.ens_name_id = en.id
        AND listings.status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    ) l ON true
    LEFT JOIN offers o ON o.ens_name_id = en.id
    GROUP BY en.id, en.name, en.token_id, en.owner_address, en.expiry_date,
             en.registration_date, en.clubs, en.last_sale_date, en.last_sale_price,
             en.last_sale_currency, en.last_sale_price_usd, en.updated_at,
             l.price_wei, l.currency_address, l.status, l.created_at
    ORDER BY en.id ASC
    LIMIT $1 OFFSET $2
  `;

  const result = await pool.query(query, [batchSize, offset]);

  if (result.rows.length === 0) {
    return 0;
  }

  // Build bulk body with full enrichment
  const bulkBody = [];
  for (const row of result.rows) {
    const enrichedData = enrichENSNameData(row, ethPriceUsd);
    bulkBody.push({ index: { _index: config.elasticsearch.index, _id: row.id.toString() } });
    bulkBody.push(enrichedData);
  }

  // Send to Elasticsearch
  const response = await esClient.bulk({
    body: bulkBody,
    timeout: '300s',
    refresh: false,
  });

  if (response.errors) {
    const errors = response.items?.filter((item: any) => item.index?.error);
    console.error(`Batch had ${errors?.length || 0} errors. First error:`, errors?.[0]?.index?.error);
  }

  const endRange = Math.min(offset + result.rows.length, totalRows);
  const percentage = ((endRange / totalRows) * 100).toFixed(1);
  console.log(`[${percentage}%] Indexed ${offset + 1}-${endRange} of ${totalRows.toLocaleString()}`);

  return result.rows.length;
}

async function completeResync() {
  console.log('\n========================================');
  console.log('COMPLETE Elasticsearch Resync');
  console.log('(with listings, offers, and all calculations)');
  console.log('========================================\n');

  const startTime = Date.now();

  try {
    // Test connection
    await esClient.ping();
    console.log('✓ Connected to Elasticsearch\n');

    // Get total count
    const countResult = await pool.query('SELECT COUNT(*) as total FROM ens_names');
    const totalRows = parseInt(countResult.rows[0].total);
    console.log(`Total ENS names to sync: ${totalRows.toLocaleString()}\n`);

    // Get listing and offer stats
    const statsResult = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM listings WHERE status = 'active') as active_listings,
        (SELECT COUNT(*) FROM offers WHERE status = 'pending') as pending_offers
    `);
    console.log(`Active listings: ${statsResult.rows[0].active_listings.toLocaleString()}`);
    console.log(`Pending offers: ${statsResult.rows[0].pending_offers.toLocaleString()}\n`);

    // Disable refresh for speed
    console.log('Optimizing index settings for bulk import...');
    await esClient.indices.putSettings({
      index: config.elasticsearch.index,
      body: {
        index: {
          refresh_interval: '-1',
          number_of_replicas: 0,
        },
      },
    }).catch(() => {
      console.log('Note: Could not adjust settings (index might not exist yet)');
    });

    console.log(`Batch size: ${BATCH_SIZE.toLocaleString()}`);
    console.log(`Concurrent batches: ${CONCURRENT_BATCHES}\n`);

    // Get ETH price for USD conversion
    const ethPriceUsd = await getEthPriceUsd();
    console.log(`ETH price for USD conversion: $${ethPriceUsd.toFixed(2)}\n`);

    console.log('Starting bulk indexing...\n');

    let processed = 0;
    let offset = 3128000;

    // Process batches with limited concurrency
    while (offset < totalRows) {
      const batchPromises: Promise<number>[] = [];

      // Launch concurrent batches
      for (let i = 0; i < CONCURRENT_BATCHES && offset < totalRows; i++) {
        batchPromises.push(processBatch(offset, BATCH_SIZE, totalRows, ethPriceUsd));
        offset += BATCH_SIZE;
      }

      // Wait for all concurrent batches to complete
      const results = await Promise.all(batchPromises);
      processed += results.reduce((sum, count) => sum + count, 0);

      // Small delay between batch groups to let DB breathe
      if (offset < totalRows) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    // Re-enable refresh and force refresh
    console.log('\n\nRestoring index settings and refreshing...');
    await esClient.indices.putSettings({
      index: config.elasticsearch.index,
      body: {
        index: {
          refresh_interval: '1s',
          number_of_replicas: 1,
        },
      },
    });

    await esClient.indices.refresh({ index: config.elasticsearch.index });

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = Math.round(processed / parseFloat(duration));

    console.log('\n========================================');
    console.log('COMPLETE RESYNC FINISHED!');
    console.log('========================================');
    console.log(`Total indexed:     ${processed.toLocaleString()}`);
    console.log(`Time elapsed:      ${duration}s`);
    console.log(`Average rate:      ${rate.toLocaleString()} docs/sec`);
    console.log('========================================\n');

    await closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error('\n✗ Resync failed:', error);
    await closeAllConnections();
    process.exit(1);
  }
}

completeResync();
