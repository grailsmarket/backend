import { Pool, Client } from 'pg';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
import config from '../config';

let pgPool: Pool | null = null;
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

    pgPool.on('connect', (client) => {
      // Container /dev/shm is too small for parallel-query DSM segments; disabling
      // parallelism pool-wide prevents "could not resize shared memory segment /
      // No space left on device" failures across all services. Replaces the
      // per-endpoint SET LOCAL guards in api/src/routes/activity.ts & feed.ts.
      client.query('SET max_parallel_workers_per_gather = 0').catch((err) => {
        console.error('Failed to disable parallel query on new connection', err);
      });
    });
  }
  return pgPool;
}

export function getElasticsearchClient(): ElasticsearchClient {
  if (!esClient) {
    const esConfig: any = {
      node: config.elasticsearch.url,
      requestTimeout: 300000, // 5 minutes for bulk operations
      maxRetries: 3,
      sniffOnStart: false,
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

  await Promise.all(promises);
}