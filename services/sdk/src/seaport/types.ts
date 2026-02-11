/**
 * Seaport Protocol Types
 */

/**
 * Seaport order type
 */
export enum OrderType {
  FULL_OPEN = 0,
  PARTIAL_OPEN = 1,
  FULL_RESTRICTED = 2,
  PARTIAL_RESTRICTED = 3,
  CONTRACT = 4,
}

/**
 * Seaport item type
 */
export enum ItemType {
  NATIVE = 0,
  ERC20 = 1,
  ERC721 = 2,
  ERC1155 = 3,
  ERC721_WITH_CRITERIA = 4,
  ERC1155_WITH_CRITERIA = 5,
}

/**
 * Seaport offer item
 */
export interface SeaportOfferItem {
  itemType: ItemType;
  token: string;
  identifierOrCriteria: string;
  startAmount: string;
  endAmount: string;
}

/**
 * Seaport consideration item
 */
export interface SeaportConsiderationItem extends SeaportOfferItem {
  recipient: string;
}

/**
 * Seaport order parameters
 */
export interface SeaportOrderParameters {
  offerer: string;
  zone: string;
  offer: SeaportOfferItem[];
  consideration: SeaportConsiderationItem[];
  orderType: OrderType;
  startTime: number;
  endTime: number;
  zoneHash: string;
  salt: string;
  conduitKey: string;
  totalOriginalConsiderationItems: number;
}

/**
 * Seaport order (parameters + signature)
 */
export interface SeaportOrder extends SeaportOrderParameters {
  signature?: string;
}

/**
 * OpenSea protocol data wrapper
 */
export interface OpenSeaProtocolData {
  parameters: SeaportOrderParameters;
  signature: string;
}

/**
 * Order data as stored in database (can be either format)
 */
export interface OrderData {
  protocol_data?: OpenSeaProtocolData;
  parameters?: SeaportOrderParameters;
  signature?: string;
}

/**
 * Basic order parameters for efficient fulfillment
 * Used with fulfillBasicOrder_efficient_6GL6yc function
 */
export interface BasicOrderParameters {
  considerationToken: string;
  considerationIdentifier: bigint;
  considerationAmount: bigint;
  offerer: string;
  zone: string;
  offerToken: string;
  offerIdentifier: bigint;
  offerAmount: bigint;
  basicOrderType: number;
  startTime: bigint;
  endTime: bigint;
  zoneHash: string;
  salt: bigint;
  offererConduitKey: string;
  fulfillerConduitKey: string;
  totalOriginalAdditionalRecipients: bigint;
  additionalRecipients: Array<{
    amount: bigint;
    recipient: string;
  }>;
  signature: string;
}

/**
 * Basic order type enum
 * https://docs.opensea.io/reference/seaport-overview#basic-order-types
 */
export enum BasicOrderType {
  ETH_TO_ERC721 = 0,
  ETH_TO_ERC1155 = 1,
  ETH_TO_ERC721_FULL_OPEN = 2,
  ETH_TO_ERC1155_FULL_OPEN = 3,
  ERC20_TO_ERC721 = 8,
  ERC20_TO_ERC1155 = 9,
  ERC20_TO_ERC721_FULL_OPEN = 10,
  ERC20_TO_ERC1155_FULL_OPEN = 11,
  ERC721_TO_ERC20 = 16,
  ERC1155_TO_ERC20 = 17,
  ERC721_TO_ERC20_FULL_OPEN = 18,
  ERC1155_TO_ERC20_FULL_OPEN = 19,
}

/**
 * Parameters for building a listing order
 */
export interface BuildListingOrderParams {
  /** ENS token ID */
  tokenId: string;
  /** Price in wei */
  priceWei: string;
  /** Seller address (offerer) */
  offerer: string;
  /** Duration in days (default: 7) */
  durationDays?: number;
  /** Currency address (default: ETH/native) */
  currencyAddress?: string;
  /** Platform fee recipient address */
  platformFeeRecipient?: string;
  /** Platform fee in basis points (e.g., 250 = 2.5%) */
  platformFeeBps?: number;
  /** Broker fee recipient address */
  brokerFeeRecipient?: string;
  /** Broker fee in basis points */
  brokerFeeBps?: number;
}

/**
 * Parameters for building an offer order
 */
export interface BuildOfferOrderParams {
  /** ENS token ID */
  tokenId: string;
  /** Offer amount in wei (WETH) */
  offerAmountWei: string;
  /** Buyer address (offerer) */
  offerer: string;
  /** Duration in days (default: 7) */
  durationDays?: number;
  /** Platform fee recipient address */
  platformFeeRecipient?: string;
  /** Platform fee in basis points */
  platformFeeBps?: number;
}
