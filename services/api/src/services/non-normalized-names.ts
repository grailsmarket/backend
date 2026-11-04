import { getElasticsearchClient, config } from '../../../shared/src';
import { logger } from '../utils/logger';

/**
 * Names that aren't in ENSIP-15 normalized form (e.g. "Jesse.eth"), for search paths that
 * run in PostgreSQL. Postgres can't run ENS normalization, so the Elasticsearch
 * `is_normalized: false` flag is the source of truth. The set is small (a few hundred)
 * and rarely changes, so it's cached in memory.
 *
 * Fails open: if Elasticsearch is unreachable, returns the last known set (or an empty
 * one) so search keeps working, just without this filter.
 */

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_NAMES = 10000;

let cached: string[] = [];
let cachedAt = 0;
let inFlight: Promise<string[]> | null = null;

async function fetchNonNormalizedNames(): Promise<string[]> {
  const es = getElasticsearchClient();
  const result: any = await es.search({
    index: config.elasticsearch.index,
    size: MAX_NAMES,
    _source: ['name'],
    query: { term: { is_normalized: false } },
  });
  const hits = result.hits?.hits ?? [];
  if (hits.length >= MAX_NAMES) {
    logger.warn({ count: hits.length }, 'Non-normalized name set hit its size cap; some may not be filtered');
  }
  return hits.map((hit: any) => hit._source?.name).filter((name: unknown): name is string => typeof name === 'string');
}

export async function getNonNormalizedNames(): Promise<string[]> {
  if (Date.now() - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  if (!inFlight) {
    inFlight = fetchNonNormalizedNames()
      .then((names) => {
        cached = names;
        cachedAt = Date.now();
        return names;
      })
      .catch((error) => {
        logger.warn({ err: error }, 'Could not load non-normalized names; PostgreSQL search will not hide them');
        return cached;
      })
      .finally(() => {
        inFlight = null;
      });
  }

  return inFlight;
}
