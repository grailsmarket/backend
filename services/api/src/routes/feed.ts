import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse, CURRENCY_ADDRESSES } from '../../../shared/src';
import { optionalAuth } from '../middleware/auth';
import { cacheHandler } from '../middleware/cache';
import { mutelistService } from '../services/mutelist';

const pool = getPostgresPool();

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const WEI_RE = /^\d+$/;

const KindEnum = z.enum(['activity', 'comment']);

/**
 * Unified feed query. Merges marketplace activity (activity_history) and user
 * comments into one time-ordered, paginated stream.
 *
 * Filter classes:
 *  - selector:      kinds (which streams to include; default = both)
 *  - shared:        owner, clubs, watchlist (+ list_id) — apply to both streams
 *  - activity-only: event_type, platform, min/max price — apply to the activity stream
 *
 * Auto-scope rule: when no explicit `kinds` is given, the presence of any
 * activity-only filter implicitly excludes the comment stream (comments can't
 * satisfy it). An explicit `kinds` always wins.
 */
const FeedQuerySchema = z.object({
  kinds: z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (v == null) return undefined;
      const raw = Array.isArray(v) ? v : v.split(',');
      const parsed = Array.from(
        new Set(raw.map((s) => s.trim().toLowerCase()).filter(Boolean))
      );
      return parsed.length ? parsed : undefined;
    })
    .pipe(z.array(KindEnum).min(1).max(2).optional()),

  // activity-only
  event_type: z.union([z.string(), z.array(z.string()).max(20)]).optional(),
  platform: z.union([z.string(), z.array(z.string()).max(20)]).optional(),
  min_price_wei: z.string().regex(WEI_RE, 'min_price_wei must be a decimal wei string').optional(),
  max_price_wei: z.string().regex(WEI_RE, 'max_price_wei must be a decimal wei string').optional(),

  // shared
  owner: z
    .string()
    .regex(ADDRESS_RE, 'Invalid address')
    .transform((s) => s.toLowerCase())
    .optional(),
  clubs: z.string().trim().min(1).optional(),
  watchlist: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  list_id: z.coerce.number().int().positive().optional(),

  // pagination
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const sendError = (
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown
) =>
  reply.status(status).send({
    success: false,
    error: { code, message, ...(details ? { details } : {}) },
    meta: { timestamp: new Date().toISOString() },
  });

// Normalize a multi-value query param (?x=a&x=b OR ?x=a,b) into a clean array.
function parseMulti(value: string | string[] | undefined): string[] {
  if (value == null) return [];
  const raw = Array.isArray(value) ? value : value.split(',');
  return raw.map((s) => s.trim()).filter(Boolean);
}

