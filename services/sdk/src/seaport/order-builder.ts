/**
 * Seaport Order Builder
 */

import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import {
  type SeaportOrder,
  type SeaportOfferItem,
  type SeaportConsiderationItem,
  type BuildListingOrderParams,
  type BuildOfferOrderParams,
  type BuildBulkOfferOrdersParams,
  type BuildCriteriaOfferOrderParams,
  type BuildNOfManyOfferOrdersParams,
  type NOfManyOrderResult,
  OrderType,
  ItemType,
} from './types.js';
import {
  ENS_REGISTRAR_ADDRESS,
  WETH_ADDRESS,
  ZERO_ADDRESS,
  DEFAULT_CONDUIT_KEY,
  DEFAULT_ZONE,
  DEFAULT_ZONE_HASH,
} from './constants.js';
import {
  prepareBulkSignature,
  extractBulkSignatures,
  type BulkSignatureResult,
  type IndividualBulkSignature,
} from './bulk-signature.js';
import {
  buildCriteriaMerkleTree,
  applyOfferCriteria,
  type CriteriaOrderResult,
} from './criteria-order.js';

/**
 * Calculate fee amount in wei
 */
function calculateFee(priceWei: string, basisPoints: number): bigint {
  const price = BigInt(priceWei);
  return (price * BigInt(basisPoints)) / BigInt(10000);
}

/**
 * Generate a random salt for the order
 */
function generateSalt(offerer: string, tokenId: string): string {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('uint256, address, uint256'), [
      BigInt(Date.now()),
      offerer as `0x${string}`,
      BigInt(tokenId),
    ])
  );
}

/**
 * Seaport Order Builder
 *
 * Builds Seaport orders for ENS name listings and offers
 */
export class SeaportOrderBuilder {
  /**
   * Build a listing order (seller offers ENS name, wants payment)
   *
   * @param params - Listing order parameters
   * @returns Seaport order structure (unsigned)
   *
   * @example
   * ```ts
   * const orderBuilder = new SeaportOrderBuilder();
   * const order = orderBuilder.buildListingOrder({
   *   tokenId: '12345678901234567890',
   *   priceWei: '1000000000000000000', // 1 ETH
   *   offerer: '0x...',
   *   durationDays: 7,
   *   platformFeeRecipient: '0x...',
   *   platformFeeBps: 250, // 2.5%
   * });
   * ```
   */
  buildListingOrder(params: BuildListingOrderParams): SeaportOrder {
    const {
      tokenId,
      priceWei,
      offerer,
      durationDays = 7,
      currencyAddress = ZERO_ADDRESS,
      platformFeeRecipient,
      platformFeeBps = 0,
      brokerFeeRecipient,
      brokerFeeBps = 0,
    } = params;

    // Calculate times
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationDays * 24 * 60 * 60;

    // Generate salt
    const salt = generateSalt(offerer, tokenId);

    // Build offer (ENS NFT)
    const offer: SeaportOfferItem[] = [
      {
        itemType: ItemType.ERC721,
        token: ENS_REGISTRAR_ADDRESS,
        identifierOrCriteria: tokenId,
        startAmount: '1',
        endAmount: '1',
      },
    ];

    // Calculate fees
    const platformFee = platformFeeRecipient && platformFeeBps > 0
      ? calculateFee(priceWei, platformFeeBps)
      : 0n;

    const brokerFee = brokerFeeRecipient && brokerFeeBps > 0
      ? calculateFee(priceWei, brokerFeeBps)
      : 0n;

    // Calculate seller proceeds
    const totalFees = platformFee + brokerFee;
    const sellerProceeds = BigInt(priceWei) - totalFees;

    // Determine payment token type
    const isNativePayment = currencyAddress === ZERO_ADDRESS;
    const paymentItemType = isNativePayment ? ItemType.NATIVE : ItemType.ERC20;

    // Build consideration (payment to seller + fees)
    const consideration: SeaportConsiderationItem[] = [
      {
        itemType: paymentItemType,
        token: currencyAddress,
        identifierOrCriteria: '0',
        startAmount: sellerProceeds.toString(),
        endAmount: sellerProceeds.toString(),
        recipient: offerer,
      },
    ];

    // Add platform fee if applicable
    if (platformFeeRecipient && platformFee > 0n) {
      consideration.push({
        itemType: paymentItemType,
        token: currencyAddress,
        identifierOrCriteria: '0',
        startAmount: platformFee.toString(),
        endAmount: platformFee.toString(),
        recipient: platformFeeRecipient,
      });
    }

    // Add broker fee if applicable
    if (brokerFeeRecipient && brokerFee > 0n) {
      consideration.push({
        itemType: paymentItemType,
        token: currencyAddress,
        identifierOrCriteria: '0',
        startAmount: brokerFee.toString(),
        endAmount: brokerFee.toString(),
        recipient: brokerFeeRecipient,
      });
    }

    return {
      offerer,
      zone: DEFAULT_ZONE,
      offer,
      consideration,
      orderType: OrderType.FULL_OPEN,
      startTime,
      endTime,
      zoneHash: DEFAULT_ZONE_HASH,
      salt,
      conduitKey: DEFAULT_CONDUIT_KEY,
      totalOriginalConsiderationItems: consideration.length,
    };
  }

