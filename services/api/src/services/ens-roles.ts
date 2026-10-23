import { createPublicClient, http } from 'viem';
import {
  config,
  viemChain,
  getPostgresPool,
  isEnsV2Name,
  ensV2LabelId,
  getEnsV2State,
  getEnsV2Resolver,
  checkEnsV2Transferable,
  EnsV2Status,
} from '../../../shared/src';
import { logger } from '../utils/logger';

// Name Wrapper contract address
const NAME_WRAPPER_ADDRESS = config.blockchain.ensNameWrapperAddress.toLowerCase();

// In-memory cache with TTL (5 minutes)
const CACHE_TTL_MS = 5 * 60 * 1000;
const rolesCache = new Map<string, { data: EnsRoles; timestamp: number }>();
const manageableNamesCache = new Map<string, { allNames: ManageableNameSummary[]; total: number; timestamp: number }>();

/**
 * ENS Name Wrapper fuse flags
 * These control what actions are restricted on wrapped names
 */
export const FUSES = {
  CANNOT_UNWRAP: 1,
  CANNOT_BURN_FUSES: 2,
  CANNOT_TRANSFER: 4,
  CANNOT_SET_RESOLVER: 8,
  CANNOT_SET_TTL: 16,
  CANNOT_CREATE_SUBDOMAIN: 32,
  PARENT_CANNOT_CONTROL: 65536,
  CAN_EXTEND_EXPIRY: 262144,
} as const;

/**
 * Decoded fuse permissions for a wrapped name
 */
export interface FusePermissions {
  canUnwrap: boolean;
  canBurnFuses: boolean;
  canTransfer: boolean;
  canSetResolver: boolean;
  canSetTTL: boolean;
  canCreateSubdomain: boolean;
  parentCanControl: boolean;
  canExtendExpiry: boolean;
  raw: number;
}

/**
 * Role information for an ENS name
 */
export interface EnsRoles {
  name: string;
  /** NFT holder - full control (registrant for unwrapped, wrappedOwner for wrapped) */
  owner: string | null;
  /** Authorized to edit records - only separate from owner for unwrapped names */
  manager: string | null;
  /** ETH address record - where funds are sent */
  ethAddress: string | null;
  /** Whether the name is wrapped in the NameWrapper contract */
  isWrapped: boolean;
  /** Fuse permissions (only set for wrapped names) */
  fuses: FusePermissions | null;
  /** Registration expiry date (Unix timestamp) */
  expiryDate: number | null;
  /** Resolver contract address */
  resolver: string | null;
  /** 1 = ENS v1 (BaseRegistrar / NameWrapper), 2 = ENSv2 ETHRegistry */
  ensVersion: 1 | 2;
  /** v2 only: the current ETHRegistry token ID (changes when roles change) */
  tokenId?: string;
  /**
   * v2 only: whether the owner can transfer (and so sell) the name: the owner holds
   * ROLE_CAN_TRANSFER_ADMIN, nobody else holds a role on it, and the registry is emancipated.
   */
  transferable?: boolean;
  /** v2 only: why the name can't be transferred, when transferable is false */
  transferBlocker?: string;
}

/**
 * GraphQL response types
 */
interface GraphAccount {
  id: string;
}

interface GraphWrappedDomain {
  owner: GraphAccount;
  fuses: number;
  expiryDate: string;
}

interface GraphRegistration {
  registrant: GraphAccount;
  expiryDate: string;
}

interface GraphDomain {
  name: string;
  owner: GraphAccount | null;
  registrant: GraphAccount | null;
  wrappedOwner: GraphAccount | null;
  resolvedAddress: GraphAccount | null;
  resolver: { address: string } | null;
  wrappedDomain: GraphWrappedDomain | null;
  registration: GraphRegistration | null;
}

interface GraphResponse {
  data?: {
    domains?: GraphDomain[];
    asManager?: GraphDomain[];
    asOwner?: GraphDomain[];
    asWrappedOwner?: GraphDomain[];
  };
  errors?: Array<{ message: string }>;
}

/**
 * Decode fuse bitmask into permission flags
 */
export function decodeFuses(fuses: number): FusePermissions {
  return {
    canUnwrap: (fuses & FUSES.CANNOT_UNWRAP) === 0,
    canBurnFuses: (fuses & FUSES.CANNOT_BURN_FUSES) === 0,
    canTransfer: (fuses & FUSES.CANNOT_TRANSFER) === 0,
    canSetResolver: (fuses & FUSES.CANNOT_SET_RESOLVER) === 0,
    canSetTTL: (fuses & FUSES.CANNOT_SET_TTL) === 0,
    canCreateSubdomain: (fuses & FUSES.CANNOT_CREATE_SUBDOMAIN) === 0,
    parentCanControl: (fuses & FUSES.PARENT_CANNOT_CONTROL) === 0,
    canExtendExpiry: (fuses & FUSES.CAN_EXTEND_EXPIRY) !== 0,
    raw: fuses,
  };
}

