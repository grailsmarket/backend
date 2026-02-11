/**
 * Domain Model Types
 */

/**
 * Listing status
 */
export type ListingStatus = 'active' | 'sold' | 'cancelled' | 'expired' | 'unfunded';

/**
 * Offer status
 */
export type OfferStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'unfunded';

/**
 * Transaction type
 */
export type TransactionType = 'sale' | 'transfer' | 'registration' | 'renewal';

/**
 * Sale source
 */
export type SaleSource = 'opensea' | 'grails' | 'blur' | 'looksrare' | 'x2y2' | 'other';

/**
 * Active listing information
 */
export interface ListingInfo {
  id: number;
  price_wei: string;
  currency_address: string;
  status: ListingStatus;
  source: string;
  expires_at: string | null;
  created_at: string;
}

/**
 * ENS Name entity
 */
export interface ENSName {
  id: number;
  name: string;
  label_name?: string;
  token_id: string;
  owner: string | null;
  expiry_date: string | null;
  registration_date: string | null;
  last_sale_date: string | null;
  last_sale_price: string | null;
  last_sale_currency: string | null;
  last_sale_price_usd: number | null;
  metadata: Record<string, unknown>;
  metadata_updated_at: string | null;
  clubs: string[];
  has_numbers: boolean;
  has_emoji: boolean;
  view_count: number;
}

/**
 * Search result - enriched ENS name with listings and user-specific data
 */
export interface SearchResult extends ENSName {
  listings: ListingInfo[];
  upvotes: number;
  downvotes: number;
  net_score: number;
  watchers_count: number;
  is_user_watching: boolean;
  watchlist_record_id: number | null;
  highest_offer_wei: string | null;
  highest_offer_currency: string | null;
  highest_offer_id: number | null;
}

/**
 * Listing entity
 */
export interface Listing {
  id: number;
  ens_name_id: number;
  seller_address: string;
  price_wei: string;
  currency_address: string;
  order_hash: string | null;
  order_data: Record<string, unknown>;
  status: ListingStatus;
  source: string;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields
  ens_name?: string;
  token_id?: string;
  current_owner?: string;
  name_expiry_date?: string;
  registration_date?: string;
  last_sale_date?: string;
}

/**
 * Offer entity
 */
export interface Offer {
  id: number;
  ens_name_id: number;
  buyer_address: string;
  offer_amount_wei: string;
  currency_address: string;
  order_hash: string | null;
  order_data: Record<string, unknown>;
  status: OfferStatus;
  expires_at: string | null;
  created_at: string;
  // Joined fields
  name?: string;
  token_id?: string;
}

/**
 * Sale entity
 */
export interface Sale {
  id: number;
  ens_name_id: number;
  seller_address: string;
  buyer_address: string;
  sale_price_wei: string;
  currency_address: string;
  listing_id: number | null;
  offer_id: number | null;
  transaction_hash: string;
  block_number: number;
  order_hash: string | null;
  order_data: Record<string, unknown> | null;
  source: SaleSource;
  platform_fee_wei: string | null;
  creator_fee_wei: string | null;
  metadata: Record<string, unknown> | null;
  sale_date: string;
  created_at: string;
}

/**
 * Transaction/history entity
 */
export interface Transaction {
  id: number;
  ens_name_id: number;
  transaction_hash: string;
  block_number: number;
  from_address: string;
  to_address: string;
  price_wei: string | null;
  transaction_type: TransactionType;
  timestamp: string;
  created_at: string;
}

/**
 * User entity (from auth/me)
 */
export interface User {
  id: number;
  address: string;
  email: string | null;
  emailVerified: boolean;
  telegram: string | null;
  discord: string | null;
  createdAt: string;
  updatedAt?: string;
  lastSignIn: string;
}

/**
 * Nonce response
 */
export interface NonceResponse {
  nonce: string;
  expiresAt: string;
}

/**
 * Auth verification response
 */
export interface AuthVerifyResponse {
  token: string;
  user: User;
}
