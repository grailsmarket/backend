// API Response types
export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
  meta: {
    timestamp: string;
    version?: string;
  };
}

export interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// ENS Name types
export interface ENSName {
  id: number;
  token_id: string;
  name: string;
  owner_address: string;
  expiry_date: string | null;
  registration_date: string | null;
  last_transfer_date: string | null;
  metadata?: any;
  created_at: string;
  updated_at: string;
  // Additional fields from listings join
  listing_price?: string;
  listing_status?: string;
  listing_expires_at?: string;
  listing_seller?: string;
  active_offers_count?: number;
  recent_transactions?: Transaction[];
}

// Listing types
export interface Listing {
  id: number;
  ens_name_id: number;
  seller_address: string;
  price_wei: string;
  currency_address: string;
  order_hash?: string;
  order_data: any; // Seaport order data
  status: 'active' | 'sold' | 'cancelled' | 'expired';
  source?: 'grails' | 'opensea';
  created_at: string;
  updated_at: string;
  expires_at?: string;
  // Additional fields from ENS join
  ens_name?: string;
  token_id?: string;
  current_owner?: string;
  name_expiry_date?: string;
  registration_date?: string;
}

// Offer types
export interface Offer {
  id: number;
  ens_name_id: number;
  buyer_address: string;
  offer_amount_wei: string;
  currency_address: string;
  order_hash?: string;
  order_data: any;
  status: 'pending' | 'accepted' | 'rejected' | 'expired';
  created_at: string;
  expires_at?: string;
}

// Transaction types
export interface Transaction {
  id: number;
  ens_name_id: number;
  transaction_hash: string;
  block_number: number;
  from_address: string;
  to_address: string;
  price_wei?: string;
  transaction_type: 'sale' | 'transfer' | 'registration' | 'renewal';
  timestamp: string;
  created_at: string;
}

// Seaport types
export interface SeaportOrderParameters {
  offerer: string;
  zone: string;
  offer: OfferItem[];
  consideration: ConsiderationItem[];
  orderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  totalOriginalConsiderationItems: number;
}

export interface OfferItem {
  itemType: number;
  token: string;
  identifierOrCriteria: bigint;
  startAmount: bigint;
  endAmount: bigint;
}

export interface ConsiderationItem extends OfferItem {
  recipient: string;
}

export interface SeaportOrder {
  parameters: SeaportOrderParameters;
  signature: string;
}