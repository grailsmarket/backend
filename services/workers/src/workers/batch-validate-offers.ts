/**
 * Batch Offer Validation Worker
 *
 * Validates multiple offers efficiently using Multicall3 contract.
 * Groups offers by currency type and batches RPC calls.
 */

import { getPostgresPool } from '../../../shared/src';
import { ethers } from 'ethers';
import {
  ValidationResult,
  OfferWithBalance,
  Currency,
  ZERO_ADDRESS,
  WETH_ADDRESS,
  USDC_ADDRESS,
  MULTICALL3_ADDRESS
} from './types';

const pool = getPostgresPool();

// Initialize provider (will be set by environment)
let provider: ethers.Provider | null = null;

export function initializeProvider(rpcUrl: string) {
  provider = new ethers.JsonRpcProvider(rpcUrl);
}

// Multicall3 ABI (minimal)
const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) returns (tuple(bool success, bytes returnData)[] returnData)'
];

// ERC20 balanceOf selector
const BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)

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
 * Fetch offers from database
 */
async function fetchOffers(offerIds: number[]): Promise<OfferWithBalance[]> {
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
    WHERE o.id = ANY($1)
  `, [offerIds]);

  return result.rows;
}

/**
 * Encode balanceOf(address) call data
 */
function encodeBalanceOf(address: string): string {
  return BALANCE_OF_SELECTOR + address.slice(2).padStart(64, '0');
}

/**
 * Decode balance from return data
 */
function decodeBalance(returnData: string): bigint {
  try {
    return BigInt(returnData);
  } catch {
    return 0n;
  }
}

/**
 * Validate balance result
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

/**
 * Batch validate ETH balances using Multicall3
 */
async function batchValidateETHOffers(offers: OfferWithBalance[]): Promise<Map<number, ValidationResult>> {
  if (!provider) {
    throw new Error('Provider not initialized. Call initializeProvider() first.');
  }

  const results = new Map<number, ValidationResult>();

  if (offers.length === 0) {
    return results;
  }

  try {
    const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

    // Build calls - for ETH balance, we can use getEthBalance from Multicall3
    // But for simplicity, we'll just call each address with empty calldata
    const calls = offers.map(offer => ({
      target: offer.buyer_address,
      allowFailure: true,
      callData: '0x'
    }));

    // Execute multicall
    const responses = await multicall.aggregate3.staticCall(calls);

    // Process results
    offers.forEach((offer, index) => {
      let balance = 0n;

      if (responses[index].success) {
        // For ETH balance check via multicall, we actually need to use provider.getBalance
        // Multicall3 doesn't directly return ETH balance, so we'll fall back to individual calls
        // This is a limitation - for now, mark as needing individual validation
        results.set(offer.id, {
          isValid: false,
          reason: 'needs_individual_validation',
          checkedAt: new Date()
        });
      } else {
        results.set(offer.id, {
          isValid: false,
          reason: 'balance_check_failed',
          checkedAt: new Date()
        });
      }
    });

    // Actually, let's do individual ETH balance checks since multicall doesn't help here
    for (const offer of offers) {
      const balance = await provider.getBalance(offer.buyer_address);
      results.set(offer.id, validateBalanceResult(balance, offer.price_wei, 'ETH'));
    }

  } catch (error: any) {
    console.error('Error in batch ETH validation:', error);
    // Mark all as needing retry
    offers.forEach(offer => {
      results.set(offer.id, {
        isValid: false,
        reason: 'batch_validation_error',
        checkedAt: new Date()
      });
    });
  }

  return results;
}

/**
 * Batch validate ERC20 token balances using Multicall3
 */
async function batchValidateTokenOffers(
  tokenAddress: string,
  offers: OfferWithBalance[],
  currency: Currency
): Promise<Map<number, ValidationResult>> {
  if (!provider) {
    throw new Error('Provider not initialized. Call initializeProvider() first.');
  }

  const results = new Map<number, ValidationResult>();

  if (offers.length === 0) {
    return results;
  }

  try {
    const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

    // Build balanceOf calls for each buyer address
    const calls = offers.map(offer => ({
      target: tokenAddress,
      allowFailure: true,
      callData: encodeBalanceOf(offer.buyer_address)
    }));

    // Execute multicall
    const responses = await multicall.aggregate3.staticCall(calls);

    // Process results
    offers.forEach((offer, index) => {
      if (responses[index].success) {
        const balance = decodeBalance(responses[index].returnData);
        results.set(offer.id, validateBalanceResult(balance, offer.price_wei, currency));
      } else {
        results.set(offer.id, {
          isValid: false,
          reason: 'balance_check_failed',
          checkedAt: new Date()
        });
      }
    });

  } catch (error: any) {
    console.error(`Error in batch ${currency} validation:`, error);
    // Mark all as needing retry
    offers.forEach(offer => {
      results.set(offer.id, {
        isValid: false,
        reason: 'batch_validation_error',
        checkedAt: new Date()
      });
    });
  }

  return results;
}

/**
 * Batch validate offers - main entry point
 */
export async function batchValidateOffers(offerIds: number[]): Promise<Map<number, ValidationResult>> {
  try {
    // Fetch all offers
    const offers = await fetchOffers(offerIds);

    // Group by currency
    const ethOffers = offers.filter(o => determineCurrency(o.currency_address) === 'ETH');
    const wethOffers = offers.filter(o => determineCurrency(o.currency_address) === 'WETH');
    const usdcOffers = offers.filter(o => determineCurrency(o.currency_address) === 'USDC');
    const unknownOffers = offers.filter(o => determineCurrency(o.currency_address) === 'UNKNOWN');

    const results = new Map<number, ValidationResult>();

    // Validate ETH offers
    if (ethOffers.length > 0) {
      const ethResults = await batchValidateETHOffers(ethOffers);
      ethResults.forEach((result, offerId) => results.set(offerId, result));
    }

    // Validate WETH offers
    if (wethOffers.length > 0) {
      const wethResults = await batchValidateTokenOffers(WETH_ADDRESS, wethOffers, 'WETH');
      wethResults.forEach((result, offerId) => results.set(offerId, result));
    }

    // Validate USDC offers
    if (usdcOffers.length > 0) {
      const usdcResults = await batchValidateTokenOffers(USDC_ADDRESS, usdcOffers, 'USDC');
      usdcResults.forEach((result, offerId) => results.set(offerId, result));
    }

    // Mark unknown currency offers as invalid
    unknownOffers.forEach(offer => {
      results.set(offer.id, {
        isValid: false,
        reason: 'unsupported_currency',
        checkedAt: new Date()
      });
    });

    return results;

  } catch (error: any) {
    console.error('Error in batch offer validation:', error);
    throw error;
  }
}
