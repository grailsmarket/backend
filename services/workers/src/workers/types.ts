/**
 * Types for validation workers
 */

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  checkedAt: Date;
  details?: {
    currentOwner?: string;
    expectedOwner?: string;
    currentBalance?: string;
    requiredBalance?: string;
    currency?: Currency;
  };
}

export interface ValidationJob {
  type: 'listing_ownership' | 'offer_balance' | 'batch_offers' | 'revalidate_unfunded';
  entityId?: number;
  entityIds?: number[];
  priority: 'high' | 'normal' | 'low';
  source: 'event' | 'periodic' | 'revalidation' | 'manual';
}

export interface ListingWithOwner {
  id: number;
  seller_address: string;
  ens_name_id: number;
  name: string;
  token_id: string;
  current_owner: string;
  status: string;
}

export interface OfferWithBalance {
  id: number;
  buyer_address: string;
  price_wei: string;
  currency_address: string;
  status: string;
  ens_name_id: number;
  name?: string;
}

export type Currency = 'ETH' | 'WETH' | 'USDC' | 'UNKNOWN';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const WETH_ADDRESS = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
export const USDC_ADDRESS = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
export const ENS_REGISTRAR_ADDRESS = '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85';
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';
