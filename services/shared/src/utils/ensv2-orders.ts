import { createPublicClient, http, keccak256, parseAbi, toBytes } from 'viem';
import { viemChain, config } from '../config';
import { getPostgresPool } from '../db/client';
import { ItemType } from '../types';

/**
 * Trading ENSv2 names: a v2 .eth name is an ERC1155 token on the ETHRegistry whose token ID
 * changes when roles on the name change (TokenRegenerated) and differs from its v1 token ID.
 * Seaport orders must reference the CURRENT token ID, and a fill only succeeds when the
 * registry allows the transfer (see PermissionedRegistry._update).
 */

// contracts-v2 post-audit-2: RegistryRolesLib.ROLE_CAN_TRANSFER_ADMIN, EACBaseRolesLib.ALL_ROLES
const ROLE_CAN_TRANSFER_ADMIN = (1n << 28n) << 128n;
const ALL_ROLES = 0x1111111111111111111111111111111111111111111111111111111111111111n;

const ETH_REGISTRY_READ_ABI = parseAbi([
  'function getTokenId(uint256 anyId) view returns (uint256)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function hasRoles(uint256 anyId, uint256 roleBitmap, address account) view returns (bool)',
  'function isOnlyAssignee(uint256 resource, uint256 roleBitmap, address account) view returns (bool)',
  'function isApprovedForAll(address account, address operator) view returns (bool)',
  'function isEmancipated() view returns (bool)',
  'function getState(uint256 anyId) view returns ((uint8 status, uint64 expiry, address latestOwner, uint256 tokenId, uint256 resource))',
  'function getResolver(string label) view returns (address)',
]);

/** IPermissionedRegistry.Status */
export const EnsV2Status = { AVAILABLE: 0, RESERVED: 1, REGISTERED: 2 } as const;

function ethRegistry(): `0x${string}` {
  const registry = config.blockchain.ensv2?.ethRegistryAddress as `0x${string}` | undefined;
  if (!registry) {
    throw new Error('ENSv2 is not configured for this chain');
  }
  return registry;
}

function registryClient() {
  return createPublicClient({ chain: viemChain, transport: http(config.blockchain.rpcUrl) });
}

/**
 * The ETHRegistry id of a .eth second-level name: its labelhash, which the registry accepts
 * anywhere it takes an anyId. Null for anything that isn't a 2LD .eth name.
 */
export function ensV2LabelId(name: string): bigint | null {
  const labels = name.split('.');
  if (labels.length !== 2 || labels[1] !== 'eth' || !labels[0]) return null;
  return BigInt(keccak256(toBytes(labels[0])));
}

/** v1 unwrapped token ID (decimal labelhash) -> the 0x-prefixed labelhash stored in ens_names.labelhash */
export function labelhashFromV1TokenId(tokenId: string): string | null {
  try {
    return '0x' + BigInt(tokenId).toString(16).padStart(64, '0');
  } catch {
    return null;
  }
}

/**
 * The resolver set on the ETHRegistry for a .eth label: where the name's records must be
 * written (per-account PermissionedResolvers, so never assume a shared one). Zero address
 * when unset, and the registry masks it to zero once the name is expired.
 */
export async function getEnsV2Resolver(label: string): Promise<string> {
  return (await registryClient().readContract({
    address: ethRegistry(),
    abi: ETH_REGISTRY_READ_ABI,
    functionName: 'getResolver',
    args: [label],
  })) as string;
}

export interface EnsV2State {
  status: number;
  expiry: bigint;
  latestOwner: string;
  tokenId: string;
}

/**
 * A name's live state on the ETHRegistry. anyId can be the labelhash or any token ID the name
 * ever had (current or superseded), so this is how to get the CURRENT token ID: token IDs
 * change on role changes, re-registration and unregistration, and the indexer can lag.
 */
