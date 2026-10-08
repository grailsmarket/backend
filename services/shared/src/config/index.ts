import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';
import { getNetworkPreset } from './network';

// Load .env from project root
// Try multiple possible locations to handle different execution contexts
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../../../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config(); // Also try default location

const ConfigSchema = z.object({
  database: z.object({
    url: z.string().default('postgresql://localhost:5432/grails'),
    // Reduced from 20 to 10 to prevent connection exhaustion with multiple services
    // Each service also uses pg-boss which has its own pool. Total connections:
    // (10 app + 3-10 pg-boss) * 4 services = ~60-80 connections (within PostgreSQL default of 100)
    maxConnections: z.number().default(10),
    ssl: z.boolean().default(false),
  }),
  elasticsearch: z.object({
    url: z.string().default('http://localhost:9200'),
    index: z.string().default('ens_names'),
  }),
  // Chain-specific defaults come from the network preset (see ./network.ts)
  blockchain: z.object({
    rpcUrl: z.string(),
    chainId: z.number(),
    ensRegistrarAddress: z.string(),
    ensControllerAddresses: z.array(z.string()),
    ensNameWrapperAddress: z.string(),
    ensBulkRenewalEventEmitter: z.string().nullable(),
    seaportAddress: z.string(),
    seaportStartBlock: z.number(),
    wethAddress: z.string(),
    usdcAddress: z.string(),
    ensTokenAddress: z.string().nullable(),
    multicall3Address: z.string(),
    openseaConduitAddress: z.string(),
    marketplaceConduitAddress: z.string().nullable(),
    legacyPublicResolverAddress: z.string().nullable(),
    startBlock: z.number().optional(),
    confirmations: z.number().default(12),
  }),
  opensea: z.object({
    enabled: z.boolean(),
    apiKey: z.string().optional(),
    apiBaseUrl: z.string(),
    chainSlug: z.string(),
    collectionSlug: z.string(),
    streamUrl: z.string().default('wss://stream.openseabeta.com/socket/websocket'),
  }),
  features: z.object({
    unclaimedDeposits: z.boolean(),
  }),
  theGraph: z.object({
    ensSubgraphUrl: z.string(),
    apiKey: z.string().optional(),
    ensWorkerUrl: z.string().nullable(),
  }),
  api: z.object({
    port: z.number().default(3000),
    host: z.string().default('0.0.0.0'),
    corsOrigins: z.array(z.string()).default(['http://localhost:3000']),
    rateLimitMax: z.number().default(150),
    rateLimitWindow: z.number().default(60000),
  }),
  monitoring: z.object({
    sentryDsn: z.string().optional(),
    logLevel: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
  }),
  jwt: z.object({
    secret: z.string().optional(),
    expiresIn: z.union([z.string(), z.number()]).default('24h'),
  }),
  email: z.object({
    smtpServer: z.string().optional(),
    smtpPort: z.number().default(587),
    smtpLogin: z.string().optional(),
    smtpPassword: z.string().optional(),
    fromEmail: z.string().default('noreply@grails.market'),
    enabled: z.boolean().default(true),
  }),
  frontend: z.object({
    url: z.string().default('http://localhost:3001'),
  }),
  redis: z.object({
    url: z.string().default('redis://localhost:6379'),
    enabled: z.boolean().default(true),
    cacheTtlSeconds: z.number().default(15),
  }),
  poap: z.object({
    apiKey: z.string().optional(),
    collectionIds: z.array(z.string()).default(['213962', '219949']),
  }),
  broker: z.object({
    minFeeBasisPoints: z.number().min(0).max(10000).default(100), // Default 1% minimum
  }),
  openai: z.object({
    apiKey: z.string().optional(),
  }),
  etherscan: z.object({
    apiKey: z.string().optional(),
    baseUrl: z.string().default('https://api.etherscan.io/v2/api'),
  }),
  ensvision: z.object({
    apiBaseUrl: z.string().default('https://api2.ensvision.com/v1'),
    enabled: z.coerce.boolean().default(true),
  }),
  efp: z.object({
    apiBaseUrl: z.string().default('https://api.ethfollow.xyz/api/v1'),
    enabled: z.coerce.boolean().default(true),
    timeoutMs: z.coerce.number().default(5000), // per-request timeout
    overallTimeoutMs: z.coerce.number().default(20000), // hard cap on the whole paginated fetch
    followingCacheTtlSeconds: z.coerce.number().default(300), // 5 min
    maxFollowing: z.coerce.number().default(5000), // safety cap on fetched following set
  }),
  googleAds: z.object({
    developerToken: z.string().optional(),
    clientId: z.string().optional(),
    clientSecret: z.string().optional(),
    refreshToken: z.string().optional(),
    customerId: z.string().optional(),
  }),
  storage: z.object({
    bucket: z.string().optional(),
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    endpoint: z.string().optional(),
    region: z.string().default('auto'),
    forcePathStyle: z.boolean().default(false),
    enabled: z.boolean(),
  }),
  valuation: z.object({
    openrouterApiKey: z.string().optional(),
    web2TldDataApiKey: z.string().optional(),
    web2TldDataBaseUrl: z.string().optional(),
  }),
});

