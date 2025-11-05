import dotenv from 'dotenv';
import { z } from 'zod';
import path from 'path';

// Load .env from project root
// Try multiple possible locations to handle different execution contexts
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../../../../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config(); // Also try default location

const ConfigSchema = z.object({
  database: z.object({
    url: z.string().default('postgresql://localhost:5432/grails'),
    maxConnections: z.number().default(20),
    ssl: z.boolean().default(false),
  }),
  elasticsearch: z.object({
    url: z.string().default('http://localhost:9200'),
    index: z.string().default('ens_names'),
  }),
  blockchain: z.object({
    rpcUrl: z.string(),
    chainId: z.number().default(1),
    ensRegistrarAddress: z.string().default('0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85'),
    seaportAddress: z.string().default('0x0000000000000068F116a894984e2DB1123eB395'),
    startBlock: z.number().optional(),
    confirmations: z.number().default(12),
  }),
  opensea: z.object({
    apiKey: z.string().optional(),
    streamUrl: z.string().default('wss://stream.openseabeta.com/socket/websocket'),
  }),
  theGraph: z.object({
    ensSubgraphUrl: z.string().default('https://gateway.thegraph.com/api/subgraphs/id/5XqPmWe6gjyrJtFn9cLy237i4cWw2j9HcUJEXsP5qGtH'),
    apiKey: z.string().optional(),
  }),
  api: z.object({
    port: z.number().default(3000),
    host: z.string().default('0.0.0.0'),
    corsOrigins: z.array(z.string()).default(['http://localhost:3000']),
    rateLimitMax: z.number().default(100),
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
});

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
    chainId: parseInt(process.env.CHAIN_ID || '1'),
    ensRegistrarAddress: process.env.ENS_REGISTRAR_ADDRESS,
    seaportAddress: process.env.SEAPORT_ADDRESS,
    startBlock: process.env.START_BLOCK ? parseInt(process.env.START_BLOCK) : undefined,
    confirmations: parseInt(process.env.CONFIRMATIONS || '12'),
  },
  opensea: {
    apiKey: process.env.OPENSEA_API_KEY,
    streamUrl: process.env.OPENSEA_STREAM_URL,
  },
  theGraph: {
    ensSubgraphUrl: process.env.THE_GRAPH_ENS_SUBGRAPH_URL,
    apiKey: process.env.THE_GRAPH_API_KEY,
  },
  api: {
    port: parseInt(process.env.API_PORT || '3000'),
    host: process.env.API_HOST,
    corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
    rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100'),
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
};

export const config = ConfigSchema.parse(rawConfig);

// Currency constants
export const CURRENCY_ADDRESSES = {
  ETH: '0x0000000000000000000000000000000000000000',
  WETH: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
} as const;

// Helper to check if currency is ETH or WETH
export function isEthOrWeth(currencyAddress: string | null | undefined): boolean {
  if (!currencyAddress) return false;
  const normalized = currencyAddress.toLowerCase();
  return normalized === CURRENCY_ADDRESSES.ETH.toLowerCase() ||
         normalized === CURRENCY_ADDRESSES.WETH.toLowerCase();
}

// SQL fragment for filtering ETH/WETH currencies
export const ETH_WETH_FILTER = `(currency_address = '${CURRENCY_ADDRESSES.ETH}' OR currency_address = '${CURRENCY_ADDRESSES.WETH}')`;

export default config;