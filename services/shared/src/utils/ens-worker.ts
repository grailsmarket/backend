import { createPublicClient, http } from 'viem';
import { mainnet } from 'viem/chains';
import { config } from '../config';

// Common text record keys to try when The Graph keys aren't available
const COMMON_TEXT_KEYS = [
  'avatar', 'description', 'display', 'email', 'keywords', 'mail',
  'notice', 'location', 'phone', 'url', 'name', 'header',
  'com.github', 'com.twitter', 'org.telegram', 'com.discord',
  'com.reddit', 'com.linkedin', 'io.keybase', 'xyz.farcaster',
];

const BAD_RESOLVER = '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41';

/**
 * Determine if we need to fall back to the ENS worker for text records.
 *
 * Returns true when either:
 * 1. The resolver is the known Public Resolver v2 that only emits keys to The Graph
 * 2. The Graph returned text keys (`texts` array) but ALL `textChangeds` values are null/empty
 */
export function needsEnsWorkerFallback(
  resolverAddress: string | null | undefined,
  texts: string[] | null | undefined,
  textChangeds: Array<{ key: string; value: string | null }> | null | undefined,
): boolean {
  // Check for the known bad resolver
  if (resolverAddress && resolverAddress.toLowerCase() === BAD_RESOLVER) {
    return true;
  }

  // Generic detection: texts array has entries but all textChangeds values are empty
  if (texts && texts.length > 0) {
    if (!textChangeds || textChangeds.length === 0) {
      return true;
    }
    const hasAnyValue = textChangeds.some(
      (r) => r.value != null && r.value !== '',
    );
    if (!hasAnyValue) {
      return true;
    }
  }

  return false;
}

/**
 * Fetch text records for an ENS name from the ENS worker (on-chain resolution).
 *
 * Returns a flat Record<string, string> of text record key/value pairs.
 */
export async function fetchTextRecordsFromEnsWorker(
  name: string,
): Promise<Record<string, string>> {
  const url = `${config.theGraph.ensWorkerUrl}/u/${name}`;

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  });

  if (!response.ok) {
    throw new Error(
      `ENS worker request failed for ${name}: ${response.status} ${response.statusText}`,
    );
  }

  const json: any = await response.json();

  const records: Record<string, string> = {};
  if (json.records && typeof json.records === 'object') {
    for (const [key, value] of Object.entries(json.records)) {
      if (value != null && value !== '') {
        records[key] = value as string;
      }
    }
  }

  return records;
}

/**
 * Fetch text records directly from chain using viem's getEnsText().
 * Used as a secondary fallback when the ENS worker is unavailable.
 *
 * @param name - Full ENS name (e.g., "siwe.eth")
 * @param textKeys - Array of text record keys to resolve. Falls back to common keys if empty.
 * @returns A flat Record<string, string> of text record key/value pairs.
 */
export async function fetchTextRecordsOnChain(
  name: string,
  textKeys?: string[],
): Promise<Record<string, string>> {
  const keys = textKeys && textKeys.length > 0 ? textKeys : COMMON_TEXT_KEYS;

  const client = createPublicClient({
    chain: mainnet,
    transport: http(config.blockchain.rpcUrl),
  });

  const records: Record<string, string> = {};

  const results = await Promise.allSettled(
    keys.map(async (key) => {
      const value = await client.getEnsText({
        name,
        key,
      });
      return { key, value };
    }),
  );

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value.value) {
      records[result.value.key] = result.value.value;
    }
  }

  return records;
}
