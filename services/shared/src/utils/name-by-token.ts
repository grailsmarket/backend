import { createPublicClient, hexToBytes, http, isAddress, labelhash, parseAbi, type Hex } from 'viem';
import { viemChain, config } from '../config';
import { getPostgresPool } from '../db/client';
import { findEnsV2NameByTokenId } from './ensv2-orders';

/**
 * Finding a .eth name from (contract, token id), for any of the three ENS NFT contracts:
 * - v1 BaseRegistrar: token id = labelhash
 * - v1 NameWrapper:   token id = namehash
 * - v2 ETHRegistry:   token id = labelhash with its low 32 bits replaced by a version counter
 *
 * ens_names.token_id holds a name's current token: the labelhash (unwrapped v1), the namehash
 * (wrapped v1) or the current v2 token id.
 */

export type TokenContractKind = 'v1-registrar' | 'v1-wrapper' | 'v2-registry';

const MAX_UINT256 = (1n << 256n) - 1n;

const nameWrapperAbi = parseAbi(['function names(bytes32) view returns (bytes)']);

/** A uint256 token id from a path param, decimal or 0x hex; null when invalid. */
export function parseTokenIdParam(raw: string): bigint | null {
  if (!/^(0x[0-9a-fA-F]{1,64}|\d{1,78})$/.test(raw)) return null;
  const id = BigInt(raw);
  return id <= MAX_UINT256 ? id : null;
}

/** Which ENS NFT contract an address is on this network; null for any other contract. */
export function tokenContractKind(contract: string): TokenContractKind | null {
  if (!isAddress(contract, { strict: false })) return null;
  const c = contract.toLowerCase();
  if (c === config.blockchain.ensRegistrarAddress.toLowerCase()) return 'v1-registrar';
  if (c === config.blockchain.ensNameWrapperAddress.toLowerCase()) return 'v1-wrapper';
  if (config.blockchain.ensv2 && c === config.blockchain.ensv2.ethRegistryAddress.toLowerCase()) return 'v2-registry';
  return null;
}

export const toUint256Hex = (id: bigint): Hex => `0x${id.toString(16).padStart(64, '0')}`;

/** The contract and token id a name currently trades as, from its ens_names row. */
export function currentTokenOf(row: { name: string; token_id: string; token_contract: string | null; ens_version: number }): {
  contract: string;
  token_id: string;
} {
  if (row.ens_version === 2 && row.token_contract) return { contract: row.token_contract.toLowerCase(), token_id: row.token_id };
  // v1: unwrapped names hold the labelhash, wrapped names the namehash
  const label = row.name.endsWith('.eth') ? row.name.slice(0, -4) : row.name;
  const unwrapped = row.token_id === BigInt(labelhash(label)).toString();
  return {
    contract: (unwrapped ? config.blockchain.ensRegistrarAddress : config.blockchain.ensNameWrapperAddress).toLowerCase(),
    token_id: row.token_id,
  };
}

/** Decodes a DNS wire-format name (as NameWrapper.names returns it); null when empty or malformed. */
export function dnsDecodeName(wire: Hex): string | null {
  const bytes = hexToBytes(wire);
  const labels: string[] = [];
  let i = 0;
  while (i < bytes.length) {
    const len = bytes[i]!;
    if (len === 0) return labels.length && i === bytes.length - 1 ? labels.join('.') : null;
    const label = bytes.slice(i + 1, i + 1 + len);
    if (label.length !== len) return null;
    labels.push(new TextDecoder().decode(label));
    i += 1 + len;
  }
  return null;
}

export interface EnsV2TokenLabel {
  name: string | null;
  label: string | null;
  labelhash: string | null;
  token_id: string | null;
  status: string;
  current: boolean;
}

/**
 * The label behind an ENSv2 token id, from the ENS worker's registry index. Any version of the
 * token id finds it, and premigration reserved every v1 label, so a v1 labelhash finds its
 * name too. Null when the worker has no such label or no index; throws when it's unreachable.
 */
export async function fetchEnsV2TokenFromWorker(registry: string, tokenId: bigint): Promise<EnsV2TokenLabel | null> {
  if (!config.ensWorker.url) return null;
  const url = `${config.ensWorker.url}/v2/token/${registry.toLowerCase()}/${tokenId.toString()}`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
  if (response.status === 404 || response.status === 501) return null;
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`ENS worker token lookup failed: ${response.status} ${body.slice(0, 200)}`);
  }
  return (await response.json()) as EnsV2TokenLabel;
}

async function nameFromNameWrapper(tokenId: bigint): Promise<string | null> {
  const client = createPublicClient({ chain: viemChain, transport: http(config.blockchain.rpcUrl) });
  const wire = await client.readContract({
    address: config.blockchain.ensNameWrapperAddress as Hex,
    abi: nameWrapperAbi,
    functionName: 'names',
    args: [toUint256Hex(tokenId)],
  });
  return wire && wire !== '0x' ? dnsDecodeName(wire) : null;
}

async function findByName(name: string): Promise<{ id: number; name: string } | null> {
  const result = await getPostgresPool().query('SELECT id, name FROM ens_names WHERE name = $1', [name]);
  return result.rows[0] ?? null;
}

/**
 * The ens_names row for a token on one of the ENS NFT contracts, or null. Tries, in order:
 * the current token id, older v2 token ids, the labelhash of migrated names (v1 BaseRegistrar
 * ids), NameWrapper.names() on chain (NameWrapper ids), then the ENS worker's ETHRegistry index.
 */
export async function findNameByToken(contract: string, tokenId: bigint): Promise<{ id: number; name: string } | null> {
  const kind = tokenContractKind(contract);
  if (!kind) return null;
  const pool = getPostgresPool();
  const dec = tokenId.toString();
  const hex = toUint256Hex(tokenId);

  if (kind === 'v2-registry') {
    const row = await findEnsV2NameByTokenId(dec);
    if (row) return { id: row.id, name: row.name };
  } else {
    const exact = await pool.query('SELECT id, name FROM ens_names WHERE token_id = $1 AND ens_version = 1', [dec]);
    if (exact.rows[0]) return exact.rows[0];
  }

  if (kind === 'v1-registrar') {
    // Migrated to v2: the row now holds the v2 token id, and keeps the labelhash
    const migrated = await pool.query('SELECT id, name FROM ens_names WHERE labelhash = $1 LIMIT 1', [hex]);
    if (migrated.rows[0]) return migrated.rows[0];
  }

  if (kind === 'v1-wrapper') {
    const name = await nameFromNameWrapper(tokenId);
    return name ? findByName(name) : null;
  }

  const registry = config.blockchain.ensv2?.ethRegistryAddress;
  if (!registry) return null;
  const label = await fetchEnsV2TokenFromWorker(registry, tokenId);
  // A v1 labelhash must match in full, not just in the bits the v2 lookup keys on
  if (!label?.name || (kind === 'v1-registrar' && label.labelhash?.toLowerCase() !== hex)) return null;
  return findByName(label.name);
}
