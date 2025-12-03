/**
 * Listing Ownership Validation Worker
 *
 * Validates that the seller of a listing still owns the ENS name.
 * Uses database as primary source, with 10% on-chain verification for accuracy.
 */

import { getPostgresPool } from '../../../shared/src';
import { ethers } from 'ethers';
import {
  ValidationResult,
  ListingWithOwner,
  ENS_REGISTRAR_ADDRESS
} from './types';

const pool = getPostgresPool();

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
 * Get ENS owner from on-chain (ENS Registrar contract)
 */
async function getENSOwnerFromRPC(tokenId: string): Promise<string | null> {
  if (!provider) {
    throw new Error('Provider not initialized. Call initializeProvider() first.');
  }

  try {
    const registrar = new ethers.Contract(
      ENS_REGISTRAR_ADDRESS,
      ['function ownerOf(uint256 tokenId) view returns (address)'],
      provider
    );

    const owner = await registrar.ownerOf(tokenId);
    return owner;
  } catch (error: any) {
    // Token might not exist or contract error
    console.error(`Error fetching on-chain owner for token ${tokenId}:`, error.message);
    return null;
  }
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
