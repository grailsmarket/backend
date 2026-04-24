/**
 * Seaport Order Fulfiller
 */

import {
  type BasicOrderParameters,
  type OrderData,
  type SeaportOrderParameters,
  type FulfillAdvancedOrderParams,
  type AdvancedOrderParameters,
  type CriteriaResolver,
  BasicOrderType,
  ItemType,
} from './types.js';
import {
  SEAPORT_ADDRESS,
  DEFAULT_CONDUIT_KEY,
  FULFILL_BASIC_ORDER_ABI,
  FULFILL_ADVANCED_ORDER_ABI,
  GET_COUNTER_ABI,
} from './constants.js';

/**
 * Extract Seaport parameters from various order data formats
 */
function extractParameters(orderData: OrderData | string): SeaportOrderParameters {
  const data = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;

  // Check for OpenSea protocol_data format
  if (data.protocol_data?.parameters) {
    return data.protocol_data.parameters;
  }

  // Check for direct parameters
  if (data.parameters) {
    return data.parameters;
  }

  // Assume the data itself is the parameters
  return data as SeaportOrderParameters;
}

/**
 * Extract signature from order data
 */
function extractSignature(orderData: OrderData | string): string {
  const data = typeof orderData === 'string' ? JSON.parse(orderData) : orderData;

  // Check for OpenSea protocol_data format
  if (data.protocol_data?.signature) {
    return data.protocol_data.signature;
  }

  // Check for direct signature
  if (data.signature) {
    return data.signature;
  }

  throw new Error('No signature found in order data');
}

/**
 * Determine basic order type from order parameters
 */
function determineBasicOrderType(params: SeaportOrderParameters): BasicOrderType {
  const offerItem = params.offer[0];
  const considerationItem = params.consideration[0];

  if (!offerItem || !considerationItem) {
    throw new Error('Invalid order: missing offer or consideration items');
  }

  // ERC721 listing (NFT for ETH/ERC20)
  if (offerItem.itemType === ItemType.ERC721) {
    if (considerationItem.itemType === ItemType.NATIVE) {
      return BasicOrderType.ETH_TO_ERC721_FULL_OPEN;
    }
    if (considerationItem.itemType === ItemType.ERC20) {
      return BasicOrderType.ERC20_TO_ERC721_FULL_OPEN;
    }
  }

  // ERC721 offer (ERC20 for NFT)
  if (offerItem.itemType === ItemType.ERC20) {
    if (considerationItem.itemType === ItemType.ERC721) {
      return BasicOrderType.ERC721_TO_ERC20_FULL_OPEN;
    }
  }

  throw new Error('Unsupported order type');
}

/**
 * Seaport Order Fulfiller
 *
 * Builds parameters for fulfilling Seaport orders on-chain
 */
export class SeaportOrderFulfiller {
  /**
   * Build BasicOrderParameters for efficient fulfillment
   *
   * Use this with the fulfillBasicOrder_efficient_6GL6yc function
   *
   * @param orderData - The order data (from listing or offer)
   * @param signature - Optional signature override (otherwise extracted from orderData)
   * @returns Parameters for fulfillBasicOrder_efficient_6GL6yc
   *
   * @example
   * ```ts
   * import { SeaportOrderFulfiller } from '@grails/sdk';
   *
   * const fulfiller = new SeaportOrderFulfiller();
   * const params = fulfiller.buildBasicOrderParameters(listing.orderData);
   *
   * await walletClient.writeContract({
   *   address: fulfiller.getSeaportAddress(),
   *   abi: SeaportOrderFulfiller.getFulfillBasicOrderAbi(),
   *   functionName: 'fulfillBasicOrder_efficient_6GL6yc',
   *   args: [params],
   *   value: BigInt(listing.priceWei),
   * });
   * ```
   */
  buildBasicOrderParameters(
    orderData: OrderData | string,
    signature?: string
  ): BasicOrderParameters {
    const params = extractParameters(orderData);
    const sig = signature || extractSignature(orderData);

    const offerItem = params.offer[0];
    const considerationItem = params.consideration[0];

    if (!offerItem || !considerationItem) {
      throw new Error('Invalid order: missing offer or consideration items');
    }

    // Get additional recipients (fees)
    const additionalRecipients = params.consideration.slice(1).map((item) => ({
      amount: BigInt(item.startAmount),
      recipient: item.recipient,
    }));

    // Determine basic order type
    const basicOrderType = determineBasicOrderType(params);

    return {
      considerationToken: considerationItem.token,
      considerationIdentifier: BigInt(considerationItem.identifierOrCriteria),
      considerationAmount: BigInt(considerationItem.startAmount),
      offerer: params.offerer,
      zone: params.zone,
      offerToken: offerItem.token,
      offerIdentifier: BigInt(offerItem.identifierOrCriteria),
      offerAmount: BigInt(offerItem.startAmount),
      basicOrderType,
      startTime: BigInt(params.startTime),
      endTime: BigInt(params.endTime),
      zoneHash: params.zoneHash,
      salt: BigInt(params.salt),
      offererConduitKey: params.conduitKey,
      fulfillerConduitKey: DEFAULT_CONDUIT_KEY,
      totalOriginalAdditionalRecipients: BigInt(additionalRecipients.length),
      additionalRecipients,
      signature: sig,
    };
  }

