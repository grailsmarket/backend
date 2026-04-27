import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getPostgresPool, type APIResponse } from '../../../shared/src';
import { requireAuth, requireAdmin, requireMinTier } from '../middleware/auth';
import { getQueueClient, QUEUE_NAMES } from '../queue';

const TICKET_STATUSES = ['open', 'closed', 'fixed'] as const;
type TicketStatus = (typeof TICKET_STATUSES)[number];

const CreateTicketSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(10_000),
  urls: z.array(z.string().url()).max(10).optional().default([]),
});

const PostMessageSchema = z.object({
  body: z.string().trim().min(1).max(10_000),
});

const ListTicketsQuerySchema = z.object({
  status: z.enum(TICKET_STATUSES).optional(),
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

const AdminListQuerySchema = ListTicketsQuerySchema.extend({
  userId: z.coerce.number().int().positive().optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

const UpdateStatusSchema = z.object({
  status: z.enum(TICKET_STATUSES),
});

type TicketRow = {
  id: number;
  user_id: number;
  subject: string;
  urls: string[];
  status: TicketStatus;
  created_at: Date;
  updated_at: Date;
  last_admin_reply_at: Date | null;
  last_user_reply_at: Date | null;
};

type MessageRow = {
  id: number;
  ticket_id: number;
  author_user_id: number;
  author_role: 'user' | 'admin';
  body: string;
  created_at: Date;
};

type StatusChangeRow = {
  id: number;
  ticket_id: number;
  actor_user_id: number;
  actor_role: 'user' | 'admin';
  from_status: TicketStatus | null;
  to_status: TicketStatus;
  created_at: Date;
};

function serializeStatusChange(row: StatusChangeRow & { actor_address?: string }) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    actorUserId: row.actor_user_id,
    actorAddress: row.actor_address ?? null,
    actorRole: row.actor_role,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    createdAt: row.created_at,
  };
}

async function loadStatusChanges(
  pool: ReturnType<typeof getPostgresPool>,
  ticketId: number
) {
  const res = await pool.query<StatusChangeRow & { actor_address: string }>(
    `SELECT s.id, s.ticket_id, s.actor_user_id, s.actor_role,
            s.from_status, s.to_status, s.created_at,
            u.address AS actor_address
       FROM support_ticket_status_changes s
       LEFT JOIN users u ON u.id = s.actor_user_id
      WHERE s.ticket_id = $1
      ORDER BY s.created_at DESC, s.id DESC`,
    [ticketId]
  );
  return res.rows.map(serializeStatusChange);
}

function serializeTicket(row: TicketRow & { user_address?: string }) {
  return {
    id: row.id,
    userId: row.user_id,
    userAddress: row.user_address ?? null,
    subject: row.subject,
    urls: row.urls ?? [],
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastAdminReplyAt: row.last_admin_reply_at,
    lastUserReplyAt: row.last_user_reply_at,
  };
}

function serializeMessage(row: MessageRow & { author_address?: string }) {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorUserId: row.author_user_id,
    authorAddress: row.author_address ?? null,
    authorRole: row.author_role,
    body: row.body,
    createdAt: row.created_at,
  };
}

type NotifyKind = 'admin_reply' | 'status_changed' | 'reopened';

async function notifyTicketEvent(
  pool: ReturnType<typeof getPostgresPool>,
  recipientUserIds: number[],
  ticket: { id: number; subject: string; status: TicketStatus },
  kind: NotifyKind,
  extra: Record<string, unknown> = {}
) {
  if (recipientUserIds.length === 0) return;

  const metadata = {
    kind,
    ticketId: ticket.id,
    subject: ticket.subject,
    status: ticket.status,
    ...extra,
  };

  const boss = await getQueueClient();
  await Promise.all(
    recipientUserIds.map((userId) =>
      boss.send(QUEUE_NAMES.SEND_NOTIFICATION, {
        type: 'support-ticket-update',
        userId,
        ensNameId: null,
        metadata,
      })
    )
  );
}

async function getAdminUserIds(pool: ReturnType<typeof getPostgresPool>): Promise<number[]> {
  const res = await pool.query<{ id: number }>(
    `SELECT id FROM users WHERE is_admin = TRUE`
  );
  return res.rows.map((r) => r.id);
}

async function loadTicketMessages(
  pool: ReturnType<typeof getPostgresPool>,
  ticketId: number
) {
  const res = await pool.query<MessageRow & { author_address: string }>(
    `SELECT m.id, m.ticket_id, m.author_user_id, m.author_role, m.body, m.created_at,
            u.address AS author_address
       FROM support_ticket_messages m
       LEFT JOIN users u ON u.id = m.author_user_id
      WHERE m.ticket_id = $1
      ORDER BY m.created_at ASC, m.id ASC`,
    [ticketId]
  );
  return res.rows.map(serializeMessage);
}

function metaResponse() {
  return { timestamp: new Date().toISOString(), version: '1.0.0' };
}

// =============================================================================
// User-facing routes — mounted at /api/v1/support
// =============================================================================
export async function supportRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const userPreHandlers = [requireAuth, requireMinTier('plus')];

  // POST /api/v1/support/tickets — create a ticket
  fastify.post('/tickets', { preHandler: userPreHandlers }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const { subject, body, urls } = CreateTicketSchema.parse(request.body);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const ticketResult = await client.query<TicketRow>(
        `INSERT INTO support_tickets (user_id, subject, urls, last_user_reply_at)
         VALUES ($1, $2, $3, NOW())
         RETURNING *`,
        [userId, subject, urls]
      );
      const ticket = ticketResult.rows[0];

      await client.query(
        `INSERT INTO support_ticket_messages (ticket_id, author_user_id, author_role, body)
         VALUES ($1, $2, 'user', $3)`,
        [ticket.id, userId, body]
      );

      await client.query('COMMIT');

      const messages = await loadTicketMessages(pool, ticket.id);
      const response: APIResponse = {
        success: true,
        data: { ticket: serializeTicket(ticket), messages },
        meta: metaResponse(),
      };
      return reply.status(201).send(response);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  });

  // GET /api/v1/support/tickets — list current user's tickets
  fastify.get('/tickets', { preHandler: userPreHandlers }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const { status, page, limit } = ListTicketsQuerySchema.parse(request.query);
    const offset = (page - 1) * limit;

    const where = ['t.user_id = $1'];
    const params: any[] = [userId];
    if (status) {
      where.push(`t.status = $${params.length + 1}`);
      params.push(status);
    }
    const whereClause = where.join(' AND ');

    const [countResult, listResult] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM support_tickets t WHERE ${whereClause}`,
        params
      ),
      pool.query<TicketRow & { message_count: string }>(
        `SELECT t.*,
                (SELECT COUNT(*) FROM support_ticket_messages WHERE ticket_id = t.id) AS message_count
           FROM support_tickets t
          WHERE ${whereClause}
          ORDER BY t.updated_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    const response: APIResponse = {
      success: true,
      data: {
        tickets: listResult.rows.map((row) => ({
          ...serializeTicket(row),
          messageCount: parseInt(row.message_count),
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
      meta: metaResponse(),
    };
    return reply.send(response);
  });

  // GET /api/v1/support/tickets/:id — get one (with messages)
  fastify.get('/tickets/:id', { preHandler: userPreHandlers }, async (request, reply) => {
    const userId = parseInt(request.user!.sub);
    const ticketId = parseInt((request.params as { id: string }).id);
    if (!Number.isFinite(ticketId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Invalid ticket id' },
        meta: metaResponse(),
      });
    }

    const ticketRes = await pool.query<TicketRow>(
      `SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2`,
      [ticketId, userId]
    );
    if (ticketRes.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Ticket not found' },
        meta: metaResponse(),
      });
    }

    const messages = await loadTicketMessages(pool, ticketId);
    return reply.send({
      success: true,
      data: { ticket: serializeTicket(ticketRes.rows[0]), messages },
      meta: metaResponse(),
    } as APIResponse);
  });

  // POST /api/v1/support/tickets/:id/messages — user reply
  fastify.post(
    '/tickets/:id/messages',
    { preHandler: userPreHandlers },
    async (request, reply) => {
      const userId = parseInt(request.user!.sub);
      const ticketId = parseInt((request.params as { id: string }).id);
      const { body } = PostMessageSchema.parse(request.body);

      const ticketRes = await pool.query<TicketRow>(
        `SELECT * FROM support_tickets WHERE id = $1 AND user_id = $2`,
        [ticketId, userId]
      );
      if (ticketRes.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Ticket not found' },
          meta: metaResponse(),
        });
      }
      const ticket = ticketRes.rows[0];
      if (ticket.status !== 'open') {
        return reply.status(409).send({
          success: false,
          error: {
            code: 'TICKET_NOT_OPEN',
            message:
              ticket.status === 'closed'
                ? 'Reopen the ticket before posting a new message.'
                : 'This ticket is marked fixed; please open a new ticket.',
          },
          meta: metaResponse(),
        });
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO support_ticket_messages (ticket_id, author_user_id, author_role, body)
           VALUES ($1, $2, 'user', $3)`,
          [ticketId, userId, body]
        );
        await client.query(
          `UPDATE support_tickets SET last_user_reply_at = NOW() WHERE id = $1`,
          [ticketId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const messages = await loadTicketMessages(pool, ticketId);
      return reply.status(201).send({
        success: true,
        data: { messages },
        meta: metaResponse(),
      } as APIResponse);
    }
  );

  // POST /api/v1/support/tickets/:id/reopen — reopen a closed ticket
  fastify.post(
    '/tickets/:id/reopen',
    { preHandler: userPreHandlers },
    async (request, reply) => {
      const userId = parseInt(request.user!.sub);
      const ticketId = parseInt((request.params as { id: string }).id);

      const client = await pool.connect();
      let updateRes;
      try {
        await client.query('BEGIN');
        updateRes = await client.query<TicketRow>(
          `UPDATE support_tickets
              SET status = 'open'
            WHERE id = $1 AND user_id = $2 AND status = 'closed'
            RETURNING *`,
          [ticketId, userId]
        );
        if (updateRes.rows.length > 0) {
          await client.query(
            `INSERT INTO support_ticket_status_changes
               (ticket_id, actor_user_id, actor_role, from_status, to_status)
             VALUES ($1, $2, 'user', 'closed', 'open')`,
            [ticketId, userId]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      if (updateRes.rows.length === 0) {
        // Disambiguate 404 vs invalid status
        const exists = await pool.query<{ status: TicketStatus }>(
          `SELECT status FROM support_tickets WHERE id = $1 AND user_id = $2`,
          [ticketId, userId]
        );
        if (exists.rows.length === 0) {
          return reply.status(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Ticket not found' },
            meta: metaResponse(),
          });
        }
        return reply.status(409).send({
          success: false,
          error: {
            code: 'TICKET_NOT_REOPENABLE',
            message: `Tickets in '${exists.rows[0].status}' status cannot be reopened.`,
          },
          meta: metaResponse(),
        });
      }

      const ticket = updateRes.rows[0];
      const adminIds = await getAdminUserIds(pool);
      await notifyTicketEvent(pool, adminIds, ticket, 'reopened', {
        reopenedByUserId: userId,
      });

      return reply.send({
        success: true,
        data: { ticket: serializeTicket(ticket) },
        meta: metaResponse(),
      } as APIResponse);
    }
  );
}

// =============================================================================
// Admin routes — mounted at /api/v1/admin/support
// =============================================================================
export async function adminSupportRoutes(fastify: FastifyInstance) {
  const pool = getPostgresPool();
  const adminPreHandlers = [requireAuth, requireAdmin];

  // GET /api/v1/admin/support/tickets — list with filters
  fastify.get('/tickets', { preHandler: adminPreHandlers }, async (request, reply) => {
    const { status, userId, search, page, limit } = AdminListQuerySchema.parse(
      request.query
    );
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: any[] = [];
    if (status) {
      params.push(status);
      where.push(`t.status = $${params.length}`);
    }
    if (userId) {
      params.push(userId);
      where.push(`t.user_id = $${params.length}`);
    }
    if (search) {
      params.push(`%${search}%`);
      where.push(`t.subject ILIKE $${params.length}`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const [countResult, listResult] = await Promise.all([
      pool.query<{ count: string }>(
        `SELECT COUNT(*) FROM support_tickets t ${whereClause}`,
        params
      ),
      pool.query<TicketRow & { user_address: string; message_count: string }>(
        `SELECT t.*, u.address AS user_address,
                (SELECT COUNT(*) FROM support_ticket_messages WHERE ticket_id = t.id) AS message_count
           FROM support_tickets t
           JOIN users u ON u.id = t.user_id
           ${whereClause}
          ORDER BY t.updated_at DESC
          LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, limit, offset]
      ),
    ]);

    const total = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(total / limit);

    return reply.send({
      success: true,
      data: {
        tickets: listResult.rows.map((row) => ({
          ...serializeTicket(row),
          messageCount: parseInt(row.message_count),
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
      meta: metaResponse(),
    } as APIResponse);
  });

  // GET /api/v1/admin/support/tickets/:id
  fastify.get('/tickets/:id', { preHandler: adminPreHandlers }, async (request, reply) => {
    const ticketId = parseInt((request.params as { id: string }).id);
    if (!Number.isFinite(ticketId)) {
      return reply.status(400).send({
        success: false,
        error: { code: 'BAD_REQUEST', message: 'Invalid ticket id' },
        meta: metaResponse(),
      });
    }

    const ticketRes = await pool.query<TicketRow & { user_address: string }>(
      `SELECT t.*, u.address AS user_address
         FROM support_tickets t
         JOIN users u ON u.id = t.user_id
        WHERE t.id = $1`,
      [ticketId]
    );
    if (ticketRes.rows.length === 0) {
      return reply.status(404).send({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Ticket not found' },
        meta: metaResponse(),
      });
    }

    const [messages, statusChanges] = await Promise.all([
      loadTicketMessages(pool, ticketId),
      loadStatusChanges(pool, ticketId),
    ]);
    return reply.send({
      success: true,
      data: { ticket: serializeTicket(ticketRes.rows[0]), messages, statusChanges },
      meta: metaResponse(),
    } as APIResponse);
  });

  // POST /api/v1/admin/support/tickets/:id/messages — admin reply
  fastify.post(
    '/tickets/:id/messages',
    { preHandler: adminPreHandlers },
    async (request, reply) => {
      const adminUserId = parseInt(request.user!.sub);
      const ticketId = parseInt((request.params as { id: string }).id);
      const { body } = PostMessageSchema.parse(request.body);

      const ticketRes = await pool.query<TicketRow>(
        `SELECT * FROM support_tickets WHERE id = $1`,
        [ticketId]
      );
      if (ticketRes.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Ticket not found' },
          meta: metaResponse(),
        });
      }
      const ticket = ticketRes.rows[0];

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO support_ticket_messages (ticket_id, author_user_id, author_role, body)
           VALUES ($1, $2, 'admin', $3)`,
          [ticketId, adminUserId, body]
        );
        await client.query(
          `UPDATE support_tickets SET last_admin_reply_at = NOW() WHERE id = $1`,
          [ticketId]
        );
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      await notifyTicketEvent(pool, [ticket.user_id], ticket, 'admin_reply');

      const messages = await loadTicketMessages(pool, ticketId);
      return reply.status(201).send({
        success: true,
        data: { messages },
        meta: metaResponse(),
      } as APIResponse);
    }
  );

  // PATCH /api/v1/admin/support/tickets/:id — update status
  fastify.patch(
    '/tickets/:id',
    { preHandler: adminPreHandlers },
    async (request, reply) => {
      const adminUserId = parseInt(request.user!.sub);
      const ticketId = parseInt((request.params as { id: string }).id);
      const { status } = UpdateStatusSchema.parse(request.body);

      const client = await pool.connect();
      let updateRes;
      try {
        await client.query('BEGIN');
        const existing = await client.query<{ status: TicketStatus }>(
          `SELECT status FROM support_tickets WHERE id = $1 FOR UPDATE`,
          [ticketId]
        );
        if (existing.rows.length === 0) {
          await client.query('ROLLBACK');
          return reply.status(404).send({
            success: false,
            error: { code: 'NOT_FOUND', message: 'Ticket not found' },
            meta: metaResponse(),
          });
        }
        const fromStatus = existing.rows[0].status;
        updateRes = await client.query<TicketRow>(
          `UPDATE support_tickets SET status = $1 WHERE id = $2 RETURNING *`,
          [status, ticketId]
        );
        if (fromStatus !== status) {
          await client.query(
            `INSERT INTO support_ticket_status_changes
               (ticket_id, actor_user_id, actor_role, from_status, to_status)
             VALUES ($1, $2, 'admin', $3, $4)`,
            [ticketId, adminUserId, fromStatus, status]
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
      const ticket = updateRes.rows[0];

      await notifyTicketEvent(pool, [ticket.user_id], ticket, 'status_changed', {
        newStatus: status,
      });

      return reply.send({
        success: true,
        data: { ticket: serializeTicket(ticket) },
        meta: metaResponse(),
      } as APIResponse);
    }
  );
}
