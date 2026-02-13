import { decode, getCodec } from '@ensdomains/content-hash';

export interface ContenthashRecord {
  protocol: string;  // 'ipfs', 'ipns', 'swarm', 'onion', 'onion3', 'skynet', 'arweave'
  value: string;     // Decoded value (e.g., IPFS CID)
  raw?: string;      // Optional: raw hex bytes
}

/**
 * Decode raw contenthash bytes from the ENS subgraph into a structured format.
 *
 * @param rawBytes - The raw contenthash bytes as hex string (e.g., "0xe3010170...")
 * @returns ContenthashRecord or null if decoding fails or value is empty
 */
export function decodeContenthash(rawBytes: string | null | undefined): ContenthashRecord | null {
  try {
    // Skip if contenthash is empty/null
    if (!rawBytes || rawBytes === '0x' || rawBytes === '0x0' || rawBytes === '0x00') {
      return null;
    }

    // Remove 0x prefix if present
    const hexWithoutPrefix = rawBytes.startsWith('0x') ? rawBytes.slice(2) : rawBytes;
    if (hexWithoutPrefix.length === 0) {
      return null;
    }

    // Decode the contenthash
    const decoded = decode(rawBytes);
    const codec = getCodec(rawBytes);

    if (!decoded || !codec) {
      return null;
    }

    return {
      protocol: codec,
      value: decoded,
      raw: rawBytes,
    };
  } catch (error) {
    // Silently fail for decode errors - this is expected for unsupported formats
    return null;
  }
}

/**
 * Process contenthash changes from the ENS subgraph contenthashChangeds field.
 * Returns the latest non-null contenthash, or null if the most recent change unset it.
 *
 * @param contenthashChangeds - Array of { hash } from the subgraph (historical changes in order)
 * @param fallbackContentHash - Direct contentHash field from resolver (used if no changes array)
 * @returns ContenthashRecord or null
 */
export function processContenthash(
  contenthashChangeds: Array<{ hash: string }> | null | undefined,
  fallbackContentHash: string | null | undefined
): ContenthashRecord | null {
  // If we have historical changes, process them to get the latest value
  if (contenthashChangeds && Array.isArray(contenthashChangeds) && contenthashChangeds.length > 0) {
    // Get the last change (most recent)
    const lastChange = contenthashChangeds[contenthashChangeds.length - 1];

    // If the last change unset the contenthash, return null
    if (!lastChange.hash || lastChange.hash === '0x' || lastChange.hash === '0x0' || lastChange.hash === '0x00') {
      return null;
    }

    return decodeContenthash(lastChange.hash);
  }

  // Fall back to direct contentHash field if no changes array
  return decodeContenthash(fallbackContentHash);
}
