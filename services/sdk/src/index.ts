/**
 * Grails SDK - TypeScript SDK for the Grails ENS Marketplace API
 *
 * @packageDocumentation
 */

// Main client
export { GrailsClient } from './client.js';

// Configuration
export {
  type GrailsClientOptions,
  type TokenStorage,
  MemoryTokenStorage,
  CONTRACTS,
  DEFAULT_CONFIG,
} from './config.js';

// API modules
export {
  AuthAPI,
  ListingsAPI,
  OffersAPI,
  OrdersAPI,
  NamesAPI,
  SearchAPI,
  type CreateListingParams,
  type UpdateListingParams,
  type CancelListingResponse,
  type CreateOfferParams,
  type UpdateOfferParams,
  type CreateBulkOffersParams,
  type CreateCriteriaOfferParams,
  type BulkOfferResponse,
  type BulkOfferGroup,
  type CriteriaOfferResponse,
  type EditOfferParams,
  type BulkEditParams,
  type OfferLimits as SDKOfferLimits,
  type OrderType,
  type SaveOrderParams,
  type CreateOrderParams,
  type ValidateOrderResponse,
  type CancelOrderResponse,
  type BulkListing,
  type BulkListingResult,
  type BulkSaveResponse,
  type NameMetadata,
} from './api/index.js';

// Authentication
export {
  createSiweMessage,
  prepareSiweMessage,
  createSiweMessageString,
  SessionManager,
  createViemSigner,
  createWagmiSigner,
  createCustomSigner,
  type CreateSiweMessageParams,
  type MessageSigner,
} from './auth/index.js';

// Seaport
export {
  SeaportOrderBuilder,
  SeaportOrderFulfiller,
  OrderType as SeaportOrderType,
  ItemType,
  BasicOrderType,
  SEAPORT_ADDRESS,
  ENS_REGISTRAR_ADDRESS,
  WETH_ADDRESS,
  FULFILL_BASIC_ORDER_ABI,
  FULFILL_ADVANCED_ORDER_ABI,
  GET_COUNTER_ABI,
  prepareBulkSignature,
  extractBulkSignatures,
  buildCriteriaMerkleTree,
  applyOfferCriteria,
  getCriteriaProof,
  verifyCriteriaProof,
  type SeaportOfferItem,
  type SeaportConsiderationItem,
  type SeaportOrderParameters,
  type SeaportOrder,
  type OpenSeaProtocolData,
  type OrderData,
  type BasicOrderParameters,
  type BuildListingOrderParams,
  type BuildOfferOrderParams,
  type BuildBulkOfferOrdersParams,
  type BuildCriteriaOfferOrderParams,
  type BuildNOfManyOfferOrdersParams,
  type NOfManyOrderResult,
  type BulkSignatureResult,
  type IndividualBulkSignature,
  type CriteriaOrderResult,
  type CriteriaResolver,
  type AdvancedOrderParameters,
  type FulfillAdvancedOrderParams,
} from './seaport/index.js';

// Types
export {
  // API types
  type APIResponse,
  type Pagination,
  type PaginatedResponse,
  type PaginatedListingsResponse,
  type PaginatedOffersResponse,
  type PaginatedNamesResponse,
  type BulkSearchStats,
  type BulkSearchResponse,

  // Model types
  type ListingStatus,
  type OfferStatus,
  type TransactionType,
  type SaleSource,
  type ListingInfo,
  type ENSName,
  type SearchResult,
  type Listing,
  type Offer,
  type Sale,
  type Transaction,
  type User,
  type NonceResponse,
  type AuthVerifyResponse,

  // Filter types
  type CharacterFilterMode,
  type NameStatus,
  type MarketplaceFilter,
  type SortBy,
  type SortOrder,
  type ListingFilters,
  type OfferFilters,
  type SearchFilters,
  type BulkExactSearchOptions,
  type BulkFiltersSearchOptions,
  type NamesFilters,
} from './types/index.js';

// Errors
export {
  GrailsError,
  GrailsAPIError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  RateLimitError,
  NetworkError,
  TimeoutError,
  AuthError,
  NonceExpiredError,
  InvalidNonceError,
  InvalidSignatureError,
  TokenExpiredError,
  NotAuthenticatedError,
  type APIErrorDetails,
} from './errors/index.js';

// Utilities
export {
  isValidAddress,
  normalizeAddress,
  isValidENSName,
  normalizeENSName,
  isValidWeiAmount,
  isValidOrderHash,
  isValidTxHash,
  isValidTokenId,
} from './utils/index.js';
