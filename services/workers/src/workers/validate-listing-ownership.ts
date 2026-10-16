/**
 * Listing Ownership Validation Worker
 *
 * Validates that the seller of a listing still owns the ENS name.
 * Uses database as primary source, with 10% on-chain verification for accuracy.
 */

import {
  config,
  getPostgresPool,
  getOrderNftItem,
  checkEnsV2OrderItem,
  checkEnsV2Transferable,
  getOrderOperator,
} from '../../../shared/src';
import { ethers } from 'ethers';
import {
  type ValidationResult,
  type ListingWithOwner,
  ENS_REGISTRAR_ADDRESS
} from './types';

const pool = getPostgresPool();

// Name Wrapper contract address
const NAME_WRAPPER_ADDRESS = config.blockchain.ensNameWrapperAddress;

// Initialize provider (will be set by environment)
let provider: ethers.Provider | null = null;

export function initializeProvider(rpcUrl: string) {
  provider = new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * Fetch listing with current owner from database
 */
async function fetchListingWithOwner(listingId: number): Promise<ListingWithOwner | null> {
  const result = await pool.query(`
    SELECT
      l.id,
      l.seller_address,
      l.ens_name_id,
      l.status,
      en.name,
      en.token_id,
      en.ens_version,
      l.order_data,
      en.owner_address as current_owner
    FROM listings l
    JOIN ens_names en ON en.id = l.ens_name_id
    WHERE l.id = $1
  `, [listingId]);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Get ENS owner from on-chain
 *
 * Handles both wrapped and unwrapped names:
 * - For unwrapped names: Base Registrar ownerOf returns the actual owner
 * - For wrapped names: Base Registrar ownerOf returns Name Wrapper, so we query Name Wrapper
 *
 * The tokenId could be either:
 * - A labelhash (Base Registrar token ID for unwrapped names)
 * - A namehash (Name Wrapper token ID for wrapped names stored in our DB)
 */
async function getENSOwnerFromRPC(tokenId: string): Promise<string | null> {
  if (!provider) {
    throw new Error('Provider not initialized. Call initializeProvider() first.');
  }

  const registrar = new ethers.Contract(
    ENS_REGISTRAR_ADDRESS,
    ['function ownerOf(uint256 tokenId) view returns (address)'],
    provider
  );

  const nameWrapper = new ethers.Contract(
    NAME_WRAPPER_ADDRESS,
    ['function ownerOf(uint256 id) view returns (address)'],
    provider
  );

  try {
    // First, try Base Registrar with the token ID
    const registrarOwner = await registrar.ownerOf(tokenId);

    // If owner is Name Wrapper, get the real owner from Name Wrapper
    if (registrarOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()) {
      try {
        // For wrapped names, the Name Wrapper uses namehash as token ID
        // Our DB stores namehash for wrapped names, so this should work
        const wrappedOwner = await nameWrapper.ownerOf(tokenId);

        // Zero address means not wrapped or burned
        if (wrappedOwner && wrappedOwner !== ethers.ZeroAddress) {
          return wrappedOwner;
        }
      } catch (wrapperError: any) {
        console.warn(`Name Wrapper ownerOf failed for token ${tokenId}:`, wrapperError.message);
      }
      // Fall back to registrar owner (Name Wrapper address)
      return registrarOwner;
    }

    return registrarOwner;
  } catch (registrarError: any) {
    // Base Registrar failed - this could happen if:
    // 1. The token ID is a namehash (for wrapped names) but not a valid labelhash
    // 2. The name doesn't exist or is expired

    // Try Name Wrapper directly with the token ID (might be a namehash)
    try {
      const wrappedOwner = await nameWrapper.ownerOf(tokenId);

      if (wrappedOwner && wrappedOwner !== ethers.ZeroAddress) {
        return wrappedOwner;
      }
    } catch (wrapperError: any) {
      // Both failed - log and return null
      console.error(`Error fetching on-chain owner for token ${tokenId}:`, registrarError.message);
    }

    return null;
  }
}

/**
 * Validate a listing on an ENSv2 name, always on-chain: the order must reference the name's
 * current ETHRegistry token, and the registry must allow Seaport to move it from the seller.
 * A changed token ID or a non-transferable name can never fill again (permanent: cancel);
 * a lost owner, an expired name or a missing approval may recover (unfunded).
 */
async function validateEnsV2Listing(listing: ListingWithOwner): Promise<ValidationResult> {
  const orderData = typeof listing.order_data === 'string' ? JSON.parse(listing.order_data) : listing.order_data;
  const params = orderData?.protocol_data?.parameters ?? orderData?.parameters ?? orderData ?? {};

  const itemError = checkEnsV2OrderItem(getOrderNftItem(params, 'listing'), listing.token_id);
  if (itemError) {
    return { isValid: false, permanent: true, reason: 'token_changed', checkedAt: new Date() };
  }
  const operator = getOrderOperator(params.conduitKey);
  if (!operator) {
    return { isValid: false, permanent: true, reason: 'unknown_conduit', checkedAt: new Date() };
  }

  const transfer = await checkEnsV2Transferable({ tokenId: listing.token_id, owner: listing.seller_address, operator });
  if (transfer.ok) {
    return { isValid: true, checkedAt: new Date() };
  }
  return {
    isValid: false,
    permanent: transfer.reason === 'token_changed' || transfer.reason === 'not_transferable',
    reason: transfer.reason === 'ownership_lost' ? 'ownership_lost_onchain' : transfer.reason,
    checkedAt: new Date(),
    details: transfer.reason === 'ownership_lost'
      ? { expectedOwner: listing.seller_address, currentOwner: transfer.detail }
      : undefined,
  };
}

/**
 * Validate listing ownership
 */
export async function validateListingOwnership(listingId: number): Promise<ValidationResult> {
  try {
    // 1. Fetch listing and current owner from database
    const listing = await fetchListingWithOwner(listingId);

    if (!listing) {
      return {
        isValid: false,
        reason: 'listing_not_found',
        checkedAt: new Date()
      };
    }

    // ENSv2 names: the registry decides (token ID, transfer roles, approval)
    if (listing.ens_version === 2) {
      return await validateEnsV2Listing(listing);
    }

    // 2. Check if seller still owns the name (database check)
    const dbOwnerMatches = listing.current_owner?.toLowerCase() === listing.seller_address.toLowerCase();

    if (!dbOwnerMatches) {
      // Database shows different owner - listing is unfunded
      return {
        isValid: false,
        reason: 'ownership_lost',
        checkedAt: new Date(),
        details: {
          expectedOwner: listing.seller_address,
          currentOwner: listing.current_owner
        }
      };
    }

    // 3. Random sample: 10% on-chain verification
    const shouldVerifyOnChain = Math.random() < 0.1;

    if (shouldVerifyOnChain && provider) {
      try {
        const onChainOwner = await getENSOwnerFromRPC(listing.token_id);

        if (onChainOwner && onChainOwner.toLowerCase() !== listing.seller_address.toLowerCase()) {
          // On-chain differs - our indexer is behind, mark unfunded
          return {
            isValid: false,
            reason: 'ownership_lost_onchain',
            checkedAt: new Date(),
            details: {
              expectedOwner: listing.seller_address,
              currentOwner: onChainOwner
            }
          };
        }
      } catch (error: any) {
        // Log RPC error but don't fail validation
        console.warn(`On-chain verification failed for listing ${listingId}:`, error.message);
      }
    }

    // 4. All checks passed - listing is valid
    return {
      isValid: true,
      checkedAt: new Date()
    };

  } catch (error: any) {
    // Unexpected error during validation
    console.error(`Error validating listing ${listingId}:`, error);
    throw error; // Let pg-boss retry
  }
}

/**
 * Batch validate multiple listings (for periodic validation)
 */
export async function batchValidateListings(listingIds: number[]): Promise<Map<number, ValidationResult>> {
  const results = new Map<number, ValidationResult>();

  for (const listingId of listingIds) {
    try {
      const result = await validateListingOwnership(listingId);
      results.set(listingId, result);
    } catch (error: any) {
      console.error(`Failed to validate listing ${listingId}:`, error.message);
      results.set(listingId, {
        isValid: false,
        reason: 'validation_error',
        checkedAt: new Date()
      });
    }
  }

  return results;
}
