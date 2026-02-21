import { ethers } from 'ethers';
import { config, needsEnsWorkerFallback, fetchTextRecordsFromEnsWorker } from '../../../shared/src';
import { logger } from '../utils/logger';

let provider: ethers.JsonRpcProvider | null = null;

// Name Wrapper contract address
const NAME_WRAPPER_ADDRESS = '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401';

export function getBlockchainProvider(): ethers.JsonRpcProvider {
  if (!provider) {
    provider = new ethers.JsonRpcProvider(config.blockchain.rpcUrl);
    logger.info('Blockchain provider initialized');
  }
  return provider;
}

// ENS Registry ABI (minimal - just what we need)
const ENS_REGISTRY_ABI = [
  'function resolver(bytes32 node) view returns (address)',
];

// Name Wrapper ABI (minimal - just ownerOf)
const NAME_WRAPPER_ABI = [
  'function ownerOf(uint256 id) view returns (address)',
];

// ENS Resolver ABI (minimal - text record methods)
const ENS_RESOLVER_ABI = [
  'function text(bytes32 node, string key) view returns (string)',
  'function contenthash(bytes32 node) view returns (bytes)',
  'function addr(bytes32 node) view returns (address)',
];

export interface ENSMetadata {
  [key: string]: string | undefined;
  resolverAddress?: string;
}

/**
 * Fetch ENS metadata from The Graph
 * Queries the ENS subgraph for text records, which is more reliable than
 * direct blockchain queries since The Graph maintains historical data.
 */
export async function fetchENSMetadata(name: string): Promise<ENSMetadata> {
  try {
    const query = `
      query GetDomain($name: String!) {
        domains(where: { name: $name }) {
          resolver {
            address
            texts
            textChangeds {
              key
              value
            }
          }
        }
      }
    `;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.theGraph?.apiKey) {
      headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
    }

    const response = await fetch(config.theGraph.ensSubgraphUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: { name: name.toLowerCase() },
      }),
    });

    if (!response.ok) {
      throw new Error(`Graph request failed: ${response.status} ${response.statusText}`);
    }

    const json: any = await response.json();

    if (json.errors) {
      throw new Error(`Graph query error: ${JSON.stringify(json.errors)}`);
    }

    const domain = json.data?.domains?.[0];

    if (!domain?.resolver) {
      logger.debug({ name }, 'No resolver found in Graph for ENS name');
      return { resolverAddress: ethers.ZeroAddress };
    }

    // Build metadata object from text records
    // textChangeds contains all historical changes, we want the latest value for each key
    const metadata: ENSMetadata = {
      resolverAddress: domain.resolver.address || ethers.ZeroAddress,
    };

    if (domain.resolver.textChangeds && Array.isArray(domain.resolver.textChangeds)) {
      for (const record of domain.resolver.textChangeds) {
        if (record.key && record.value) {
          metadata[record.key] = record.value;
        }
      }
    }

    // Fallback to ENS worker if resolver doesn't emit values to The Graph
    if (needsEnsWorkerFallback(domain.resolver.address, domain.resolver.texts, domain.resolver.textChangeds)) {
      try {
        const workerRecords = await fetchTextRecordsFromEnsWorker(name);
        Object.assign(metadata, workerRecords);
        logger.info({ name, keys: Object.keys(workerRecords) }, 'ENS worker fallback used for text records');
      } catch (error) {
        logger.warn({ error, name }, 'ENS worker fallback failed');
      }
    }

    logger.debug({ name, keys: Object.keys(metadata) }, 'Fetched ENS metadata from Graph');

    return metadata;
  } catch (error) {
    logger.error({ error, name }, 'Error fetching ENS metadata from Graph');
    throw error;
  }
}

/**
 * Get current owner of ENS name from blockchain
 *
 * Handles both wrapped and unwrapped names:
 * - For unwrapped names: Base Registrar ownerOf returns the actual owner
 * - For wrapped names: Base Registrar ownerOf returns Name Wrapper, so we query Name Wrapper
 *
 * The tokenId could be either:
 * - A labelhash (Base Registrar token ID for unwrapped names)
 * - A namehash (Name Wrapper token ID for wrapped names stored in our DB)
 */
