import { FastifyInstance } from 'fastify';
import { getPostgresPool, getElasticsearchClient } from '../../../shared/src';
import { buildESFilters, buildESSort, calculateMinScore, ESFilterOptions } from '../utils/elasticsearch-filters';
import { requireAuth } from '../middleware/auth';
import { stringify } from 'csv-stringify';

const MAX_EXPORT_ROWS = 10000;
const BATCH_SIZE = 1000;

// CSV column headers
const CSV_HEADERS = [
  'id',
  'name',
  'token_id',
  'owner_address',
  'expiry_date',
  'status',
  'list_price',
  'registration_date',
  'clubs',
  'view_count',
];

interface ExportRow {
  id: number;
  name: string;
  token_id: string;
  owner_address: string;
  expiry_date: string | null;
  status: string;
  list_price: string | null;
  registration_date: string | null;
  clubs: string;
  view_count: number;
}

/**
 * Parse query params from bracket notation (same as search.ts)
 */
function parseSearchParams(rawQuery: any): {
  q: string;
  sortBy?: string;
  sortOrder?: string;
  filters: Record<string, any>;
} {
  const transformedQuery: any = {
    q: rawQuery.q || '',
    sortBy: rawQuery.sortBy,
    sortOrder: rawQuery.sortOrder,
    filters: {},
  };

  // Parse filters from bracket notation
  for (const key in rawQuery) {
    if (key.startsWith('filters[')) {
      const match = key.match(/filters\[([^\]]+)\](\[\])?/);
      if (match) {
        const filterName = match[1];
        const isArray = match[2] === '[]';

        if (isArray) {
          if (!transformedQuery.filters[filterName]) {
            transformedQuery.filters[filterName] = [];
          }
          const value = rawQuery[key];
          if (Array.isArray(value)) {
            const values = filterName === 'clubs' ? value.map((v: any) => String(v)) : value;
            transformedQuery.filters[filterName].push(...values);
          } else {
            const stringValue = String(value);
            if (stringValue.includes(',')) {
              const splitValues = stringValue.split(',').map(v => v.trim()).filter(v => v);
              transformedQuery.filters[filterName].push(...splitValues);
            } else {
              const val = filterName === 'clubs' ? stringValue : value;
              transformedQuery.filters[filterName].push(val);
            }
          }
        } else {
          const value = rawQuery[key];
          if (filterName === 'clubs') {
            const clubValues = Array.isArray(value) ? value : [value];
            transformedQuery.filters[filterName] = clubValues.map((c: any) => String(c));
          } else if (filterName === 'status') {
            const stringValue = String(value);
            if (stringValue.includes(',')) {
              transformedQuery.filters[filterName] = stringValue.split(',').map(v => v.trim()).filter(v => v);
            } else {
              transformedQuery.filters[filterName] = value;
            }
          } else {
            transformedQuery.filters[filterName] = value;
          }
        }
      }
    }
  }

  return transformedQuery;
}

/**
 * Resolve owner filter - converts ENS name to address if needed
 */
async function resolveOwnerAddress(owner: string | undefined, pool: any, log: any): Promise<string | null> {
  if (!owner) return null;

  const isAddress = /^0x[a-fA-F0-9]{40}$/.test(owner);
  if (isAddress) {
    return owner.toLowerCase();
  }

  try {
    const resolveQuery = `
      SELECT owner_address
      FROM ens_names
      WHERE LOWER(name) = LOWER($1)
    `;
    const resolveResult = await pool.query(resolveQuery, [owner]);

    if (resolveResult.rows.length > 0 && resolveResult.rows[0].owner_address) {
      return resolveResult.rows[0].owner_address.toLowerCase();
    }
  } catch (error: any) {
    log.error(`Error resolving ENS name "${owner}":`, error.message);
  }

  return '0x0000000000000000000000000000000000000000';
}

/**
 * Fetch ENS names from Elasticsearch using search_after for efficient pagination
 */
