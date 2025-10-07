import { Pool, Client } from 'pg';
import type { RedisClientType } from 'redis';
import { Client as ElasticsearchClient } from '@elastic/elasticsearch';
export declare function getPostgresPool(): Pool;
export declare function getRedisClient(): Promise<RedisClientType>;
export declare function getElasticsearchClient(): ElasticsearchClient;
export declare function createPostgresClient(): Promise<Client>;
export declare function closeAllConnections(): Promise<void>;
//# sourceMappingURL=client.d.ts.map