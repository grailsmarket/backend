import { getPostgresPool } from '../db/client';

interface OfferLimits {
  max_bulk_offers_per_request: number;
  max_active_offers_per_user: number;
  min_offer_amount_wei: string;
  min_offer_floor_pct: number;
  max_bulk_offer_names: number;
  max_criteria_offer_names: number;
  bulk_offers_enabled: boolean;
  max_n_of_many_target_count: number;
  max_n_of_many_items: number;
}

const DEFAULT_LIMITS: OfferLimits = {
  max_bulk_offers_per_request: 500,
  max_active_offers_per_user: 5000,
  min_offer_amount_wei: '100000000000000',
  min_offer_floor_pct: 10,
  max_bulk_offer_names: 10000,
  max_criteria_offer_names: 1000,
  bulk_offers_enabled: true,
  max_n_of_many_target_count: 50,
  max_n_of_many_items: 1000,
};

let cachedLimits: OfferLimits | null = null;
let cacheExpiry = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch offer limits from database with 5-minute cache.
 */
export async function getOfferLimits(): Promise<OfferLimits> {
  if (cachedLimits && Date.now() < cacheExpiry) {
    return cachedLimits;
  }

  const pool = getPostgresPool();

  try {
    const result = await pool.query('SELECT key, value FROM offer_limits');

    const limits = { ...DEFAULT_LIMITS };
    for (const row of result.rows) {
      switch (row.key) {
        case 'max_bulk_offers_per_request':
          limits.max_bulk_offers_per_request = parseInt(row.value);
          break;
        case 'max_active_offers_per_user':
          limits.max_active_offers_per_user = parseInt(row.value);
          break;
        case 'min_offer_amount_wei':
          limits.min_offer_amount_wei = row.value;
          break;
        case 'min_offer_floor_pct':
          limits.min_offer_floor_pct = parseInt(row.value);
          break;
        case 'max_bulk_offer_names':
          limits.max_bulk_offer_names = parseInt(row.value);
          break;
        case 'max_criteria_offer_names':
          limits.max_criteria_offer_names = parseInt(row.value);
          break;
        case 'bulk_offers_enabled':
          limits.bulk_offers_enabled = row.value === 'true';
          break;
        case 'max_n_of_many_target_count':
          limits.max_n_of_many_target_count = parseInt(row.value);
          break;
        case 'max_n_of_many_items':
          limits.max_n_of_many_items = parseInt(row.value);
          break;
      }
    }

    cachedLimits = limits;
    cacheExpiry = Date.now() + CACHE_TTL_MS;

    return limits;
  } catch {
    // Table might not exist yet — return defaults
    return DEFAULT_LIMITS;
  }
}

/**
 * Invalidate the cached limits (e.g., after admin update).
 */
export function invalidateOfferLimitsCache(): void {
  cachedLimits = null;
  cacheExpiry = 0;
}

/**
 * Validate a bulk offer request against limits.
 *
 * @returns null if valid, or an error message string
 */
export async function validateBulkOfferLimits(params: {
  offerCount: number;
  buyerAddress: string;
  offerAmounts: string[];
}): Promise<string | null> {
  const limits = await getOfferLimits();

  if (!limits.bulk_offers_enabled) {
    return 'Bulk offers are currently disabled';
  }

  if (params.offerCount > limits.max_bulk_offers_per_request) {
    return `Maximum ${limits.max_bulk_offers_per_request} offers per request`;
  }

  // Check minimum amounts
  const minAmount = BigInt(limits.min_offer_amount_wei);
  for (let i = 0; i < params.offerAmounts.length; i++) {
    if (BigInt(params.offerAmounts[i]) < minAmount) {
      return `Offer ${i} amount below minimum (${limits.min_offer_amount_wei} wei)`;
    }
  }

  // Check active offers cap
  const pool = getPostgresPool();
  const activeResult = await pool.query(
    `SELECT COUNT(*) FROM offers
     WHERE LOWER(buyer_address) = LOWER($1) AND status = 'pending'`,
    [params.buyerAddress]
  );
  const activeCount = parseInt(activeResult.rows[0].count);

  if (activeCount + params.offerCount > limits.max_active_offers_per_user) {
    return `Would exceed maximum active offers (${limits.max_active_offers_per_user}). Currently have ${activeCount} active offers.`;
  }

  return null;
}

/**
 * Validate an n-of-many offer request against limits.
 *
 * @returns null if valid, or an error message string
 */
export async function validateNOfManyOfferLimits(params: {
  targetCount: number;
  totalItems: number;
  buyerAddress: string;
  offerAmountWei: string;
}): Promise<string | null> {
  const limits = await getOfferLimits();

  if (!limits.bulk_offers_enabled) {
    return 'Bulk offers are currently disabled';
  }

  if (params.targetCount > limits.max_n_of_many_target_count) {
    return `Maximum target count is ${limits.max_n_of_many_target_count}`;
  }

  if (params.totalItems > limits.max_n_of_many_items) {
    return `Maximum candidate items is ${limits.max_n_of_many_items}`;
  }

  if (params.targetCount > params.totalItems) {
    return 'Target count cannot exceed total items';
  }

  // Check minimum amount
  const minAmount = BigInt(limits.min_offer_amount_wei);
  if (BigInt(params.offerAmountWei) < minAmount) {
    return `Offer amount below minimum (${limits.min_offer_amount_wei} wei)`;
  }

  // Check active offers cap
  const pool = getPostgresPool();
  const activeResult = await pool.query(
    `SELECT COUNT(*) FROM offers
     WHERE LOWER(buyer_address) = LOWER($1) AND status = 'pending'`,
    [params.buyerAddress]
  );
  const activeCount = parseInt(activeResult.rows[0].count);

  if (activeCount + params.targetCount > limits.max_active_offers_per_user) {
    return `Would exceed maximum active offers (${limits.max_active_offers_per_user}). Currently have ${activeCount} active offers.`;
  }

  return null;
}

export type { OfferLimits };