  /**
   * Build an offer order (buyer offers WETH, wants ENS name)
   *
   * @param params - Offer order parameters
   * @returns Seaport order structure (unsigned)
   *
   * @example
   * ```ts
   * const orderBuilder = new SeaportOrderBuilder();
   * const order = orderBuilder.buildOfferOrder({
   *   tokenId: '12345678901234567890',
   *   offerAmountWei: '500000000000000000', // 0.5 WETH
   *   offerer: '0x...',
   *   durationDays: 7,
   * });
   * ```
   */
  buildOfferOrder(params: BuildOfferOrderParams): SeaportOrder {
    const {
      tokenId,
      offerAmountWei,
      offerer,
      durationDays = 7,
      // Reserved for future use when offer fulfillment with fees is implemented
      platformFeeRecipient: _platformFeeRecipient,
      platformFeeBps: _platformFeeBps = 0,
    } = params;

    // Calculate times
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationDays * 24 * 60 * 60;

    // Generate salt
    const salt = generateSalt(offerer, tokenId);

    // Calculate fees (reserved for future use when offer fulfillment is implemented)
    // const platformFee = platformFeeRecipient && platformFeeBps > 0
    //   ? calculateFee(offerAmountWei, platformFeeBps)
    //   : 0n;

    // Build offer (WETH from buyer)
    const offer: SeaportOfferItem[] = [
      {
        itemType: ItemType.ERC20,
        token: WETH_ADDRESS,
        identifierOrCriteria: '0',
        startAmount: offerAmountWei,
        endAmount: offerAmountWei,
      },
    ];

    // Build consideration (ENS name to buyer + fees)
    // Note: The seller's address will be filled in when the offer is accepted
    const consideration: SeaportConsiderationItem[] = [
      {
        itemType: ItemType.ERC721,
        token: ENS_REGISTRAR_ADDRESS,
        identifierOrCriteria: tokenId,
        startAmount: '1',
        endAmount: '1',
        recipient: offerer,
      },
    ];

    // The WETH payment considerations will be set by the fulfiller
    // For now, we just create the basic offer structure

    return {
      offerer,
      zone: DEFAULT_ZONE,
      offer,
      consideration,
      orderType: OrderType.FULL_OPEN,
      startTime,
      endTime,
      zoneHash: DEFAULT_ZONE_HASH,
      salt,
      conduitKey: DEFAULT_CONDUIT_KEY,
      totalOriginalConsiderationItems: consideration.length,
    };
  }

