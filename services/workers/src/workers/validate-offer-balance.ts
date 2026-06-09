/**
 * Offer Balance Validation Worker
 *
 * Validates that the buyer of an offer has sufficient balance to complete the offer.
 * Supports ETH (native), WETH, and USDC.
 */

import { getPostgresPool } from '../../../shared/src';
import { ethers } from 'ethers';
import {
  type ValidationResult,
  type OfferWithBalance,
  type Currency,
  ZERO_ADDRESS,
  WETH_ADDRESS,
  USDC_ADDRESS,
  OPENSEA_CONDUIT_ADDRESS,
  MARKETPLACE_CONDUIT_ADDRESS,
  SEAPORT_ADDRESS
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
      o.offer_amount_wei,
      o.currency_address,
      o.status,
      o.ens_name_id,
      o.source,
      o.order_data,
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
 * Get ERC20 token allowance
 */
async function getTokenAllowance(tokenAddress: string, owner: string, spender: string): Promise<bigint> {
  if (!provider) {
    throw new Error('Provider not initialized. Call initializeProvider() first.');
  }

  const tokenContract = new ethers.Contract(
    tokenAddress,
    ['function allowance(address owner, address spender) view returns (uint256)'],
    provider
  );

  return await tokenContract.allowance(owner, spender);
}

/**
 * Get the appropriate conduit address based on offer source
 */
function getConduitAddress(source: string | undefined): string {
  if (source === 'opensea') {
    return OPENSEA_CONDUIT_ADDRESS;
  }
  // Default for 'grails' and other sources
  return MARKETPLACE_CONDUIT_ADDRESS;
}

/**
 * Resolve the address the WETH/USDC approval must target for this offer.
 *
 * Seaport orders carry a `conduitKey`: a zero key means tokens move through the
 * Seaport contract directly, so the approval must be set to Seaport itself (this
 * is how ENS Vision offers are signed). A non-zero key means a conduit is used,
 * which we map by source. Reading the key from the signed order keeps validation
 * correct for any marketplace rather than assuming a per-source conduit.
 */
function getSpenderAddress(offer: OfferWithBalance): string {
  const conduitKey: unknown = (offer as any).order_data?.parameters?.conduitKey;
  if (typeof conduitKey === 'string' && /^0x0+$/i.test(conduitKey)) {
    return SEAPORT_ADDRESS;
  }
  return getConduitAddress(offer.source);
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
    const required = BigInt(offer.offer_amount_wei);

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

    // 5. Check allowance for ERC20 tokens (WETH, USDC)
    if (currency !== 'ETH') {
      const conduitAddress = getSpenderAddress(offer);
      const allowance = await getTokenAllowance(
        offer.currency_address,
        offer.buyer_address,
        conduitAddress
      );

      if (allowance < required) {
        return {
          isValid: false,
          reason: `insufficient_${currency.toLowerCase()}_allowance`,
          checkedAt: new Date(),
          details: {
            currentAllowance: allowance.toString(),
            requiredAllowance: required.toString(),
            currency
          }
        };
      }
    }

    // 6. All checks passed - offer is funded
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