async function fetchNamesFromES(
  es: any,
  options: ESFilterOptions,
  maxRows: number,
  log: any
): Promise<string[]> {
  const { must, filter } = buildESFilters(options);
  const sort = buildESSort({
    sortBy: options.sortBy,
    sortOrder: options.sortOrder,
    q: options.q,
    resolvedOwnerAddress: options.resolvedOwnerAddress,
  });
  const minScore = calculateMinScore(options.q);

  // Add tie-breaker for search_after
  const sortWithTieBreaker = [...sort];
  if (!sortWithTieBreaker.some(s => s['name.keyword'])) {
    sortWithTieBreaker.push({ 'name.keyword': { order: 'asc' } });
  }

  const allNames: string[] = [];
  let searchAfter: any[] | undefined;

  while (allNames.length < maxRows) {
    const remaining = maxRows - allNames.length;
    const batchSize = Math.min(BATCH_SIZE, remaining);

    const esQuery: any = {
      index: 'ens_names',
      body: {
        query: {
          bool: {
            must: must.length > 0 ? must : [{ match_all: {} }],
            filter,
          },
        },
        size: batchSize,
        sort: sortWithTieBreaker,
      },
    };

    if (minScore !== undefined) {
      esQuery.body.min_score = minScore;
    }

    if (searchAfter) {
      esQuery.body.search_after = searchAfter;
    }

    const esResult = await es.search(esQuery);
    const hits = esResult.hits.hits;

    if (hits.length === 0) {
      break;
    }

    // Extract names (filter out placeholders)
    const names = hits
      .map((hit: any) => hit._source.name)
      .filter((name: string) => name && !name.startsWith('token-') && !name.startsWith('['));

    allNames.push(...names);

    // Get search_after value from last hit
    searchAfter = hits[hits.length - 1].sort;

    log.info(`Fetched ${names.length} names from ES (total: ${allNames.length})`);

    // If we got fewer than requested, we've reached the end
    if (hits.length < batchSize) {
      break;
    }
  }

  return allNames.slice(0, maxRows);
}

/**
 * Fetch export data from PostgreSQL for the given names
 */
async function fetchExportData(
  pool: any,
  names: string[],
  log: any
): Promise<ExportRow[]> {
  if (names.length === 0) {
    return [];
  }

  // Build placeholder list for IN clause
  const placeholders = names.map((_, i) => `$${i + 1}`).join(',');

  // Query to fetch export data with computed status and lowest active listing price
  const query = `
    SELECT
      en.id,
      en.name,
      en.token_id,
      en.owner_address,
      en.expiry_date,
      en.registration_date,
      en.clubs,
      COALESCE(en.view_count, 0) as view_count,
      MIN(CASE WHEN l.status = 'active' THEN l.price_wei END) as list_price,
      CASE
        WHEN en.expiry_date IS NULL THEN 'registered'
        WHEN en.expiry_date > NOW() THEN 'registered'
        WHEN en.expiry_date > NOW() - INTERVAL '90 days' THEN 'grace'
        WHEN en.expiry_date > NOW() - INTERVAL '111 days' THEN 'premium'
        ELSE 'available'
      END as status
    FROM ens_names en
    LEFT JOIN listings l ON l.ens_name_id = en.id
    WHERE LOWER(en.name) IN (${placeholders})
    GROUP BY en.id
  `;

  const result = await pool.query(query, names.map(n => n.toLowerCase()));

  // Create a map for ordering
  const dataMap = new Map<string, any>();
  for (const row of result.rows) {
    dataMap.set(row.name.toLowerCase(), row);
  }

  // Return results in the same order as input names
  const orderedResults: ExportRow[] = [];
  for (const name of names) {
    const row = dataMap.get(name.toLowerCase());
    if (row) {
      orderedResults.push({
        id: row.id,
        name: row.name,
        token_id: row.token_id,
        owner_address: row.owner_address,
        expiry_date: row.expiry_date ? row.expiry_date.toISOString() : null,
        status: row.status,
        list_price: row.list_price || null,
        registration_date: row.registration_date ? row.registration_date.toISOString() : null,
        clubs: Array.isArray(row.clubs) ? row.clubs.join(',') : '',
        view_count: row.view_count,
      });
    }
  }

  log.info(`Fetched ${orderedResults.length} export rows from PostgreSQL`);
  return orderedResults;
}

