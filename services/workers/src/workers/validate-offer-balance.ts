/**
 * Offer Balance Validation Worker
 *
 * Validates that the buyer of an offer has sufficient balance to complete the offer.
 * Supports ETH (native), WETH, and USDC.
 */

import { getPostgresPool } from '../../../shared/src';
import { ethers } from 'ethers';
import {
  ValidationResult,
  OfferWithBalance,
  Currency,
  ZERO_ADDRESS,
  WETH_ADDRESS,
  USDC_ADDRESS
} from './types';

const pool = getPostgresPool();

// Initialize provider (will be set by environment)
let provider: ethers.Provider | null = null;

export function initializeProvider(rpcUrl: string) {
  provider = new ethers.JsonRpcProvider(rpcUrl);
}

/**
 * Fetch offer from database
 */
async function fetchOffer(offerId: number): Promise<OfferWithBalance | null> {
  const result = await pool.query(`
    SELECT
      o.id,
      o.buyer_address,
      o.price_wei,
      o.currency_address,
      o.status,
      o.ens_name_id,
      en.name
    FROM offers o
    JOIN ens_names en ON en.id = o.ens_name_id
    WHERE o.id = $1
  `, [offerId]);

  if (result.rows.length === 0) {
    return null;
  }

  return result.rows[0];
}

/**
 * Determine currency type from address
 */
function determineCurrency(currencyAddress: string | null): Currency {
  if (!currencyAddress || currencyAddress === ZERO_ADDRESS) {
    return 'ETH';
  }

  const addr = currencyAddress.toLowerCase();

  if (addr === WETH_ADDRESS.toLowerCase()) {
    return 'WETH';
  }

  if (addr === USDC_ADDRESS.toLowerCase()) {
    return 'USDC';
  }

  return 'UNKNOWN';
}

/**
 * Get ERC20 token balance
 */
async function getTokenBalance(tokenAddress: string, holderAddress: string): Promise<bigint> {
  if (!provider) {
    throw new Error('Provider not initialized. Call initializeProvider() first.');
  }

  const tokenContract = new ethers.Contract(
    tokenAddress,
    ['function balanceOf(address) view returns (uint256)'],
    provider
  );

  return await tokenContract.balanceOf(holderAddress);
}

/**
 * Validate offer balance
 */
export async function validateOfferBalance(offerId: number): Promise<ValidationResult> {
  try {
    // 1. Fetch offer details
    const offer = await fetchOffer(offerId);

    if (!offer) {
      return {
        isValid: false,
        reason: 'offer_not_found',
        checkedAt: new Date()
      };
    }

    if (!provider) {
      throw new Error('Provider not initialized. Call initializeProvider() first.');
    }

    // 2. Determine currency type
    const currency = determineCurrency(offer.currency_address);

    if (currency === 'UNKNOWN') {
      return {
        isValid: false,
        reason: 'unsupported_currency',
        checkedAt: new Date()
      };
    }

    // 3. Check balance based on currency
    let balance: bigint;

    if (currency === 'ETH') {
      balance = await provider.getBalance(offer.buyer_address);
    } else {
      // WETH or USDC
      balance = await getTokenBalance(offer.currency_address, offer.buyer_address);
    }

    // 4. Compare balance to required amount
    const required = BigInt(offer.price_wei);

    if (balance < required) {
      return {
        isValid: false,
        reason: `insufficient_${currency.toLowerCase()}`,
        checkedAt: new Date(),
        details: {
          currentBalance: balance.toString(),
          requiredBalance: required.toString(),
          currency
        }
      };
    }

    // 5. All checks passed - offer is funded
    return {
      isValid: true,
      checkedAt: new Date()
    };

  } catch (error: any) {
    // Unexpected error during validation
    console.error(`Error validating offer ${offerId}:`, error);
    throw error; // Let pg-boss retry
  }
}

/**
 * Validate balance result helper
 */
function validateBalanceResult(balance: bigint, priceWei: string, currency: Currency): ValidationResult {
  const required = BigInt(priceWei);

  if (balance < required) {
    return {
      isValid: false,
      reason: `insufficient_${currency.toLowerCase()}`,
      checkedAt: new Date(),
      details: {
        currentBalance: balance.toString(),
        requiredBalance: required.toString(),
        currency
      }
    };
  }

  return {
    isValid: true,
    checkedAt: new Date()
  };
}