  /**
   * Build multiple offer orders for bulk signing (shotgun offers).
   * Each offer targets a different ENS name at a specified price.
   *
   * @param params - Bulk offer parameters
   * @returns Array of SeaportOrder structures (unsigned)
   */
  buildBulkOfferOrders(params: BuildBulkOfferOrdersParams): SeaportOrder[] {
    const { offers, offerer, durationDays = 7 } = params;

    return offers.map((item) =>
      this.buildOfferOrder({
        tokenId: item.tokenId,
        offerAmountWei: item.offerAmountWei,
        offerer,
        durationDays,
      })
    );
  }

  /**
   * Build a criteria-based offer order (pick-one offers).
   * Creates a single offer valid for ANY one name from the provided set.
   *
   * @param params - Criteria offer parameters
   * @returns Order with merkle root + proofs for fulfillment
   */
  buildCriteriaOfferOrder(params: BuildCriteriaOfferOrderParams): CriteriaOrderResult {
    const { tokenIds, offerAmountWei, offerer, durationDays = 7 } = params;

    // Build merkle tree of acceptable token IDs
    const { merkleRoot, proofs, sortedTokenIds } = buildCriteriaMerkleTree(tokenIds);

    // Build a standard offer order using the first token ID as placeholder
    const baseOrder = this.buildOfferOrder({
      tokenId: tokenIds[0],
      offerAmountWei,
      offerer,
      durationDays,
    });

    // Convert to criteria-based order
    const order = applyOfferCriteria(baseOrder, merkleRoot);

    return { order, merkleRoot, proofs, sortedTokenIds };
  }

  /**
   * Build n-of-many offer orders.
   * Creates N criteria-based offers, each valid for any of M candidate names.
   * All N orders share the same merkle root but have unique salts.
   *
   * @param params - N-of-many offer parameters
   * @returns N orders + shared merkle root + proofs for fulfillment
   *
   * @example
   * ```ts
   * const orderBuilder = new SeaportOrderBuilder();
   * const result = orderBuilder.buildNOfManyOfferOrders({
   *   tokenIds: ['123', '456', '789', '101', '202'],
   *   offerAmountWei: '500000000000000000', // 0.5 WETH each
   *   offerer: '0x...',
   *   count: 3, // want 3 of the 5
   * });
   * // result.orders.length === 3
   * // All 3 orders share result.merkleRoot covering all 5 token IDs
   * ```
   */
  buildNOfManyOfferOrders(params: BuildNOfManyOfferOrdersParams): NOfManyOrderResult {
    const { tokenIds, offerAmountWei, offerer, count, durationDays = 7 } = params;

    if (tokenIds.length < 2) {
      throw new Error('At least 2 token IDs required for n-of-many offers');
    }
    if (count < 1) {
      throw new Error('Count must be at least 1');
    }
    if (count > tokenIds.length) {
      throw new Error('Count cannot exceed the number of token IDs');
    }

    // Build criteria merkle tree from the full candidate set
    const { merkleRoot, proofs, sortedTokenIds } = buildCriteriaMerkleTree(tokenIds);

    // Calculate shared timing
    const startTime = Math.floor(Date.now() / 1000);
    const endTime = startTime + durationDays * 24 * 60 * 60;

    // Build N criteria orders with unique salts
    const orders: SeaportOrder[] = [];
    for (let i = 0; i < count; i++) {
      // Index-based salt for uniqueness across the N orders
      const salt = keccak256(
        encodeAbiParameters(parseAbiParameters('uint256, address, uint256'), [
          BigInt(Date.now()),
          offerer as `0x${string}`,
          BigInt(i),
        ])
      );

      const offer: SeaportOfferItem[] = [
        {
          itemType: ItemType.ERC20,
          token: WETH_ADDRESS,
          identifierOrCriteria: '0',
          startAmount: offerAmountWei,
          endAmount: offerAmountWei,
        },
      ];

      const consideration: SeaportConsiderationItem[] = [
        {
          itemType: ItemType.ERC721_WITH_CRITERIA,
          token: ENS_REGISTRAR_ADDRESS,
          identifierOrCriteria: merkleRoot,
          startAmount: '1',
          endAmount: '1',
          recipient: offerer,
        },
      ];

      orders.push({
        offerer,
        zone: DEFAULT_ZONE,
        offer,
        consideration,
        orderType: OrderType.FULL_OPEN,
        startTime,
        endTime,
        zoneHash: DEFAULT_ZONE_HASH,
        salt,
        conduitKey: DEFAULT_CONDUIT_KEY,
        totalOriginalConsiderationItems: consideration.length,
      });
    }

    return { orders, merkleRoot, proofs, sortedTokenIds };
  }

