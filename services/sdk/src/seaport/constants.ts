/**
 * Seaport Constants
 */

import { CONTRACTS } from '../config.js';

/**
 * Seaport 1.6 contract address (mainnet)
 */
export const SEAPORT_ADDRESS = CONTRACTS.seaport;

/**
 * ENS Base Registrar address (mainnet)
 */
export const ENS_REGISTRAR_ADDRESS = CONTRACTS.ensRegistrar;

/**
 * WETH address (mainnet)
 */
export const WETH_ADDRESS = CONTRACTS.weth;

/**
 * Zero address
 */
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Zero bytes32
 */
export const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000';

/**
 * Default conduit key (zero)
 */
export const DEFAULT_CONDUIT_KEY = ZERO_BYTES32;

/**
 * Default zone address (zero)
 */
export const DEFAULT_ZONE = ZERO_ADDRESS;

/**
 * Default zone hash (zero)
 */
export const DEFAULT_ZONE_HASH = ZERO_BYTES32;

/**
 * Seaport fulfillBasicOrder ABI
 */
export const FULFILL_BASIC_ORDER_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'considerationToken', type: 'address' },
          { name: 'considerationIdentifier', type: 'uint256' },
          { name: 'considerationAmount', type: 'uint256' },
          { name: 'offerer', type: 'address' },
          { name: 'zone', type: 'address' },
          { name: 'offerToken', type: 'address' },
          { name: 'offerIdentifier', type: 'uint256' },
          { name: 'offerAmount', type: 'uint256' },
          { name: 'basicOrderType', type: 'uint8' },
          { name: 'startTime', type: 'uint256' },
          { name: 'endTime', type: 'uint256' },
          { name: 'zoneHash', type: 'bytes32' },
          { name: 'salt', type: 'uint256' },
          { name: 'offererConduitKey', type: 'bytes32' },
          { name: 'fulfillerConduitKey', type: 'bytes32' },
          { name: 'totalOriginalAdditionalRecipients', type: 'uint256' },
          {
            components: [
              { name: 'amount', type: 'uint256' },
              { name: 'recipient', type: 'address' },
            ],
            name: 'additionalRecipients',
            type: 'tuple[]',
          },
          { name: 'signature', type: 'bytes' },
        ],
        name: 'parameters',
        type: 'tuple',
      },
    ],
    name: 'fulfillBasicOrder_efficient_6GL6yc',
    outputs: [{ name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

/**
 * Seaport fulfillAdvancedOrder ABI
 * Required for criteria-based orders (n-of-many, pick-one)
 */
export const FULFILL_ADVANCED_ORDER_ABI = [
  {
    inputs: [
      {
        name: 'advancedOrder',
        type: 'tuple',
        components: [
          {
            name: 'parameters',
            type: 'tuple',
            components: [
              { name: 'offerer', type: 'address' },
              { name: 'zone', type: 'address' },
              {
                name: 'offer',
                type: 'tuple[]',
                components: [
                  { name: 'itemType', type: 'uint8' },
                  { name: 'token', type: 'address' },
                  { name: 'identifierOrCriteria', type: 'uint256' },
                  { name: 'startAmount', type: 'uint256' },
                  { name: 'endAmount', type: 'uint256' },
                ],
              },
              {
                name: 'consideration',
                type: 'tuple[]',
                components: [
                  { name: 'itemType', type: 'uint8' },
                  { name: 'token', type: 'address' },
                  { name: 'identifierOrCriteria', type: 'uint256' },
                  { name: 'startAmount', type: 'uint256' },
                  { name: 'endAmount', type: 'uint256' },
                  { name: 'recipient', type: 'address' },
                ],
              },
              { name: 'orderType', type: 'uint8' },
              { name: 'startTime', type: 'uint256' },
              { name: 'endTime', type: 'uint256' },
              { name: 'zoneHash', type: 'bytes32' },
              { name: 'salt', type: 'uint256' },
              { name: 'conduitKey', type: 'bytes32' },
              { name: 'totalOriginalConsiderationItems', type: 'uint256' },
            ],
          },
          { name: 'numerator', type: 'uint120' },
          { name: 'denominator', type: 'uint120' },
          { name: 'signature', type: 'bytes' },
          { name: 'extraData', type: 'bytes' },
        ],
      },
      {
        name: 'criteriaResolvers',
        type: 'tuple[]',
        components: [
          { name: 'orderIndex', type: 'uint256' },
          { name: 'side', type: 'uint8' },
          { name: 'index', type: 'uint256' },
          { name: 'identifier', type: 'uint256' },
          { name: 'criteriaProof', type: 'bytes32[]' },
        ],
      },
      { name: 'fulfillerConduitKey', type: 'bytes32' },
      { name: 'recipient', type: 'address' },
    ],
    name: 'fulfillAdvancedOrder',
    outputs: [{ name: 'fulfilled', type: 'bool' }],
    stateMutability: 'payable',
    type: 'function',
  },
] as const;

/**
 * Seaport getCounter ABI
 * Read the current counter for an offerer
 */
export const GET_COUNTER_ABI = [
  {
    inputs: [{ name: 'offerer', type: 'address' }],
    name: 'getCounter',
    outputs: [{ name: 'counter', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;