export async function fetchENSOwner(tokenId: string): Promise<string> {
  const provider = getBlockchainProvider();

  // ENS Base Registrar contract
  const registrar = new ethers.Contract(
    config.blockchain.ensRegistrarAddress,
    ['function ownerOf(uint256 tokenId) view returns (address)'],
    provider
  );

  // Name Wrapper contract
  const nameWrapper = new ethers.Contract(
    NAME_WRAPPER_ADDRESS,
    NAME_WRAPPER_ABI,
    provider
  );

  try {
    // First, try Base Registrar with the token ID
    const registrarOwner = await registrar.ownerOf(tokenId);
    logger.debug({ tokenId, registrarOwner }, 'Base Registrar owner');

    // If owner is Name Wrapper, get the real owner from Name Wrapper
    if (registrarOwner.toLowerCase() === NAME_WRAPPER_ADDRESS.toLowerCase()) {
      try {
        // For wrapped names, the Name Wrapper uses namehash as token ID
        // Our DB stores namehash for wrapped names, so this should work
        const wrappedOwner = await nameWrapper.ownerOf(tokenId);
        logger.debug({ tokenId, wrappedOwner }, 'Name Wrapper owner');

        // Zero address means not wrapped or burned
        if (wrappedOwner && wrappedOwner !== ethers.ZeroAddress) {
          return wrappedOwner;
        }
      } catch (wrapperError: any) {
        logger.warn({ tokenId, error: wrapperError.message }, 'Name Wrapper ownerOf failed, returning registrar owner');
      }
      // Fall back to registrar owner (Name Wrapper address)
      return registrarOwner;
    }

    return registrarOwner;
  } catch (registrarError: any) {
    // Base Registrar failed - this could happen if:
    // 1. The token ID is a namehash (for wrapped names) but not a valid labelhash
    // 2. The name doesn't exist or is expired

    logger.debug({ tokenId, error: registrarError.message }, 'Base Registrar ownerOf failed, trying Name Wrapper');

    // Try Name Wrapper directly with the token ID (might be a namehash)
    try {
      const wrappedOwner = await nameWrapper.ownerOf(tokenId);

      if (wrappedOwner && wrappedOwner !== ethers.ZeroAddress) {
        logger.debug({ tokenId, wrappedOwner }, 'Found owner via Name Wrapper');
        return wrappedOwner;
      }
    } catch (wrapperError: any) {
      logger.debug({ tokenId, error: wrapperError.message }, 'Name Wrapper ownerOf also failed');
    }

    // Both failed - rethrow original error
    logger.error({ tokenId, error: registrarError.message }, 'Error fetching ENS owner');
    throw registrarError;
  }
}

/**
 * Resolve token ID to ENS name using The Graph
 */
export async function resolveTokenIdToName(tokenId: string): Promise<string | null> {
  try {
    // Convert tokenId to labelhash (32 bytes hex with 0x prefix)
    const hexString = BigInt(tokenId).toString(16).padStart(64, '0');
    const labelhash = '0x' + hexString;

    const query = `
      query GetENSName($labelhash: String!) {
        domains(where: { labelhash: $labelhash, parent: "0x93cdeb708b7545dc668eb9280176169d1c33cfd8ed6f04690a0bcc88a93fc4ae" }) {
          id
          name
          labelName
          labelhash
          registration {
            expiryDate
          }
        }
      }
    `;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (config.theGraph?.apiKey) {
      headers['Authorization'] = `Bearer ${config.theGraph.apiKey}`;
    }

    const response = await fetch(config.theGraph.ensSubgraphUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        query,
        variables: { labelhash }
      }),
    });

    if (!response.ok) {
      logger.error({ status: response.status, statusText: response.statusText, tokenId }, 'Graph API error');
      return null;
    }

    const data = await response.json() as any;

    if (data.errors) {
      logger.error({ errors: data.errors, tokenId }, 'Graph query errors');
      return null;
    }

    const domains = data.data?.domains || [];

    if (domains.length > 0) {
      const domain = domains[0];
      const name = domain.name || domain.labelName;

      if (name) {
        logger.info({ tokenId, name }, 'Resolved token ID to ENS name');
        return name;
      }
    }

    logger.debug({ tokenId }, 'No ENS name found for token ID');
    return null;

  } catch (error) {
    logger.error({ error, tokenId }, 'Error resolving ENS name');
    return null;
  }
}
