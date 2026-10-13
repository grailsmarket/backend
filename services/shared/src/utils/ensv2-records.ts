import { createPublicClient, http } from 'viem';
import { viemChain, config } from '../config';
import { getPostgresPool } from '../db/client';
import { fetchTextRecordsOnChain } from './ens-worker';

/**
 * ENSv2 names aren't in the v1 ENS subgraph: new v2 names have no entry, and a migrated
 * name's entry still shows the v1 resolver that migration cleared. Their records are
 * resolved on-chain through the UniversalResolver (viem's chain config) instead.
 */

/** True when the name is indexed as an ENSv2 name (ens_names.ens_version = 2). */
export async function isEnsV2Name(name: string): Promise<boolean> {
  if (!config.blockchain.ensv2) return false;
  const result = await getPostgresPool().query(
    'SELECT 1 FROM ens_names WHERE name = $1 AND ens_version = 2 LIMIT 1',
    [name]
  );
  return result.rows.length > 0;
}

export interface OnChainNameRecords {
  resolverAddress: string | null;
  textRecords: Record<string, string>;
  // Same shape as the subgraph's multicoinAddrChangeds, for processAddressRecords()
  addressRecords: Array<{ coinType: string; addr: string }>;
}

/**
 * Resolve a name's resolver, common text records and ETH address on-chain.
 * Text keys can't be enumerated on-chain, so only the common keys are read.
 */
export async function fetchNameRecordsOnChain(name: string): Promise<OnChainNameRecords> {
  const client = createPublicClient({
    chain: viemChain,
    transport: http(config.blockchain.rpcUrl),
  });

  const [resolver, textRecords, ethAddress] = await Promise.all([
    client.getEnsResolver({ name }).catch(() => null),
    fetchTextRecordsOnChain(name),
    client.getEnsAddress({ name }).catch(() => null),
  ]);

  return {
    resolverAddress: resolver ? resolver.toLowerCase() : null,
    textRecords,
    addressRecords: ethAddress ? [{ coinType: '60', addr: ethAddress.toLowerCase() }] : [],
  };
}
