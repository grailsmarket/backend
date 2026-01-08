/**
 * ENS Name Normalization Utility
 *
 * Provides functions to normalize ENS names according to ENSIP-15 specification.
 * Uses @adraffy/ens-normalize (via viem) for standards-compliant normalization.
 *
 * @see https://docs.ens.domains/ensip/15
 * @see https://github.com/adraffy/ens-normalize.js
 */

import { normalize } from 'viem/ens';

export interface NormalizationResult {
  /** The normalized name, or null if invalid or placeholder */
  normalized: string | null;
  /** Whether the name is valid per ENSIP-15 */
  isValid: boolean;
  /** Whether the name was already in normalized form */
  wasAlreadyNormalized: boolean;
  /** Whether this is a placeholder name (not a real ENS name) */
  isPlaceholder: boolean;
  /** Error message if invalid */
  error?: string;
  /** The original input name */
  original: string;
}

// Placeholder patterns:
// - "token-{numbers}" (e.g., "token-12345")
// - "#{numbers}" (e.g., "#12345")
// - "[{hex}].eth" (e.g., "[38a60d7949033bbeb5421f5e4b4e6d9da0c47ecab38dffc5d13a852a2ad2ae89].eth")
const PLACEHOLDER_REGEX = /^(token-\d+|#\d+|\[[0-9a-fA-F]{64}\]\.eth)$/;

/**
 * Check if a name is a placeholder (not a real ENS name yet)
 *
 * Placeholders are used when we have a token_id but haven't resolved
 * the actual name from The Graph yet. Format: "token-123" or "#123"
 */
export function isPlaceholderName(name: string): boolean {
  return PLACEHOLDER_REGEX.test(name);
}

/**
 * Normalize an ENS name and return detailed result
 *
 * @example
 * normalizeEnsName('Vitalik.eth')
 * // { normalized: 'vitalik.eth', isValid: true, wasAlreadyNormalized: false, ... }
 *
 * normalizeEnsName('vitalik.eth')
 * // { normalized: 'vitalik.eth', isValid: true, wasAlreadyNormalized: true, ... }
 *
 * normalizeEnsName('token-123')
 * // { normalized: null, isValid: false, isPlaceholder: true, ... }
 */
export function normalizeEnsName(name: string): NormalizationResult {
  const isPlaceholder = isPlaceholderName(name);

  if (isPlaceholder) {
    return {
      normalized: null,
      isValid: false,
      wasAlreadyNormalized: false,
      isPlaceholder: true,
      original: name,
    };
  }

  try {
    const normalized = normalize(name);
    return {
      normalized,
      isValid: true,
      wasAlreadyNormalized: normalized === name,
      isPlaceholder: false,
      original: name,
    };
  } catch (error: any) {
    return {
      normalized: null,
      isValid: false,
      wasAlreadyNormalized: false,
      isPlaceholder: false,
      error: error.message || 'Unknown normalization error',
      original: name,
    };
  }
}

/**
 * Normalize an ENS name, returning the normalized form or original if invalid/placeholder
 *
 * Use this when you need a name value regardless of validity.
 */
export function safeNormalize(name: string): string {
  if (isPlaceholderName(name)) {
    return name;
  }

  try {
    return normalize(name);
  } catch {
    return name;
  }
}
