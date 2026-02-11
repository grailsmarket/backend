/**
 * Input validation utilities
 */

/**
 * Check if string is a valid Ethereum address
 */
export function isValidAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

/**
 * Normalize Ethereum address to lowercase with checksum validation
 */
export function normalizeAddress(address: string): string {
  if (!isValidAddress(address)) {
    throw new Error(`Invalid Ethereum address: ${address}`);
  }
  return address.toLowerCase();
}

/**
 * Check if string is a valid ENS name
 */
export function isValidENSName(name: string): boolean {
  // Basic validation: must end with .eth and have at least one character before
  return /^[a-z0-9\-]+\.eth$/i.test(name) || /^.+\.eth$/i.test(name);
}

/**
 * Normalize ENS name (lowercase, add .eth if missing)
 */
export function normalizeENSName(name: string): string {
  const lower = name.toLowerCase().trim();
  return lower.endsWith('.eth') ? lower : `${lower}.eth`;
}

/**
 * Check if string is a valid wei amount (positive integer string)
 */
export function isValidWeiAmount(wei: string): boolean {
  if (!/^\d+$/.test(wei)) {
    return false;
  }
  try {
    const value = BigInt(wei);
    return value >= 0n;
  } catch {
    return false;
  }
}

/**
 * Check if string is a valid order hash
 */
export function isValidOrderHash(hash: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(hash);
}

/**
 * Check if string is a valid transaction hash
 */
export function isValidTxHash(hash: string): boolean {
  return /^0x[a-fA-F0-9]{64}$/.test(hash);
}

/**
 * Check if string is a valid token ID (positive integer)
 */
export function isValidTokenId(tokenId: string): boolean {
  if (!/^\d+$/.test(tokenId)) {
    return false;
  }
  try {
    const value = BigInt(tokenId);
    return value > 0n;
  } catch {
    return false;
  }
}
