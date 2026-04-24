/**
 * Seaport Criteria-Based Order Support
 *
 * Builds criteria-based orders for "pick-one" offers:
 * - Build merkle tree of token IDs
 * - Use ItemType.ERC721_WITH_CRITERIA (4)
 * - Generate proofs for fulfillment
 */

import { keccak256, encodePacked } from 'viem';
import type { SeaportOrder, SeaportConsiderationItem } from './types.js';
import { ItemType } from './types.js';

/** Result from building a criteria order */
export interface CriteriaOrderResult {
  /** The Seaport order with criteria-based consideration */
  order: SeaportOrder;
  /** Merkle root of accepted token IDs */
  merkleRoot: string;
  /** Map of tokenId -> merkle proof for fulfillment */
  proofs: Map<string, string[]>;
  /** Sorted token IDs used in the tree */
  sortedTokenIds: string[];
}

/**
 * Hash a token ID leaf for the criteria merkle tree.
 * Seaport expects keccak256(abi.encodePacked(tokenId)).
 */
function hashTokenId(tokenId: string): string {
  return keccak256(encodePacked(['uint256'], [BigInt(tokenId)]));
}

/**
 * Hash two sorted sibling nodes.
 * Seaport criteria trees use sorted pair hashing (smaller hash first).
 */
function hashSortedPair(a: string, b: string): string {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower <= bLower) {
    return keccak256(encodePacked(['bytes32', 'bytes32'], [a as `0x${string}`, b as `0x${string}`]));
  }
  return keccak256(encodePacked(['bytes32', 'bytes32'], [b as `0x${string}`, a as `0x${string}`]));
}

/**
 * Next power of 2 >= n
 */
function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

/**
 * Build a sorted merkle tree from token ID hashes.
 * Returns all layers (leaves at 0, root at last).
 */
function buildSortedMerkleTree(leaves: string[]): string[][] {
  // Pad to power of 2 with zero hashes
  const paddedCount = nextPow2(leaves.length);
  const paddedLeaves = [...leaves];
  while (paddedLeaves.length < paddedCount) {
    paddedLeaves.push('0x' + '00'.repeat(32));
  }

  const layers: string[][] = [paddedLeaves];
  let currentLayer = paddedLeaves;

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      nextLayer.push(hashSortedPair(currentLayer[i], currentLayer[i + 1]));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return layers;
}

/**
 * Extract proof for a given leaf index in a sorted merkle tree.
 */
function getSortedMerkleProof(layers: string[][], index: number): string[] {
  const proof: string[] = [];
  let idx = index;

  for (let i = 0; i < layers.length - 1; i++) {
    const siblingIndex = idx % 2 === 0 ? idx + 1 : idx - 1;
    if (siblingIndex < layers[i].length) {
      proof.push(layers[i][siblingIndex]);
    }
    idx = Math.floor(idx / 2);
  }

  return proof;
}

/**
 * Build a criteria merkle tree from an array of token IDs.
 *
 * @param tokenIds - Array of ENS token IDs to include
 * @returns Merkle root and proofs for each token ID
 */
export function buildCriteriaMerkleTree(tokenIds: string[]): {
  merkleRoot: string;
  proofs: Map<string, string[]>;
  sortedTokenIds: string[];
} {
  if (tokenIds.length === 0) {
    throw new Error('At least one token ID required');
  }

  if (tokenIds.length === 1) {
    // Single token — merkle root is just the hash of that token
    const leaf = hashTokenId(tokenIds[0]);
    return {
      merkleRoot: leaf,
      proofs: new Map([[tokenIds[0], []]]),
      sortedTokenIds: tokenIds,
    };
  }

  // Hash and sort leaves
  const hashedLeaves = tokenIds.map((id) => ({
    tokenId: id,
    hash: hashTokenId(id),
  }));

  // Sort by hash for deterministic tree
  hashedLeaves.sort((a, b) => a.hash.toLowerCase().localeCompare(b.hash.toLowerCase()));

  const sortedTokenIds = hashedLeaves.map((l) => l.tokenId);
  const leafHashes = hashedLeaves.map((l) => l.hash);

  const layers = buildSortedMerkleTree(leafHashes);
  const merkleRoot = layers[layers.length - 1][0];

  // Build proofs for each token
  const proofs = new Map<string, string[]>();
  for (let i = 0; i < hashedLeaves.length; i++) {
    proofs.set(hashedLeaves[i].tokenId, getSortedMerkleProof(layers, i));
  }

  return { merkleRoot, proofs, sortedTokenIds };
}

/**
 * Modify an offer order to use criteria-based consideration.
 *
 * Takes a standard offer order (for a specific token ID) and converts it
 * to use ERC721_WITH_CRITERIA with the merkle root as the identifier.
 *
 * @param order - Standard SeaportOrder with ERC721 consideration
 * @param merkleRoot - Merkle root of accepted token IDs
 * @returns Modified order with criteria-based consideration
 */
export function applyOfferCriteria(
  order: SeaportOrder,
  merkleRoot: string
): SeaportOrder {
  const newConsideration: SeaportConsiderationItem[] = order.consideration.map((item) => {
    if (item.itemType === ItemType.ERC721) {
      return {
        ...item,
        itemType: ItemType.ERC721_WITH_CRITERIA,
        identifierOrCriteria: merkleRoot,
      };
    }
    return item;
  });

  return {
    ...order,
    consideration: newConsideration,
  };
}

/**
 * Get the merkle proof for a specific token ID.
 * Used by the seller when fulfilling a criteria-based offer.
 *
 * @param proofs - Map of tokenId -> proof from buildCriteriaMerkleTree
 * @param tokenId - The token ID being offered to fulfill
 * @returns Array of proof elements, or null if token not in set
 */
export function getCriteriaProof(
  proofs: Map<string, string[]>,
  tokenId: string
): string[] | null {
  return proofs.get(tokenId) || null;
}

/**
 * Verify that a token ID is part of a criteria set.
 *
 * @param merkleRoot - The merkle root from the criteria order
 * @param tokenId - Token ID to verify
 * @param proof - Merkle proof elements
 * @returns true if the token ID is valid for this criteria
 */
export function verifyCriteriaProof(
  merkleRoot: string,
  tokenId: string,
  proof: string[]
): boolean {
  let hash = hashTokenId(tokenId);

  for (const proofElement of proof) {
    hash = hashSortedPair(hash, proofElement);
  }

  return hash.toLowerCase() === merkleRoot.toLowerCase();
}
