import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/auth';
import {
  sanitizeCommentBody,
  invalidateBlacklistCache,
} from '../services/commentSanitizer';
import {
  getCommentConfig,
  getQuotaCap,
  getQuotaSnapshot,
  getQuotaUsed,
} from '../services/commentQuota';

const ENS_NAME_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;

const ListCommentsQuerySchema = z.object({
  name: z.string().regex(ENS_NAME_RE, 'Invalid ENS name'),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const CreateCommentSchema = z.object({
  name: z.string().regex(ENS_NAME_RE, 'Invalid ENS name'),
  body: z.string().min(1).max(2000),
});

const AdminListQuerySchema = z.object({
  author: z.string().optional(),
  name: z.string().optional(),
  status: z.enum(['visible', 'deleted', 'hidden', 'all']).default('all'),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const DeleteReasonSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const SuspendSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(7),
  reason: z.string().trim().min(1).max(500),
});

const BanSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const BlacklistAddSchema = z.object({
  term: z.string().trim().min(1).max(100),
  action: z.enum(['censor', 'block']).default('censor'),
});

const ConfigPatchSchema = z.object({
  warning_threshold: z.coerce.number().int().min(1).max(100).optional(),
  suspension_threshold: z.coerce.number().int().min(1).max(100).optional(),
  suspension_window_days: z.coerce.number().int().min(1).max(365).optional(),
  default_suspension_days: z.coerce.number().int().min(1).max(365).optional(),
  quota_cap: z.coerce.number().int().min(1).max(10000).optional(),
  quota_floor: z.coerce.number().int().min(0).max(10000).optional(),
  quota_names_weight: z.coerce.number().min(0).max(1000).optional(),
  quota_listings_weight: z.coerce.number().min(0).max(1000).optional(),
  quota_eth_weight: z.coerce.number().min(0).max(1000).optional(),
  max_comment_length: z.coerce.number().int().min(10).max(5000).optional(),
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

const ok = <T>(data: T): APIResponse<T> => ({
  success: true,
  data,
  meta: { timestamp: new Date().toISOString(), version: '1.0.0' },
});

interface UserStatusRow {
  user_id: number;
  status: 'active' | 'warned' | 'suspended' | 'banned';
  suspended_until: Date | null;
  deletion_count_30d: number;
}

async function getUserModStatus(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number
): Promise<UserStatusRow | null> {
  const r = await pool.query<UserStatusRow>(
    `SELECT user_id, status, suspended_until, deletion_count_30d
       FROM comment_user_status WHERE user_id = $1`,
    [userId]
  );
  return r.rows[0] ?? null;
}

async function insertModerationNotification(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number,
  type:
    | 'comment_warning'
    | 'comment_suspended'
    | 'comment_banned'
    | 'comment_unbanned'
    | 'comment_deleted',
  ensNameId: number | null,
  metadata: Record<string, unknown>
): Promise<void> {
  await pool.query(
    `INSERT INTO notifications (user_id, type, ens_name_id, metadata, sent_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [userId, type, ensNameId, JSON.stringify(metadata)]
  );
}

// Recompute deletion_count_30d from the comments table; this is the source
// of truth. Keeps the denormalized counter honest even if rows were deleted
// out-of-band or counts drift after config changes.
async function recomputeDeletionCount(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number,
  windowDays: number
): Promise<number> {
  const r = await pool.query(
    `SELECT COUNT(*)::int AS c FROM comments
      WHERE user_id = $1
        AND status = 'deleted'
        AND deleted_at > NOW() - ($2 || ' days')::interval`,
    [userId, windowDays]
  );
  return r.rows[0]?.c ?? 0;
}

async function upsertUserStatus(
  pool: ReturnType<typeof getPostgresPool>,
  userId: number,
  fields: Partial<{
    status: 'active' | 'warned' | 'suspended' | 'banned';
    suspended_until: Date | null;
    deletion_count_30d: number;
    last_warned_at: Date | null;
    last_action_by: number | null;
    last_action_reason: string | null;
  }>
): Promise<void> {
  // Build a dynamic UPDATE/INSERT — only writes fields the caller passed.
  const cols: string[] = [];
  const vals: unknown[] = [userId];
  for (const [k, v] of Object.entries(fields)) {
    cols.push(k);
    vals.push(v);
  }
  if (cols.length === 0) return;

  const setClause = cols
    .map((c, i) => `${c} = $${i + 2}`)
    .join(', ');
  const insertCols = ['user_id', ...cols].join(', ');
  const insertPlaceholders = vals.map((_, i) => `$${i + 1}`).join(', ');

  await pool.query(
    `INSERT INTO comment_user_status (${insertCols})
     VALUES (${insertPlaceholders})
     ON CONFLICT (user_id) DO UPDATE SET ${setClause}, updated_at = NOW()`,
    vals
  );
}

export async function commentsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/comments
   * Cursor-paginated visible comments for an ENS name. Newest first.
   */
  fastify.get('/', { preHandler: optionalAuth }, async (request, reply) => {
    try {
      const { name, cursor, limit } = ListCommentsQuerySchema.parse(request.query);

      const ensResult = await pool.query(
        `SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)`,
        [name]
      );
      if (ensResult.rows.length === 0) {
        return sendError(reply, 404, 'NAME_NOT_FOUND', 'ENS name not found');
      }
      const ensNameId = ensResult.rows[0].id as number;

      const params: unknown[] = [ensNameId, limit];
      let cursorClause = '';
      if (cursor) {
        params.push(cursor);
        cursorClause = `AND c.created_at < $3`;
      }

      const result = await pool.query(
        `SELECT c.id,
                c.ens_name_id,
                c.user_id,
                COALESCE(c.body_censored, c.body) AS body,
                c.created_at,
                c.updated_at,
                u.address AS author_address,
                u.persona_id AS author_persona_id
           FROM comments c
           JOIN users u ON u.id = c.user_id
          WHERE c.ens_name_id = $1
            AND c.status = 'visible'
            ${cursorClause}
          ORDER BY c.created_at DESC, c.id DESC
          LIMIT $2`,
        params
      );

      const comments = result.rows;
      const nextCursor =
        comments.length === limit
          ? new Date(comments[comments.length - 1].created_at).toISOString()
          : null;

      return reply.send(
        ok({
          comments,
          nextCursor,
        })
      );
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', error.errors);
      }
      fastify.log.error({ error }, 'Error listing comments');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list comments');
    }
  });

  /**
   * GET /api/v1/comments/quota
   * Returns the caller's current quota usage. Used by the composer UI.
   */
  fastify.get('/quota', { preHandler: requireAuth }, async (request, reply) => {
    try {
      const userId = parseInt(request.user!.sub, 10);
      const address = request.user!.address;
      const snapshot = await getQuotaSnapshot(userId, address);
      return reply.send(ok(snapshot));
    } catch (error: unknown) {
      fastify.log.error({ error }, 'Error fetching comment quota');
      return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch quota');
    }
  });

  /**
   * POST /api/v1/comments
   * Create a comment. Auth required. Sanitization, blacklist, mod-status, and
   * quota checks all run before insert.
   */
  fastify.post(
    '/',
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 30, timeWindow: 60_000 } },
    },
    async (request, reply) => {
      try {
        const body = CreateCommentSchema.parse(request.body);
        const userId = parseInt(request.user!.sub, 10);
        const address = request.user!.address;

        if (!Number.isFinite(userId)) {
          return sendError(reply, 401, 'INVALID_TOKEN', 'Invalid user id');
        }

        const ensResult = await pool.query(
          `SELECT id FROM ens_names WHERE LOWER(name) = LOWER($1)`,
          [body.name]
        );
        if (ensResult.rows.length === 0) {
          return sendError(reply, 404, 'NAME_NOT_FOUND', 'ENS name not found');
        }
        const ensNameId = ensResult.rows[0].id as number;

        // Mod status gate
        const modStatus = await getUserModStatus(pool, userId);
        if (modStatus?.status === 'banned') {
          return sendError(
            reply,
            403,
            'COMMENT_BANNED',
            'You are permanently banned from commenting'
          );
        }
        if (
          modStatus?.status === 'suspended' &&
          modStatus.suspended_until &&
          new Date(modStatus.suspended_until) > new Date()
        ) {
          return sendError(
            reply,
            403,
            'COMMENT_SUSPENDED',
            `You are suspended from commenting until ${new Date(
              modStatus.suspended_until
            ).toISOString()}`,
            { suspendedUntil: modStatus.suspended_until }
          );
        }

        // Sanitize + blacklist
        const config = await getCommentConfig();
        const sanitized = await sanitizeCommentBody(body.body, {
          maxLength: config.max_comment_length,
        });
        if (sanitized.status === 'rejected') {
          return sendError(reply, 400, 'INVALID_BODY', sanitized.reason);
        }

        // Quota gate
        const [quotaCap, quotaUsed] = await Promise.all([
          getQuotaCap(address, config),
          getQuotaUsed(userId),
        ]);
        if (quotaUsed >= quotaCap) {
          return sendError(
            reply,
            429,
            'QUOTA_EXCEEDED',
            `Daily comment limit reached (${quotaCap}). Try again later.`,
            { used: quotaUsed, max: quotaCap }
          );
        }

        const inserted = await pool.query(
          `INSERT INTO comments (ens_name_id, user_id, body, body_censored)
           VALUES ($1, $2, $3, $4)
           RETURNING id, ens_name_id, user_id,
                     COALESCE(body_censored, body) AS body,
                     created_at, updated_at`,
          [ensNameId, userId, sanitized.body, sanitized.bodyCensored]
        );

        // Attach author info to match GET shape
        const userRow = await pool.query(
          `SELECT address, persona_id FROM users WHERE id = $1`,
          [userId]
        );

        const comment = {
          ...inserted.rows[0],
          author_address: userRow.rows[0]?.address,
          author_persona_id: userRow.rows[0]?.persona_id,
        };

        return reply.status(201).send(
          ok({
            comment,
            quota: {
              used: quotaUsed + 1,
              max: quotaCap,
              remaining: Math.max(0, quotaCap - (quotaUsed + 1)),
            },
          })
        );
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(
            reply,
            400,
            'VALIDATION_ERROR',
            'Invalid request body',
            error.errors
          );
        }
        fastify.log.error({ error }, 'Error creating comment');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to create comment');
      }
    }
  );

  // ===========================================================================
  // Admin endpoints
  // ===========================================================================

  /**
   * GET /api/v1/comments/admin
   * Chronological list with filters by author, name, date, status.
   */
  fastify.get(
    '/admin',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const q = AdminListQuerySchema.parse(request.query);

        const where: string[] = [];
        const params: unknown[] = [];
        let i = 0;
        const next = () => {
          i += 1;
          return `$${i}`;
        };

        if (q.status !== 'all') {
          where.push(`c.status = ${next()}`);
          params.push(q.status);
        }
        if (q.author) {
          // Match either an Ethereum address or a userId
          if (/^0x[a-fA-F0-9]{40}$/.test(q.author)) {
            where.push(`LOWER(u.address) = ${next()}`);
            params.push(q.author.toLowerCase());
          } else if (/^\d+$/.test(q.author)) {
            where.push(`c.user_id = ${next()}`);
            params.push(parseInt(q.author, 10));
          } else {
            where.push(`LOWER(u.address) = ${next()}`);
            params.push(q.author.toLowerCase());
          }
        }
        if (q.name) {
          where.push(`LOWER(en.name) = ${next()}`);
          params.push(q.name.toLowerCase());
        }
        if (q.from) {
          where.push(`c.created_at >= ${next()}`);
          params.push(q.from);
        }
        if (q.to) {
          where.push(`c.created_at <= ${next()}`);
          params.push(q.to);
        }
        if (q.cursor) {
          where.push(`c.created_at < ${next()}`);
          params.push(q.cursor);
        }

        const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const limitParam = next();
        params.push(q.limit);

        const result = await pool.query(
          `SELECT c.id,
                  c.ens_name_id,
                  c.user_id,
                  c.body,
                  c.body_censored,
                  c.status,
                  c.deleted_at,
                  c.deleted_by,
                  c.deleted_reason,
                  c.created_at,
                  c.updated_at,
                  en.name AS ens_name,
                  u.address AS author_address,
                  u.persona_id AS author_persona_id,
                  cus.status AS author_mod_status,
                  cus.suspended_until AS author_suspended_until
             FROM comments c
             JOIN ens_names en ON en.id = c.ens_name_id
             JOIN users u ON u.id = c.user_id
        LEFT JOIN comment_user_status cus ON cus.user_id = c.user_id
            ${whereClause}
            ORDER BY c.created_at DESC, c.id DESC
            LIMIT ${limitParam}`,
          params
        );

        const nextCursor =
          result.rows.length === q.limit
            ? new Date(result.rows[result.rows.length - 1].created_at).toISOString()
            : null;

        return reply.send(
          ok({
            comments: result.rows,
            nextCursor,
          })
        );
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid query', error.errors);
        }
        fastify.log.error({ error }, 'Error listing admin comments');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to list comments');
      }
    }
  );

  /**
   * DELETE /api/v1/comments/admin/:id
   * Soft-delete a comment. Recomputes the author's deletion_count_30d and
   * may auto-warn or auto-suspend based on configured thresholds.
   */
  fastify.delete(
    '/admin/:id',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
        const { reason } = DeleteReasonSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const result = await pool.query(
          `UPDATE comments
              SET status = 'deleted',
                  deleted_at = NOW(),
                  deleted_by = $1,
                  deleted_reason = $2,
                  updated_at = NOW()
            WHERE id = $3 AND status <> 'deleted'
            RETURNING id, user_id, ens_name_id`,
          [adminId, reason, id]
        );

        if (result.rows.length === 0) {
          return sendError(
            reply,
            404,
            'COMMENT_NOT_FOUND',
            'Comment not found or already deleted'
          );
        }

        const { user_id: userId, ens_name_id: ensNameId } = result.rows[0];

        await pool.query(
          `INSERT INTO comment_moderation_log (comment_id, user_id, admin_id, action, reason)
           VALUES ($1, $2, $3, 'delete', $4)`,
          [id, userId, adminId, reason]
        );

        // Notify the author that their comment was removed
        await insertModerationNotification(
          pool,
          userId,
          'comment_deleted',
          ensNameId,
          { reason, commentId: id }
        );

        // Threshold logic: recompute and possibly auto-warn / auto-suspend.
        const config = await getCommentConfig();
        const count = await recomputeDeletionCount(
          pool,
          userId,
          config.suspension_window_days
        );
        const existing = await getUserModStatus(pool, userId);

        let nextStatus = existing?.status ?? 'active';
        let suspendedUntil: Date | null = existing?.suspended_until ?? null;
        let triggered: 'warn' | 'suspend' | null = null;

        if (count >= config.suspension_threshold && nextStatus !== 'banned') {
          nextStatus = 'suspended';
          suspendedUntil = new Date(
            Date.now() + config.default_suspension_days * 24 * 60 * 60 * 1000
          );
          triggered = 'suspend';
        } else if (
          count >= config.warning_threshold &&
          nextStatus === 'active'
        ) {
          nextStatus = 'warned';
          triggered = 'warn';
        }

        await upsertUserStatus(pool, userId, {
          status: nextStatus,
          suspended_until: suspendedUntil,
          deletion_count_30d: count,
          last_warned_at: triggered === 'warn' ? new Date() : undefined,
          last_action_by: adminId,
          last_action_reason: reason,
        });

        if (triggered === 'warn') {
          await pool.query(
            `INSERT INTO comment_moderation_log (user_id, admin_id, action, reason, metadata)
             VALUES ($1, $2, 'auto_warn', $3, $4)`,
            [
              userId,
              adminId,
              `Auto-warning at ${count} deletions`,
              JSON.stringify({ count, threshold: config.warning_threshold }),
            ]
          );
          await insertModerationNotification(
            pool,
            userId,
            'comment_warning',
            null,
            {
              count,
              threshold: config.warning_threshold,
              suspensionThreshold: config.suspension_threshold,
            }
          );
        } else if (triggered === 'suspend') {
          await pool.query(
            `INSERT INTO comment_moderation_log (user_id, admin_id, action, reason, metadata)
             VALUES ($1, $2, 'auto_suspend', $3, $4)`,
            [
              userId,
              adminId,
              `Auto-suspended at ${count} deletions`,
              JSON.stringify({
                count,
                threshold: config.suspension_threshold,
                days: config.default_suspension_days,
              }),
            ]
          );
          await insertModerationNotification(
            pool,
            userId,
            'comment_suspended',
            null,
            {
              count,
              suspendedUntil: suspendedUntil?.toISOString(),
              days: config.default_suspension_days,
              reason: 'Auto-suspended for repeated comment deletions',
            }
          );
        }

        return reply.send(
          ok({
            id,
            deletionCount: count,
            triggered,
            authorStatus: nextStatus,
            authorSuspendedUntil: suspendedUntil?.toISOString() ?? null,
          })
        );
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(
            reply,
            400,
            'VALIDATION_ERROR',
            'Invalid request',
            error.errors
          );
        }
        fastify.log.error({ error }, 'Error deleting comment');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to delete comment');
      }
    }
  );

  /**
   * GET /api/v1/comments/admin/users/:userId
   * Per-user moderation view: status, deletion count, recent comments.
   */
  fastify.get(
    '/admin/users/:userId',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = z
          .object({ userId: z.coerce.number().int().positive() })
          .parse(request.params);

        const userResult = await pool.query(
          `SELECT id, address, persona_id, email, created_at FROM users WHERE id = $1`,
          [userId]
        );
        if (userResult.rows.length === 0) {
          return sendError(reply, 404, 'USER_NOT_FOUND', 'User not found');
        }

        const status = await getUserModStatus(pool, userId);
        const recent = await pool.query(
          `SELECT c.id, c.body, c.body_censored, c.status, c.created_at, c.deleted_at,
                  c.deleted_reason, en.name AS ens_name
             FROM comments c
             JOIN ens_names en ON en.id = c.ens_name_id
            WHERE c.user_id = $1
            ORDER BY c.created_at DESC
            LIMIT 100`,
          [userId]
        );

        const log = await pool.query(
          `SELECT id, comment_id, action, reason, metadata, created_at, admin_id
             FROM comment_moderation_log
            WHERE user_id = $1
            ORDER BY created_at DESC
            LIMIT 50`,
          [userId]
        );

        return reply.send(
          ok({
            user: userResult.rows[0],
            status: status ?? {
              user_id: userId,
              status: 'active',
              suspended_until: null,
              deletion_count_30d: 0,
            },
            comments: recent.rows,
            log: log.rows,
          })
        );
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(
            reply,
            400,
            'VALIDATION_ERROR',
            'Invalid request',
            error.errors
          );
        }
        fastify.log.error({ error }, 'Error fetching user mod info');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch user');
      }
    }
  );

  /**
   * POST /api/v1/comments/admin/users/:userId/suspend
   */
  fastify.post(
    '/admin/users/:userId/suspend',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = z
          .object({ userId: z.coerce.number().int().positive() })
          .parse(request.params);
        const { days, reason } = SuspendSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const suspendedUntil = new Date(
          Date.now() + days * 24 * 60 * 60 * 1000
        );

        await upsertUserStatus(pool, userId, {
          status: 'suspended',
          suspended_until: suspendedUntil,
          last_action_by: adminId,
          last_action_reason: reason,
        });

        await pool.query(
          `INSERT INTO comment_moderation_log (user_id, admin_id, action, reason, metadata)
           VALUES ($1, $2, 'suspend', $3, $4)`,
          [userId, adminId, reason, JSON.stringify({ days })]
        );

        await insertModerationNotification(pool, userId, 'comment_suspended', null, {
          days,
          suspendedUntil: suspendedUntil.toISOString(),
          reason,
        });

        return reply.send(ok({ userId, suspendedUntil: suspendedUntil.toISOString() }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error suspending user');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to suspend user');
      }
    }
  );

  /**
   * POST /api/v1/comments/admin/users/:userId/ban
   */
  fastify.post(
    '/admin/users/:userId/ban',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = z
          .object({ userId: z.coerce.number().int().positive() })
          .parse(request.params);
        const { reason } = BanSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        await upsertUserStatus(pool, userId, {
          status: 'banned',
          suspended_until: null,
          last_action_by: adminId,
          last_action_reason: reason,
        });

        await pool.query(
          `INSERT INTO comment_moderation_log (user_id, admin_id, action, reason)
           VALUES ($1, $2, 'ban', $3)`,
          [userId, adminId, reason]
        );

        await insertModerationNotification(pool, userId, 'comment_banned', null, {
          reason,
        });

        return reply.send(ok({ userId, status: 'banned' }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error banning user');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to ban user');
      }
    }
  );

  /**
   * POST /api/v1/comments/admin/users/:userId/unban
   * Lifts ban or suspension and resets status to active.
   */
  fastify.post(
    '/admin/users/:userId/unban',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { userId } = z
          .object({ userId: z.coerce.number().int().positive() })
          .parse(request.params);
        const { reason } = BanSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        await upsertUserStatus(pool, userId, {
          status: 'active',
          suspended_until: null,
          last_action_by: adminId,
          last_action_reason: reason,
        });

        await pool.query(
          `INSERT INTO comment_moderation_log (user_id, admin_id, action, reason)
           VALUES ($1, $2, 'unban', $3)`,
          [userId, adminId, reason]
        );

        await insertModerationNotification(pool, userId, 'comment_unbanned', null, {
          reason,
        });

        return reply.send(ok({ userId, status: 'active' }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error unbanning user');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to unban user');
      }
    }
  );

  /**
   * GET /api/v1/comments/admin/blacklist
   */
  fastify.get(
    '/admin/blacklist',
    { preHandler: [requireAuth, requireAdmin] },
    async (_request, reply) => {
      try {
        const result = await pool.query(
          `SELECT id, term, action, created_at, created_by FROM comment_blacklist_terms
            ORDER BY term ASC`
        );
        return reply.send(ok({ terms: result.rows }));
      } catch (error: unknown) {
        fastify.log.error({ error }, 'Error fetching blacklist');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch blacklist');
      }
    }
  );

  /**
   * POST /api/v1/comments/admin/blacklist
   */
  fastify.post(
    '/admin/blacklist',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { term, action } = BlacklistAddSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const result = await pool.query(
          `INSERT INTO comment_blacklist_terms (term, action, created_by)
           VALUES ($1, $2, $3)
           ON CONFLICT (LOWER(term)) DO UPDATE SET action = EXCLUDED.action
           RETURNING id, term, action, created_at`,
          [term, action, adminId]
        );

        await pool.query(
          `INSERT INTO comment_moderation_log (admin_id, action, reason, metadata)
           VALUES ($1, 'blacklist_add', $2, $3)`,
          [adminId, term, JSON.stringify({ action })]
        );
        invalidateBlacklistCache();

        return reply.send(ok({ term: result.rows[0] }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error adding blacklist term');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to add term');
      }
    }
  );

  /**
   * DELETE /api/v1/comments/admin/blacklist/:id
   */
  fastify.delete(
    '/admin/blacklist/:id',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const { id } = z
          .object({ id: z.coerce.number().int().positive() })
          .parse(request.params);
        const adminId = parseInt(request.user!.sub, 10);

        const result = await pool.query(
          `DELETE FROM comment_blacklist_terms WHERE id = $1 RETURNING term`,
          [id]
        );
        if (result.rows.length === 0) {
          return sendError(reply, 404, 'TERM_NOT_FOUND', 'Term not found');
        }
        await pool.query(
          `INSERT INTO comment_moderation_log (admin_id, action, reason)
           VALUES ($1, 'blacklist_remove', $2)`,
          [adminId, result.rows[0].term]
        );
        invalidateBlacklistCache();

        return reply.send(ok({ id, term: result.rows[0].term }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error removing blacklist term');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to remove term');
      }
    }
  );

  /**
   * GET /api/v1/comments/admin/config
   */
  fastify.get(
    '/admin/config',
    { preHandler: [requireAuth, requireAdmin] },
    async (_request, reply) => {
      try {
        const config = await getCommentConfig();
        return reply.send(ok({ config }));
      } catch (error: unknown) {
        fastify.log.error({ error }, 'Error fetching config');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to fetch config');
      }
    }
  );

  /**
   * PATCH /api/v1/comments/admin/config
   */
  fastify.patch(
    '/admin/config',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      try {
        const updates = ConfigPatchSchema.parse(request.body);
        const adminId = parseInt(request.user!.sub, 10);

        const cols: string[] = [];
        const params: unknown[] = [];
        let i = 0;
        for (const [k, v] of Object.entries(updates)) {
          if (v === undefined) continue;
          i += 1;
          cols.push(`${k} = $${i}`);
          params.push(v);
        }
        if (cols.length === 0) {
          return sendError(reply, 400, 'NO_FIELDS', 'No fields to update');
        }
        cols.push(`updated_at = NOW()`);

        await pool.query(
          `UPDATE comment_config SET ${cols.join(', ')} WHERE id = 1`,
          params
        );

        await pool.query(
          `INSERT INTO comment_moderation_log (admin_id, action, reason, metadata)
           VALUES ($1, 'config_update', 'Config patched', $2)`,
          [adminId, JSON.stringify(updates)]
        );

        const config = await getCommentConfig();
        return reply.send(ok({ config }));
      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return sendError(reply, 400, 'VALIDATION_ERROR', 'Invalid request', error.errors);
        }
        fastify.log.error({ error }, 'Error updating config');
        return sendError(reply, 500, 'INTERNAL_ERROR', 'Failed to update config');
      }
    }
  );
}