  /**
   * Prepare a bulk signature structure for multiple orders.
   * Returns the typed data for a single wallet signTypedData call.
   *
   * @param orders - Array of SeaportOrder objects
   * @param counter - Seaport counter for the signer (default 0)
   * @returns BulkSignatureResult with typed data
   */
  prepareBulkSignature(
    orders: SeaportOrder[],
    counter: bigint = 0n
  ): BulkSignatureResult {
    return prepareBulkSignature(orders, counter);
  }

  /**
   * Extract per-order signatures from a bulk signature.
   *
   * @param signature - Raw signature from signTypedData
   * @param result - BulkSignatureResult from prepareBulkSignature
   * @param orders - Original orders array
   * @returns Array of IndividualBulkSignature
   */
  extractBulkSignatures(
    signature: string,
    result: BulkSignatureResult,
    orders: SeaportOrder[]
  ): IndividualBulkSignature[] {
    return extractBulkSignatures(signature, result, orders);
  }

  /**
   * Validate an order structure
   *
   * @param order - Order to validate
   * @returns Validation result with errors if any
   */
  validate(order: SeaportOrder): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    // Validate offerer
    if (!order.offerer || !/^0x[a-fA-F0-9]{40}$/.test(order.offerer)) {
      errors.push('Invalid offerer address');
    }

    // Validate offer items
    if (!order.offer || order.offer.length === 0) {
      errors.push('Order must have at least one offer item');
    }

    // Validate consideration items
    if (!order.consideration || order.consideration.length === 0) {
      errors.push('Order must have at least one consideration item');
    }

    // Validate timing
    const currentTime = Math.floor(Date.now() / 1000);
    const maxFutureTime = currentTime + 365 * 24 * 60 * 60;

    if (order.startTime > maxFutureTime) {
      errors.push('Start time too far in the future');
    }

    if (order.endTime <= order.startTime) {
      errors.push('End time must be after start time');
    }

    if (order.endTime > maxFutureTime) {
      errors.push('End time too far in the future');
    }

    // Validate offer items
    for (let i = 0; i < order.offer.length; i++) {
      const item = order.offer[i];

      if (item.itemType === ItemType.ERC721 || item.itemType === ItemType.ERC1155) {
        if (!item.token || !/^0x[a-fA-F0-9]{40}$/.test(item.token)) {
          errors.push(`Invalid token address in offer item ${i}`);
        }
      }

      try {
        const startAmount = BigInt(item.startAmount);
        const endAmount = BigInt(item.endAmount);

        if (startAmount < 0n) {
          errors.push(`Invalid start amount in offer item ${i}`);
        }

        if (endAmount < startAmount) {
          errors.push(`End amount must be >= start amount in offer item ${i}`);
        }
      } catch {
        errors.push(`Invalid amount in offer item ${i}`);
      }
    }

    // Validate consideration items
    for (let i = 0; i < order.consideration.length; i++) {
      const item = order.consideration[i];

      if (!item.recipient || !/^0x[a-fA-F0-9]{40}$/.test(item.recipient)) {
        errors.push(`Invalid recipient address in consideration item ${i}`);
      }

      try {
        const startAmount = BigInt(item.startAmount);
        const endAmount = BigInt(item.endAmount);

        if (startAmount <= 0n) {
          errors.push(`Invalid start amount in consideration item ${i}`);
        }

        if (endAmount < startAmount) {
          errors.push(`End amount must be >= start amount in consideration item ${i}`);
        }
      } catch {
        errors.push(`Invalid amount in consideration item ${i}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}
