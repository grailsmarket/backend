import { ethers } from 'ethers';
import { config } from '../../../shared/src';
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
  avatar?: string;
  description?: string;
  url?: string;
  twitter?: string;
  github?: string;
  email?: string;
  discord?: string;
  telegram?: string;
  resolverAddress?: string;
}

/**
 * Fetch ENS metadata from blockchain
 */
export async function fetchENSMetadata(nameHash: string): Promise<ENSMetadata> {
  const provider = getBlockchainProvider();

  try {
    // Convert decimal token_id to bytes32 hex format if needed
    const bytes32Hash = nameHash.startsWith('0x')
      ? nameHash
      : ethers.toBeHex(BigInt(nameHash), 32);

    // Get resolver address from ENS registry
    const ENS_REGISTRY_ADDRESS = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e';
    const ensRegistry = new ethers.Contract(
      ENS_REGISTRY_ADDRESS,
      ENS_REGISTRY_ABI,
      provider
    );

    const resolverAddress = await ensRegistry.resolver(bytes32Hash);

    // If no resolver set, return empty metadata
    if (resolverAddress === ethers.ZeroAddress) {
      logger.debug({ nameHash }, 'No resolver set for ENS name');
      return { resolverAddress: ethers.ZeroAddress };
    }

    // Query text records from resolver
    const resolver = new ethers.Contract(
      resolverAddress,
      ENS_RESOLVER_ABI,
      provider
    );

    // Fetch common text records in parallel
    const [avatar, description, url, twitter, github, email, discord, telegram] = await Promise.allSettled([
      resolver.text(bytes32Hash, 'avatar').catch(() => ''),
      resolver.text(bytes32Hash, 'description').catch(() => ''),
      resolver.text(bytes32Hash, 'url').catch(() => ''),
      resolver.text(bytes32Hash, 'com.twitter').catch(() => ''),
      resolver.text(bytes32Hash, 'com.github').catch(() => ''),
      resolver.text(bytes32Hash, 'email').catch(() => ''),
      resolver.text(bytes32Hash, 'com.discord').catch(() => ''),
      resolver.text(bytes32Hash, 'org.telegram').catch(() => ''),
    ]);

    const metadata: ENSMetadata = {
      resolverAddress,
    };

    // Helper to extract fulfilled values
    const getValue = (result: PromiseSettledResult<string>): string | undefined => {
      if (result.status === 'fulfilled' && result.value) {
        return result.value;
      }
      return undefined;
    };

    metadata.avatar = getValue(avatar);
    metadata.description = getValue(description);
    metadata.url = getValue(url);
    metadata.twitter = getValue(twitter);
    metadata.github = getValue(github);
    metadata.email = getValue(email);
    metadata.discord = getValue(discord);
    metadata.telegram = getValue(telegram);

    logger.debug({ nameHash, metadata }, 'Fetched ENS metadata');

    return metadata;
  } catch (error) {
    logger.error({ error, nameHash }, 'Error fetching ENS metadata');
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