export async function exportRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const es = getElasticsearchClient();

  // Export search results as CSV
  // GET /api/v1/export
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    const rawQuery = request.query as any;
    const { q, sortBy, sortOrder, filters } = parseSearchParams(rawQuery);
    const filename = rawQuery.filename || 'ens-export';

    const {
      minPrice,
      maxPrice,
      minOffer,
      maxOffer,
      minLength,
      maxLength,
      hasEmoji,
      hasNumbers,
      showListings,
      showUnlisted,
      clubs,
      excludeClubs,
      inAnyClub,
      isExpired,
      isGracePeriod,
      isPremiumPeriod,
      expiringWithinDays,
      hasSales,
      lastSoldAfter,
      lastSoldBefore,
      minDaysSinceLastSale,
      maxDaysSinceLastSale,
      owner,
      includeExpired,
      contains,
      startsWith,
      endsWith,
      doesNotContain,
      doesNotStartWith,
      doesNotEndWith,
      status,
      listed,
      hasOffer,
      digits,
      letters,
      emoji,
      repeatingChars,
    } = filters;

    fastify.log.info(`Export request: q="${q}", sortBy=${sortBy}, filters=${JSON.stringify(filters)}`);

    try {
      // Resolve owner address if provided
      const resolvedOwnerAddress = await resolveOwnerAddress(owner, pool, fastify.log);

      // Build filter options for Elasticsearch
      const esOptions: ESFilterOptions = {
        q,
        minPrice,
        maxPrice,
        minOffer,
        maxOffer,
        minLength,
        maxLength,
        hasEmoji,
        hasNumbers,
        digits,
        letters,
        emoji,
        repeatingChars,
        contains,
        startsWith,
        endsWith,
        doesNotContain,
        doesNotStartWith,
        doesNotEndWith,
        listed,
        showListings,
        showUnlisted,
        hasOffer,
        clubs,
        excludeClubs,
        inAnyClub,
        resolvedOwnerAddress,
        status,
        isExpired,
        isGracePeriod,
        isPremiumPeriod,
        expiringWithinDays,
        includeExpired,
        hasSales,
        lastSoldAfter,
        lastSoldBefore,
        minDaysSinceLastSale,
        maxDaysSinceLastSale,
        sortBy,
        sortOrder,
      };

      // Fetch names from Elasticsearch
      const names = await fetchNamesFromES(es, esOptions, MAX_EXPORT_ROWS, fastify.log);

      if (names.length === 0) {
        // Return empty CSV with headers
        reply.header('Content-Type', 'text/csv');
        reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
        return reply.send(CSV_HEADERS.join(',') + '\n');
      }

      // Fetch export data from PostgreSQL
      const exportData = await fetchExportData(pool, names, fastify.log);

      // Generate CSV
      const csvStringifier = stringify({
        header: true,
        columns: CSV_HEADERS,
      });

      // Collect CSV output
      const csvChunks: string[] = [];
      csvStringifier.on('data', (chunk: Buffer) => {
        csvChunks.push(chunk.toString());
      });

      // Write data rows
      for (const row of exportData) {
        csvStringifier.write([
          row.id,
          row.name,
          row.token_id,
          row.owner_address,
          row.expiry_date || '',
          row.status,
          row.list_price || '',
          row.registration_date || '',
          row.clubs,
          row.view_count,
        ]);
      }

      // End the stream and wait for completion
      await new Promise<void>((resolve, reject) => {
        csvStringifier.on('finish', resolve);
        csvStringifier.on('error', reject);
        csvStringifier.end();
      });

      const csvContent = csvChunks.join('');

      fastify.log.info(`Export complete: ${exportData.length} rows, ${csvContent.length} bytes`);

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', `attachment; filename="${filename}.csv"`);
      return reply.send(csvContent);
    } catch (error: any) {
      fastify.log.error({ error }, 'Export failed');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'EXPORT_ERROR',
          message: 'Export failed',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
