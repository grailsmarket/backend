import { createPublicClient, http } from 'viem';
import { coinNameToTypeMap } from '@ensdomains/address-encoder';
import { viemChain, config } from '../config';
import { addressRecordFromEncoded, type AddressRecord } from './address-decoder';
import { contenthashFromUri, type ContenthashRecord } from './contenthash-decoder';
import { getExpiryPhase } from './expiry-phase';

// Common text record keys to try when The Graph keys aren't available
const COMMON_TEXT_KEYS = [
  'avatar', 'description', 'display', 'email', 'keywords', 'mail',
  'notice', 'location', 'phone', 'url', 'name', 'header',
  'com.github', 'com.twitter', 'org.telegram', 'com.discord',
  'com.reddit', 'com.linkedin', 'io.keybase', 'xyz.farcaster',
];

const BAD_RESOLVER = config.blockchain.legacyPublicResolverAddress?.toLowerCase() ?? null;

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
  // No ENS worker for this network
  if (!config.ensWorker.url) {
    return false;
  }

  // Check for the known bad resolver
  if (BAD_RESOLVER && resolverAddress && resolverAddress.toLowerCase() === BAD_RESOLVER) {
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
  const url = `${config.ensWorker.url}/u/${encodeURIComponent(name)}`;

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

/** Text, address and contenthash records in the shape stored in ens_names.metadata. */
export interface NameRecords {
  [key: string]: string | AddressRecord[] | ContenthashRecord | undefined;
  chains?: AddressRecord[];
  contenthash?: ContenthashRecord;
}

export type WorkerRecordsResult =
  | { found: true; records: NameRecords; resolverAddress: string | null }
  // The UniversalResolver found no resolver: the name is unregistered, expired (ENSv2
  // registries hide the resolver from the moment a name expires, grace period included)
  // or has no resolver set.
  | { found: false };

const SLIP44_MSB = 0x80000000;
const coinType = (name: string): number => {
  const t = (coinNameToTypeMap as Record<string, number>)[name];
  if (t === undefined) throw new Error(`unknown coin name ${name}`);
  return t;
};
const evmCoinType = (chainId: number): number => (SLIP44_MSB | chainId) >>> 0;

/**
 * Keys of the worker's `chains` map -> coin type. Mirrors COIN_DISPLAY_NAMES in
 * ensv2-records/src/records.ts. Coin types without a display name come back as the
 * number itself (handled in parseWorkerChains).
 */
const WORKER_CHAIN_COIN_TYPES: Record<string, number> = {
  eth: coinType('eth'),
  btc: coinType('btc'),
  ltc: coinType('ltc'),
  doge: coinType('doge'),
  bch: coinType('bch'),
  etc: coinType('etc'),
  xmr: coinType('xmr'),
  ripple: coinType('xrp'),
  stellar: coinType('xlm'),
  tezos: coinType('xtz'),
  hedera: coinType('hbar'),
  cardano: coinType('ada'),
  mona: coinType('mona'),
  rootstock: coinType('rbtc'),
  bnb: coinType('bnb'),
  sol: coinType('sol'),
  dot: coinType('dot'),
  optimism: evmCoinType(10),
  bsc: evmCoinType(56),
  gnosis: evmCoinType(100),
  polygon: evmCoinType(137),
  fantom: evmCoinType(250),
  zksync: evmCoinType(324),
  moonbeam: evmCoinType(1284),
  base: evmCoinType(8453),
  arbitrum: evmCoinType(42161),
  celo: evmCoinType(42220),
  avalanche: evmCoinType(43114),
  linea: evmCoinType(59144),
  scroll: evmCoinType(534352),
};

/** Convert the worker's `chains` map ({eth: "0x…", btc: "bc1…"}) to AddressRecords. */
export function parseWorkerChains(chains: unknown): AddressRecord[] {
  if (!chains || typeof chains !== 'object') return [];
  const records: AddressRecord[] = [];
  for (const [key, address] of Object.entries(chains as Record<string, unknown>)) {
    if (typeof address !== 'string' || address === '') continue;
    const type = WORKER_CHAIN_COIN_TYPES[key] ?? (/^\d+$/.test(key) ? Number(key) : undefined);
    if (type === undefined) continue;
    const record = addressRecordFromEncoded(type, address);
    if (record) records.push(record);
  }
  return records.sort((a, b) => a.coinType - b.coinType);
}

/** Convert a worker profile response to the ens_names.metadata shape. */
export function parseWorkerProfile(json: any): NameRecords {
  const records: NameRecords = {};
  if (json?.records && typeof json.records === 'object') {
    for (const [key, value] of Object.entries(json.records)) {
      if (typeof value === 'string' && value !== '') {
        records[key] = value;
      }
    }
  }
  const chains = parseWorkerChains(json?.chains);
  if (chains.length > 0) {
    records.chains = chains;
  }
  const contenthash = contenthashFromUri(json?.contenthash);
  if (contenthash) {
    records.contenthash = contenthash;
  }
  return records;
}

/**
 * Fetch a name's text, address and contenthash records from the ENS worker, which resolves
 * ENSv1, ENSv2 and offchain names through the UniversalResolver.
 *
 * Returns `{ found: false }` on 404 (no resolver). Throws when the worker isn't configured,
 * is unreachable, or the name's resolver errored (502), so callers can fall back.
 *
 * @param fresh - bypass the worker's profile cache
 */
export async function fetchNameRecordsFromWorker(
  name: string,
  { fresh = false }: { fresh?: boolean } = {},
): Promise<WorkerRecordsResult> {
  if (!config.ensWorker.url) {
    throw new Error('ENS worker is not configured for this network');
  }

  const url = `${config.ensWorker.url}/n/${encodeURIComponent(name)}${fresh ? '?fresh=true' : ''}`;
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });

  if (response.status === 404) {
    return { found: false };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ENS worker request failed for ${name}: ${response.status} ${body.slice(0, 200)}`);
  }

  const json: any = await response.json();
  return {
    found: true,
    records: parseWorkerProfile(json),
    resolverAddress: typeof json.resolver === 'string' ? json.resolver.toLowerCase() : null,
  };
}

/**
 * Whether to keep a name's cached records when the worker finds no resolver for it.
 *
 * ENSv2 registries stop returning a name's resolver as soon as it expires, and an unmigrated
 * v1 name loses it 62 days into its 90-day grace period (when its v2 reservation lapses).
 * The records are still on the resolver and come back if the owner renews, so a name in
 * its grace period keeps its cached records. Otherwise (still registered with no resolver,
 * or past grace) the name has no records.
 */
export function keepCachedRecordsWithoutResolver(
  expiryDate: Date | string | null | undefined,
  ensVersion: number | null | undefined,
): boolean {
  return getExpiryPhase(expiryDate, ensVersion) === 'grace';
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
    chain: viemChain,
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
