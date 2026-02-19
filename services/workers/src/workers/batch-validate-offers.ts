/**
 * Batch Offer Validation Worker
 *
 * Validates multiple offers efficiently using Multicall3 contract.
 * Groups offers by currency type and batches RPC calls.
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
  MULTICALL3_ADDRESS,
  OPENSEA_CONDUIT_ADDRESS,
  MARKETPLACE_CONDUIT_ADDRESS
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

// ERC20 function selectors
const BALANCE_OF_SELECTOR = '0x70a08231'; // balanceOf(address)
const ALLOWANCE_SELECTOR = '0xdd62ed3e'; // allowance(address,address)

// Max offers per multicall batch to avoid RPC payload limits (each offer = 2 calls)
const MULTICALL_BATCH_SIZE = 200;

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
      o.offer_amount_wei,
      o.currency_address,
      o.status,
      o.ens_name_id,
      o.source,
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
 * Encode allowance(owner, spender) call data
 */
function encodeAllowance(owner: string, spender: string): string {
  return ALLOWANCE_SELECTOR + owner.slice(2).padStart(64, '0') + spender.slice(2).padStart(64, '0');
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
 * Batch validate ETH balances using individual getBalance calls.
 * Processes in chunks to avoid overwhelming the RPC provider.
 */
async function batchValidateETHOffers(offers: OfferWithBalance[]): Promise<Map<number, ValidationResult>> {
  if (!provider) {
    throw new Error('Provider not initialized. Call initializeProvider() first.');
  }

  const results = new Map<number, ValidationResult>();

  if (offers.length === 0) {
    return results;
  }

  for (let i = 0; i < offers.length; i += MULTICALL_BATCH_SIZE) {
    const chunk = offers.slice(i, i + MULTICALL_BATCH_SIZE);

    try {
      for (const offer of chunk) {
        const balance = await provider.getBalance(offer.buyer_address);
        results.set(offer.id, validateBalanceResult(balance, offer.offer_amount_wei, 'ETH'));
      }
    } catch (error: any) {
      console.error(`Error in batch ETH validation (chunk ${i / MULTICALL_BATCH_SIZE + 1}):`, error);
      chunk.forEach(offer => {
        if (!results.has(offer.id)) {
          results.set(offer.id, {
            isValid: false,
            reason: 'batch_validation_error',
            checkedAt: new Date()
          });
        }
      });
    }
  }

  return results;
}

/**
 * Batch validate ERC20 token balances and allowances using Multicall3.
 * Chunks offers into batches to avoid 413 Payload Too Large errors from RPC providers.
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

  const multicall = new ethers.Contract(MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);

  // Process in chunks to stay under RPC payload limits
  for (let i = 0; i < offers.length; i += MULTICALL_BATCH_SIZE) {
    const chunk = offers.slice(i, i + MULTICALL_BATCH_SIZE);

    try {
      // Build paired calls: [balanceOf, allowance, balanceOf, allowance, ...]
      const calls = chunk.flatMap(offer => {
        const conduitAddress = getConduitAddress(offer.source);
        return [
          {
            target: tokenAddress,
            allowFailure: true,
            callData: encodeBalanceOf(offer.buyer_address)
          },
          {
            target: tokenAddress,
            allowFailure: true,
            callData: encodeAllowance(offer.buyer_address, conduitAddress)
          }
        ];
      });

      // Execute multicall
      const responses = await multicall.aggregate3.staticCall(calls);

      // Process results in pairs
      chunk.forEach((offer, index) => {
        const balanceResult = responses[index * 2];
        const allowanceResult = responses[index * 2 + 1];
        const required = BigInt(offer.offer_amount_wei);

        // Check balance first
        if (!balanceResult.success) {
          results.set(offer.id, {
            isValid: false,
            reason: 'balance_check_failed',
            checkedAt: new Date()
          });
          return;
        }

        const balance = decodeBalance(balanceResult.returnData);
        if (balance < required) {
          results.set(offer.id, {
            isValid: false,
            reason: `insufficient_${currency.toLowerCase()}`,
            checkedAt: new Date(),
            details: {
              currentBalance: balance.toString(),
              requiredBalance: required.toString(),
              currency
            }
          });
          return;
        }

        // Check allowance
        if (!allowanceResult.success) {
          results.set(offer.id, {
            isValid: false,
            reason: 'allowance_check_failed',
            checkedAt: new Date()
          });
          return;
        }

        const allowance = decodeBalance(allowanceResult.returnData);
        if (allowance < required) {
          results.set(offer.id, {
            isValid: false,
            reason: `insufficient_${currency.toLowerCase()}_allowance`,
            checkedAt: new Date(),
            details: {
              currentAllowance: allowance.toString(),
              requiredAllowance: required.toString(),
              currency
            }
          });
          return;
        }

        // Both balance and allowance are sufficient
        results.set(offer.id, {
          isValid: true,
          checkedAt: new Date()
        });
      });

    } catch (error: any) {
      console.error(`Error in batch ${currency} validation (chunk ${i / MULTICALL_BATCH_SIZE + 1}):`, error);
      // Mark this chunk as needing retry
      chunk.forEach(offer => {
        results.set(offer.id, {
          isValid: false,
          reason: 'batch_validation_error',
          checkedAt: new Date()
        });
      });
    }
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
