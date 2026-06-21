import type { FastifyInstance } from 'fastify';
import dns from 'dns/promises';
import net from 'net';
import { z } from 'zod';
import { config, getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth } from '../middleware/auth';

const MAX_PUSH_SUBSCRIPTIONS_PER_USER = 20;

const PushSubscriptionBodySchema = z.object({
  endpoint: z.string().url().max(2048),
  keys: z.object({
    p256dh: z.string().min(43).max(256),
    auth: z.string().min(16).max(256),
  }),
  expirationTime: z.union([z.number(), z.string(), z.null()]).optional(),
  deviceName: z.string().trim().min(1).max(120).optional(),
});

const SubscriptionParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

interface PushSubscriptionRow {
  id: number;
  endpoint: string;
  device_name: string | null;
  enabled: boolean;
  last_seen_at: Date;
  created_at: Date;
}

function serializeSubscription(row: PushSubscriptionRow) {
  return {
    id: row.id,
    endpoint: row.endpoint,
    deviceName: row.device_name,
    enabled: row.enabled,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
  };
}

function parseExpirationTime(value: string | number | null | undefined): Date | null {
  if (value === undefined || value === null) {
    return null;
  }

  const timestamp = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return null;
  }

  return new Date(timestamp);
}

function getUserAgent(header: string | string[] | undefined): string | null {
  if (Array.isArray(header)) {
    return header.join(' ');
  }

  return header || null;
}

function isBlockedIpAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    const [first, second] = parts;

    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      first === 169 && second === 254 ||
      first === 172 && second >= 16 && second <= 31 ||
      first === 192 && second === 168 ||
      first >= 224
    );
  }

  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:') ||
      normalized.startsWith('ff')
    );
  }

  return true;
}

async function validatePushEndpoint(endpoint: string): Promise<void> {
  const parsed = new URL(endpoint);

  if (parsed.protocol !== 'https:') {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'Push endpoint must use HTTPS',
    }]);
  }

  if (parsed.username || parsed.password) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'Push endpoint must not include credentials',
    }]);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'Push endpoint host is not allowed',
    }]);
  }

  if (net.isIP(hostname)) {
    if (isBlockedIpAddress(hostname)) {
      throw new z.ZodError([{
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message: 'Push endpoint IP range is not allowed',
      }]);
    }
    return;
  }

  const resolved = await dns.lookup(hostname, { all: true, verbatim: false });
  if (resolved.some((entry) => isBlockedIpAddress(entry.address))) {
    throw new z.ZodError([{
      code: z.ZodIssueCode.custom,
      path: ['endpoint'],
      message: 'Push endpoint resolves to a disallowed IP range',
    }]);
  }
}

export async function pushRoutes(fastify: FastifyInstance) {
  fastify.get('/vapid-public-key', async (_request, reply) => {
    if (!config.webPush.enabled || !config.webPush.publicKey) {
      return reply.status(501).send({
        success: false,
        error: {
          code: 'PUSH_NOT_CONFIGURED',
          message: 'Push notifications are not configured',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    const response: APIResponse<{ publicKey: string }> = {
      success: true,
      data: {
        publicKey: config.webPush.publicKey,
      },
      meta: {
        timestamp: new Date().toISOString(),
        version: '1.0.0',
      },
    };

    return reply.send(response);
  });
}

export async function userPushSubscriptionRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();

  fastify.get('/', { preHandler: requireAuth }, async (request, reply) => {
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

    try {
      const userId = Number(request.user.sub);
      const result = await pool.query<PushSubscriptionRow>(
        `SELECT id, endpoint, device_name, enabled, last_seen_at, created_at
         FROM push_subscriptions
         WHERE user_id = $1
         ORDER BY last_seen_at DESC`,
        [userId]
      );

      const response: APIResponse<{ subscriptions: ReturnType<typeof serializeSubscription>[] }> = {
        success: true,
        data: {
          subscriptions: result.rows.map(serializeSubscription),
        },
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error({ error }, 'Error fetching push subscriptions');
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to fetch push subscriptions',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  fastify.post('/', { preHandler: requireAuth }, async (request, reply) => {
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

    try {
      const userId = Number(request.user.sub);
      const body = PushSubscriptionBodySchema.parse(request.body);
      await validatePushEndpoint(body.endpoint);

      const client = await pool.connect();

      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock($1)', [userId]);

        const existingResult = await client.query<{ id: number }>(
          'SELECT id FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2',
          [userId, body.endpoint]
        );

        if (existingResult.rows.length === 0) {
          const countResult = await client.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM push_subscriptions WHERE user_id = $1 AND enabled = TRUE',
            [userId]
          );
          const activeCount = Number(countResult.rows[0]?.count || '0');

          if (activeCount >= MAX_PUSH_SUBSCRIPTIONS_PER_USER) {
            await client.query('ROLLBACK');
            return reply.status(409).send({
              success: false,
              error: {
                code: 'SUBSCRIPTION_LIMIT_REACHED',
                message: `You can register up to ${MAX_PUSH_SUBSCRIPTIONS_PER_USER} push subscriptions`,
              },
              meta: {
                timestamp: new Date().toISOString(),
              },
            });
          }
        }

        const userAgent = getUserAgent(request.headers['user-agent']);
        const result = await client.query<PushSubscriptionRow>(
          `INSERT INTO push_subscriptions (
             user_id, endpoint, p256dh, auth, expiration_time, device_name, user_agent, enabled, last_seen_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE, NOW())
           ON CONFLICT (endpoint) DO UPDATE SET
             user_id = EXCLUDED.user_id,
             p256dh = EXCLUDED.p256dh,
             auth = EXCLUDED.auth,
             expiration_time = EXCLUDED.expiration_time,
             device_name = EXCLUDED.device_name,
             user_agent = EXCLUDED.user_agent,
             enabled = TRUE,
             last_seen_at = NOW()
           RETURNING id, endpoint, device_name, enabled, last_seen_at, created_at`,
          [
            userId,
            body.endpoint,
            body.keys.p256dh,
            body.keys.auth,
            parseExpirationTime(body.expirationTime),
            body.deviceName || null,
            userAgent,
          ]
        );

        await client.query('COMMIT');

        const response: APIResponse<{ subscription: ReturnType<typeof serializeSubscription> }> = {
          success: true,
          data: {
            subscription: serializeSubscription(result.rows[0]),
          },
          meta: {
            timestamp: new Date().toISOString(),
            version: '1.0.0',
          },
        };

        return reply.status(existingResult.rows.length === 0 ? 201 : 200).send(response);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      fastify.log.error({ error }, 'Error upserting push subscription');

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid push subscription payload',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to save push subscription',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });

  fastify.delete('/:id', { preHandler: requireAuth }, async (request, reply) => {
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

    try {
      const userId = Number(request.user.sub);
      const { id } = SubscriptionParamsSchema.parse(request.params);
      const result = await pool.query<{ id: number }>(
        'DELETE FROM push_subscriptions WHERE id = $1 AND user_id = $2 RETURNING id',
        [id, userId]
      );

      if (result.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Push subscription not found',
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      const response: APIResponse<null> = {
        success: true,
        data: null,
        meta: {
          timestamp: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      return reply.send(response);
    } catch (error) {
      fastify.log.error({ error }, 'Error deleting push subscription');

      if (error instanceof z.ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid push subscription id',
            details: error.errors,
          },
          meta: {
            timestamp: new Date().toISOString(),
          },
        });
      }

      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to delete push subscription',
        },
        meta: {
          timestamp: new Date().toISOString(),
        },
      });
    }
  });
}