  /**
   * Build parameters for fulfilling a criteria-based order via fulfillAdvancedOrder.
   *
   * Use this for criteria/n-of-many offers that use ERC721_WITH_CRITERIA.
   * fulfillBasicOrder does NOT support criteria-based items.
   *
   * @param orderData - The order data (criteria-based offer)
   * @param tokenId - The specific token ID the seller is offering
   * @param criteriaProof - Merkle proof for the token ID (from /offers/n-of-many/:groupId/proof/:tokenId)
   * @param recipient - Address to receive the offer proceeds (seller)
   * @param signature - Optional signature override
   * @returns Parameters for fulfillAdvancedOrder
   *
   * @example
   * ```ts
   * const fulfiller = new SeaportOrderFulfiller();
   *
   * // Get proof from API
   * const { proof } = await grails.offers.getNOfManyProof(groupId, tokenId);
   *
   * // Build fulfillment params
   * const params = fulfiller.buildAdvancedOrderParameters(
   *   offer.orderData,
   *   BigInt(tokenId),
   *   proof,
   *   sellerAddress
   * );
   *
   * await walletClient.writeContract({
   *   address: fulfiller.getSeaportAddress(),
   *   abi: SeaportOrderFulfiller.getFulfillAdvancedOrderAbi(),
   *   functionName: 'fulfillAdvancedOrder',
   *   args: [
   *     params.advancedOrder,
   *     params.criteriaResolvers,
   *     params.fulfillerConduitKey,
   *     params.recipient,
   *   ],
   * });
   * ```
   */
  buildAdvancedOrderParameters(
    orderData: OrderData | string,
    tokenId: bigint,
    criteriaProof: string[],
    recipient: string,
    signature?: string
  ): FulfillAdvancedOrderParams {
    const params = extractParameters(orderData);
    const sig = signature || extractSignature(orderData);

    const advancedOrder: AdvancedOrderParameters = {
      parameters: params,
      numerator: 1n,
      denominator: 1n,
      signature: sig,
      extraData: '0x',
    };

    // Build criteria resolver for the ERC721_WITH_CRITERIA consideration item
    // For offers: the criteria item is in consideration (side=1), typically at index 0
    const criteriaItemIndex = params.consideration.findIndex(
      (item) => item.itemType === ItemType.ERC721_WITH_CRITERIA ||
                item.itemType === ItemType.ERC1155_WITH_CRITERIA
    );

    if (criteriaItemIndex === -1) {
      throw new Error('No criteria-based item found in order consideration');
    }

    const criteriaResolvers: CriteriaResolver[] = [
      {
        orderIndex: 0,
        side: 1, // CONSIDERATION
        index: criteriaItemIndex,
        identifier: tokenId,
        criteriaProof,
      },
    ];

    return {
      advancedOrder,
      criteriaResolvers,
      fulfillerConduitKey: DEFAULT_CONDUIT_KEY,
      recipient,
    };
  }

  /**
   * Get the Seaport contract address
   */
  getSeaportAddress(): `0x${string}` {
    return SEAPORT_ADDRESS as `0x${string}`;
  }

  /**
   * Get the fulfillBasicOrder ABI
   */
  static getFulfillBasicOrderAbi() {
    return FULFILL_BASIC_ORDER_ABI;
  }

  /**
   * Get the fulfillAdvancedOrder ABI.
   * Use this for criteria-based orders (n-of-many, pick-one).
   */
  static getFulfillAdvancedOrderAbi() {
    return FULFILL_ADVANCED_ORDER_ABI;
  }

  /**
   * Get the getCounter ABI.
   * Use with readContract to fetch the current Seaport counter for an offerer.
   *
   * @example
   * ```ts
   * const counter = await publicClient.readContract({
   *   address: fulfiller.getSeaportAddress(),
   *   abi: SeaportOrderFulfiller.getCounterAbi(),
   *   functionName: 'getCounter',
   *   args: [offererAddress],
   * });
   * ```
   */
  static getCounterAbi() {
    return GET_COUNTER_ABI;
  }

  /**
   * Calculate the value to send for ETH purchases
   *
   * @param orderData - The order data
   * @returns Total ETH value to send (in wei)
   */
  calculateValue(orderData: OrderData | string): bigint {
    const params = extractParameters(orderData);

    // Sum up all consideration amounts (if paying in ETH)
    let total = 0n;

    for (const item of params.consideration) {
      if (item.itemType === ItemType.NATIVE) {
        total += BigInt(item.startAmount);
      }
    }

    return total;
  }

  /**
   * Check if order is still valid (not expired)
   *
   * @param orderData - The order data
   * @returns True if order is valid
   */
  isOrderValid(orderData: OrderData | string): boolean {
    const params = extractParameters(orderData);
    const now = Math.floor(Date.now() / 1000);

    return params.startTime <= now && params.endTime > now;
  }

  /**
   * Get order expiration time
   *
   * @param orderData - The order data
   * @returns Expiration timestamp (seconds)
   */
  getExpirationTime(orderData: OrderData | string): number {
    const params = extractParameters(orderData);
    return params.endTime;
  }
}
