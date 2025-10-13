import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';

const NotificationQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  unreadOnly: z.coerce.boolean().default(false),
});

export async function notificationsRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  /**
   * GET /api/v1/notifications
   * Get user's notifications
   */
  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { page, limit, unreadOnly } = NotificationQuerySchema.parse(request.query);
      const userId = parseInt(request.user.sub);
      const offset = (page - 1) * limit;

      // Build WHERE clause
      const whereConditions = ['n.user_id = $1'];
      const queryParams: any[] = [userId];

      if (unreadOnly) {
        whereConditions.push('n.read_at IS NULL');
      }

      const whereClause = whereConditions.join(' AND ');

      // Get total count
      const countResult = await pool.query(
        `SELECT COUNT(*) FROM notifications n WHERE ${whereClause}`,
        queryParams
      );

      const total = parseInt(countResult.rows[0].count);
      const totalPages = Math.ceil(total / limit);

      // Get notifications with ENS name details
      const notificationsResult = await pool.query(
        `SELECT
          n.id,
          n.type,
          n.metadata,
          n.sent_at,
          n.read_at,
          n.created_at,
          en.name as ens_name,
          en.token_id as ens_token_id
        FROM notifications n
        LEFT JOIN ens_names en ON n.ens_name_id = en.id
        WHERE ${whereClause}
        ORDER BY n.sent_at DESC
        LIMIT $${queryParams.length + 1} OFFSET $${queryParams.length + 2}`,
        [...queryParams, limit, offset]
      );

      const response: APIResponse = {
        success: true,
        data: {
          notifications: notificationsResult.rows.map(row => ({
            id: row.id,
            type: row.type,
            ensName: row.ens_name,
            ensTokenId: row.ens_token_id,
            metadata: row.metadata,
            sentAt: row.sent_at,
            readAt: row.read_at,
            isRead: !!row.read_at,
            createdAt: row.created_at,
          })),
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
      fastify.log.error('Error fetching notifications:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch notifications',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * GET /api/v1/notifications/unread/count
   * Get count of unread notifications
   */
  fastify.get('/unread/count', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const userId = parseInt(request.user.sub);

      const countResult = await pool.query(
        `SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read_at IS NULL`,
        [userId]
      );

      const unreadCount = parseInt(countResult.rows[0].count);

      const response: APIResponse = {
        success: true,
        data: {
          unreadCount,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error fetching unread count:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch unread count',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * PATCH /api/v1/notifications/:id/read
   * Mark notification as read
   */
  fastify.patch('/:id/read', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const { id } = request.params as { id: string };
      const userId = parseInt(request.user.sub);

      // Verify notification belongs to user
      const checkResult = await pool.query(
        'SELECT user_id, read_at FROM notifications WHERE id = $1',
        [parseInt(id)]
      );

      if (checkResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Notification not found',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      if (checkResult.rows[0].user_id !== userId) {
        return reply.status(403).send({
          success: false,
          error: {
            code: 'FORBIDDEN',
            message: 'This notification belongs to another user',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      // Mark as read (if not already read)
      const updateResult = await pool.query(
        `UPDATE notifications
         SET read_at = NOW()
         WHERE id = $1 AND read_at IS NULL
         RETURNING *`,
        [parseInt(id)]
      );

      const notification = updateResult.rows[0] || checkResult.rows[0];

      const response: APIResponse = {
        success: true,
        data: {
          id: notification.id,
          readAt: notification.read_at,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error marking notification as read:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to mark notification as read',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  /**
   * PATCH /api/v1/notifications/read-all
   * Mark all notifications as read
   */
  fastify.patch('/read-all', { preHandler: requireAuth }, async (request, reply) => {
    try {
      if (!request.user) {
        return reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Not authenticated',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const userId = parseInt(request.user.sub);

      // Mark all unread notifications as read
      const updateResult = await pool.query(
        `UPDATE notifications
         SET read_at = NOW()
         WHERE user_id = $1 AND read_at IS NULL
         RETURNING id`,
        [userId]
      );

      const markedCount = updateResult.rowCount || 0;

      const response: APIResponse = {
        success: true,
        data: {
          markedCount,
          message: `${markedCount} notification(s) marked as read`,
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error: any) {
      fastify.log.error('Error marking all notifications as read:', error);

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to mark all notifications as read',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
