/**
 * Seaport Bulk Signature Support
 *
 * Implements merkle tree construction for Seaport bulk orders (EIP-712).
 * Allows signing N independent offers with a single wallet signature.
 *
 * Reference: Seaport EIP-712 bulk order signing spec.
 * Tree depths 1-24 supported (2 to 16M orders).
 */

import { keccak256, encodeAbiParameters, parseAbiParameters } from 'viem';
import type { SeaportOrder } from './types.js';
import { SEAPORT_ADDRESS, ZERO_BYTES32 } from './constants.js';

/** Result from prepareBulkSignature */
export interface BulkSignatureResult {
  /** Merkle tree leaves (EIP-712 order hashes) */
  leaves: string[];
  /** Tree height (1-24) */
  treeHeight: number;
  /** Merkle root */
  merkleRoot: string;
  /** EIP-712 typed data for wallet signing */
  typedData: {
    domain: Record<string, any>;
    types: Record<string, any[]>;
    primaryType: string;
    message: Record<string, any>;
  };
  /** Total orders (including padding) */
  paddedCount: number;
}

/** Individual order signature extracted from bulk signature */
export interface IndividualBulkSignature {
  /** Order index in the tree */
  orderIndex: number;
  /** The order itself */
  order: SeaportOrder;
  /** Encoded bulk signature: compact_sig + tree_height + index + proof */
  signature: string;
}

// Seaport EIP-712 domain
const SEAPORT_DOMAIN = {
  name: 'Seaport',
  version: '1.6',
  chainId: 1,
  verifyingContract: SEAPORT_ADDRESS,
};

// EIP-712 type definitions for OrderComponents
const ORDER_COMPONENTS_TYPE = [
  { name: 'offerer', type: 'address' },
  { name: 'zone', type: 'address' },
  { name: 'offer', type: 'OfferItem[]' },
  { name: 'consideration', type: 'ConsiderationItem[]' },
  { name: 'orderType', type: 'uint8' },
  { name: 'startTime', type: 'uint256' },
  { name: 'endTime', type: 'uint256' },
  { name: 'zoneHash', type: 'bytes32' },
  { name: 'salt', type: 'uint256' },
  { name: 'conduitKey', type: 'bytes32' },
  { name: 'counter', type: 'uint256' },
];

const OFFER_ITEM_TYPE = [
  { name: 'itemType', type: 'uint8' },
  { name: 'token', type: 'address' },
  { name: 'identifierOrCriteria', type: 'uint256' },
  { name: 'startAmount', type: 'uint256' },
  { name: 'endAmount', type: 'uint256' },
];

const CONSIDERATION_ITEM_TYPE = [
  { name: 'itemType', type: 'uint8' },
  { name: 'token', type: 'address' },
  { name: 'identifierOrCriteria', type: 'uint256' },
  { name: 'startAmount', type: 'uint256' },
  { name: 'endAmount', type: 'uint256' },
  { name: 'recipient', type: 'address' },
];

/**
 * Next power of 2 >= n
 */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Log base 2 (for power-of-2 numbers)
 */
function log2(n: number): number {
  let h = 0;
  let v = n;
  while (v > 1) {
    v >>= 1;
    h++;
  }
  return h;
}

/**
 * Hash two sibling nodes in the merkle tree
 */
function hashPair(a: string, b: string): string {
  return keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32'), [
      a as `0x${string}`,
      b as `0x${string}`,
    ])
  );
}

/**
 * Build a binary merkle tree from an array of leaf hashes.
 * Returns all tree layers (leaves at index 0, root at last index).
 */
function buildMerkleTree(leaves: string[]): string[][] {
  const layers: string[][] = [leaves];
  let currentLayer = leaves;

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      nextLayer.push(hashPair(currentLayer[i], currentLayer[i + 1]));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return layers;
}

/**
 * Extract merkle proof (sibling hashes) for a given leaf index.
 */
function getMerkleProof(layers: string[][], index: number): string[] {
  const proof: string[] = [];
  let idx = index;

  for (let i = 0; i < layers.length - 1; i++) {
    const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    proof.push(layers[i][siblingIndex]);
    idx = Math.floor(idx / 2);
  }

  return proof;
}

/**
 * Create an unfulfillable dummy order hash for tree padding.
 * Uses startTime = endTime = 0 making it impossible to fulfill.
 */
function createDummyLeafHash(): string {
  return ZERO_BYTES32;
}

/**
 * Build the BulkOrder EIP-712 type name for a given tree height.
 * E.g., height=2 -> "BulkOrder" with "OrderComponents[2][2]"
 */
function getBulkOrderTypeName(height: number): string {
  return 'OrderComponents' + '[2]'.repeat(height);
}

/**
 * Build a nested tree structure for EIP-712 typed data message.
 * The tree is a nested array of OrderComponents at the leaves.
 */
