import type { FastifyInstance } from 'fastify';
import { getPostgresPool, getElasticsearchClient, type APIResponse } from '../../../shared/src';
import { buildSearchResults } from '../utils/response-builder';
import { buildESFilters, buildESSort } from '../utils/elasticsearch-filters';
import { optionalAuth } from '../middleware/auth';
import { cacheHandler } from '../middleware/cache';
import { generateSemanticExpansions, OPENAI_MODEL_NAME } from '../services/openai';

/** Cache TTL in days for search expansions */
const CACHE_TTL_DAYS = 30;

export async function aiSearchRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const es = getElasticsearchClient();

  /**
   * GET /
   * (Mounted at /api/v1/ai/search/semantic)
   *
   * Semantic search: expands a query into ~30 associated words via AI,
   * then searches ES for all of them.
   * Cached expansions are public. Generating fresh expansions requires auth.
   * Rate limited to 30 req/min per IP.
   */
  fastify.get('/', {
    preHandler: [optionalAuth, cacheHandler],
    config: { rateLimit: { max: 30, timeWindow: 60_000 } },
  }, async (request, reply) => {
    const rawQuery = request.query as any;

    // Validate required query parameter
    const q = (rawQuery.q || '').trim();
    if (!q || q.length < 2) {
      const response: APIResponse = {
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Query parameter "q" is required and must be at least 2 characters',
        },
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(400).send(response);
    }

    const page = parseInt(rawQuery.page || '1', 10);
    const limit = Math.min(parseInt(rawQuery.limit || '20', 10), 100);
    const sortBy = rawQuery.sortBy;
    const sortOrder = rawQuery.sortOrder;
    const from = (page - 1) * limit;

    // Parse filters from bracket notation (same as search.ts)
    const filters: any = {};
    for (const key in rawQuery) {
      if (key.startsWith('filters[')) {
        const match = key.match(/filters\[([^\]]+)\](\[\])?/);
        if (match) {
          const filterName = match[1];
          const isArray = match[2] === '[]';

          if (isArray) {
            if (!filters[filterName]) filters[filterName] = [];
            const value = rawQuery[key];
            if (Array.isArray(value)) {
              const values = filterName === 'clubs' ? value.map((v: any) => String(v)) : value;
              filters[filterName].push(...values);
            } else {
              const stringValue = String(value);
              if (stringValue.includes(',')) {
                filters[filterName].push(...stringValue.split(',').map((v: string) => v.trim()).filter((v: string) => v));
              } else {
                filters[filterName].push(filterName === 'clubs' ? stringValue : value);
              }
            }
          } else {
            const value = rawQuery[key];
            if (filterName === 'clubs') {
              filters[filterName] = (Array.isArray(value) ? value : [value]).map((c: any) => String(c));
            } else if (filterName === 'status') {
              const stringValue = String(value);
              filters[filterName] = stringValue.includes(',')
                ? stringValue.split(',').map((v: string) => v.trim()).filter((v: string) => v)
                : value;
            } else {
              filters[filterName] = value;
            }
          }
        }
      }
    }

    const normalizedQuery = q.toLowerCase();

    try {
      // Step 1: Check PostgreSQL cache for expansions
      const cached = await pool.query(
        `SELECT expansions FROM ai_search_expansions
         WHERE query = $1 AND expires_at > NOW()`,
        [normalizedQuery]
      );

      let expansions: string[];

      if (cached.rows.length > 0) {
        // Cache hit
        const raw = cached.rows[0].expansions;
        expansions = Array.isArray(raw) ? raw.filter((w: any) => typeof w === 'string') : [];
        fastify.log.info(`Semantic search cache HIT for "${normalizedQuery}": ${expansions.length} expansions`);
      } else {
        // Cache miss: only authenticated users can generate new expansions
        if (!request.user) {
          const response: APIResponse = {
            success: false,
            error: {
              code: 'UNAUTHORIZED',
              message: 'Log in to use semantic search',
            },
            meta: { timestamp: new Date().toISOString() },
          };
          return reply.status(401).send(response);
        }

        fastify.log.info(`Semantic search cache MISS for "${normalizedQuery}", generating expansions...`);
        const generated = await generateSemanticExpansions(normalizedQuery);

        if (!generated || generated.length === 0) {
          return reply.send({
            success: true,
            data: {
              results: [],
              pagination: { page, limit, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
            },
            meta: {
              timestamp: new Date().toISOString(),
              expansionsCount: 0,
              keywordTotal: 0,
              semanticTotal: 0,
            },
          });
        }

        expansions = generated;

        // UPSERT to cache with 30-day TTL
        const expiresAt = new Date(Date.now() + CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
        await pool.query(
          `INSERT INTO ai_search_expansions (query, expansions, model, expires_at, updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (query)
           DO UPDATE SET
             expansions = EXCLUDED.expansions,
             model = EXCLUDED.model,
             expires_at = EXCLUDED.expires_at,
             updated_at = NOW()`,
          [normalizedQuery, JSON.stringify(expansions), OPENAI_MODEL_NAME, expiresAt]
        );

        fastify.log.info(`Semantic search cached ${expansions.length} expansions for "${normalizedQuery}"`);
      }

      // Step 2: Build filter options from parsed filters
      const {
        minPrice, maxPrice, minOffer, maxOffer, minLength, maxLength,
        hasEmoji, hasNumbers, digits, letters, emoji, repeatingChars,
        contains, startsWith, endsWith, doesNotContain, doesNotStartWith, doesNotEndWith,
        listed, showListings, showUnlisted, hasOffer,
        clubs, excludeClubs, inAnyClub,
        status, isExpired, isGracePeriod, isPremiumPeriod, expiringWithinDays, includeExpired,
        hasSales, lastSoldAfter, lastSoldBefore, minDaysSinceLastSale, maxDaysSinceLastSale,
        minCreationDate, maxCreationDate, owner,
      } = filters;

      // Resolve owner filter
      let resolvedOwnerAddress: string | null = null;
      if (owner) {
        const isAddress = /^0x[a-fA-F0-9]{40}$/.test(owner);
        if (isAddress) {
          resolvedOwnerAddress = owner.toLowerCase();
        } else {
          try {
            const resolveResult = await pool.query(
              `SELECT owner_address FROM ens_names WHERE LOWER(name) = LOWER($1)`,
              [owner]
            );
            resolvedOwnerAddress = resolveResult.rows.length > 0 && resolveResult.rows[0].owner_address
              ? resolveResult.rows[0].owner_address.toLowerCase()
              : '0x0000000000000000000000000000000000000000';
          } catch {
            resolvedOwnerAddress = '0x0000000000000000000000000000000000000000';
          }
        }
      }

      const filterOptions = {
        minPrice, maxPrice, minOffer, maxOffer, minLength, maxLength,
        hasEmoji, hasNumbers, digits, letters, emoji, repeatingChars,
        contains, startsWith, endsWith, doesNotContain, doesNotStartWith, doesNotEndWith,
        listed, showListings, showUnlisted, hasOffer,
        clubs, excludeClubs, inAnyClub,
        status, isExpired, isGracePeriod, isPremiumPeriod, expiringWithinDays, includeExpired,
        hasSales, lastSoldAfter, lastSoldBefore, minDaysSinceLastSale, maxDaysSinceLastSale,
        minCreationDate, maxCreationDate, resolvedOwnerAddress,
      };

      // Step 3: Build and run semantic ES query
      const { filter: semanticFilter } = buildESFilters({ ...filterOptions, sortBy });
      const semanticSort = buildESSort({ sortBy, sortOrder, q: undefined, resolvedOwnerAddress });

      // Combine all expansion terms into single bulk queries instead of
      // per-term nested bools. Per-term prefix/ngram queries rewrite into
      // thousands of internal clauses and blow past ES maxClauseCount (1024).
      const allTermsSpaced = expansions.join(' ');
      const allTermsWithEth = expansions.map(t => `${t}.eth`);

      const semanticMust = [{
        bool: {
          should: [
            // Exact .eth matches — single terms query for all expansions
            { terms: { 'name.keyword': allTermsWithEth, boost: 100 } },
            // Analyzed match across all terms (OR by default)
            { match: { name: { query: allTermsSpaced, boost: 10 } } },
            // Ngram match across all terms
            { match: { 'name.ngram': { query: allTermsSpaced, boost: 1 } } },
          ],
          minimum_should_match: 1,
        }
      }];

      const semanticESQuery = {
        index: 'ens_names',
        body: {
          query: {
            bool: {
              must: semanticMust,
              filter: semanticFilter,
            },
          },
          from,
          size: limit,
          sort: semanticSort,
        },
      };

      const esResult = await es.search(semanticESQuery);

      // Step 4: Extract names from results
      const ensNames: string[] = esResult.hits.hits
        .map((hit: any) => hit._source.name as string)
        .filter((name: string) => name && !name.startsWith('token-') && !name.startsWith('['));

      const semanticTotal = typeof esResult.hits.total === 'object'
        ? esResult.hits.total.value
        : (esResult.hits.total || 0);

      if (ensNames.length === 0) {
        return reply.send({
          success: true,
          data: {
            results: [],
            pagination: { page, limit, total: 0, totalPages: 0, hasNext: false, hasPrev: false },
          },
          meta: {
            timestamp: new Date().toISOString(),
            expansionsCount: expansions.length,
            semanticTotal,
          },
        });
      }

      // Step 5: Enrich via buildSearchResults
      const userId = request.user ? parseInt(request.user.sub) : undefined;
      const results = await buildSearchResults(ensNames, userId);

      const totalPages = Math.ceil(semanticTotal / limit);

      return reply.send({
        success: true,
        data: {
          results,
          pagination: {
            page,
            limit,
            total: semanticTotal,
            totalPages,
            hasNext: page < totalPages,
            hasPrev: page > 1,
          },
        },
        meta: {
          timestamp: new Date().toISOString(),
          expansionsCount: expansions.length,
          semanticTotal,
        },
      });
    } catch (error) {
      fastify.log.error({ err: error, query: normalizedQuery }, 'Semantic search failed');
      const response: APIResponse = {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Semantic search failed',
        },
        meta: { timestamp: new Date().toISOString() },
      };
      return reply.status(500).send(response);
    }
  });
}