export async function getEnsV2State(anyId: string | bigint): Promise<EnsV2State> {
  const state = (await registryClient().readContract({
    address: ethRegistry(),
    abi: ETH_REGISTRY_READ_ABI,
    functionName: 'getState',
    args: [BigInt(anyId)],
  })) as { status: number; expiry: bigint; latestOwner: string; tokenId: bigint };
  return {
    status: Number(state.status),
    expiry: state.expiry,
    latestOwner: state.latestOwner,
    tokenId: state.tokenId.toString(),
  };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// Seaport conduit keys, checked against ConduitController.getConduit on mainnet and Sepolia:
// Grails (creator 0xC9C3…7334) -> 0x73E9…a05D, OpenSea -> 0x1E00…3c71
const GRAILS_CONDUIT_KEY = '0xc9c3a4337a1bba75d0860a1a81f7b990dc607334000000000000000000000000';
const OPENSEA_CONDUIT_KEY = '0x0000007b02230091a7ed01230072f7006a004d60a8d4e71d599b8104250f0000';

export function isEthRegistryToken(token: string | null | undefined): boolean {
  const registry = config.blockchain.ensv2?.ethRegistryAddress;
  return !!registry && !!token && token.toLowerCase() === registry.toLowerCase();
}

export interface EnsV2NameRef {
  id: number;
  name: string;
  token_id: string;
}

/** The name a v2 token ID belongs to, whether it's the current ID or a superseded one. */
export async function findEnsV2NameByTokenId(tokenId: string): Promise<EnsV2NameRef | null> {
  const registry = config.blockchain.ensv2?.ethRegistryAddress;
  if (!registry) return null;
  const result = await getPostgresPool().query(
    `SELECT id, name, token_id FROM ens_names
     WHERE token_id = $1 AND ens_version = 2
     UNION ALL
     SELECT en.id, en.name, en.token_id FROM ens_token_ids t
     JOIN ens_names en ON en.id = t.ens_name_id
     WHERE t.token_contract = $2 AND t.token_id = $1
     LIMIT 1`,
    [tokenId, registry.toLowerCase()]
  );
  return result.rows[0] ?? null;
}

interface OrderItem {
  itemType: number | string;
  token: string;
  identifierOrCriteria: string | number | bigint;
}

/**
 * The ENS NFT an order trades: the offer item for a listing, the consideration item for an
 * offer. Accepts the order parameters (offer/consideration arrays).
 */
export function getOrderNftItem(
  params: { offer?: OrderItem[]; consideration?: OrderItem[] },
  side: 'listing' | 'offer'
): OrderItem | null {
  const items = (side === 'listing' ? params.offer : params.consideration) ?? [];
  return items.find((item) => {
    const type = Number(item.itemType);
    return type === ItemType.ERC721 || type === ItemType.ERC1155;
  }) ?? null;
}

/**
 * For a v2 name, check that an order's NFT item is its current ETHRegistry token: ERC1155,
 * token = ETHRegistry, identifier = the name's token_id. Returns null when the order matches.
 */
export function checkEnsV2OrderItem(
  item: OrderItem | null,
  currentTokenId: string
): { code: 'INVALID_ORDER_ITEM' | 'STALE_TOKEN_ID'; message: string } | null {
  if (!item) {
    return { code: 'INVALID_ORDER_ITEM', message: 'Order has no ENS NFT item' };
  }
  if (Number(item.itemType) !== ItemType.ERC1155 || !isEthRegistryToken(item.token)) {
    return {
      code: 'INVALID_ORDER_ITEM',
      message: `ENSv2 names are ERC1155 tokens on the ETHRegistry (${config.blockchain.ensv2?.ethRegistryAddress}): the order item must be itemType 3 with that token`,
    };
  }
  if (BigInt(item.identifierOrCriteria).toString() !== currentTokenId) {
    return {
      code: 'STALE_TOKEN_ID',
      message: `Order token ID is not the name's current token ID (${currentTokenId}); it changed since the order was built`,
    };
  }
  return null;
}

export type EnsV2TransferCheck =
  | { ok: true }
  | {
      ok: false;
      // token_changed / not_transferable: no order for this token ID can ever fill (cancel).
      // ownership_lost / expired / not_approved / registry_locked: may recover (unfunded); a
      // renewal or a transfer back keeps the token ID, and revoking the registry's root roles
      // emancipates it.
      reason: 'token_changed' | 'ownership_lost' | 'expired' | 'not_transferable' | 'not_approved' | 'registry_locked';
      detail: string;
    };

/**
 * Whether Seaport can move `tokenId` from `owner` right now, mirroring the registry's
 * transfer rules: the registry is emancipated (safe transfers revert with
 * TransferUnsafeUntilRegistryIsEmancipated while an account holds root roles that override
 * token owners), the token ID is current and unexpired, `owner` owns it and holds
 * ROLE_CAN_TRANSFER_ADMIN, nobody else holds a role on it (Seaport transfers are "safe"
 * transfers, which revert with TransferUnsafeWithMultipleAssignees), and, when `operator`
 * is given, the owner has approved it (Seaport or the order's conduit).
 */
export async function checkEnsV2Transferable(params: {
  tokenId: string;
  owner: string;
  operator?: string;
}): Promise<EnsV2TransferCheck> {
  const registry = ethRegistry();
  const client = registryClient();
  const tokenId = BigInt(params.tokenId);
  const owner = params.owner as `0x${string}`;
  const read = (functionName: any, args: readonly unknown[]) =>
    client.readContract({ address: registry, abi: ETH_REGISTRY_READ_ABI, functionName, args } as any) as Promise<any>;

  const [emancipated, currentTokenId, currentOwner, canTransfer, onlyAssignee, approved] = await Promise.all([
    read('isEmancipated', []) as Promise<boolean>,
    read('getTokenId', [tokenId]) as Promise<bigint>,
    read('ownerOf', [tokenId]) as Promise<string>,
    read('hasRoles', [tokenId, ROLE_CAN_TRANSFER_ADMIN, owner]) as Promise<boolean>,
    read('isOnlyAssignee', [tokenId, ALL_ROLES, owner]) as Promise<boolean>,
    params.operator
      ? (read('isApprovedForAll', [owner, params.operator]) as Promise<boolean>)
      : Promise.resolve(true),
  ]);

  if (currentTokenId !== tokenId) {
    return { ok: false, reason: 'token_changed', detail: `token ID is now ${currentTokenId}` };
  }
  if (currentOwner === ZERO_ADDRESS) {
    // ownerOf is zero for an expired name (the token ID is current, checked above)
    return { ok: false, reason: 'expired', detail: 'name is expired' };
  }
  if (currentOwner.toLowerCase() !== params.owner.toLowerCase()) {
    return { ok: false, reason: 'ownership_lost', detail: `owned by ${currentOwner}` };
  }
  if (!emancipated) {
    return { ok: false, reason: 'registry_locked', detail: 'the ETHRegistry is not emancipated, so it allows no marketplace transfers' };
  }
  if (!canTransfer) {
    return { ok: false, reason: 'not_transferable', detail: 'owner lacks the transfer role (ROLE_CAN_TRANSFER_ADMIN)' };
  }
  if (!onlyAssignee) {
    return { ok: false, reason: 'not_transferable', detail: 'another account holds a role on this name' };
  }
  if (!approved) {
    return { ok: false, reason: 'not_approved', detail: `owner has not approved ${params.operator} on the ETHRegistry` };
  }
  return { ok: true };
}

/**
 * The account Seaport transfers the NFT through for an order: Seaport itself for a zero
 * conduit key, otherwise the conduit for that key. Returns null for an unknown conduit key.
 */
export function getOrderOperator(conduitKey: string | null | undefined): string | null {
  const ZERO_KEY = '0x0000000000000000000000000000000000000000000000000000000000000000';
  if (!conduitKey || conduitKey.toLowerCase() === ZERO_KEY) {
    return config.blockchain.seaportAddress;
  }
  // Conduit keys embed their creator in the first 20 bytes; the conduit address is derived
  // from the key, so match against the conduits we know.
  const known = [
    { key: GRAILS_CONDUIT_KEY, address: config.blockchain.marketplaceConduitAddress },
    { key: OPENSEA_CONDUIT_KEY, address: config.blockchain.openseaConduitAddress },
  ];
  const match = known.find((k) => k.address && k.key === conduitKey.toLowerCase());
  return match?.address ?? null;
}
