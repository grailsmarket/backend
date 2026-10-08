/**
 * Types for validation workers
 */

import { config } from '../../../shared/src';

export interface ValidationResult {
  isValid: boolean;
  reason?: string;
  checkedAt: Date;
  details?: {
    currentOwner?: string;
    expectedOwner?: string;
    currentBalance?: string;
    requiredBalance?: string;
    currentAllowance?: string;
    requiredAllowance?: string;
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
  offer_amount_wei: string;
  currency_address: string;
  status: string;
  ens_name_id: number;
  name?: string;
  source?: string;
}

export type Currency = 'ETH' | 'WETH' | 'USDC' | 'UNKNOWN';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const WETH_ADDRESS = config.blockchain.wethAddress;
export const USDC_ADDRESS = config.blockchain.usdcAddress;
export const ENS_REGISTRAR_ADDRESS = config.blockchain.ensRegistrarAddress;
export const MULTICALL3_ADDRESS = config.blockchain.multicall3Address;
export const SEAPORT_ADDRESS = config.blockchain.seaportAddress;

// Conduit addresses for token approvals
export const OPENSEA_CONDUIT_ADDRESS = config.blockchain.openseaConduitAddress;
// Without a marketplace conduit on this chain, grails orders use a zero conduitKey
// and approvals go to Seaport directly
export const MARKETPLACE_CONDUIT_ADDRESS = config.blockchain.marketplaceConduitAddress ?? SEAPORT_ADDRESS;
