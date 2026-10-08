import { mainnet, sepolia, type Chain } from 'viem/chains';

// Per-chain defaults. Selected by CHAIN_ID; every value can still be overridden
// by its env var in config/index.ts. A null address means "not deployed on this
// chain" and the features that depend on it are skipped.
export interface NetworkPreset {
  chain: Chain;
  ensRegistrarAddress: string;
  ensControllerAddresses: string[];
  ensNameWrapperAddress: string;
  ensBulkRenewalEventEmitter: string | null;
  seaportAddress: string;
  seaportStartBlock: number;
  wethAddress: string;
  usdcAddress: string;
  ensTokenAddress: string | null;
  multicall3Address: string;
  openseaConduitAddress: string;
  marketplaceConduitAddress: string | null;
  // Resolver whose text records are unreliable via getEnsText (falls back to the ENS worker)
  legacyPublicResolverAddress: string | null;
  ensSubgraphUrl: string;
  // ENS text-record worker (on-chain resolution fallback); null = none for this chain
  ensWorkerUrl: string | null;
  opensea: {
    enabled: boolean;
    apiBaseUrl: string;
    chainSlug: string;
    collectionSlug: string;
  };
  features: {
    unclaimedDeposits: boolean;
  };
}

export const NETWORK_PRESETS: Record<number, NetworkPreset> = {
  [mainnet.id]: {
    chain: mainnet,
    ensRegistrarAddress: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    ensControllerAddresses: [
      '0x253553366Da8546fC250F225fe3d25d0C782303b', // Original controller (deployed May 2022)
      '0x59e16fccd424cc24e280be16e11bcd56fb0ce547', // ETH Registrar Controller 2 (newer)
    ],
    ensNameWrapperAddress: '0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401',
    ensBulkRenewalEventEmitter: '0xf55575bde5953ee4272d5ce7cdd924c74d8fa81a',
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    seaportStartBlock: 19000000,
    wethAddress: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
    usdcAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    ensTokenAddress: '0xC18360217D8F7Ab5e7c516566761Ea12Ce7F9D72',
    multicall3Address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    openseaConduitAddress: '0x1E0049783F008A0085193E00003D00cd54003c71',
    marketplaceConduitAddress: '0x73E9cD721a79C208E2F944910c27196307a2a05D',
    legacyPublicResolverAddress: '0x4976fb03c32e5b8cfe2b6ccb31c09ba78ebaba41',
    ensSubgraphUrl: 'https://gateway.thegraph.com/api/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH',
    ensWorkerUrl: 'https://ens.ethfollow.xyz',
    opensea: {
      enabled: true,
      apiBaseUrl: 'https://api.opensea.io/api/v2',
      chainSlug: 'ethereum',
      collectionSlug: 'ens',
    },
    features: {
      unclaimedDeposits: true,
    },
  },
  // Sepolia addresses from ensdomains/ens-contracts deployments/sepolia and
  // docs.ens.domains/learn/deployments. Registry, BaseRegistrar, Seaport,
  // Multicall3 and the OpenSea conduit share mainnet addresses.
  [sepolia.id]: {
    chain: sepolia,
    ensRegistrarAddress: '0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85',
    ensControllerAddresses: [
      // ETHRegistrarController (v2 ABI with referrer). Disabled since the 2026-10-01
      // ENSv2 migration, but holds the v1 registration/renewal history.
      // LegacyETHRegistrarController (0x7e02892cfc2Bfd53a75275451d73cF620e793fc0) is
      // omitted: its pre-2022 event signatures aren't decoded by the indexer.
      '0xfb3cE5D01e0f33f41DbB39035dB9745962F1f968',
    ],
    ensNameWrapperAddress: '0x0635513f179D50A207757E05759CbD106d7dFcE8',
    ensBulkRenewalEventEmitter: null,
    seaportAddress: '0x0000000000000068F116a894984e2DB1123eB395',
    seaportStartBlock: 3702728, // ENS registry deployment; Seaport 1.6 block not pinned
    wethAddress: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
    usdcAddress: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    ensTokenAddress: null,
    multicall3Address: '0xcA11bde05977b3631167028862bE2a173976CA11',
    openseaConduitAddress: '0x1E0049783F008A0085193E00003D00cd54003c71',
    marketplaceConduitAddress: '0x73E9cD721a79C208E2F944910c27196307a2a05D', // same conduit key as mainnet
    legacyPublicResolverAddress: null,
    ensSubgraphUrl: 'https://api.studio.thegraph.com/query/49574/enssepolia/version/latest',
    ensWorkerUrl: null,
    opensea: {
      // OpenSea dropped testnet support (July 2025)
      enabled: false,
      apiBaseUrl: 'https://api.opensea.io/api/v2',
      chainSlug: 'sepolia',
      collectionSlug: 'ens',
    },
    features: {
      unclaimedDeposits: false,
    },
  },
};

export function getNetworkPreset(chainId: number): NetworkPreset {
  const preset = NETWORK_PRESETS[chainId];
  if (!preset) {
    throw new Error(
      `Unsupported CHAIN_ID ${chainId}. Supported: ${Object.keys(NETWORK_PRESETS).join(', ')}`
    );
  }
  return preset;
}
