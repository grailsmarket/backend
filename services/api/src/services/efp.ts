import { config } from '../../../shared/src';
import { getCachedResponse, setCachedResponse } from '../utils/redis';

/**
 * EFP (Ethereum Follow Protocol) client.
 *
 * Fetches the set of addresses a given account follows on EFP, used to filter
 * the unified feed to "people you follow". Results are cached in Redis (keyed by
 * address) so repeated/paginated feed requests reuse a single fetch.
 *
 * EFP `GET /users/{addressOrENS}/following` returns:
 *   { following: [ { version, record_type, data, address, tags } ] }
 * where `record_type === 'address'` rows carry the followed address in `data`
 * (lowercase) — matching our lowercase `users.address` / `activity_history.actor_address`.
 */

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const PAGE_LIMIT = 1000;

/**
 * Thrown when EFP cannot be reached / returns an error and we have no cached
 * following list to fall back on. The feed route maps this to 502 EFP_UNAVAILABLE
 * so the client can surface "couldn't load your follow filter" rather than
 * silently showing the wrong (unfiltered/empty) data.
 */
export class EfpUnavailableError extends Error {
  constructor(message = 'EFP API unavailable') {
    super(message);
    this.name = 'EfpUnavailableError';
  }
}

interface EfpFollowingRecord {
  record_type?: string;
  data?: string;
  address?: string;
}

function cacheKey(address: string): string {
  return `efp:following:${address}`;
}

/**
 * Fetch a single page of following records from EFP. Throws EfpUnavailableError
 * on timeout, network error, non-2xx response, or unparseable body.
 */
async function fetchFollowingPage(address: string, offset: number): Promise<EfpFollowingRecord[]> {
  const url =
    `${config.efp.apiBaseUrl}/users/${address}/following` +
    `?limit=${PAGE_LIMIT}&offset=${offset}`;
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(config.efp.timeoutMs),
    });
    if (!response.ok) {
      throw new EfpUnavailableError(`EFP following request failed: ${response.status}`);
    }
    const json: any = await response.json();
    return Array.isArray(json?.following) ? json.following : [];
  } catch (error) {
    if (error instanceof EfpUnavailableError) throw error;
    throw new EfpUnavailableError(
      `EFP following request error: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Return the lowercased, deduped set of addresses `address` follows on EFP.
 *
 * - Cache hit returns immediately (no network call) and also serves as a
 *   fallback during brief EFP outages, since cached entries only expire after
 *   `config.efp.followingCacheTtlSeconds`.
 * - An empty array is a valid "follows nobody" answer and is cached (distinct
 *   from an outage, which throws EfpUnavailableError).
 *
 * @throws EfpUnavailableError on cache miss + EFP fetch failure.
 */
export async function getFollowingAddresses(address: string): Promise<string[]> {
  const lower = address.toLowerCase();
  const key = cacheKey(lower);

  const cached = await getCachedResponse(key);
  if (Array.isArray(cached)) {
    return cached as string[];
  }

  const seen = new Set<string>();
  for (let offset = 0; ; offset += PAGE_LIMIT) {
    const page = await fetchFollowingPage(lower, offset);
    for (const rec of page) {
      if (rec.record_type && rec.record_type !== 'address') continue;
      const addr = (rec.data ?? rec.address)?.toLowerCase();
      if (addr && ADDRESS_RE.test(addr)) seen.add(addr);
    }
    if (page.length < PAGE_LIMIT) break;
    if (seen.size >= config.efp.maxFollowing) break;
  }

  const addresses = Array.from(seen);
  await setCachedResponse(key, addresses, config.efp.followingCacheTtlSeconds);
  return addresses;
}
