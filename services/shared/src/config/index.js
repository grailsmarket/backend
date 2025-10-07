"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
const dotenv_1 = __importDefault(require("dotenv"));
const zod_1 = require("zod");
const path_1 = __importDefault(require("path"));
// Load .env from project root
dotenv_1.default.config({ path: path_1.default.resolve(__dirname, '../../../../.env') });
const ConfigSchema = zod_1.z.object({
    database: zod_1.z.object({
        url: zod_1.z.string().default('postgresql://localhost:5432/grails'),
        maxConnections: zod_1.z.number().default(20),
        ssl: zod_1.z.boolean().default(false),
    }),
    redis: zod_1.z.object({
        url: zod_1.z.string().default('redis://localhost:6379'),
        ttl: zod_1.z.number().default(3600),
    }),
    elasticsearch: zod_1.z.object({
        url: zod_1.z.string().default('http://localhost:9200'),
        index: zod_1.z.string().default('ens_names'),
    }),
    blockchain: zod_1.z.object({
        rpcUrl: zod_1.z.string(),
        chainId: zod_1.z.number().default(1),
        ensRegistrarAddress: zod_1.z.string().default('0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85'),
        seaportAddress: zod_1.z.string().default('0x0000000000000068F116a894984e2DB1123eB395'),
        startBlock: zod_1.z.number().optional(),
        confirmations: zod_1.z.number().default(12),
    }),
    opensea: zod_1.z.object({
        apiKey: zod_1.z.string().optional(),
        streamUrl: zod_1.z.string().default('wss://stream.openseabeta.com/socket'),
    }),
    api: zod_1.z.object({
        port: zod_1.z.number().default(3000),
        host: zod_1.z.string().default('0.0.0.0'),
        corsOrigins: zod_1.z.array(zod_1.z.string()).default(['http://localhost:3000']),
        rateLimitMax: zod_1.z.number().default(100),
        rateLimitWindow: zod_1.z.number().default(60000),
    }),
    monitoring: zod_1.z.object({
        sentryDsn: zod_1.z.string().optional(),
        logLevel: zod_1.z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    }),
    jwt: zod_1.z.object({
        secret: zod_1.z.string().optional(),
        expiresIn: zod_1.z.string().default('24h'),
    }),
});
const rawConfig = {
    database: {
        url: process.env.DATABASE_URL,
        maxConnections: parseInt(process.env.DB_MAX_CONNECTIONS || '20'),
        ssl: process.env.DB_SSL === 'true',
    },
    redis: {
        url: process.env.REDIS_URL,
        ttl: parseInt(process.env.REDIS_TTL || '3600'),
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
    api: {
        port: parseInt(process.env.API_PORT || '3000'),
        host: process.env.API_HOST,
        corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['http://localhost:3000'],
        rateLimitMax: parseInt(process.env.RATE_LIMIT_MAX || '100'),
        rateLimitWindow: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
    },
    monitoring: {
        sentryDsn: process.env.SENTRY_DSN,
        logLevel: process.env.LOG_LEVEL || 'info',
    },
    jwt: {
        secret: process.env.JWT_SECRET,
        expiresIn: process.env.JWT_EXPIRES_IN,
    },
};
exports.config = ConfigSchema.parse(rawConfig);
exports.default = exports.config;
//# sourceMappingURL=index.js.map