import Redis from 'ioredis';
import { config } from '../../../shared/src';

const redis = new Redis(config.redis.url);

async function list(pattern: string) {
  const keys = await redis.keys(pattern);
  if (keys.length === 0) {
    console.log('No keys found.');
    return;
  }

  keys.sort();
  console.log(`Found ${keys.length} key(s):\n`);

  const pipeline = redis.pipeline();
  for (const key of keys) {
    pipeline.ttl(key);
    pipeline.strlen(key);
  }
  const results = await pipeline.exec();
  if (!results) return;

  for (let i = 0; i < keys.length; i++) {
    const ttl = results[i * 2][1] as number;
    const size = results[i * 2 + 1][1] as number;
    const ttlStr = ttl === -1 ? 'no expiry' : ttl === -2 ? 'expired' : `${ttl}s`;
    console.log(`  ${keys[i]}  (TTL: ${ttlStr}, ${size} bytes)`);
  }
}

async function get(key: string, full: boolean) {
  const value = await redis.get(key);
  if (value === null) {
    console.log(`Key not found: ${key}`);
    return;
  }

  if (full || value.length <= 500) {
    console.log(value);
  } else {
    console.log(value.slice(0, 500) + `\n\n... truncated (${value.length} chars total, use --full to see all)`);
  }
}

async function del(pattern: string) {
  const keys = await redis.keys(`cache:*${pattern}*`);
  if (keys.length === 0) {
    console.log('No matching keys found.');
    return;
  }

  for (const key of keys) {
    console.log(`  Deleted: ${key}`);
  }
  await redis.del(...keys);
  console.log(`\nDeleted ${keys.length} key(s).`);
}

async function flush() {
  const keys = await redis.keys('cache:*');
  if (keys.length === 0) {
    console.log('No cache keys found.');
    return;
  }

  await redis.del(...keys);
  console.log(`Flushed ${keys.length} cache key(s).`);
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  try {
    switch (command) {
      case 'list': {
        const pattern = args[0] ? `cache:*${args[0]}*` : 'cache:*';
        await list(pattern);
        break;
      }
      case 'get': {
        const key = args[0];
        if (!key) {
          console.error('Usage: redis-cache get <key> [--full]');
          process.exit(1);
        }
        const full = args.includes('--full');
        await get(key, full);
        break;
      }
      case 'delete': {
        const pattern = args[0];
        if (!pattern) {
          console.error('Usage: redis-cache delete <pattern>');
          process.exit(1);
        }
        await del(pattern);
        break;
      }
      case 'flush': {
        await flush();
        break;
      }
      default:
        console.log('Usage: redis-cache <command> [args]\n');
        console.log('Commands:');
        console.log('  list [pattern]     List cache keys (default: all)');
        console.log('  get <key> [--full] Print cached value');
        console.log('  delete <pattern>   Delete keys matching cache:*<pattern>*');
        console.log('  flush              Delete all cache:* keys');
        process.exit(command ? 1 : 0);
    }
  } catch (error: any) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  } finally {
    await redis.quit();
  }
}

main();