/**
 * Execute a GraphQL query against the ENS subgraph
 */
async function querySubgraph<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.theGraph?.apiKey) {
    headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
  }

  const response = await fetch(config.theGraph.ensSubgraphUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Subgraph request failed: ${response.status} ${response.statusText}`);
  }

  const json = await response.json() as GraphResponse;

  if (json.errors) {
    throw new Error(`Subgraph query error: ${json.errors.map(e => e.message).join(', ')}`);
  }

  return json as T;
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Roles for a name that lives on the ENSv2 ETHRegistry, read on-chain. The v1 subgraph is
 * wrong for these: a migrated name's v1 registrant is the Graveyard, and a new v2 name isn't
 * in it at all. Returns null for names that aren't on v2 (including unmigrated names, which
 * are only reserved on v2 and are still described correctly by v1).
 *
 * A name counts as v2 when the registry says REGISTERED, or when we've indexed it as v2
 * (an expired v2 name reads as AVAILABLE on-chain but must not fall back to v1 data).
 */
async function getEnsV2NameRoles(name: string): Promise<EnsRoles | null> {
  if (!config.blockchain.ensv2) return null;
  const labelId = ensV2LabelId(name);
  if (!labelId) return null;

  let state;
  try {
    state = await getEnsV2State(labelId);
  } catch (error: any) {
    if (await isEnsV2Name(name)) {
      // Don't serve v1 data for a v2 name
      throw error;
    }
    logger.warn({ name, error: error?.message }, 'ENSv2 state lookup failed, using v1 roles');
    return null;
  }

  if (state.status !== EnsV2Status.REGISTERED && !(await isEnsV2Name(name))) {
    return null;
  }

  const label = name.slice(0, -'.eth'.length);
  const owner = state.latestOwner === ZERO_ADDRESS ? null : state.latestOwner.toLowerCase();
  const client = createPublicClient({ chain: viemChain, transport: http(config.blockchain.rpcUrl) });

  const [resolver, ethAddress, transfer] = await Promise.all([
    getEnsV2Resolver(label).catch((error) => {
      logger.warn({ name, error: error?.message }, 'ENSv2 getResolver failed');
      return null;
    }),
    // Through the UniversalResolver, the same path wallets use
    client.getEnsAddress({ name }).catch(() => null),
    owner
      ? checkEnsV2Transferable({ tokenId: state.tokenId, owner }).catch((error) => {
          logger.warn({ name, error: error?.message }, 'ENSv2 transfer check failed');
          return null;
        })
      : Promise.resolve(null),
  ]);

  return {
    name,
    owner,
    // v2 has no separate registry "manager": record permissions live on the resolver
    manager: owner,
    ethAddress: ethAddress ? ethAddress.toLowerCase() : null,
    isWrapped: false,
    fuses: null,
    expiryDate: state.expiry > 0n ? Number(state.expiry) : null,
    resolver: resolver && resolver !== ZERO_ADDRESS ? resolver.toLowerCase() : null,
    ensVersion: 2,
    tokenId: state.tokenId,
    transferable: transfer ? transfer.ok : undefined,
    transferBlocker: transfer && !transfer.ok ? transfer.detail : undefined,
  };
}

/**
 * Get roles for a specific ENS name
 * Returns owner, manager, and ETH address along with wrapped state and fuses
 */
export async function getNameRoles(name: string): Promise<EnsRoles | null> {
  const normalizedName = name.toLowerCase();

  // Check cache
  const cached = rolesCache.get(normalizedName);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.debug({ name: normalizedName }, 'Returning cached roles');
    return cached.data;
  }

  const v2Roles = await getEnsV2NameRoles(normalizedName);
  if (v2Roles) {
    rolesCache.set(normalizedName, { data: v2Roles, timestamp: Date.now() });
    return v2Roles;
  }

  const query = `
    query GetNameRoles($name: String!) {
      domains(where: { name: $name }) {
        name
        owner { id }
        registrant { id }
        wrappedOwner { id }
        resolvedAddress { id }
        resolver { address }
        wrappedDomain {
          owner { id }
          fuses
          expiryDate
        }
        registration {
          registrant { id }
          expiryDate
        }
      }
    }
  `;

  const result = await querySubgraph<GraphResponse>(query, { name: normalizedName });
  const domain = result.data?.domains?.[0];

  if (!domain) {
    return null;
  }

  // Determine if name is wrapped
  // A name is wrapped if:
  // 1. The registrant is the NameWrapper contract (for 2LDs like name.eth), OR
  // 2. wrappedDomain exists (for subnames like sub.name.eth), OR
  // 3. domain.owner is NameWrapper AND wrappedOwner exists
  const registrant = domain.registrant?.id?.toLowerCase() || domain.registration?.registrant?.id?.toLowerCase();
  const domainOwner = domain.owner?.id?.toLowerCase();
  const hasWrappedDomain = domain.wrappedDomain !== null;
  const hasWrappedOwner = domain.wrappedOwner !== null;

  const isWrapped =
    registrant === NAME_WRAPPER_ADDRESS ||
    hasWrappedDomain ||
    (domainOwner === NAME_WRAPPER_ADDRESS && hasWrappedOwner);

  // Determine owner and manager based on wrapped state
  let owner: string | null = null;
  let manager: string | null = null;

  if (isWrapped) {
    // For wrapped names: owner = wrappedOwner, manager = owner (same as wrappedOwner)
    owner = domain.wrappedOwner?.id?.toLowerCase() || domain.wrappedDomain?.owner?.id?.toLowerCase() || null;
    manager = owner; // For wrapped names, manager and owner are the same
  } else {
    // For unwrapped names: owner = registrant, manager = domain.owner
    // For unwrapped subnames (no registrant), owner = domain.owner
    owner = registrant || domainOwner || null;
    manager = domainOwner || null;
  }

  // Get ETH address (resolvedAddress)
  const ethAddress = domain.resolvedAddress?.id?.toLowerCase() || null;

  // Get fuses for wrapped names
  let fuses: FusePermissions | null = null;
  if (isWrapped && domain.wrappedDomain?.fuses !== undefined) {
    fuses = decodeFuses(domain.wrappedDomain.fuses);
  }

  // Get expiry date
  // Note: Subnames may have expiryDate of "0" which means no expiry - treat as null
  let expiryDate: number | null = null;
  if (domain.registration?.expiryDate) {
    const parsed = parseInt(domain.registration.expiryDate);
    if (parsed > 0) expiryDate = parsed;
  } else if (domain.wrappedDomain?.expiryDate) {
    const parsed = parseInt(domain.wrappedDomain.expiryDate);
    if (parsed > 0) expiryDate = parsed;
  }

  const roles: EnsRoles = {
    name: domain.name,
    owner,
    manager,
    ethAddress,
    isWrapped,
    fuses,
    expiryDate,
    resolver: domain.resolver?.address || null,
    ensVersion: 1,
  };

  // Cache the result
  rolesCache.set(normalizedName, { data: roles, timestamp: Date.now() });

  return roles;
}

/**
 * Summary of names an address can manage
 */
export interface ManageableNameSummary {
  name: string;
  role: 'owner' | 'manager' | 'both';
  isWrapped: boolean;
  ensVersion: 1 | 2;
}

/**
 * Paginated result of manageable names
 */
export interface ManageableNamesResult {
  names: ManageableNameSummary[];
  total: number;
}

/**
 * Check if a name should be excluded from manageable names list
 * Excludes:
 * - Reverse resolution records (.addr.reverse)
 * - Names that are just hashes (no human-readable portion)
 */
function shouldExcludeName(name: string | null | undefined): boolean {
  if (!name) return true;

  // Exclude reverse resolution records
  if (name.endsWith('.addr.reverse')) return true;

  // Exclude names that look like raw hashes (no dots except for TLD, or starts with 0x)
  // These are typically internal/technical records
  if (name.startsWith('[') && name.includes('].')) return true;

  return false;
}

/**
 * Get all names that an address can manage (update records for)
 * This includes names where the address is owner OR manager
 * Excludes reverse resolution records and other non-user-facing names
 *
 * @param address - Ethereum address to query
 * @param page - Page number (1-indexed)
 * @param limit - Number of results per page
 * @returns Paginated result with names and total count
 */
export async function getManageableNames(
  address: string,
  page: number = 1,
  limit: number = 20
): Promise<ManageableNamesResult> {
  const normalizedAddress = address.toLowerCase();

  // Check cache
  const cached = manageableNamesCache.get(normalizedAddress);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    logger.debug({ address: normalizedAddress }, 'Returning cached manageable names');
    const offset = (page - 1) * limit;
    return {
      names: cached.allNames.slice(offset, offset + limit),
      total: cached.total,
    };
  }

  // Fetch all names from The Graph (we need all for accurate total count and deduplication)
  const query = `
    query GetManageableNames($address: String!) {
      asManager: domains(where: { owner: $address }, first: 1000) {
        name
        registrant { id }
        wrappedOwner { id }
      }
      asOwner: domains(where: { registrant: $address }, first: 1000) {
        name
        owner { id }
      }
      asWrappedOwner: domains(where: { wrappedOwner: $address }, first: 1000) {
        name
        wrappedDomain { fuses }
      }
    }
  `;

  const result = await querySubgraph<GraphResponse>(query, { address: normalizedAddress });

  const namesMap = new Map<string, ManageableNameSummary>();

  // Process names where address is manager (domain.owner)
  for (const domain of result.data?.asManager || []) {
    if (shouldExcludeName(domain.name)) continue;

    // Check if this is a wrapped name where address is also owner
    const registrant = domain.registrant?.id?.toLowerCase();
    const isWrapped = registrant === NAME_WRAPPER_ADDRESS;

    // For unwrapped names: if registrant matches, address is both owner and manager
    // For wrapped names: manager role doesn't apply (merged into owner)
    if (!isWrapped) {
      const isAlsoOwner = registrant === normalizedAddress;
      namesMap.set(domain.name, {
        name: domain.name,
        role: isAlsoOwner ? 'both' : 'manager',
        isWrapped: false,
        ensVersion: 1,
      });
    }
  }

  // Process names where address is owner (unwrapped - registrant)
  for (const domain of result.data?.asOwner || []) {
    if (shouldExcludeName(domain.name)) continue;

    const existing = namesMap.get(domain.name);
    if (existing) {
      // Already tracked as manager, mark as both
      existing.role = 'both';
    } else {
      // Check if same address is also manager
      const managerAddress = domain.owner?.id?.toLowerCase();
      namesMap.set(domain.name, {
        name: domain.name,
        role: managerAddress === normalizedAddress ? 'both' : 'owner',
        isWrapped: false,
        ensVersion: 1,
      });
    }
  }

  // Process names where address is owner (wrapped - wrappedOwner)
  for (const domain of result.data?.asWrappedOwner || []) {
    if (shouldExcludeName(domain.name)) continue;

    // For wrapped names, owner and manager are the same
    namesMap.set(domain.name, {
      name: domain.name,
      role: 'both', // Always both for wrapped since manager = owner
      isWrapped: true,
      ensVersion: 1,
    });
  }

  // ENSv2 names aren't in the v1 subgraph (and a migrated name's v1 entry belongs to the
  // Graveyard, so it drops out above): add the v2 names this address owns, from the index.
  if (config.blockchain.ensv2) {
    const v2Names = await getPostgresPool().query(
      'SELECT name FROM ens_names WHERE ens_version = 2 AND owner_address = $1',
      [normalizedAddress]
    );
    for (const row of v2Names.rows) {
      if (shouldExcludeName(row.name)) continue;
      namesMap.set(row.name, { name: row.name, role: 'both', isWrapped: false, ensVersion: 2 });
    }
  }

  // Convert to array and sort
  const allNames = Array.from(namesMap.values());
  const total = allNames.length;

  // Sort by name for consistent ordering
  allNames.sort((a, b) => a.name.localeCompare(b.name));

  // Cache the full sorted result
  manageableNamesCache.set(normalizedAddress, {
    allNames,
    total,
    timestamp: Date.now(),
  });

  // Apply pagination
  const offset = (page - 1) * limit;
  const paginatedNames = allNames.slice(offset, offset + limit);

  return {
    names: paginatedNames,
    total,
  };
}

/**
 * Result of checking if an address can manage a name
 */
export interface CanManageResult {
  canManage: boolean;
  role: 'owner' | 'manager' | 'both' | null;
  isWrapped: boolean;
  fuses: FusePermissions | null;
}

/**
 * Check if an address can update records for a specific ENS name
 * Returns true if address is either owner or manager
 */
export async function canUpdateRecords(name: string, address: string): Promise<CanManageResult> {
  const roles = await getNameRoles(name);

  if (!roles) {
    return {
      canManage: false,
      role: null,
      isWrapped: false,
      fuses: null,
    };
  }

  const normalizedAddress = address.toLowerCase();
  const isOwner = roles.owner === normalizedAddress;
  const isManager = roles.manager === normalizedAddress;

  // Check if fuses prevent record updates
  let canManage = isOwner || isManager;
  if (canManage && roles.fuses && !roles.fuses.canSetResolver) {
    // CANNOT_SET_RESOLVER fuse is burned - cannot update records
    canManage = false;
  }

  let role: 'owner' | 'manager' | 'both' | null = null;
  if (isOwner && isManager) {
    role = 'both';
  } else if (isOwner) {
    role = 'owner';
  } else if (isManager) {
    role = 'manager';
  }

  return {
    canManage,
    role,
    isWrapped: roles.isWrapped,
    fuses: roles.fuses,
  };
}

/**
 * Clear the roles cache (useful for testing or manual refresh)
 */
export function clearRolesCache(): void {
  rolesCache.clear();
}