const chainId = parseInt(process.env.CHAIN_ID || '1');
const network = getNetworkPreset(chainId);

// Env override for a nullable preset address: unset → preset, empty string → null
function envNullable(value: string | undefined, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  return value === '' ? null : value;
}

const rawConfig = {
  database: {
    url: process.env.DATABASE_URL,
    maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '20'),
    ssl: process.env.DB_SSL === 'true',
  },
  elasticsearch: {
    url: process.env.ELASTICSEARCH_URL,
    index: process.env.ELASTICSEARCH_INDEX,
  },
  blockchain: {
    rpcUrl: process.env.RPC_URL || '',
    chainId,
    ensRegistrarAddress: process.env.ENS_REGISTRAR_ADDRESS || network.ensRegistrarAddress,
    ensControllerAddresses: process.env.ENS_CONTROLLER_ADDRESSES?.split(',') || network.ensControllerAddresses,
    ensNameWrapperAddress: process.env.ENS_NAME_WRAPPER_ADDRESS || network.ensNameWrapperAddress,
    ensBulkRenewalEventEmitter: envNullable(process.env.ENS_BULK_RENEWAL_EVENT_EMITTER, network.ensBulkRenewalEventEmitter),
    seaportAddress: process.env.SEAPORT_ADDRESS || network.seaportAddress,
    seaportStartBlock: process.env.SEAPORT_START_BLOCK ? parseInt(process.env.SEAPORT_START_BLOCK) : network.seaportStartBlock,
    wethAddress: process.env.WETH_ADDRESS || network.wethAddress,
    usdcAddress: process.env.USDC_ADDRESS || network.usdcAddress,
    ensTokenAddress: envNullable(process.env.ENS_TOKEN_ADDRESS, network.ensTokenAddress),
    multicall3Address: process.env.MULTICALL3_ADDRESS || network.multicall3Address,
    openseaConduitAddress: process.env.OPENSEA_CONDUIT_ADDRESS || network.openseaConduitAddress,
    marketplaceConduitAddress: envNullable(process.env.MARKETPLACE_CONDUIT_ADDRESS, network.marketplaceConduitAddress),
    legacyPublicResolverAddress: network.legacyPublicResolverAddress,
    startBlock: process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined,
    confirmations: parseInt(process.env.CONFIRMATIONS || '0'),
  },
  opensea: {
    enabled: process.env.OPENSEA_ENABLED !== undefined
      ? process.env.OPENSEA_ENABLED === 'true'
      : network.opensea.enabled,
    apiKey: process.env.OPENSEA_API_KEY,
    apiBaseUrl: process.env.OPENSEA_API_BASE_URL || network.opensea.apiBaseUrl,
    chainSlug: process.env.OPENSEA_CHAIN || network.opensea.chainSlug,
    collectionSlug: process.env.OPENSEA_COLLECTION_SLUG || network.opensea.collectionSlug,
    streamUrl: process.env.OPENSEA_STREAM_URL,
  },
  features: {
    unclaimedDeposits: process.env.UNCLAIMED_DEPOSITS_ENABLED !== undefined
      ? process.env.UNCLAIMED_DEPOSITS_ENABLED === 'true'
      : network.features.unclaimedDeposits,
  },
  theGraph: {
    ensSubgraphUrl: process.env.THE_GRAPH_ENS_SUBGRAPH_URL || network.ensSubgraphUrl,
    apiKey: process.env.THE_GRAPH_API_KEY,
    ensWorkerUrl: envNullable(process.env.ENS_WORKER_URL, network.ensWorkerUrl),
  },
  api: {
    port: parseInt(process.env.API_PORT || '3000'),
    host: process.env.API_HOST,
    corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '150'),
    rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
  },
  monitoring: {
    sentryDsn: process.env.SENTRY_DSN,
    logLevel: process.env.LOG_LEVEL as any || 'info',
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    expiresIn: process.env.JWT_EXPIRES_IN || '24h',
  },
  email: {
    smtpServer: process.env.SMTP_SERVER,
    smtpPort: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : 587,
    smtpLogin: process.env.SMTP_LOGIN,
    smtpPassword: process.env.SMTP_PASSWORD,
    fromEmail: process.env.FROM_EMAIL,
    enabled: process.env.ENABLE_EMAIL !== 'false',
  },
  frontend: {
    url: process.env.FRONTEND_URL,
  },
  redis: {
    url: process.env.REDIS_URL,
    enabled: process.env.REDIS_ENABLED !== 'false',
    cacheTtlSeconds: process.env.CACHE_TTL_SECONDS ? parseInt(process.env.CACHE_TTL_SECONDS) : 15,
  },
  poap: {
    apiKey: process.env.POAP_API_KEY,
    collectionIds: process.env.POAP_COLLECTION_IDS
      ? process.env.POAP_COLLECTION_IDS.split(',')
      : ['213962', '219949'],
  },
  broker: {
    minFeeBasisPoints: parseInt(process.env.BROKER_MIN_FEE_BASIS_POINTS || '100'),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
    baseUrl: process.env.ETHERSCAN_BASE_URL,
  },
  ensvision: {
    apiBaseUrl: process.env.ENSVISION_API_BASE_URL,
    enabled: process.env.ENSVISION_ENABLED !== 'false',
  },
  efp: {
    // Numeric values stay as raw strings here; the Zod schema's z.coerce.number()
    // + .default() is the single source of coercion and defaults (no double-parse).
    apiBaseUrl: process.env.EFP_API_BASE_URL,
    enabled: process.env.EFP_ENABLED !== 'false',
    timeoutMs: process.env.EFP_TIMEOUT_MS,
    overallTimeoutMs: process.env.EFP_OVERALL_TIMEOUT_MS,
    followingCacheTtlSeconds: process.env.EFP_FOLLOWING_CACHE_TTL,
    maxFollowing: process.env.EFP_MAX_FOLLOWING,
  },
  googleAds: {
    developerToken: process.env.GOOGLE_ADS_DEVELOPER_TOKEN,
    clientId: process.env.GOOGLE_ADS_CLIENT_ID,
    clientSecret: process.env.GOOGLE_ADS_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_ADS_REFRESH_TOKEN,
    customerId: process.env.GOOGLE_ADS_CUSTOMER_ID,
  },
  storage: {
    bucket: process.env.BUCKET,
    accessKeyId: process.env.ACCESS_KEY_ID,
    secretAccessKey: process.env.SECRET_ACCESS_KEY,
    endpoint: process.env.ENDPOINT,
    region: process.env.REGION || 'auto',
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
    enabled: !!(process.env.BUCKET && process.env.ACCESS_KEY_ID && process.env.SECRET_ACCESS_KEY && process.env.ENDPOINT),
  },
  valuation: {
    openrouterApiKey: process.env.OPENROUTER_API_KEY,
    web2TldDataApiKey: process.env.WEB2_TLD_DATA_API_KEY,
    web2TldDataBaseUrl: process.env.WEB2_TLD_DATA_BASE_URL,
  },
};