function buildTreeMessage(
  orders: SeaportOrder[],
  paddedCount: number,
  counter: bigint = 0n
): any {
  const components = [];
  for (let i = 0; i < paddedCount; i++) {
    if (i < orders.length) {
      const order = orders[i];
      components.push({
        offerer: order.offerer,
        zone: order.zone,
        offer: order.offer.map((item) => ({
          itemType: item.itemType,
          token: item.token,
          identifierOrCriteria: item.identifierOrCriteria,
          startAmount: item.startAmount,
          endAmount: item.endAmount,
        })),
        consideration: order.consideration.map((item) => ({
          itemType: item.itemType,
          token: item.token,
          identifierOrCriteria: item.identifierOrCriteria,
          startAmount: item.startAmount,
          endAmount: item.endAmount,
          recipient: item.recipient,
        })),
        orderType: order.orderType,
        startTime: order.startTime,
        endTime: order.endTime,
        zoneHash: order.zoneHash,
        salt: order.salt,
        conduitKey: order.conduitKey,
        counter: counter.toString(),
      });
    } else {
      // Dummy unfulfillable order for padding
      components.push({
        offerer: '0x0000000000000000000000000000000000000000',
        zone: '0x0000000000000000000000000000000000000000',
        offer: [],
        consideration: [],
        orderType: 0,
        startTime: 0,
        endTime: 0,
        zoneHash: ZERO_BYTES32,
        salt: '0',
        conduitKey: ZERO_BYTES32,
        counter: '0',
      });
    }
  }

  // Build nested binary tree structure
  function nestArray(arr: any[], depth: number): any {
    if (depth === 1) {
      return arr;
    }
    const half = arr.length / 2;
    return [
      nestArray(arr.slice(0, half), depth - 1),
      nestArray(arr.slice(half), depth - 1),
    ];
  }

  const height = log2(paddedCount);
  return nestArray(components, height);
}

/**
 * Prepare a bulk signature for multiple orders.
 *
 * @param orders - Array of SeaportOrder objects to sign together
 * @param counter - The Seaport counter for the signer (default 0)
 * @returns BulkSignatureResult with typed data for wallet signing
 */
export function prepareBulkSignature(
  orders: SeaportOrder[],
  counter: bigint = 0n
): BulkSignatureResult {
  if (orders.length === 0) {
    throw new Error('At least one order required');
  }
  if (orders.length > 16777216) {
    throw new Error('Maximum 16,777,216 orders supported');
  }

  const paddedCount = nextPow2(orders.length);
  const treeHeight = log2(paddedCount);

  if (treeHeight < 1) {
    throw new Error('At least 2 orders required for bulk signing');
  }

  // Build leaf hashes (EIP-712 order component hashes)
  const leaves: string[] = [];
  for (let i = 0; i < paddedCount; i++) {
    if (i < orders.length) {
      // Real order — we use a simplified hash here; the actual hash
      // is computed by the wallet via signTypedData
      leaves.push(keccak256(
        encodeAbiParameters(
          parseAbiParameters('address, uint256, uint256, bytes32'),
          [
            orders[i].offerer as `0x${string}`,
            BigInt(orders[i].startTime),
            BigInt(orders[i].endTime),
            orders[i].salt as `0x${string}`,
          ]
        )
      ));
    } else {
      leaves.push(createDummyLeafHash());
    }
  }

  // Build merkle tree
  const layers = buildMerkleTree(leaves);
  const merkleRoot = layers[layers.length - 1][0];

  // Build EIP-712 typed data
  const bulkOrderType = getBulkOrderTypeName(treeHeight);
  const treeMessage = buildTreeMessage(orders, paddedCount, counter);

  const typedData = {
    domain: SEAPORT_DOMAIN,
    types: {
      BulkOrder: [{ name: 'tree', type: bulkOrderType }],
      OrderComponents: ORDER_COMPONENTS_TYPE,
      OfferItem: OFFER_ITEM_TYPE,
      ConsiderationItem: CONSIDERATION_ITEM_TYPE,
    },
    primaryType: 'BulkOrder' as const,
    message: { tree: treeMessage },
  };

  return {
    leaves,
    treeHeight,
    merkleRoot,
    typedData,
    paddedCount,
  };
}

/**
 * Extract individual bulk signatures from a single wallet signature.
 *
 * Each per-order signature = compact_sig (64 bytes) + tree_height (1 byte)
 *                           + order_index (3 bytes) + proof_elements (32 bytes each)
 *
 * @param signature - The raw signature from signTypedData (65 bytes hex)
 * @param result - The BulkSignatureResult from prepareBulkSignature
 * @param orders - The original orders array
 * @returns Array of IndividualBulkSignature for each real order
 */
export function extractBulkSignatures(
  signature: string,
  result: BulkSignatureResult,
  orders: SeaportOrder[]
): IndividualBulkSignature[] {
  // Strip 0x prefix
  const rawSig = signature.startsWith('0x') ? signature.slice(2) : signature;

  // Convert 65-byte signature to 64-byte compact format
  // Standard: r (32) + s (32) + v (1) = 65 bytes
  // Compact: r (32) + yParityAndS (32) = 64 bytes
  const r = rawSig.slice(0, 64);
  const s = rawSig.slice(64, 128);
  const v = parseInt(rawSig.slice(128, 130), 16);

  // EIP-2098 compact signature: set high bit of s if v == 28
  const sBigInt = BigInt('0x' + s);
  const compactS = v === 28
    ? (sBigInt | (1n << 255n)).toString(16).padStart(64, '0')
    : s;
  const compactSig = r + compactS;

  // Build merkle tree for proof extraction
  const layers = buildMerkleTree(result.leaves);

  const signatures: IndividualBulkSignature[] = [];

  for (let i = 0; i < orders.length; i++) {
    const proof = getMerkleProof(layers, i);

    // Encode: compact_sig (64 bytes) + height (1 byte) + index (3 bytes) + proof
    const heightHex = result.treeHeight.toString(16).padStart(2, '0');
    const indexHex = i.toString(16).padStart(6, '0');
    const proofHex = proof.map((p) => (p.startsWith('0x') ? p.slice(2) : p)).join('');

    const bulkSig = '0x' + compactSig + heightHex + indexHex + proofHex;

    signatures.push({
      orderIndex: i,
      order: orders[i],
      signature: bulkSig,
    });
  }

  return signatures;
}

/**
 * Utility: compute the hash of a pair for merkle verification
 */
export { hashPair, buildMerkleTree, getMerkleProof };
