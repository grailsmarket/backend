import { Pool, Client } from 'pg';
import type { RedisClientType } from 'redis';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import config from '../config';

let pgPool: Pool | null = null;
let redisClient: RedisClientType | null = null;
let esClient: ElasticsearchClient | null = null;

export function getPostgresPool(): Pool {
  if (!pgPool) {
    pgPool = new Pool({
      connectionString: config.database.url,
      max: config.database.maxConnections,
      ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
    });

    pgPool.on('error', (err) => {
      console.error('Unexpected error on idle PostgreSQL client', err);
    });
  }
  return pgPool;
}

export async function getRedisClient(): Promise<RedisClientType> {
  if (!redisClient) {
    const { createClient } = await import('redis');
    redisClient = createClient({
      url: config.redis.url,
    });

    redisClient.on('error', (err: Error) => {
      console.error('Redis Client Error', err);
    });

    await redisClient.connect();
  }
  return redisClient;
}

export function getElasticsearchClient(): ElasticsearchClient {
  if (!esClient) {
    const esConfig: any = {
      node: config.elasticsearch.url,
    };

    // Add authentication if credentials are provided
    if (process.env.ELASTIC_USERNAME && process.env.ELASTIC_PASSWORD) {
      esConfig.auth = {
        username: process.env.ELASTIC_USERNAME,
        password: process.env.ELASTIC_PASSWORD,
      };
    }

    esClient = new ElasticsearchClient(esConfig);
  }
  return esClient;
}

export async function createPostgresClient(): Promise<Client> {
  const client = new Client({
    connectionString: config.database.url,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : false,
  });
  await client.connect();
  return client;
}

export async function closeAllConnections(): Promise<void> {
  const promises: Promise<void>[] = [];

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