export const config = ConfigSchema.parse(rawConfig);

// viem chain definition for the configured network
export const viemChain = network.chain;

// Currency constants
export const CURRENCY_ADDRESSES = {
  ETH: '0x0000000000000000000000000000000000000000',
  WETH: config.blockchain.wethAddress.toLowerCase(),
} as const;

// Helper to get all ENS controller addresses as array
export function getEnsControllerAddresses(): string[] {
  return config.blockchain.ensControllerAddresses;
}

// Helper to check if currency is ETH or WETH
export function isEthOrWeth(currencyAddress: string | null | undefined): boolean {
  if (!currencyAddress) return false;
  const normalized = currencyAddress.toLowerCase();
  return normalized === CURRENCY_ADDRESSES.ETH.toLowerCase() ||
         normalized === CURRENCY_ADDRESSES.WETH.toLowerCase();
}

// SQL fragment for filtering ETH/WETH currencies
export const ETH_WETH_FILTER = `(currency_address = '${CURRENCY_ADDRESSES.ETH}' OR currency_address = '${CURRENCY_ADDRESSES.WETH}')`;

// ENS registration referrer codes (bytes32 values, lowercase) → human-readable source names
export const ENS_REFERRER_CODES: Record<string, string> = {
  '0x0000000000000000000000007e491cde0fbf08e51f54c4fb6b9e24afbd18966d': 'grails',
  '0x0000000000000000000000001c0ea438837302b4516ac3f380313061ec11760f': 'snipezone',
  '0x000000000000000000000000efce7f86fd1efb0359a91c873e6dee9f98788713': 'enstools',
  '0x0000000000000000000000009531c059098e3d194ff87febb587ab07b30b1306': 'rotki',
  '0x000000000000000000000000f919a96d2970380b87917b04f02e6d3d08368b10': 'vision',
  '0x000000000000000000000000486b883dbbe12b342efc5d4685343611dd4b2c18': 'namewhisper',
};

// Look up a bytes32 referrer value and return the human-readable source name, or null
export function getRegistrationSource(referrer: string): string | null {
  return ENS_REFERRER_CODES[referrer.toLowerCase()] ?? null;
}

export default config;