export async function feedRoutes(fastify: FastifyInstance) {
  /**
   * GET /api/v1/feed
   * Unified, time-ordered stream of marketplace activity + user comments.
   * Newest first. Offset-paginated with exact totals.
   */
  fastify.get(
    '/',
    { preHandler: [optionalAuth, cacheHandler] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let q: z.infer<typeof FeedQuerySchema>;
      try {
        q = FeedQuerySchema.parse(request.query);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', error.errors);
        }
        throw error;
      }

      try {
        const {
          kinds,
          event_type,
          platform,
          min_price_wei,
          max_price_wei,
          owner,
          clubs,
          watchlist,
          list_id,
          page,
          limit,
        } = q;

        // The watchlist filter needs an authenticated user to resolve their list.
        const userId = request.user ? parseInt(request.user.sub, 10) : null;
        if (watchlist && userId == null) {
          return sendError(
            reply,
            401,
            'UNAUTHORIZED',
            'Authentication required to filter the feed by watchlist'
          );
        }

        // Parse the unified `clubs` param: `any` sentinel vs a 1–10 entry list.
        let clubsAny = false;
        let clubsList: string[] | null = null;
        if (clubs) {
          const parts = clubs.split(',').map((c) => c.trim()).filter(Boolean);
          const hasAny = parts.some((p) => p.toLowerCase() === 'any');
          if (hasAny && parts.length > 1) {
            return sendError(
              reply,
              400,
              'VALIDATION_ERROR',
              'clubs=any cannot be combined with specific clubs'
            );
          }
          if (hasAny) {
            clubsAny = true;
          } else if (parts.length < 1 || parts.length > 10) {
            return sendError(reply, 400, 'VALIDATION_ERROR', 'clubs must contain 1–10 entries');
          } else {
            clubsList = parts;
          }
        }

        const eventTypes = parseMulti(event_type);
        const platforms = parseMulti(platform);
        const hasActivityOnlyFilter =
          eventTypes.length > 0 ||
          platforms.length > 0 ||
          min_price_wei !== undefined ||
          max_price_wei !== undefined;

        // Decide which branches run.
        let includeActivity: boolean;
        let includeComment: boolean;
        if (kinds && kinds.length > 0) {
          includeActivity = kinds.includes('activity');
          includeComment = kinds.includes('comment');
          // Contradiction: an activity-only filter on a comment-only stream.
          if (includeComment && !includeActivity && hasActivityOnlyFilter) {
            return sendError(
              reply,
              400,
              'VALIDATION_ERROR',
              'event_type, platform, and price filters cannot be combined with kinds=comment'
            );
          }
        } else {
          includeActivity = true;
          // Auto-scope: an activity-only filter implicitly excludes comments.
          includeComment = !hasActivityOnlyFilter;
        }

        // --- Build the shared parameter array. Both the UNION ALL data query and
        // the count query reference these same $n positions; limit/offset go last
        // so the count can reuse params.slice(0, -2). ---
        const params: any[] = [];
        const push = (v: any) => {
          params.push(v);
          return `$${params.length}`;
        };

        const mutedAddresses = mutelistService.getMutedAddresses();
        const hasMuted = mutedAddresses.length > 0;
        const mutedPh = hasMuted ? push(mutedAddresses) : '';
        const ownerPh = owner ? push(owner) : '';
        const clubsPh = clubsList ? push(clubsList) : '';

        let wlUserPh = '';
        let wlListPh = '';
        if (watchlist && userId != null) {
          wlUserPh = push(userId);
          if (list_id != null) wlListPh = push(list_id);
        }

        // Activity-only params are only referenced by the activity branch.
        const etPhs: string[] = [];
        const pPhs: string[] = [];
        let priceClause = '';
        if (includeActivity) {
          for (const et of eventTypes) etPhs.push(push(et));
          for (const p of platforms) pPhs.push(push(p));
          const minPh = min_price_wei !== undefined ? push(min_price_wei) : '';
          const maxPh = max_price_wei !== undefined ? push(max_price_wei) : '';
          const priceConds: string[] = [];
          if (minPh) priceConds.push(`CAST(ah.price_wei AS NUMERIC) >= ${minPh}`);
          if (maxPh) priceConds.push(`CAST(ah.price_wei AS NUMERIC) <= ${maxPh}`);
          if (priceConds.length > 0) {
            const ethPh = push(CURRENCY_ADDRESSES.ETH.toLowerCase());
            const wethPh = push(CURRENCY_ADDRESSES.WETH.toLowerCase());
            // Price bounds apply only to ETH/WETH-denominated priced events.
            // No-price events (pure transfers, etc.) always pass through.
            priceClause = `(ah.price_wei IS NULL OR ((ah.currency_address IS NULL OR LOWER(ah.currency_address) IN (${ethPh}, ${wethPh})) AND ${priceConds.join(' AND ')}))`;
          }
        }

        const watchlistActive = watchlist && userId != null;
        const wlClause = (col: string) =>
          wlListPh
            ? `${col} IN (SELECT ens_name_id FROM watchlist WHERE user_id = ${wlUserPh} AND list_id = ${wlListPh})`
            : `${col} IN (SELECT ens_name_id FROM watchlist WHERE user_id = ${wlUserPh})`;

        // --- Activity branch predicates. actShared is identical across the data
        // and count queries; owner/clubs diverge (direct en.* vs semi-join so the
        // count can drop the ens_names JOIN). ---
        const actShared: string[] = [];
        if (etPhs.length) actShared.push(`ah.event_type IN (${etPhs.join(', ')})`);
        if (pPhs.length) actShared.push(`ah.platform IN (${pPhs.join(', ')})`);
        if (priceClause) actShared.push(priceClause);
        if (hasMuted) {
          actShared.push(`ah.actor_address != ALL(${mutedPh})`);
          actShared.push(`(ah.counterparty_address IS NULL OR ah.counterparty_address != ALL(${mutedPh}))`);
        }
        if (watchlistActive) actShared.push(wlClause('ah.ens_name_id'));

        const actData = [...actShared];
        const actCount = [...actShared];
        if (owner) {
          actData.push(`en.owner_address = ${ownerPh}`);
          actCount.push(`ah.ens_name_id IN (SELECT id FROM ens_names WHERE owner_address = ${ownerPh})`);
        }
        if (clubsAny) {
          actData.push(`(en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0)`);
          actCount.push(`ah.ens_name_id IN (SELECT id FROM ens_names WHERE clubs IS NOT NULL AND array_length(clubs, 1) > 0)`);
        } else if (clubsList) {
          actData.push(`en.clubs && ${clubsPh}::text[]`);
          actCount.push(`ah.ens_name_id IN (SELECT id FROM ens_names WHERE clubs && ${clubsPh}::text[])`);
        }

        // --- Comment branch predicates. Always restricted to visible comments. ---
        const comShared: string[] = [`c.status = 'visible'`];
        if (watchlistActive) comShared.push(wlClause('c.ens_name_id'));

        const comData = [...comShared];
        const comCount = [...comShared];
        if (hasMuted) {
          comData.push(`u.address != ALL(${mutedPh})`);
          comCount.push(`NOT EXISTS (SELECT 1 FROM users mu WHERE mu.id = c.user_id AND mu.address = ANY(${mutedPh}))`);
        }
        if (owner) {
          comData.push(`en.owner_address = ${ownerPh}`);
          comCount.push(`c.ens_name_id IN (SELECT id FROM ens_names WHERE owner_address = ${ownerPh})`);
        }
        if (clubsAny) {
          comData.push(`(en.clubs IS NOT NULL AND array_length(en.clubs, 1) > 0)`);
          comCount.push(`c.ens_name_id IN (SELECT id FROM ens_names WHERE clubs IS NOT NULL AND array_length(clubs, 1) > 0)`);
        } else if (clubsList) {
          comData.push(`en.clubs && ${clubsPh}::text[]`);
          comCount.push(`c.ens_name_id IN (SELECT id FROM ens_names WHERE clubs && ${clubsPh}::text[])`);
        }

        // Pagination params. `cap` (= offset + limit) bounds each branch's inner
        // top-N so the merge only ever sorts a few rows. filterParamCount marks the
        // boundary so the count query can reuse exactly the filter params.
        const offset = (page - 1) * limit;
        const cap = offset + limit;
        const filterParamCount = params.length;
        const capPh = push(cap);
        const limitPh = push(limit);
        const offsetPh = push(offset);

        // --- Assemble the normalized branch SELECTs. Every column is cast to a
        // type compatible across both branches so UNION ALL type-unification holds.
        // Each branch carries its own `ORDER BY <table>.created_at DESC LIMIT cap`
        // so Postgres serves it as an index-driven top-N (no full-table sort). The
        // outer query then merges/orders only the (<= 2 * cap) capped rows. ---
        const activitySelect = `(
          SELECT
            'activity'::text                       AS kind,
            0                                      AS kind_rank,
            ah.id                                  AS activity_id,
            NULL::uuid                             AS comment_id,
            ah.ens_name_id                         AS ens_name_id,
            en.name                                AS name,
            en.clubs                               AS clubs,
            en.owner_address                       AS owner_address,
            timezone('UTC', ah.created_at)         AS created_at,
            ah.event_type::text                    AS event_type,
            ah.actor_address                       AS actor_address,
            ah.counterparty_address                AS counterparty_address,
            ah.platform                            AS platform,
            ah.chain_id                            AS chain_id,
            ah.price_wei                           AS price_wei,
            ah.currency_address                    AS currency_address,
            ah.transaction_hash                    AS transaction_hash,
            ah.block_number                        AS block_number,
            ah.metadata                            AS metadata,
            en.token_id                            AS token_id,
            NULL::text                             AS body,
            NULL::varchar                          AS author_address
          FROM activity_history ah
          JOIN ens_names en ON en.id = ah.ens_name_id
          ${actData.length ? `WHERE ${actData.join(' AND ')}` : ''}
          ORDER BY ah.created_at DESC, ah.id DESC
          LIMIT ${capPh}
        )`;

        const commentSelect = `(
          SELECT
            'comment'::text                        AS kind,
            1                                      AS kind_rank,
            NULL::integer                          AS activity_id,
            c.id                                   AS comment_id,
            c.ens_name_id                          AS ens_name_id,
            en.name                                AS name,
            en.clubs                               AS clubs,
            en.owner_address                       AS owner_address,
            timezone('UTC', c.created_at)          AS created_at,
            NULL::text                             AS event_type,
            NULL::varchar                          AS actor_address,
            NULL::varchar                          AS counterparty_address,
            NULL::varchar                          AS platform,
            NULL::integer                          AS chain_id,
            NULL::varchar                          AS price_wei,
            NULL::varchar                          AS currency_address,
            NULL::varchar                          AS transaction_hash,
            NULL::bigint                           AS block_number,
            NULL::jsonb                            AS metadata,
            NULL::varchar                          AS token_id,
            COALESCE(c.body_censored, c.body)      AS body,
            u.address                              AS author_address
          FROM comments c
          JOIN users u ON u.id = c.user_id
          JOIN ens_names en ON en.id = c.ens_name_id
          WHERE ${comData.join(' AND ')}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT ${capPh}
        )`;

        const branches: string[] = [];
        if (includeActivity) branches.push(activitySelect);
        if (includeComment) branches.push(commentSelect);

        const dataQuery = `
          SELECT * FROM (
            ${branches.join('\n          UNION ALL\n')}
          ) feed
          ORDER BY feed.created_at DESC,
                   feed.kind_rank ASC,
                   feed.activity_id DESC NULLS LAST,
                   feed.comment_id DESC NULLS LAST
          LIMIT ${limitPh} OFFSET ${offsetPh}`;

        // Exact total = activity_count + comment_count, each mirroring its branch.
        // An excluded branch contributes a literal 0 (its subquery never runs).
        const activityCount = includeActivity
          ? `(SELECT COUNT(*) FROM activity_history ah ${actCount.length ? `WHERE ${actCount.join(' AND ')}` : ''})`
          : '0';
        const commentCount = includeComment
          ? `(SELECT COUNT(*) FROM comments c WHERE ${comCount.join(' AND ')})`
          : '0';
        const countQuery = `SELECT ${activityCount} + ${commentCount} AS total`;

        // Run both queries on a single pooled connection with parallel query
        // disabled (SET LOCAL auto-reverts on COMMIT). This UNION ALL touches two
        // large tables and two ens_names joins, making it especially prone to the
        // parallel-worker DSM exhaustion ("could not resize shared memory segment")
        // that hits these feed queries under concurrent load. Same guard as the
        // activity endpoint.
        const client = await pool.connect();
        let result;
        let countResult;
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL max_parallel_workers_per_gather = 0');
          result = await client.query(dataQuery, params);
          countResult = await client.query(countQuery, params.slice(0, filterParamCount));
          await client.query('COMMIT');
        } catch (txError) {
          await client.query('ROLLBACK').catch(() => {});
          throw txError;
        } finally {
          client.release();
        }

        const items = result.rows.map((r: any) => {
          const base = {
            kind: r.kind,
            id: r.kind === 'activity' ? r.activity_id : r.comment_id,
            ens_name_id: r.ens_name_id,
            name: r.name,
            clubs: r.clubs,
            owner_address: r.owner_address,
            created_at: r.created_at,
          };
          if (r.kind === 'activity') {
            return {
              ...base,
              activity: {
                event_type: r.event_type,
                actor_address: r.actor_address,
                counterparty_address: r.counterparty_address,
                platform: r.platform,
                chain_id: r.chain_id,
                price_wei: r.price_wei,
                currency_address: r.currency_address,
                transaction_hash: r.transaction_hash,
                block_number: r.block_number,
                metadata: r.metadata,
                token_id: r.token_id,
              },
            };
          }
          return {
            ...base,
            comment: {
              body: r.body,
              author_address: r.author_address,
            },
          };
        });

        const total = parseInt(countResult.rows[0].total, 10);
        const totalPages = Math.max(1, Math.ceil(total / limit));

        const response: APIResponse = {
          success: true,
          data: {
            results: items,
            pagination: {
              page,
              limit,
              total,
              totalPages,
              hasNext: page < totalPages,
              hasPrev: page > 1,
            },
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        };

        return reply.send(response);
      } catch (error: any) {
        // Log full error server-side; return a generic, stable message to clients.
        fastify.log.error('Error fetching unified feed:', error);
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch feed');
      }
    }
  );
}
