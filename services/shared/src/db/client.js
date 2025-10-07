"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPostgresPool = getPostgresPool;
exports.getRedisClient = getRedisClient;
exports.getElasticsearchClient = getElasticsearchClient;
exports.createPostgresClient = createPostgresClient;
exports.closeAllConnections = closeAllConnections;
const pg_1 = require("pg");
const elasticsearch_1 = require("@elastic/elasticsearch");
const config_1 = __importDefault(require("../config"));
let pgPool = null;
let redisClient = null;
let esClient = null;
function getPostgresPool() {
    if (!pgPool) {
        pgPool = new pg_1.Pool({
            connectionString: config_1.default.database.url,
            max: config_1.default.database.maxConnections,
            ssl: config_1.default.database.ssl ? { rejectUnauthorized: false } : false,
        });
        pgPool.on('error', (err) => {
            console.error('Unexpected error on idle PostgreSQL client', err);
        });
    }
    return pgPool;
}
async function getRedisClient() {
    if (!redisClient) {
        const { createClient } = await Promise.resolve().then(() => __importStar(require('redis')));
        redisClient = createClient({
            url: config_1.default.redis.url,
        });
        redisClient.on('error', (err) => {
            console.error('Redis Client Error', err);
        });
        await redisClient.connect();
    }
    return redisClient;
}
function getElasticsearchClient() {
    if (!esClient) {
        esClient = new elasticsearch_1.Client({
            node: config_1.default.elasticsearch.url,
        });
    }
    return esClient;
}
async function createPostgresClient() {
    const client = new pg_1.Client({
        connectionString: config_1.default.database.url,
        ssl: config_1.default.database.ssl ? { rejectUnauthorized: false } : false,
    });
    await client.connect();
    return client;
}
async function closeAllConnections() {
    const promises = [];
    if (pgPool) {
        promises.push(pgPool.end());
        pgPool = null;
    }
    if (redisClient) {
        promises.push(redisClient.quit().then(() => undefined));
        redisClient = null;
    }
    await Promise.all(promises);
}
//# sourceMappingURL=client.js.map