/**
 * Search and Filter Types
 */

/**
 * Character filter mode
 */
export type CharacterFilterMode = 'include' | 'exclude' | 'only';

/**
 * Name status
 */
export type NameStatus = 'registered' | 'grace' | 'premium' | 'available' | 'all';

/**
 * Marketplace source filter
 */
export type MarketplaceFilter = 'grails' | 'opensea' | 'all';

/**
 * Sort options
 */
export type SortBy =
  | 'price'
  | 'expiry_date'
  | 'registration_date'
  | 'last_sale_date'
  | 'last_sale_price'
  | 'character_count'
  | 'watchers_count'
  | 'view_count'
  | 'clubs_count'
  | 'alphabetical'
  | 'offer'
  | 'listing_date'
  | 'listing_expiry'
  | 'google_monthly_searches'
  | 'google_avg_cpc';

/**
 * Sort order
 */
export type SortOrder = 'asc' | 'desc';

/**
 * Listing filter options
 */
export interface ListingFilters {
  /** Filter by status */
  status?: 'active' | 'sold' | 'cancelled' | 'expired' | 'unfunded';
  /** Filter by seller address */
  seller?: string;
  /** Minimum price in wei */
  minPrice?: string;
  /** Maximum price in wei */
  maxPrice?: string;
  /** Sort field */
  sort?: 'price' | 'created' | 'expiry' | 'name';
  /** Sort order */
  order?: SortOrder;
}

/**
 * Offer filter options
 */
export interface OfferFilters {
  /** Filter by status */
  status?: 'pending' | 'accepted' | 'rejected' | 'expired' | 'unfunded';
  /** Page number */
  page?: number;
  /** Items per page */
  limit?: number;
}

/**
 * Search filter options
 */
export interface SearchFilters {
  // Text search
  /** Search query */
  q?: string;

  // Price filters
  /** Minimum listing price in wei */
  minPrice?: string;
  /** Maximum listing price in wei */
  maxPrice?: string;
  /** Minimum offer amount in wei */
  minOffer?: string;
  /** Maximum offer amount in wei */
  maxOffer?: string;

  // Length filters
  /** Minimum name length (excluding .eth) */
  minLength?: number;
  /** Maximum name length (excluding .eth) */
  maxLength?: number;

  // Count filters
  /** Minimum watchers count */
  minWatchersCount?: number;
  /** Maximum watchers count */
  maxWatchersCount?: number;
  /** Minimum view count */
  minViewCount?: number;
  /** Maximum view count */
  maxViewCount?: number;
  /** Minimum clubs count */
  minClubsCount?: number;
  /** Maximum clubs count */
  maxClubsCount?: number;

  // Legacy character filters
  /** Has numbers (legacy) */
  hasNumbers?: boolean;
  /** Has emoji (legacy) */
  hasEmoji?: boolean;

  // Tri-state character filters
  /** Digits filter mode */
  digits?: CharacterFilterMode;
  /** Letters filter mode */
  letters?: CharacterFilterMode;
  /** Emoji filter mode */
  emoji?: CharacterFilterMode;
  /** Repeating characters filter mode */
  repeatingChars?: CharacterFilterMode;

  // String pattern filters
  /** Name contains substring */
  contains?: string;
  /** Name starts with prefix */
  startsWith?: string;
  /** Name ends with suffix (before .eth) */
  endsWith?: string;
  /** Name does not contain substring */
  doesNotContain?: string;
  /** Name does not start with prefix */
  doesNotStartWith?: string;
  /** Name does not end with suffix */
  doesNotEndWith?: string;

  // Listing/market filters
  /** Only listed names (true) or only unlisted (false) */
  listed?: boolean;
  /** Has active offer */
  hasOffer?: boolean;
  /** Only names with active listings */
  showListings?: boolean;
  /** Only names without active listings */
  showUnlisted?: boolean;
  /** Filter by marketplace source */
  marketplace?: MarketplaceFilter;

  // Club filters
  /** Filter by clubs (OR logic for multiple) */
  clubs?: string[];
  /** Exclude names in these clubs */
  excludeClubs?: string[];
  /** In any club (true) or not in any club (false) */
  inAnyClub?: boolean;

  // Status filters
  /** Name status (single or multiple with OR logic) */
  status?: NameStatus | NameStatus[];

  // Legacy expiration filters
  /** Is expired */
  isExpired?: boolean;
  /** Is in 90-day grace period */
  isGracePeriod?: boolean;
  /** Is in premium auction period */
  isPremiumPeriod?: boolean;
  /** Expiring within X days */
  expiringWithinDays?: number;
  /** Include expired names */
  includeExpired?: boolean;

  // Sale history filters
  /** Has sale history */
  hasSales?: boolean;
  /** Last sold after date (ISO string) */
  lastSoldAfter?: string;
  /** Last sold before date (ISO string) */
  lastSoldBefore?: string;
  /** Minimum days since last sale */
  minDaysSinceLastSale?: number;
  /** Maximum days since last sale */
  maxDaysSinceLastSale?: number;

  // Creation date filters
  /** Minimum creation date (ISO string) */
  minCreationDate?: string;
  /** Maximum creation date (ISO string) */
  maxCreationDate?: string;

  // Owner filter
  /** Filter by owner (address or ENS name) */
  owner?: string;

  // Sorting
  /** Sort field */
  sortBy?: SortBy;
  /** Sort order */
  sortOrder?: SortOrder;

  // Pagination
  /** Page number (1-indexed) */
  page?: number;
  /** Items per page (max 100) */
  limit?: number;
}

/**
 * Bulk exact search options
 */
export interface BulkExactSearchOptions {
  /** List of terms to search for */
  terms: string[];
  /** Page number */
  page?: number;
  /** Items per page */
  limit?: number;
}

/**
 * Bulk search with filters options
 */
export interface BulkFiltersSearchOptions extends SearchFilters {
  /** List of terms to search for */
  terms: string[];
}

/**
 * Names list filter options
 */
export interface NamesFilters {
  /** Filter by owner address */
  owner?: string;
  /** Filter by status */
  status?: 'available' | 'listed' | 'expiring';
  /** Sort field */
  sort?: 'name' | 'price' | 'expiry' | 'created';
  /** Sort order */
  order?: SortOrder;
  /** Page number */
  page?: number;
  /** Items per page */
  limit?: number;
}
